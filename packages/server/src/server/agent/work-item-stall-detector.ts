/**
 * Pure detection for AgentStallSweep's work-item leg (OR-D10): an open item whose owner is idle
 * and whose revision has not moved across two consecutive sweeps, and whose last transition is
 * older than a threshold. No I/O and no clock reads; the sweep passes the signals and `nowMs` in.
 * See docs/stalled-agents.md and docs/work-queue.md.
 */

export type StallItemState = "pending" | "in-progress" | "blocked";

export interface StallItemView {
  id: string;
  title: string;
  owner: string;
  state: StallItemState;
  revision: number | undefined;
  /** The item's last transition. */
  updatedAtMs: number;
}

/**
 * Sweeps the item must sit at the same revision across before it even starts the clock: a tool
 * call pausing between steps looks exactly like a stall on one reading alone.
 */
export const MIN_UNCHANGED_SWEEPS = 2;

export interface StallItemMemory {
  revision: number | undefined;
  /** Consecutive sweeps seen at this revision, this one included. */
  sweepsAtRevision: number;
  /** A finding already fired for this revision. Cleared once the item changes. */
  alreadyFound: boolean;
}

/** Folds one sweep's reading of the item's revision into its memory. */
export function recordItemObservation(
  previous: StallItemMemory | undefined,
  revision: number | undefined,
): StallItemMemory {
  if (previous && previous.revision === revision) {
    return { ...previous, sweepsAtRevision: previous.sweepsAtRevision + 1 };
  }
  // A new revision re-arms: the old finding no longer applies to work that has moved.
  return { revision, sweepsAtRevision: 1, alreadyFound: false };
}

/** Null when the item is a stall finding this sweep should act on; otherwise why it is not. */
export function notStalledItemReason(input: {
  item: StallItemView;
  /** False excludes a human owner and a cross-host owner the daemon cannot resolve locally. */
  ownerIsLocalAgent: boolean;
  /** The owner's own lifecycle: occupied with a turn, a pending permission, or a child running. */
  ownerIdle: boolean;
  memory: StallItemMemory;
  nowMs: number;
  thresholdMs: number;
}): string | null {
  const { item, ownerIsLocalAgent, ownerIdle, memory, nowMs, thresholdMs } = input;
  if (item.state !== "in-progress") return `is ${item.state}, not in-progress`;
  if (!ownerIsLocalAgent) return "owner is human or not a local agent";
  if (!ownerIdle) return "owner is busy";
  if (memory.sweepsAtRevision < MIN_UNCHANGED_SWEEPS) {
    return `seen unchanged for ${memory.sweepsAtRevision} sweep(s) of ${MIN_UNCHANGED_SWEEPS} required`;
  }
  const unchangedForMs = nowMs - item.updatedAtMs;
  if (unchangedForMs < thresholdMs) {
    return `unchanged for ${Math.floor(unchangedForMs / 60_000)}m of ${Math.floor(thresholdMs / 60_000)}m required`;
  }
  if (memory.alreadyFound) {
    return "already nudged this revision; re-arms once the item changes";
  }
  return null;
}

/** The one nudge a stalled item's owner gets, before its envelope. */
export function buildItemStallNudgePrompt(input: {
  item: Pick<StallItemView, "id" | "title">;
  unchangedForMs: number;
}): string {
  const minutes = Math.floor(input.unchangedForMs / 60_000);
  return [
    `The Paseo daemon found work-queue item ${input.item.id} ("${input.item.title}") still ` +
      `in-progress and assigned to you, unchanged for ${minutes} minutes.`,
    "If it is done, blocked, or no longer yours, close it from your final message with a " +
      `closure marker (for example \`queue: ${input.item.id} done no-follow-on\` or ` +
      `\`queue: ${input.item.id} blocked blocked_on=<id>\`), or hand it off with the queue tools.`,
    "If you are still working it, continue; this is only a check.",
  ].join("\n\n");
}
