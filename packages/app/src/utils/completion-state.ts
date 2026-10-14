import type { CompletionState } from "@getpaseo/protocol/agent-labels";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

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
