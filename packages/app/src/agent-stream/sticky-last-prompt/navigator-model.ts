import type { UserMessageItem } from "@/types/stream";

export interface PromptNavigatorSelection {
  prompts: UserMessageItem[];
  selectedIndex: number;
}

export type PromptNavigatorStepDirection = "back" | "forward";

export const EMPTY_SELECTION: PromptNavigatorSelection = { prompts: [], selectedIndex: -1 };

/** Selects the newest prompt, or the empty selection when there are none. */
export function resolveInitialSelection(prompts: UserMessageItem[]): PromptNavigatorSelection {
  if (prompts.length === 0) return EMPTY_SELECTION;
  return { prompts, selectedIndex: prompts.length - 1 };
}

export function canStepBack(selection: PromptNavigatorSelection): boolean {
  return selection.selectedIndex > 0;
}

export function canStepForward(selection: PromptNavigatorSelection): boolean {
  return selection.selectedIndex >= 0 && selection.selectedIndex < selection.prompts.length - 1;
}

export function stepSelection(
  selection: PromptNavigatorSelection,
  direction: PromptNavigatorStepDirection,
): PromptNavigatorSelection {
  if (direction === "back") {
    if (!canStepBack(selection)) return selection;
    return { ...selection, selectedIndex: selection.selectedIndex - 1 };
  }
  if (!canStepForward(selection)) return selection;
  return { ...selection, selectedIndex: selection.selectedIndex + 1 };
}

/** 1-based "selected/total" label, or null when there's nothing to navigate. */
export function resolvePositionLabel(selection: PromptNavigatorSelection): string | null {
  if (selection.selectedIndex < 0 || selection.prompts.length === 0) return null;
  return `${selection.selectedIndex + 1}/${selection.prompts.length}`;
}

export function resolveSelectedPrompt(selection: PromptNavigatorSelection): UserMessageItem | null {
  return selection.prompts[selection.selectedIndex] ?? null;
}

/**
 * Tells "a new prompt arrived" (reset to newest) apart from "older history
 * loaded, growing the list from the front" (keep the same prompt selected,
 * index shifts). Compares by the previously-selected prompt's id, since
 * `loadOlder` shifts every earlier index when it prepends older prompts.
 */
export function reconcileSelectionOnNewPrompts(
  previous: PromptNavigatorSelection,
  nextPrompts: UserMessageItem[],
): PromptNavigatorSelection {
  if (nextPrompts.length === 0) return EMPTY_SELECTION;

  const previousNewest = previous.prompts.at(-1) ?? null;
  const nextNewest = nextPrompts.at(-1) ?? null;
  if (previousNewest?.id !== nextNewest?.id) {
    return resolveInitialSelection(nextPrompts);
  }

  if (previous.prompts === nextPrompts) return previous;

  const selectedPrompt = resolveSelectedPrompt(previous);
  if (selectedPrompt === null) return resolveInitialSelection(nextPrompts);

  const nextIndex = nextPrompts.findIndex((prompt) => prompt.id === selectedPrompt.id);
  if (nextIndex === -1) return resolveInitialSelection(nextPrompts);

  // `combinedItems` gets a new array identity on every streaming tick even when no user
  // message changed, so `nextPrompts` is a fresh array nearly every call. Same newest id (above),
  // same length, and the selected prompt landing at the same index together mean nothing
  // actually changed -- stream items are append-only, so that combination can't happen from a
  // real edit. Returning `previous` here (not an equivalent new object) is what lets
  // use-prompt-navigator.ts's `next !== selectionRef.current` check skip the re-render.
  if (nextIndex === previous.selectedIndex && nextPrompts.length === previous.prompts.length) {
    return previous;
  }

  return { prompts: nextPrompts, selectedIndex: nextIndex };
}
