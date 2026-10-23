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

/**
 * Same rule as `selectLastPrompt`, generalized to the whole ordered list
 * instead of only the newest -- the prompt navigator's candidate set.
 */
export function selectRecentPrompts(items: readonly StreamItem[]): UserMessageItem[] {
  const prompts: UserMessageItem[] = [];
  for (const item of items) {
    if (item.kind === "user_message") prompts.push(item);
  }
  return prompts;
}

export interface StickyLastPromptState {
  prompt: UserMessageItem | null;
}

export interface StickyLastPromptSource {
  subscribe: (listener: () => void) => () => void;
  getState: () => StickyLastPromptState;
}

export interface StickyLastPromptPublisher extends StickyLastPromptSource {
  publish: (state: StickyLastPromptState) => void;
}

export const NO_STICKY_PROMPT: StickyLastPromptState = { prompt: null };

function stickyLastPromptStatesEqual(
  left: StickyLastPromptState,
  right: StickyLastPromptState,
): boolean {
  return left.prompt?.id === right.prompt?.id;
}

/**
 * Publishing outside React, like `chat-outline`'s active-prompt publisher,
 * lets only the bar itself re-render on a new prompt instead of the whole
 * transcript.
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
