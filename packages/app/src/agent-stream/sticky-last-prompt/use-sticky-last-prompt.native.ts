import { useEffect, useMemo, useRef } from "react";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { StreamItem } from "@/types/stream";
import {
  createSeenThenLeftTracker,
  createStickyLastPromptPublisher,
  NO_STICKY_PROMPT,
  selectLastPrompt,
  type StickyLastPromptSource,
} from "./model";

export interface UseStickyLastPromptInput {
  agentId: string;
  items: readonly StreamItem[];
}

export interface UseStickyLastPromptResult {
  source: StickyLastPromptSource;
  /** No-op on native: there is no reading-position signal. */
  reportReadingPosition: (rowId: string | null) => void;
  /** Feed the native transcript's FlatList viewability callback. */
  reportVisibleRowIds: (visibleRowIds: ReadonlySet<string>) => void;
}

/**
 * Native has no reading-position equivalent, so visibility comes from
 * FlatList's own viewability tracking via a "seen then left" state machine
 * (see model.ts) instead of inverted-list offset math.
 */
export function useStickyLastPrompt(input: UseStickyLastPromptInput): UseStickyLastPromptResult {
  const publisher = useMemo(() => createStickyLastPromptPublisher(), []);
  const tracker = useMemo(() => createSeenThenLeftTracker(), []);
  const lastVisibleRowIdsRef = useRef<ReadonlySet<string>>(new Set());

  const recomputeAndPublish = useStableEvent(() => {
    const lastPrompt = selectLastPrompt(input.items);
    if (!lastPrompt) {
      publisher.publish({ prompt: null, barVisible: false });
      return;
    }
    const isCurrentlyVisible = lastVisibleRowIdsRef.current.has(lastPrompt.id);
    const barVisible = tracker.update(lastPrompt.id, isCurrentlyVisible);
    publisher.publish({ prompt: lastPrompt, barVisible });
  });

  // Reset before the items-driven recompute below runs, so a pane that switches agents without
  // remounting never paints the previous agent's prompt first (mirrors use-chat-outline.ts's
  // `activePrompt.publish(null)` reset keyed on agentId).
  useEffect(() => {
    lastVisibleRowIdsRef.current = new Set();
    publisher.publish(NO_STICKY_PROMPT);
  }, [publisher, input.agentId]);

  useEffect(() => {
    recomputeAndPublish();
  }, [input.items, recomputeAndPublish]);

  const reportVisibleRowIds = useStableEvent((visibleRowIds: ReadonlySet<string>) => {
    lastVisibleRowIdsRef.current = visibleRowIds;
    recomputeAndPublish();
  });

  return { source: publisher, reportReadingPosition: () => undefined, reportVisibleRowIds };
}
