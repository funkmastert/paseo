import {
  WORK_ITEM_CLOSURE_REASONS,
  type WorkItemClosure,
  type WorkItemClosureReason,
  type WorkItemState,
} from "@getpaseo/protocol/coordination/queue-schemas";

// The closure marker: how an agent's final message closes the items it owns. One line per item:
//
//   queue: <itemId> <state> [<reason>[=<target>]]
//
// e.g. `queue: wi_123 done no-follow-on`, `queue: wi_123 blocked blocked_on=wi_456`. Any line
// that starts with `queue:` and does not fit this grammar is malformed and changes nothing; a line
// that does not start with `queue:` is ordinary prose. See docs/work-queue.md#closure-marker.

export const CLOSURE_MARKER_PREFIX = "queue:";

const MARKER_STATES = ["done", "blocked", "failed", "denied", "canceled"] as const;
type MarkerState = (typeof MARKER_STATES)[number] & WorkItemState;

export interface ClosureMarker {
  itemId: string;
  to: MarkerState;
  closure?: WorkItemClosure;
  line: string;
}

export interface MalformedClosureMarker {
  line: string;
  problem: string;
}

export interface ParsedClosureMarkers {
  markers: ClosureMarker[];
  malformed: MalformedClosureMarker[];
}

const MARKER_PATTERN = /^queue: (\S+) (\S+)(?: (\S+))?$/;

export function parseClosureMarkers(text: string): ParsedClosureMarkers {
  const markers: ClosureMarker[] = [];
  const malformed: MalformedClosureMarker[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(CLOSURE_MARKER_PREFIX)) continue;
    const parsed = parseLine(line);
    if ("problem" in parsed) malformed.push(parsed);
    else markers.push(parsed);
  }
  // Two markers for one item contradict or repeat each other; neither is trusted.
  const counts = new Map<string, number>();
  for (const marker of markers) counts.set(marker.itemId, (counts.get(marker.itemId) ?? 0) + 1);
  const unique: ClosureMarker[] = [];
  for (const marker of markers) {
    if ((counts.get(marker.itemId) ?? 0) > 1) {
      malformed.push({ line: marker.line, problem: `more than one marker for ${marker.itemId}` });
    } else {
      unique.push(marker);
    }
  }
  return { markers: unique, malformed };
}

function parseLine(line: string): ClosureMarker | MalformedClosureMarker {
  const match = MARKER_PATTERN.exec(line);
  if (!match) {
    return { line, problem: "expected `queue: <itemId> <state> [<reason>[=<target>]]`" };
  }
  const [, itemId, state, closureToken] = match;
  if (!isMarkerState(state)) {
    return { line, problem: `state must be one of ${MARKER_STATES.join(", ")}` };
  }
  if (!closureToken) return { itemId, to: state, line };
  const separator = closureToken.indexOf("=");
  const reason = separator === -1 ? closureToken : closureToken.slice(0, separator);
  const target = separator === -1 ? undefined : closureToken.slice(separator + 1);
  if (!isClosureReason(reason)) {
    return { line, problem: `closure reason must be one of ${WORK_ITEM_CLOSURE_REASONS.join(", ")}` };
  }
  if (target === "") return { line, problem: "empty target after `=`" };
  return {
    itemId,
    to: state,
    closure: target === undefined ? { reason } : { reason, target },
    line,
  };
}

function isMarkerState(value: string): value is MarkerState {
  return (MARKER_STATES as readonly string[]).includes(value);
}

function isClosureReason(value: string): value is WorkItemClosureReason {
  return (WORK_ITEM_CLOSURE_REASONS as readonly string[]).includes(value);
}
