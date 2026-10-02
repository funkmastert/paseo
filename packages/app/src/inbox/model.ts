import {
  HUMAN_WORK_ITEM_OWNER,
  OPEN_WORK_ITEM_STATES,
  type WorkItem,
  type WorkItemState,
} from "@getpaseo/protocol/coordination/queue-schemas";
import type { StreamEntry, StreamUrgency } from "@getpaseo/protocol/coordination/stream-schemas";

// OR-A5 / OR-H1: the Inbox splits into "Human requests" (open items owned by `human`) and
// "Updates" (the coordination stream, newest first). Pure selectors and row builders so the
// screens stay thin. See docs/work-queue.md#inbox.

/** A work item tagged with the host it came from, for a flat cross-host list. */
export interface AggregatedWorkItem extends WorkItem {
  serverId: string;
  serverName: string;
}

/** A stream entry tagged with the host it came from. */
export interface AggregatedStreamEntry extends StreamEntry {
  serverId: string;
  serverName: string;
}

/**
 * Open items owned by `human`, oldest first: the oldest unhandled request should not be buried
 * by newer ones arriving behind it.
 */
export function selectHumanRequests(items: readonly AggregatedWorkItem[]): AggregatedWorkItem[] {
  return items
    .filter(
      (item) =>
        item.owner === HUMAN_WORK_ITEM_OWNER &&
        (OPEN_WORK_ITEM_STATES as readonly WorkItemState[]).includes(item.state),
    )
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/**
 * The coordination stream, newest first. Every entry renders regardless of `type` — an
 * unrecognized kind still carries a `summary`, so nothing is silently dropped.
 */
export function selectUpdates(entries: readonly AggregatedStreamEntry[]): AggregatedStreamEntry[] {
  return [...entries].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export interface HumanRequestRow {
  id: string;
  serverId: string;
  serverName: string;
  title: string;
  owner: string;
  creator: string | null;
  state: WorkItemState;
  ageMs: number;
  closureReason: string | null;
  closureTarget: string | null;
  deliveryFailed: boolean;
}

/** The nine-field phone-friendly row (docs/work-queue.md#inbox), reduced to what fits a compact
 * row: title, owner/creator, state, age, closure/target when closed, delivery failure. */
export function buildHumanRequestRow(item: AggregatedWorkItem, nowMs: number): HumanRequestRow {
  return {
    id: item.id,
    serverId: item.serverId,
    serverName: item.serverName,
    title: item.title,
    owner: item.owner,
    creator: item.createdBy ?? null,
    state: item.state,
    ageMs: Math.max(0, nowMs - Date.parse(item.createdAt)),
    closureReason: item.closure?.reason ?? null,
    closureTarget: item.closure?.target ?? null,
    deliveryFailed: item.delivery?.state === "failed",
  };
}

export interface UpdateRow {
  id: string;
  serverId: string;
  serverName: string;
  type: string;
  summary: string;
  source: string;
  subject: string | null;
  urgency: StreamUrgency | null;
  ageMs: number;
}

export function buildUpdateRow(entry: AggregatedStreamEntry, nowMs: number): UpdateRow {
  return {
    id: entry.id,
    serverId: entry.serverId,
    serverName: entry.serverName,
    type: entry.type,
    summary: entry.summary,
    source: entry.source,
    subject: entry.subject ?? null,
    urgency: entry.urgency ?? null,
    ageMs: Math.max(0, nowMs - Date.parse(entry.at)),
  };
}
