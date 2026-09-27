import type { AgentDecision } from "./classifier";
import { echoed } from "./echo";
import { mcpScopeLabelValue } from "./mcp-scope";

/**
 * One line per classifier decision, at create. The prefix is fixed so
 * `grep 'classifier-decision '` over the daemon log finds every one, and the
 * rest of the line is a single JSON object so `jq` reads it.
 */
export const DECISION_LOG_PREFIX = "classifier-decision";

/** Enough of an `agent.create` request to read what it became. Structural, like the other request reads in this plugin. */
export interface LoggedRequest {
  callerAgentId?: string;
  initialPrompt?: string;
  labels?: Record<string, string>;
  config: { provider?: string; model?: string; title?: string | null; cwd?: string; thinkingOptionId?: string };
}

/**
 * Carries a create's pairing token from the role router's hook to the account
 * router's hook. The daemon hands every `before` handler a structured clone
 * and strict-parses each output, so no object survives between the two hooks
 * and no field outside the request schema does either; a label does. The
 * account router's hook strips it, so it never reaches an agent.
 */
export const DECISION_TOKEN_LABEL = "paseo.decision-log-token";

export interface DecisionLog {
  /** Called by the role router (server/role-router.ts) with what it decided for `request`. Writes nothing. */
  note(request: LoggedRequest, decision: AgentDecision): void;
  /**
   * Called by the role router's hook with the request the role router received
   * and what the hook is about to return. Returns `output` carrying the pairing
   * token of the decision noted for `request`, or `output` unchanged when none
   * was noted.
   */
  tag<T extends { labels?: Record<string, string> }>(request: object, output: T): T;
  /**
   * Strips the pairing token from a request, returning the token and the
   * request without it. The account router's hook routes and returns the
   * stripped request.
   */
  untag<T extends { labels?: Record<string, string> }>(request: T): { token: string | undefined; request: T };
  /**
   * Called by the account router's hook with the pairing token, the request it
   * received and what came out of it: `undefined` when the create was refused.
   * This is the only place a line is written, because the account is decided
   * here — after the role router, which deliberately classifies without
   * `nowMs` — so a line written any earlier would name an account that isn't
   * the one that runs. A create whose decision cannot be found still gets a
   * line, with the decision marked unknown. Never throws.
   */
  finish(token: string | undefined, request: LoggedRequest, result: LoggedRequest | undefined): void;
}

export interface DecisionLogOptions {
  write: (line: string) => void;
  now?: () => number;
}

/** A create whose account router never reported back (a throw, a passthrough hook) is forgotten after this. */
const PENDING_TTL_MS = 60_000;
const MAX_PENDING = 64;

interface Pending {
  decision: AgentDecision;
  atMs: number;
  /** Set once its line is written, so a repeated finish writes nothing. Kept until the TTL so the repeat is recognised. */
  finished: boolean;
}

export function createDecisionLog(options: DecisionLogOptions): DecisionLog {
  const now = options.now ?? Date.now;
  const instance = Math.random().toString(36).slice(2, 10);
  let sequence = 0;
  const pending = new Map<string, Pending>();
  const noted = new WeakMap<object, string>();

  const prune = (nowMs: number) => {
    for (const [token, entry] of pending) {
      if (nowMs - entry.atMs >= PENDING_TTL_MS) {
        pending.delete(token);
      }
    }
    // Insertion order is age order, so the first keys are the oldest.
    for (const token of pending.keys()) {
      if (pending.size < MAX_PENDING) break;
      pending.delete(token);
    }
  };

  return {
    note(request, decision) {
      const nowMs = now();
      prune(nowMs);
      sequence += 1;
      const token = `${instance}-${sequence}`;
      pending.set(token, { decision, atMs: nowMs, finished: false });
      noted.set(request, token);
    },
    tag(request, output) {
      const token = noted.get(request);
      if (token === undefined) {
        return output;
      }
      return { ...output, labels: { ...output.labels, [DECISION_TOKEN_LABEL]: token } };
    },
    untag(request) {
      const token = request.labels?.[DECISION_TOKEN_LABEL];
      if (token === undefined) {
        return { token: undefined, request };
      }
      const { [DECISION_TOKEN_LABEL]: _token, ...labels } = request.labels ?? {};
      return { token, request: { ...request, labels } };
    },
    finish(token, request, result) {
      try {
        const nowMs = now();
        prune(nowMs);
        const entry = token === undefined ? undefined : pending.get(token);
        if (entry?.finished) {
          return;
        }
        if (entry) {
          entry.finished = true;
        }
        const line = entry ? describe(entry.decision, result) : describeUnknown(request, result);
        options.write(`${DECISION_LOG_PREFIX} ${JSON.stringify(line)}`);
      } catch {
        // A log line is never worth failing a create over.
      }
    },
  };
}

/** The model the request that runs carries. It is the caller's own whenever no hook rewrote it, so it is capped. */
function finalModel(result: LoggedRequest | undefined): { final: string } | undefined {
  return result?.config.model !== undefined ? { final: echoed(result.config.model) } : undefined;
}

/** The account the request that runs carries, or that it was refused. It is the caller's own whenever the pool passed it through, so it is capped. */
function account(result: LoggedRequest | undefined): Record<string, unknown> {
  if (!result) {
    return { refused: true };
  }
  return { providerId: result.config.provider !== undefined ? echoed(result.config.provider) : null };
}

/** The line for a create whose decision was never noted or has expired: what ran, and that the decision is not known. */
function describeUnknown(request: LoggedRequest, result: LoggedRequest | undefined): Record<string, unknown> {
  const final = finalModel(result);
  return {
    caller: request.callerAgentId ? "child" : "root",
    decision: "unknown",
    ...(final ? { model: final } : {}),
    account: account(result),
  };
}

function describe(decision: AgentDecision, result: LoggedRequest | undefined): Record<string, unknown> {
  const { role, taskClass, model, thinking, outputStyle, mcp } = decision;
  return {
    caller: role.source === "leader-tier" ? "root" : "child",
    role: { id: role.role.id, source: role.source },
    taskClass: { value: taskClass.taskClass ?? null, source: taskClass.source },
    model: {
      ref: model.model ?? null,
      outcome: model.outcome,
      poolSlot: model.poolSlot,
      ...(model.resolvedFrom !== undefined ? { resolvedFrom: model.resolvedFrom } : {}),
      ...(model.requestedRef !== undefined ? { requested: model.requestedRef } : {}),
      ...(model.override ? { overridden: true } : {}),
      ...(model.unadvertised ? { unadvertised: model.unadvertised.ref } : {}),
      // What the request actually carries after every hook ran, for the case a hook skipped the rewrite.
      ...finalModel(result),
    },
    // Both can be the caller's own value, left standing, so both are capped.
    thinking: { optionId: thinking.optionId === null ? null : echoed(thinking.optionId), outcome: thinking.outcome },
    outputStyle: outputStyle.style === null ? null : echoed(outputStyle.style),
    // The paseo.mcp-scope value, or "all" for an agent that keeps every server.
    mcp: mcpScopeLabelValue(mcp) ?? "all",
    account: account(result),
    ...(model.unadvertisedPoolEntries.length > 0 ? { unadvertisedPoolEntries: model.unadvertisedPoolEntries } : {}),
    reasons: {
      role: role.reason,
      taskClass: taskClass.reason,
      model: model.reason,
      outputStyle: outputStyle.reason,
    },
  };
}
