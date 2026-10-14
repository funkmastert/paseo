import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";

export interface TimelineSyncCursor {
  epoch: string;
  seq: number;
}

export interface ProjectedTimelineTailFetchPlan {
  direction: "tail";
  limit: number;
  projection: "projected";
}

export interface ProjectedTimelineAfterFetchPlan {
  direction: "after";
  cursor: TimelineSyncCursor;
  limit: number;
  projection: "projected";
}

export interface ProjectedTimelineBeforeFetchPlan {
  direction: "before";
  cursor: TimelineSyncCursor;
  limit: number;
  projection: "projected";
}

export type ProjectedTimelineFetchPlan =
  | ProjectedTimelineTailFetchPlan
  | ProjectedTimelineAfterFetchPlan
  | ProjectedTimelineBeforeFetchPlan;

export type ProjectedTimelineForwardFetchPlan =
  | ProjectedTimelineTailFetchPlan
  | ProjectedTimelineAfterFetchPlan;

export function planTimelineCatchUpAfter(cursor: TimelineSyncCursor) {
  return {
    direction: "after",
    cursor,
    limit: TIMELINE_FETCH_PAGE_SIZE,
    projection: "projected",
  } as const;
}

export function planTimelineTailFetch() {
  return {
    direction: "tail",
    limit: TIMELINE_FETCH_PAGE_SIZE,
    projection: "projected",
  } as const;
}

export function planTimelineResumeFetch(
  range: { epoch: string; endSeq: number } | null | undefined,
): ProjectedTimelineForwardFetchPlan {
  return range
    ? planTimelineCatchUpAfter({ epoch: range.epoch, seq: range.endSeq })
    : planTimelineTailFetch();
}

export function planTimelineOlderFetch(cursor: TimelineSyncCursor) {
  return {
    direction: "before",
    cursor,
    limit: TIMELINE_FETCH_PAGE_SIZE,
    projection: "projected",
  } as const;
}

export interface ProjectedTimelineStartFetchPlan {
  direction: "after";
  limit: number;
  projection: "projected";
  mergeWindow: true;
}

// No cursor: the server defaults an uncursored "after" fetch to baseSeq 0, so this
// reaches the session's true earliest rows in one request instead of walking
// backward page by page from wherever the client's window currently starts.
// `mergeWindow` keeps whatever is already loaded near the live tail rather than
// discarding it, matching how `planTimelinePromptJump` jumps to an older message.
export function planTimelineStartFetch(): ProjectedTimelineStartFetchPlan {
  return {
    direction: "after",
    limit: TIMELINE_FETCH_PAGE_SIZE,
    projection: "projected",
    mergeWindow: true,
  } as const;
}

export function planTimelinePromptJump(target: TimelineSyncCursor) {
  const newerRows = Math.floor(TIMELINE_FETCH_PAGE_SIZE / 2);
  return {
    direction: "before",
    cursor: { epoch: target.epoch, seq: target.seq + newerRows + 1 },
    limit: TIMELINE_FETCH_PAGE_SIZE,
    projection: "projected",
    mergeWindow: true,
  } as const;
}

export function isTimelineCatchUpComplete(input: {
  direction: "tail" | "before" | "after";
  hasNewer: boolean;
  error: string | null;
}): boolean {
  if (input.error) {
    return false;
  }

  return input.direction !== "after" || !input.hasNewer;
}

export function isTimelineResumeSnapshotAuthoritative(input: {
  direction: "tail" | "before" | "after";
  hasNewer: boolean;
  error: string | null;
}): boolean {
  if (input.error || input.direction === "before") return false;
  return input.direction === "tail" || !input.hasNewer;
}
