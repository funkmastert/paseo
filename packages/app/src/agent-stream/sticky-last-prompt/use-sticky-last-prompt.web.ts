import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { StreamItem } from "@/types/stream";
import {
  createStickyLastPromptPublisher,
  isLastPromptAboveViewport,
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
  /** Feed the web transcript's existing reading-position signal (`onReadingPositionChange`). */
  reportReadingPosition: (rowId: string | null) => void;
  /** No-op on web: visibility comes from reading position instead. */
  reportVisibleRowIds: (visibleRowIds: ReadonlySet<string>) => void;
}

function noopReportVisibleRowIds(_visibleRowIds: ReadonlySet<string>): void {}

/**
 * Derives sticky-bar visibility from the same reading-position signal the chat
 * outline already consumes, instead of adding a second scroll listener. See
 * the sticky-last-prompt plan's Key Technical Decisions for why this needs no
 * virtualizer-offset math: the reading-position row's order relative to the
 * last prompt is enough.
 */
export function useStickyLastPrompt(input: UseStickyLastPromptInput): UseStickyLastPromptResult {
  const publisher = useMemo(() => createStickyLastPromptPublisher(), []);
  const itemsRef = useRef(input.items);
  itemsRef.current = input.items;
  const readingPositionRowIdRef = useRef<string | null>(null);

  const recomputeAndPublish = useStableEvent(() => {
    const items = itemsRef.current;
    const lastPrompt = selectLastPrompt(items);
    const barVisible = lastPrompt
      ? isLastPromptAboveViewport({
          lastPromptId: lastPrompt.id,
          readingPositionRowId: readingPositionRowIdRef.current,
          items,
        })
      : false;
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
    readingPositionRowIdRef.current = null;
    publisher.publish(NO_STICKY_PROMPT);
  }, [publisher, input.agentId]);

  // A new turn (or the first prompt arriving) changes which row is "the last prompt," so this
  // must recompute even if the reading position itself hasn't changed.
  useEffect(() => {
    recomputeAndPublish();
  }, [input.items, recomputeAndPublish]);

  const reportReadingPosition = useStableEvent((rowId: string | null) => {
    readingPositionRowIdRef.current = rowId;
    recomputeAndPublish();
  });

  return useMemo(
    () => ({
      source: publisher,
      reportReadingPosition,
      reportVisibleRowIds: noopReportVisibleRowIds,
    }),
    [publisher, reportReadingPosition],
  );
}
