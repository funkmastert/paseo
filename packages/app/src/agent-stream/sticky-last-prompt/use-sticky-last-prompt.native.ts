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
  /** The actively streaming turn's not-yet-committed items. Native finds `selectLastPrompt`
   * purely from `items`, and the user's own prompt always commits to `items` before the agent
   * starts responding, so this exists only to keep the input shape identical to web's. */
  head?: readonly StreamItem[];
}

export interface UseStickyLastPromptResult {
  source: StickyLastPromptSource;
}

export function useStickyLastPrompt(input: UseStickyLastPromptInput): UseStickyLastPromptResult {
  const publisher = useMemo(() => createStickyLastPromptPublisher(), []);

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

  useEffect(() => {
    publisher.publish({ prompt: selectLastPrompt(input.items) });
  }, [input.items, publisher]);

  return useMemo(() => ({ source: publisher }), [publisher]);
}
