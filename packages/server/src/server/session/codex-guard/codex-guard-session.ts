import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { getCodexGuardHealthState } from "../../agent/codex-guard-health.js";
import type { ResourceMonitorAgentSummary } from "../../agent/agent-manager.js";

export interface CodexGuardSessionOptions {
  host: { emit: (message: SessionOutboundMessage) => void };
  /** A fresh agent list per request: health can flip red mid-session, and children start and stop constantly. */
  listAgents: () => readonly ResourceMonitorAgentSummary[];
}

/**
 * A `codex/` child: provider "codex", running right now, and carrying a parent -- Tyler's own
 * Codex sessions (no `paseo.parent-agent-id`) never count against KTD-9's `maxChildren` cap.
 */
export function countRunningCodexChildren(agents: readonly ResourceMonitorAgentSummary[]): number {
  return agents.filter(
    (agent) => agent.provider === "codex" && agent.isRunning && agent.parentAgentId !== null,
  ).length;
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
    const { host, listAgents } = this.options;
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
          runningChildren: countRunningCodexChildren(listAgents()),
        },
      },
    });
  }
}

export function createCodexGuardSession(options: CodexGuardSessionOptions): CodexGuardSession {
  return new CodexGuardSession(options);
}
