import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

import { ACCOUNT_FAILOVER_MIGRATED_TO_LABEL } from "../agent/account-failover-detector.js";
import type { AgentLifecycleStatus } from "../agent/agent-manager.js";
import { isSystemInjectedEnvelope } from "../agent/agent-prompt.js";
import type { AgentPermissionRequest } from "../agent/agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";

/**
 * Which leaders are waiting on Tyler, and since when (docs/jev.md, "Feature 14: away
 * auto-reply"). Pure: the job feeds it the live agent list and a timeline tail.
 */

/** Opts one agent out, any value but absent. Set with `update_agent`, like `paseo.keep`. */
export const AWAY_REPLY_OPT_OUT_LABEL = "paseo.away-reply";
/** ISO time of the last auto-reply. Also marks the episode it answered as done. */
export const AUTO_REPLIED_AT_LABEL = "paseo.auto-replied-at";
/** Auto-replies since Tyler last wrote to this agent. */
export const AUTO_REPLY_STREAK_LABEL = "paseo.auto-reply-streak";

/** Every auto-reply starts with this, so it is never read as Tyler's own message. */
export const AWAY_REPLY_MARKER_PREFIX = "[Auto-reply on Tyler's behalf";

const REMEDIATION_LABELS = ["paseo.remediation", "paseo.remediation-key"];
const SCHEDULE_LABELS = ["paseo.schedule-id", "paseo.schedule-run"];

/** One live agent as the job sees it. Built in `job.ts` from the agent manager. */
export interface AwayReplyAgentView {
  id: string;
  provider: string;
  cwd: string;
  workspaceId: string | undefined;
  internal: boolean;
  lifecycle: AgentLifecycleStatus;
  /** A foreground turn, a pending run, or a replacement in flight (the done janitor's meaning). */
  busy: boolean;
  labels: Record<string, string>;
  runningProviderSubagentCount: number;
  pendingPermissions: AgentPermissionRequest[];
  /** Set when the stored record is archived. A live runtime is closed on archive, so rare. */
  archivedAt: string | null;
}

export type AwayReplyWaitKind = "turn-ended" | "question" | "plan" | "permission";

export interface WaitingEpisode {
  agentId: string;
  kind: AwayReplyWaitKind;
  /** Stable for one wait; changes as soon as anything new happens in the thread. */
  key: string;
  waitingSinceMs: number;
  /** The agent's last message, whole. Empty when it wrote none. */
  lastMessage: string;
  /** The pending request, for every kind but `turn-ended`. */
  request: AgentPermissionRequest | null;
}

export type WaitingDetection =
  | { waiting: true; episode: WaitingEpisode }
  | { waiting: false; reason: string };

/** Why this agent is not a leader the job may answer, or null. */
export function leaderSkipReason(
  agent: AwayReplyAgentView,
  all: readonly AwayReplyAgentView[],
  options: { pinnedWorkspaceIds: ReadonlySet<string>; skipPinnedWorkspaces: boolean },
): string | null {
  if (agent.internal) return "internal";
  if (getParentAgentIdFromLabels(agent.labels)) return "not-a-leader";
  if (agent.archivedAt) return "archived";
  if (REMEDIATION_LABELS.some((label) => label in agent.labels)) return "remediation-agent";
  if (SCHEDULE_LABELS.some((label) => label in agent.labels)) return "schedule-agent";
  if (ACCOUNT_FAILOVER_MIGRATED_TO_LABEL in agent.labels) return "retired-by-failover";
  if (AWAY_REPLY_OPT_OUT_LABEL in agent.labels) return "opted-out";
  if (
    options.skipPinnedWorkspaces &&
    agent.workspaceId &&
    options.pinnedWorkspaceIds.has(agent.workspaceId)
  ) {
    return "pinned-workspace";
  }
  if (agent.runningProviderSubagentCount > 0) return "subagents-running";
  const childRunning = all.some(
    (other) =>
      getParentAgentIdFromLabels(other.labels) === agent.id &&
      !other.archivedAt &&
      (other.busy || other.lifecycle === "running" || other.lifecycle === "initializing"),
  );
  if (childRunning) return "children-running";
  return null;
}

