/**
 * The one prompt restart recovery sends an agent it resumes, wrapped by the caller in the
 * `<paseo-system>` envelope. It names the interrupted turn and what did and did not survive it,
 * the way account failover's resume prompt does. See docs/restart-recovery.md.
 */

export interface RecoveryPeer {
  agentId: string;
  title: string | null;
}

export function buildRecoveryResumePrompt(input: {
  agentId: string;
  runStartedAt: string;
  daemonStartedAt: string;
  /** The nearest ancestor recovery is also resuming, if any. */
  recoveringParent: RecoveryPeer | null;
  /** Children recovery resumes after this agent. */
  recoveringChildren: readonly RecoveryPeer[];
}): string {
  const lines = [
    `Restart recovery: the Paseo daemon stopped while you were mid-turn. That turn started at ` +
      `${input.runStartedAt}; the daemon came back at ${input.daemonStartedAt}. You are the same ` +
      `agent (${input.agentId}) with the same conversation, resumed by the new daemon.`,
    "",
    "What survived: your conversation up to the provider's last save, and everything on disk. " +
      "What did not: whatever the interrupted turn had running inside the provider process " +
      "(tool calls in flight, background shells, Monitor watches, workflows), and any permission " +
      "request that was waiting.",
    "",
    "1. Check what the interrupted turn already finished before redoing any of it: git status, " +
      "the files you were changing, the state of anything you were waiting on.",
    "2. Then carry on with the task. If it was already done or is waiting on a person, report " +
      "and stop.",
  ];
  if (input.recoveringChildren.length > 0) {
    lines.push(
      `3. Recovery is also resuming these subagents of yours, which were mid-turn: ` +
        `${input.recoveringChildren.map(formatPeer).join(", ")}. Do not relaunch or re-prompt ` +
        "them. A finish notification armed before the restart may not arrive, so follow them " +
        "with wait_for_agent or get_agent_status.",
    );
  }
  if (input.recoveringParent) {
    lines.push(
      `${input.recoveringChildren.length > 0 ? "4" : "3"}. Your parent ` +
        `${formatPeer(input.recoveringParent)} was resumed before you and knows you are coming ` +
        "back. Report to it as you normally would when you finish.",
    );
  }
  return lines.join("\n");
}

/** Sent once to a resumed parent whose mid-turn children recovery could not bring back. */
export function buildUnrecoveredChildrenNotice(
  children: readonly (RecoveryPeer & { reason: string })[],
): string {
  return [
    "Restart recovery could not resume these subagents of yours, which were mid-turn when the " +
      "daemon stopped:",
    ...children.map((child) => `- ${formatPeer(child)}: ${child.reason}`),
    "Decide whether to resume each with send_agent_prompt, replace it, or drop its task.",
  ].join("\n");
}

function formatPeer(peer: RecoveryPeer): string {
  return peer.title ? `${peer.agentId} ("${peer.title}")` : peer.agentId;
}
