/**
 * Selection logic for AgentDoneJanitor: which root agents are mechanically finished and may be
 * asked whether they are done, how their answer is read, and when they may be asked again. Pure —
 * no I/O, no clock reads; the janitor passes `nowMs` in and carries `DoneJanitorMemory` between
 * sweeps, the same shape build-daemon-reaper.ts uses. See docs/done-janitor.md.
 *
 * Every check is conjunctive and every one of them on its own is enough to spare an agent. A fact
 * that cannot be established (an unparseable timestamp, a missing record) counts as "not done".
 */

import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import { ACCOUNT_FAILOVER_MIGRATED_TO_LABEL } from "./account-failover-detector.js";

/**
 * Any value pins: an agent carrying this label is never asked, archived or reclaimed, and neither
 * is any tree or workspace it belongs to. Presence is the whole test, so `"false"` pins too — a
 * pin that one typo could undo is not a pin.
 */
export const DONE_JANITOR_KEEP_LABEL = "paseo.keep";

/** One agent, merged from its live summary when loaded and its stored record otherwise. */
export interface DoneJanitorAgentView {
  id: string;
  title: string | null;
  provider: string;
  workspaceId: string | undefined;
  cwd: string;
  internal: boolean;
  archived: boolean;
  /** `closed` for an agent with no live runtime. */
  lifecycle: AgentLifecycleStatus;
  busy: boolean;
  pendingPermissionCount: number;
  requiresAttention: boolean;
  attentionReason: "finished" | "error" | "permission" | null;
  hasAlert: boolean;
  runningProviderSubagentCount: number;
  /** Null when no activity timestamp parses. */
  lastActivityAtMs: number | null;
  labels: Record<string, string>;
  hasSession: boolean;
  /** A schedule or heartbeat that is not completed still targets it. */
  hasSchedule: boolean;
}

export type NotDoneReason = string;

export function isPinned(view: Pick<DoneJanitorAgentView, "labels">): boolean {
  return Object.prototype.hasOwnProperty.call(view.labels, DONE_JANITOR_KEEP_LABEL);
}

export function parentOf(view: Pick<DoneJanitorAgentView, "labels">): string | null {
  return getParentAgentIdFromLabels(view.labels);
}

/**
 * Why this one agent is not finished, ignoring its tree. `quietMs` null skips the quiet check —
 * used for the re-check right after the agent answered, when the answer itself is the newest
 * activity.
 */
export function agentNotDoneReason(
  view: DoneJanitorAgentView,
  nowMs: number,
  quietMs: number | null,
): NotDoneReason | null {
  if (isPinned(view)) return `pinned with ${DONE_JANITOR_KEEP_LABEL}`;
  if (view.lifecycle === "running" || view.lifecycle === "initializing") {
    return `is ${view.lifecycle}`;
  }
  // A failed agent is a problem nobody has looked at yet, not finished work.
  if (view.lifecycle === "error") return "is in error";
  if (view.busy) return "has a turn in flight";
  if (view.pendingPermissionCount > 0) return "is waiting on a permission";
  // Any unread flag, `finished` included: archiving clears it, which would erase the only sign
  // that there is a result nobody has read.
  if (view.requiresAttention)
    return `is flagged for attention (${view.attentionReason ?? "unread"})`;
  if (view.hasAlert) return "carries a live token-burn, spend or resource alert";
  if (view.runningProviderSubagentCount > 0) {
    return `has ${view.runningProviderSubagentCount} provider subagent(s) still running`;
  }
  if (view.hasSchedule) return "has a schedule or heartbeat that will wake it";
  // Its successor carries the work on; the retired record is the failover's to manage.
  if (view.labels[ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]) return "was retired by account failover";
  if (quietMs === null) return null;
  if (view.lastActivityAtMs === null) return "has no readable last-activity time";
  const quietForMs = nowMs - view.lastActivityAtMs;
  if (quietForMs < quietMs) {
    return `quiet for ${formatDuration(quietForMs)} of the ${formatDuration(quietMs)} required`;
  }
  return null;
}

/** Every unarchived agent whose parent chain reaches `rootId`, however deep. */
export function listDescendants(
  rootId: string,
  views: readonly DoneJanitorAgentView[],
): DoneJanitorAgentView[] {
  const childrenByParent = new Map<string, DoneJanitorAgentView[]>();
  for (const view of views) {
    if (view.archived) continue;
    const parent = parentOf(view);
    if (!parent) continue;
    const siblings = childrenByParent.get(parent);
    if (siblings) siblings.push(view);
    else childrenByParent.set(parent, [view]);
  }
  const descendants: DoneJanitorAgentView[] = [];
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const next = queue.shift()!;
    for (const child of childrenByParent.get(next) ?? []) {
      // A label cycle would otherwise loop forever.
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      descendants.push(child);
      queue.push(child.id);
    }
  }
  return descendants;
}

