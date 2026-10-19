import { useEffect, useLayoutEffect, useMemo } from "react";
import type { StreamItem } from "@/types/stream";
import {
  createStickyLastPromptPublisher,
  NO_STICKY_PROMPT,
  selectLastPrompt,
  type StickyLastPromptSource,
} from "./model";

export interface UseStickyLastPromptInput {
  agentId: string;
  items: readonly StreamItem[];
  /** The actively streaming turn's not-yet-committed items (rendered as the live head), not
   * part of `items` yet -- the last prompt can be the first thing in a turn still arriving. */
  head?: readonly StreamItem[];
}

export interface UseStickyLastPromptResult {
  source: StickyLastPromptSource;
}

const EMPTY_STREAM_ITEMS: readonly StreamItem[] = [];

export function useStickyLastPrompt(input: UseStickyLastPromptInput): UseStickyLastPromptResult {
  const publisher = useMemo(() => createStickyLastPromptPublisher(), []);
  const head = input.head ?? EMPTY_STREAM_ITEMS;
  const combinedItems = useMemo(
    () => (head.length > 0 ? [...input.items, ...head] : input.items),
    [input.items, head],
  );

  // useLayoutEffect, not useEffect: StickyPromptOverlay subscribes to `publisher` directly via
  // useSyncExternalStore, and that subscription forces the overlay to re-render on a publish
  // regardless of memo (memo only bails out parent-driven re-renders, not a subscribed store's
  // own notify). A layout effect's publish is flushed synchronously before the browser paints;
  // a passive effect's publish lands only after that frame already painted, which is the flash
  // this is fixing (mirrors use-chat-outline.ts's `activePrompt.publish(null)` reset keyed on
  // agentId, upgraded here because the overlay is now memoized -- see sticky-prompt-fixes.json
  // finding 2).
  useLayoutEffect(() => {
    publisher.publish(NO_STICKY_PROMPT);
  }, [publisher, input.agentId]);

  // A new turn (or the first prompt arriving) changes which row is "the last prompt."
  useEffect(() => {
    publisher.publish({ prompt: selectLastPrompt(combinedItems) });
  }, [combinedItems, publisher]);

  return useMemo(() => ({ source: publisher }), [publisher]);
}
