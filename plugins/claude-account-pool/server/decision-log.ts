import type { AgentDecision } from "./classifier";

/**
 * One line per classifier decision, at create. The prefix is fixed so
 * `grep 'classifier-decision '` over the daemon log finds every one, and the
 * rest of the line is a single JSON object so `jq` reads it.
 */
export const DECISION_LOG_PREFIX = "classifier-decision";

/** Enough of an `agent.create` request to fingerprint it and read what it became. Structural, like the other request reads in this plugin. */
export interface LoggedRequest {
  callerAgentId?: string;
  initialPrompt?: string;
  labels?: Record<string, string>;
  config: { provider?: string; model?: string; title?: string | null; cwd?: string; thinkingOptionId?: string };
}

export interface DecisionLog {
  /** Called by the role router (server/role-router.ts) with what it decided for `request`. Writes nothing. */
  note(request: LoggedRequest, decision: AgentDecision): void;
  /**
   * Called by the account router's hook with the request it received and what
   * came out of it: `undefined` when the create was refused. This is the only
   * place a line is written, because the account is decided here — after the
   * role router, which deliberately classifies without `nowMs` — so a line
   * written any earlier would name an account that isn't the one that runs.
   */
  finish(request: LoggedRequest, result: LoggedRequest | undefined): void;
}

export interface DecisionLogOptions {
  write: (line: string) => void;
  now?: () => number;
}

/** A create whose account router never reported back (a throw, a passthrough hook) is forgotten after this. */
const PENDING_TTL_MS = 60_000;
const MAX_PENDING = 64;

interface Pending {
  fingerprint: string;
  decision: AgentDecision;
  atMs: number;
}

/**
 * The role router and the account router are separate hooks, and the request
 * object is copied between them, so the decision is matched to its create by
 * fingerprint rather than by identity. None of the fields below is rewritten
 * by either router: the model, provider and thinking level are.
 */
function fingerprintOf(request: LoggedRequest): string {
  return [
    request.callerAgentId ?? "",
    request.config.cwd ?? "",
    request.config.title ?? "",
    (request.initialPrompt ?? "").slice(0, 120),
  ].join("\u0000");
}

export function createDecisionLog(options: DecisionLogOptions): DecisionLog {
  const now = options.now ?? Date.now;
  let pending: Pending[] = [];

  return {
    note(request, decision) {
      const nowMs = now();
      pending = pending.filter((entry) => nowMs - entry.atMs < PENDING_TTL_MS).slice(-(MAX_PENDING - 1));
      pending.push({ fingerprint: fingerprintOf(request), decision, atMs: nowMs });
    },
    finish(request, result) {
      const nowMs = now();
      pending = pending.filter((entry) => nowMs - entry.atMs < PENDING_TTL_MS);
      const fingerprint = fingerprintOf(request);
      const index = pending.findIndex((entry) => entry.fingerprint === fingerprint);
      if (index === -1) {
        return;
      }
      const [entry] = pending.splice(index, 1);
      options.write(`${DECISION_LOG_PREFIX} ${JSON.stringify(describe(entry.decision, result))}`);
    },
  };
}

function describe(decision: AgentDecision, result: LoggedRequest | undefined): Record<string, unknown> {
  const { role, taskClass, model, thinking, outputStyle } = decision;
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
      ...(result?.config.model !== undefined ? { final: result.config.model } : {}),
    },
    thinking: { optionId: thinking.optionId, outcome: thinking.outcome },
    outputStyle: outputStyle.style,
    account: result ? { providerId: result.config.provider ?? null } : { refused: true },
    ...(model.unadvertisedPoolEntries.length > 0 ? { unadvertisedPoolEntries: model.unadvertisedPoolEntries } : {}),
    reasons: {
      role: role.reason,
      taskClass: taskClass.reason,
      model: model.reason,
      outputStyle: outputStyle.reason,
    },
  };
}