/**
 * Why the tree rooted at `root` is not finished. Archiving a root cascades to its children, so
 * every descendant has to pass the same checks — a leader whose subagents are still working is
 * not done however quiet it is, and a pinned child pins the whole tree.
 */
export function treeNotDoneReason(
  root: DoneJanitorAgentView,
  views: readonly DoneJanitorAgentView[],
  nowMs: number,
  quietMs: number | null,
  /** Descendants are never the ones asked, so their quiet check always applies. */
  descendantQuietMs: number,
): NotDoneReason | null {
  const own = agentNotDoneReason(root, nowMs, quietMs);
  if (own) return own;
  for (const descendant of listDescendants(root.id, views)) {
    const reason = agentNotDoneReason(descendant, nowMs, descendantQuietMs);
    if (reason) return `subagent ${descendant.id} ${reason}`;
  }
  return null;
}

/** The roots a sweep considers: unarchived, not internal, and with no parent. */
export function listRootCandidates(views: readonly DoneJanitorAgentView[]): DoneJanitorAgentView[] {
  const known = new Set(views.filter((view) => !view.archived).map((view) => view.id));
  return views.filter((view) => {
    if (view.archived || view.internal) return false;
    const parent = parentOf(view);
    // A child whose parent is archived or gone has no root left that would cascade to it, so it
    // is its own root. A child whose parent is active is decided with its parent's tree.
    return parent === null || !known.has(parent);
  });
}

// ─── The question ────────────────────────────────────────────────────────────────────────────

export const DONE_ANSWER = "DONE";
export const NOT_DONE_ANSWER = "NOT_DONE";

/** The body the janitor sends, before the `<paseo-system>` envelope. Kept short: it is a turn. */
export function buildDoneQuestion(quietForMs: number): string {
  return [
    `Automated check from the Paseo daemon, not from a person. You have been idle for ${formatDuration(quietForMs)}.`,
    "Is your task completely finished, with nothing left to do in this conversation? If you answer",
    `${DONE_ANSWER}, you will be archived and your worktree may be deleted once its work is verified`,
    "committed and merged or pushed.",
    `Reply with exactly one word and use no tools: ${DONE_ANSWER} if finished, ${NOT_DONE_ANSWER} otherwise.`,
    `If you are unsure, or are waiting on anything or anyone, reply ${NOT_DONE_ANSWER}.`,
  ].join("\n");
}

/**
 * Strict: the whole reply, trimmed, must be `DONE` with at most one trailing period. Anything
 * else — `NOT_DONE`, "Done!", "DONE, but…", a question back, markdown, silence — is not done.
 * An agent that wants to be archived can say so in one word; one that says more has something
 * to say, and that is a reason to leave it.
 */
export function isDoneAnswer(reply: string | null | undefined): boolean {
  if (typeof reply !== "string") return false;
  return /^DONE\.?$/.test(reply.trim());
}

// ─── Memory between sweeps ───────────────────────────────────────────────────────────────────

export type ProbeOutcome =
  | "done"
  | "not-done"
  | "no-answer"
  | "permission"
  | "failed"
  | "changed-after-answer";

export interface ProbeRecord {
  askedAtMs: number;
  outcome: ProbeOutcome;
  /** Consecutive outcomes other than `done`. Drives the backoff below. */
  consecutiveNegatives: number;
}

export type DoneJanitorMemory = Map<string, ProbeRecord>;

const MAX_BACKOFF_MULTIPLIER = 8;

/**
 * When an agent that did not say `done` may be asked again. Its own answer is activity, so the
 * quiet check alone already waits one full quiet period; this doubles the spacing per consecutive
 * negative, capped at 8×, so an agent that keeps saying "not yet" is asked less and less often.
 * In memory only: a daemon restart resets the backoff, never the quiet period.
 */
export function nextAskAllowedAtMs(record: ProbeRecord | undefined, quietMs: number): number {
  if (!record) return Number.NEGATIVE_INFINITY;
  const multiplier = Math.min(
    2 ** Math.max(record.consecutiveNegatives - 1, 0),
    MAX_BACKOFF_MULTIPLIER,
  );
  return record.askedAtMs + quietMs * multiplier;
}

export function recordProbeOutcome(
  memory: DoneJanitorMemory,
  agentId: string,
  askedAtMs: number,
  outcome: ProbeOutcome,
): ProbeRecord {
  const previous = memory.get(agentId);
  const record: ProbeRecord = {
    askedAtMs,
    outcome,
    consecutiveNegatives: outcome === "done" ? 0 : (previous?.consecutiveNegatives ?? 0) + 1,
  };
  memory.set(agentId, record);
  return record;
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}
