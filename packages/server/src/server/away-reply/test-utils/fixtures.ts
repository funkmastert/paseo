import type { AgentPermissionRequest, AgentTimelineItem } from "../../agent/agent-sdk-types.js";
import type { AgentTimelineRow } from "../../agent/agent-timeline-store-types.js";
import type { AwayReplyAgentView } from "../detect.js";

/** Shared builders for the away auto-reply tests. */

export const T0 = Date.parse("2026-09-29T08:00:00.000Z");
export const MINUTE = 60_000;

export function leaderView(overrides: Partial<AwayReplyAgentView> = {}): AwayReplyAgentView {
  return {
    id: "leader-1",
    provider: "claude",
    cwd: "/tmp/away-reply-leader",
    workspaceId: "ws-1",
    internal: false,
    lifecycle: "idle",
    busy: false,
    labels: {},
    runningProviderSubagentCount: 0,
    pendingPermissions: [],
    archivedAt: null,
    title: null,
    // A finished turn raises the unread flag; Tyler opening the agent clears it.
    requiresAttention: true,
    ...overrides,
  };
}

export function rowsOf(
  entries: Array<{ at: number; item: AgentTimelineItem }>,
  startSeq = 1,
): AgentTimelineRow[] {
  return entries.map((entry, index) => ({
    seq: startSeq + index,
    timestamp: new Date(entry.at).toISOString(),
    item: entry.item,
  }));
}

export function user(text: string, at: number): { at: number; item: AgentTimelineItem } {
  return { at, item: { type: "user_message", text } };
}

export function assistant(text: string, at: number): { at: number; item: AgentTimelineItem } {
  return { at, item: { type: "assistant_message", text } };
}

export function questionRequest(
  overrides: Partial<AgentPermissionRequest> = {},
): AgentPermissionRequest {
  return {
    id: "perm-question",
    provider: "claude",
    name: "AskUserQuestion",
    kind: "question",
    input: {
      questions: [
        {
          question: "Which store should the cache use?",
          header: "Cache store",
          multiSelect: false,
          allowOther: true,
          options: [
            { label: "SQLite (Recommended)", description: "Already a dependency" },
            { label: "JSON file", description: "Simplest" },
          ],
        },
      ],
    },
    ...overrides,
  };
}

export function planRequest(plan: string): AgentPermissionRequest {
  return {
    id: "perm-plan",
    provider: "claude",
    name: "ExitPlanMode",
    kind: "plan",
    input: { plan },
    actions: [
      { id: "reject", label: "Reject", behavior: "deny", variant: "danger", intent: "dismiss" },
      {
        id: "implement",
        label: "Implement",
        behavior: "allow",
        variant: "primary",
        intent: "implement",
      },
      {
        id: "implement_resume",
        label: "Implement with Bypass",
        behavior: "allow",
        variant: "secondary",
        intent: "implement_resume",
      },
    ],
    metadata: { planText: plan },
  };
}

export function toolRequest(name: string, input: Record<string, unknown>): AgentPermissionRequest {
  return { id: `perm-${name}`, provider: "claude", name, kind: "tool", input };
}
