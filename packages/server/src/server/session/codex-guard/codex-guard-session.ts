import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { getCodexGuardHealthState } from "../../agent/codex-guard-health.js";
import type { CodexGuardChildCandidateSummary } from "../../agent/agent-manager.js";

export interface CodexGuardSessionOptions {
  host: { emit: (message: SessionOutboundMessage) => void };
  /** A fresh agent list per request: health can flip red mid-session, and children start and stop constantly. */
  listAgents: () => readonly CodexGuardChildCandidateSummary[];
  /** Injectable for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * How long a freshly created, still-idle Codex child keeps counting against KTD-9's
 * `maxChildren` cap (code-review finding, round 1). A fresh agent sits at lifecycle `"idle"`
 * until its first turn is admitted, so counting `lifecycle === "running"` alone undercounts a
 * burst of near-simultaneous creates: each one looks uncounted to the next until admission
 * catches up, letting the burst sail past the cap. 15 minutes comfortably covers the admission
 * queue and the daemon's own per-request budgets; nothing legitimate stays idle-after-create that
 * long without either starting its first turn (which flips `busy`/`lifecycle`) or being closed.
 */
const RECENT_CREATE_WINDOW_MS = 15 * 60 * 1000;

/**
 * A Codex child that is, or is about to be, drawing on the Codex window (KTD-9): not archived and
 * not closed, and either running, initializing, created within `RECENT_CREATE_WINDOW_MS`, or
 * carrying a queued/admitted turn (`busy`). Tyler's own Codex sessions (no
 * `paseo.parent-agent-id`) never count. "Not archived and not closed" needs no explicit check
 * here: `agent-manager.ts`'s `this.agents` map never holds either state in the first place
 * (`prepareAgentForClosure` deletes the entry synchronously, before any `await`), so anything
 * `listAgentsForCodexGuardStatus` returns already satisfies it. The `lifecycle !== "closed"` guard
 * below is defense in depth against that invariant changing, not the primary filter.
 */
export function countRunningCodexChildren(
  agents: readonly CodexGuardChildCandidateSummary[],
  now: () => number = Date.now,
): number {
  const nowMs = now();
  return agents.filter((agent) => {
    if (agent.provider !== "codex" || agent.parentAgentId === null) return false;
    if (agent.lifecycle === "closed") return false;
    if (agent.lifecycle === "running" || agent.lifecycle === "initializing") return true;
    if (agent.busy) return true;
    const ageMs = nowMs - new Date(agent.createdAt).getTime();
    return Number.isFinite(ageMs) && ageMs <= RECENT_CREATE_WINDOW_MS;
  }).length;
}

/**
 * Serves `codex.guard.status` (docs/codex-workers.md, "Guard health"): the daemon-side guard
 * self-test's verdict (KTD-6), plus the running-children count KTD-9's usability gate needs. This
 * is the plugin-host boundary `isCodexGuardHealthy()` and `runningCodexChildren` were missing --
 * plugins can't import daemon modules directly, so this RPC is what carries both across.
 */
export class CodexGuardSession {
  private readonly options: CodexGuardSessionOptions;

  constructor(options: CodexGuardSessionOptions) {
    this.options = options;
  }

  async handleStatus(
    msg: Extract<SessionInboundMessage, { type: "codex.guard.status.request" }>,
  ): Promise<void> {
    const { host, listAgents, now } = this.options;
    const state = getCodexGuardHealthState();
    host.emit({
      type: "codex.guard.status.response",
      payload: {
        requestId: msg.requestId,
        status: {
          status: state.status,
          reason: state.reason,
          checkedAt: state.timestamp,
          codexVersion: state.codexVersion,
          runningChildren: countRunningCodexChildren(listAgents(), now),
        },
      },
    });
  }
}

export function createCodexGuardSession(options: CodexGuardSessionOptions): CodexGuardSession {
  return new CodexGuardSession(options);
}
