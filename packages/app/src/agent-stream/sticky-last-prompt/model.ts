import type { StreamItem, UserMessageItem } from "@/types/stream";

/**
 * The daemon never dispatches synthetic prompts (heartbeats, schedule fires,
 * `<paseo-system>` notes, refocus restatements) to clients as timeline items,
 * so the last `user_message` in an agent's own timeline is always the last
 * real instruction it was given, including a child agent's delegated prompt.
 */
export function selectLastPrompt(items: readonly StreamItem[]): UserMessageItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "user_message") return item;
  }
  return null;
}

export interface LastPromptVisibilityInput {
  lastPromptId: string;
  readingPositionRowId: string | null;
  items: readonly StreamItem[];
}

/**
 * The web transcript reports which row sits at the top of the viewport on
 * every scroll change. The last prompt has scrolled above the viewport only
 * once that reported row comes after it in timeline order.
 */
export function isLastPromptAboveViewport(input: LastPromptVisibilityInput): boolean {
  const { lastPromptId, readingPositionRowId, items } = input;
  if (readingPositionRowId === null) return false;

  const lastPromptIndex = items.findIndex((item) => item.id === lastPromptId);
  const readingPositionIndex = items.findIndex((item) => item.id === readingPositionRowId);
  if (lastPromptIndex === -1 || readingPositionIndex === -1) return false;

  return readingPositionIndex > lastPromptIndex;
}

export interface SeenThenLeftTracker {
  update(targetId: string, isCurrentlyVisible: boolean): boolean;
}

/**
 * Native's FlatList reports only which rows are currently viewable, not a
 * single reading-position row, and the list is inverted so an offset-based
 * "above the viewport" check would depend on fragile index direction. A
 * freshly sent prompt always starts on-screen, so instead: once the target
 * row has been seen at least once, the bar shows the moment it leaves the
 * viewable set.
 */
export function createSeenThenLeftTracker(): SeenThenLeftTracker {
  let trackedId: string | null = null;
  let seen = false;

  return {
    update(targetId: string, isCurrentlyVisible: boolean): boolean {
      if (targetId !== trackedId) {
        trackedId = targetId;
        seen = isCurrentlyVisible;
        return false;
      }

      if (isCurrentlyVisible) {
        seen = true;
        return false;
      }

      return seen;
    },
  };
}

export interface StickyLastPromptState {
  prompt: UserMessageItem | null;
  barVisible: boolean;
}

export interface StickyLastPromptSource {
  subscribe: (listener: () => void) => () => void;
  getState: () => StickyLastPromptState;
}

export interface StickyLastPromptPublisher extends StickyLastPromptSource {
  publish: (state: StickyLastPromptState) => void;
}

const NO_STICKY_PROMPT: StickyLastPromptState = { prompt: null, barVisible: false };

function stickyLastPromptStatesEqual(
  left: StickyLastPromptState,
  right: StickyLastPromptState,
): boolean {
  return left.prompt?.id === right.prompt?.id && left.barVisible === right.barVisible;
}

/**
 * Visibility can recompute on every scroll frame (web) or viewability callback
 * (native). Publishing outside React, like `chat-outline`'s active-prompt
 * publisher, lets only the bar itself re-render on those updates instead of
 * the whole transcript.
 */
export function createStickyLastPromptPublisher(): StickyLastPromptPublisher {
  const listeners = new Set<() => void>();
  let state = NO_STICKY_PROMPT;
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
    publish(next) {
      if (stickyLastPromptStatesEqual(state, next)) return;
      state = next;
      for (const listener of listeners) listener();
    },
  };
}
