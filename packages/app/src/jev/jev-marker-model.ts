import type { JevDecisionRecord, JevStatus } from "@getpaseo/protocol/jev/rpc-schemas";
import type { JevMarkerItem } from "@/types/stream";
import {
  formatJevCost,
  jevFeatureLabel,
  parseJevDecisionAt,
  subjectLabelFor,
  tagFor,
} from "./jev-decisions-model";
import type { JevDecisionLine } from "./jev-decisions-model";

/**
 * Oldest first, unlike the popover's `buildJevDecisionsView` (newest first, capped at 8): a
 * marker has to cover every decision across the whole visible history, not just the latest few.
 */
export function buildJevMarkerLines(
  decisions: readonly JevDecisionRecord[],
  status: JevStatus | null,
): JevDecisionLine[] {
  const provider = status?.provider ?? null;
  const lines: JevDecisionLine[] = [];
  for (const record of decisions) {
    const at = parseJevDecisionAt(record.at);
    if (!at) continue;
    lines.push({
      key: record.callId,
      featureId: record.feature,
      feature: jevFeatureLabel(record.feature),
      question: record.question,
      verdict: record.verdict,
      action: record.action,
      tag: tagFor(record, status),
      cost: formatJevCost(record.costUsd, provider),
      at,
      summary: record.summary ?? null,
      detail: record.detail ?? null,
      subjectLabel: subjectLabelFor(record),
    });
  }
  lines.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
  // The newest only: a leader with a wide fan-out gets its children's decisions too, and the
  // timeline is for reading the conversation, not a full log (the badge's list has every one).
  return lines.length > JEV_MARKER_LINES_MAX ? lines.slice(-JEV_MARKER_LINES_MAX) : lines;
}

/** Decisions placed in one agent's timeline, newest kept. */
export const JEV_MARKER_LINES_MAX = 40;

/**
 * Splits marker lines across the tail/head boundary so a decision is placed exactly once. A line
 * timestamped at or before the boundary (the last tail item) belongs in the tail; a `null`
 * boundary means the tail is empty, so everything goes to the tail instead of the live head — a
 * decision made before the very first row belongs at the top of history, not in the ephemeral
 * live-head segment.
 */
export function splitJevMarkerLines(
  lines: readonly JevDecisionLine[],
  tailBoundaryMs: number | null,
): { forTail: JevDecisionLine[]; forHead: JevDecisionLine[] } {
  if (tailBoundaryMs === null) {
    return { forTail: [...lines], forHead: [] };
  }
  const forTail: JevDecisionLine[] = [];
  const forHead: JevDecisionLine[] = [];
  for (const line of lines) {
    if (line.at === null || line.at.getTime() <= tailBoundaryMs) {
      forTail.push(line);
    } else {
      forHead.push(line);
    }
  }
  return { forTail, forHead };
}

function createJevMarkerItem(group: JevDecisionLine[]): JevMarkerItem {
  const last = group[group.length - 1];
  return {
    kind: "jev_marker",
    // Keyed on the group's first decision: a group grows by appending, so the id (the React row
    // key) survives a new decision landing in the same gap, and an open tooltip stays open.
    id: `jev_marker:${group[0].key}`,
    timestamp: last.at ?? new Date(0),
    lines: group,
  };
}

/**
 * Interleaves JEV decision markers into a timestamp-ordered item list, collapsing every decision
 * that lands in the same gap into one marker. Returns `items` itself, unchanged, when there is
 * nothing to place — an agent with no JEV activity never gets a new array identity, which keeps
 * every cache keyed on that identity (`buildAgentStreamRenderModel`, `layoutStream`) cold.
 */
export function placeJevMarkers<T extends { id: string; timestamp: Date }>(
  items: readonly T[],
  lines: readonly JevDecisionLine[],
): Array<T | JevMarkerItem> {
  if (lines.length === 0) {
    return items as Array<T | JevMarkerItem>;
  }
  const result: Array<T | JevMarkerItem> = [];
  let lineIndex = 0;
  let pendingGroup: JevDecisionLine[] = [];
  const flushGroup = () => {
    if (pendingGroup.length === 0) return;
    result.push(createJevMarkerItem(pendingGroup));
    pendingGroup = [];
  };
  for (const item of items) {
    while (
      lineIndex < lines.length &&
      (lines[lineIndex].at?.getTime() ?? 0) <= item.timestamp.getTime()
    ) {
      pendingGroup.push(lines[lineIndex]);
      lineIndex += 1;
    }
    flushGroup();
    result.push(item);
  }
  while (lineIndex < lines.length) {
    pendingGroup.push(lines[lineIndex]);
    lineIndex += 1;
  }
  flushGroup();
  return result;
}
