import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

export const COMPLETION_LABEL = "paseo.completion";
export const COMPLETION_NOTE_LABEL = "paseo.completion-note";

export const COMPLETION_STATES = ["ready-to-merge", "done"] as const;
export type CompletionState = (typeof COMPLETION_STATES)[number];

const COMPLETION_NOTE_MAX_LENGTH = 200;

function isCompletionState(value: unknown): value is CompletionState {
  return typeof value === "string" && (COMPLETION_STATES as readonly string[]).includes(value);
}

export function getCompletionStateFromLabels(
  labels: Record<string, unknown> | null | undefined,
): CompletionState | null {
  const value = labels?.[COMPLETION_LABEL];
  return isCompletionState(value) ? value : null;
}

export function getCompletionNoteFromLabels(
  labels: Record<string, unknown> | null | undefined,
): string | null {
  const value = labels?.[COMPLETION_NOTE_LABEL];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, COMPLETION_NOTE_MAX_LENGTH) : null;
}

/**
 * Which completion icon a row shows, if any. A completion label only means something once the
 * row has gone fully quiet — needs_input/failed/attention/running are all buckets other than
 * "done" and win outright, which is also how a label that arrived while the agent was still busy
 * gets ignored until the daemon clears it on the next human prompt.
 */
export function resolveRowCompletionIndicator(input: {
  bucket: SidebarStateBucket;
  completionState: CompletionState | null;
}): CompletionState | null {
  if (input.bucket !== "done") {
    return null;
  }
  return input.completionState;
}
