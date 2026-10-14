import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
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
  /** The actively streaming turn's not-yet-committed items. Native finds `selectLastPrompt`
   * purely from `items`, and the user's own prompt always commits to `items` before the agent
   * starts responding, so this exists only to keep the input shape identical to web's. */
  head?: readonly StreamItem[];
}

export interface UseStickyLastPromptResult {
  source: StickyLastPromptSource;
  /** No-op on native: there is no reading-position signal. */
  reportReadingPosition: (rowId: string | null) => void;
  /** Feed the native transcript's FlatList viewability callback. */
  reportVisibleRowIds: (visibleRowIds: ReadonlySet<string>) => void;
}

function noopReportReadingPosition(_rowId: string | null): void {}

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

  // useLayoutEffect, not useEffect: StickyPromptOverlay subscribes to `publisher` directly via
  // useSyncExternalStore, and that subscription forces the overlay to re-render on a publish
  // regardless of memo (memo only bails out parent-driven re-renders, not a subscribed store's
  // own notify). A layout effect's publish is flushed synchronously before the browser paints;
  // a passive effect's publish lands only after that frame already painted, which is the flash
  // this is fixing (mirrors use-chat-outline.ts's `activePrompt.publish(null)` reset keyed on
  // agentId, upgraded here because the overlay is now memoized -- see sticky-prompt-fixes.json
  // finding 2).
  useLayoutEffect(() => {
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

  return useMemo(
    () => ({
      source: publisher,
      reportReadingPosition: noopReportReadingPosition,
      reportVisibleRowIds,
    }),
    [publisher, reportVisibleRowIds],
  );
}
