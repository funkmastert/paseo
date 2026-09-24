/**
 * Push-notification `data.reason` value for the done janitor. Untyped JSON on the wire (not part
 * of the closed `attentionReason` enum), so it is safe for old apps: with no `agentId` to open
 * they fall back to the workspaces list. Sent only when a sweep archived, deleted or removed something —
 * a sweep that merely checked stays silent.
 */
export type DoneJanitorNotificationReason = "done_janitor";

export interface DoneJanitorNotificationData {
  [key: string]: unknown;
  serverId: string;
  reason: DoneJanitorNotificationReason;
}

export interface DoneJanitorNotificationPayload {
  title: string;
  body: string;
  data: DoneJanitorNotificationData;
}

export interface BuildDoneJanitorNotificationPayloadInput {
  serverId: string;
  archivedAgentCount: number;
  /** Agents archived because they were closed or errored and unpinned, not because they answered. */
  archivedDeadAgentCount?: number;
  deletedWorktreeCount: number;
  /** Projects removed because they had no workspaces and their directory was gone. */
  removedProjectCount?: number;
  /** Total freed, summed over worktrees whose size was sampled before deletion. */
  reclaimedBytes: number;
  /** Worktrees whose agents were archived but which were kept, with the reason for each. */
  keptWorktrees: readonly { name: string; reason: string }[];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function buildDoneJanitorNotificationPayload(
  input: BuildDoneJanitorNotificationPayloadInput,
): DoneJanitorNotificationPayload {
  const parts: string[] = [];
  if (input.archivedAgentCount > 0) {
    parts.push(`Archived ${plural(input.archivedAgentCount, "finished agent")}`);
  }
  const dead = input.archivedDeadAgentCount ?? 0;
  if (dead > 0) {
    parts.push(`${parts.length > 0 ? "archived" : "Archived"} ${plural(dead, "dead session")}`);
  }
  if (input.deletedWorktreeCount > 0) {
    const verb = parts.length > 0 ? "deleted" : "Deleted";
    parts.push(
      `${verb} ${plural(input.deletedWorktreeCount, "worktree")}, freeing ${formatGigabytes(input.reclaimedBytes)}`,
    );
  }
  const removedProjects = input.removedProjectCount ?? 0;
  if (removedProjects > 0) {
    parts.push(
      `${parts.length > 0 ? "removed" : "Removed"} ${plural(removedProjects, "empty project")}`,
    );
  }
  const head = parts.slice(0, -1).join(", ");
  const sentences = [`${head ? `${head} and ` : ""}${parts[parts.length - 1]}.`];
  const [firstKept, ...otherKept] = input.keptWorktrees;
  if (firstKept) {
    const more = otherKept.length > 0 ? ` (+${otherKept.length} more)` : "";
    sentences.push(`Kept ${firstKept.name}: ${firstKept.reason}${more}.`);
  }
  return {
    title: "Cleaned up finished work",
    body: sentences.join(" "),
    data: { serverId: input.serverId, reason: "done_janitor" },
  };
}
