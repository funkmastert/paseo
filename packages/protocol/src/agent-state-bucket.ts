import type { AgentLifecycleStatus } from "./agent-lifecycle.js";
import type { WorkspaceStateBucket } from "./messages.js";

export type { WorkspaceStateBucket };
export type AgentAttentionReason = "finished" | "error" | "permission" | null | undefined;

export interface AgentStateBucketInput {
  status: AgentLifecycleStatus;
  pendingPermissionCount?: number;
  requiresAttention?: boolean;
  attentionReason?: AgentAttentionReason;
  /**
   * Presence of a live token-burn breach. Attention-worthy independent of `attentionReason` —
   * that enum is closed on the wire and a token-burn alert deliberately never joins it. Unlike
   * requiresAttention, this can be true while `status === "running"` (a runaway agent is by
   * definition still running), so it outranks "running" below. See
   * docs/plans/2026-09-12-006-feat-token-burn-monitor-plan.md.
   */
  tokenBurnAlert?: boolean;
}

const WORKSPACE_STATE_BUCKET_PRIORITY = {
  needs_input: 0,
  failed: 1,
  running: 2,
  attention: 3,
  done: 4,
} as const satisfies Record<WorkspaceStateBucket, number>;

export function deriveAgentStateBucket(input: AgentStateBucketInput): WorkspaceStateBucket {
  if ((input.pendingPermissionCount ?? 0) > 0 || input.attentionReason === "permission") {
    return "needs_input";
  }
  if (input.status === "error" || input.attentionReason === "error") {
    return "failed";
  }
  // Checked before the running status below: a token-burn alert fires *while* the agent is
  // still running (that's the case it exists to catch), unlike requiresAttention, which is
  // edge-triggered only at turn completion and never co-occurs with "running" in practice.
  if (input.tokenBurnAlert) {
    return "attention";
  }
  if (input.status === "running") {
    return "running";
  }
  if (input.requiresAttention) {
    return "attention";
  }
  return "done";
}

export function getWorkspaceStateBucketPriority(bucket: WorkspaceStateBucket): number {
  return WORKSPACE_STATE_BUCKET_PRIORITY[bucket];
}

export function getAgentStatusPriority(input: AgentStateBucketInput): number {
  if ((input.pendingPermissionCount ?? 0) > 0 || input.attentionReason === "permission") {
    return 0;
  }
  if (input.status === "error" || input.attentionReason === "error") {
    return 1;
  }
  if (input.status === "running") {
    return 2;
  }
  if (input.status === "initializing") {
    return 3;
  }
  return 4;
}
