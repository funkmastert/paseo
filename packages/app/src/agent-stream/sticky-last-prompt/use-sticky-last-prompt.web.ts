import { useEffect, useMemo, useRef } from "react";
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

  // Reset before the items-driven recompute below runs, so a pane that switches agents without
  // remounting never paints the previous agent's prompt first (mirrors use-chat-outline.ts's
  // `activePrompt.publish(null)` reset keyed on agentId).
  useEffect(() => {
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

  return { source: publisher, reportReadingPosition, reportVisibleRowIds: () => undefined };
}