/** A user message Tyler wrote: not a `<paseo-system>` envelope, not an auto-reply. */
export function isTylerMessage(text: string): boolean {
  return !isSystemInjectedEnvelope(text) && !text.startsWith(AWAY_REPLY_MARKER_PREFIX);
}

function timestampMs(row: AgentTimelineRow): number | null {
  const parsed = Date.parse(row.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function isMessageRow(row: AgentTimelineRow): boolean {
  return row.item.type === "user_message" || row.item.type === "assistant_message";
}

/** The agent's last message: the last contiguous assistant chunks (providers stream them). */
export function lastAssistantMessage(rows: readonly AgentTimelineRow[]): string {
  const chunks: string[] = [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index].item;
    if (item.type !== "assistant_message") {
      if (chunks.length > 0) break;
      continue;
    }
    chunks.push(item.text);
  }
  return chunks.toReversed().join("");
}

/** Whether Tyler wrote to the agent at or after `sinceMs`, as far as the tail reaches. */
export function tylerMessagedSince(rows: readonly AgentTimelineRow[], sinceMs: number): boolean {
  return rows.some((row) => {
    if (row.item.type !== "user_message" || !isTylerMessage(row.item.text)) return false;
    const at = timestampMs(row);
    return at !== null && at >= sinceMs;
  });
}

const REQUEST_KINDS: Partial<Record<AgentPermissionRequest["kind"], AwayReplyWaitKind>> = {
  question: "question",
  plan: "plan",
  tool: "permission",
};

/**
 * Whether the agent is waiting on Tyler, and since when.
 *
 * - A pending question, plan approval or tool permission: the agent's turn is blocked on it, so
 *   the newest timeline row is when it asked.
 * - Otherwise its turn has ended (idle, nothing in flight) and the newest message in the thread is
 *   its own; the wait starts at the newest row, the turn's end.
 */
export function detectWaiting(
  agent: AwayReplyAgentView,
  rows: readonly AgentTimelineRow[],
): WaitingDetection {
  if (agent.lifecycle !== "idle" && agent.lifecycle !== "running") {
    return { waiting: false, reason: `lifecycle-${agent.lifecycle}` };
  }
  const lastRow = rows.at(-1);
  const lastAt = lastRow ? timestampMs(lastRow) : null;
  if (!lastRow || lastAt === null) return { waiting: false, reason: "no-timeline" };

  if (agent.pendingPermissions.length > 1) {
    return { waiting: false, reason: "several-pending-requests" };
  }
  const request = agent.pendingPermissions[0];
  if (request) {
    const kind = REQUEST_KINDS[request.kind];
    if (!kind) return { waiting: false, reason: `unsupported-request-${request.kind}` };
    return {
      waiting: true,
      episode: {
        agentId: agent.id,
        kind,
        key: `${agent.id}:${kind}:${request.id}`,
        waitingSinceMs: lastAt,
        lastMessage: lastAssistantMessage(rows),
        request,
      },
    };
  }

  if (agent.lifecycle !== "idle" || agent.busy) return { waiting: false, reason: "turn-running" };
  const lastMessageRow = rows.findLast(isMessageRow);
  if (!lastMessageRow) return { waiting: false, reason: "no-messages" };
  if (lastMessageRow.item.type !== "assistant_message") {
    return { waiting: false, reason: "last-message-not-agent" };
  }
  return {
    waiting: true,
    episode: {
      agentId: agent.id,
      kind: "turn-ended",
      key: `${agent.id}:turn:${lastRow.seq}:${lastRow.timestamp}`,
      waitingSinceMs: lastAt,
      lastMessage: lastAssistantMessage(rows),
      request: null,
    },
  };
}
