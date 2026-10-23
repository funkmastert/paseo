import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { StreamItem, UserMessageItem } from "@/types/stream";
import type { StreamViewportHandle } from "../strategy";
import { selectRecentPrompts } from "./model";
import {
  canStepBack as canStepBackSelector,
  canStepForward as canStepForwardSelector,
  EMPTY_SELECTION,
  reconcileSelectionOnNewPrompts,
  resolvePositionLabel,
  resolveSelectedPrompt,
  stepSelection,
  type PromptNavigatorSelection,
} from "./navigator-model";

export interface UsePromptNavigatorInput {
  agentId: string;
  items: readonly StreamItem[];
  head?: readonly StreamItem[];
  hasOlderHistory: boolean;
  isLoadingOlderHistory: boolean;
  loadOlder: () => boolean | Promise<boolean>;
  viewportRef: RefObject<StreamViewportHandle | null>;
  visibleItemIds?: ReadonlySet<string>;
  revealLoadedItem?: (itemId: string) => boolean;
  onHighlight?: (itemId: string) => void;
}

export interface PromptNavigator {
  selectedPrompt: UserMessageItem | null;
  positionLabel: string | null;
  canStepBack: boolean;
  canStepForward: boolean;
  isLoadingOlder: boolean;
  stepBack: () => void;
  stepForward: () => void;
  jumpToSelected: () => void;
}

const EMPTY_STREAM_ITEMS: readonly StreamItem[] = [];
const EMPTY_PROMPTS: UserMessageItem[] = [];

export function usePromptNavigator(input: UsePromptNavigatorInput): PromptNavigator {
  const head = input.head ?? EMPTY_STREAM_ITEMS;
  // The head gets a new identity on every streaming tick, the tail rarely does. Scan them
  // apart so a tick rescans only the head, and keep `prompts` stable while the head holds none.
  const tailPrompts = useMemo(() => selectRecentPrompts(input.items), [input.items]);
  const headPrompts = useMemo(() => {
    const found = selectRecentPrompts(head);
    return found.length > 0 ? found : EMPTY_PROMPTS;
  }, [head]);
  const prompts = useMemo(
    () => (headPrompts.length > 0 ? [...tailPrompts, ...headPrompts] : tailPrompts),
    [tailPrompts, headPrompts],
  );

  const [selection, setSelection] = useState<PromptNavigatorSelection>(EMPTY_SELECTION);
  // The source of truth for any handler that must read the *current*
  // selection synchronously (e.g. jumpToSelected called right after
  // stepBack, in the same tick, before React re-renders). Every mutator
  // below writes here immediately; `selection` state exists only to drive
  // re-renders for the UI.
  const selectionRef = useRef(selection);

  // Navigation intents (a step, a jump, an agent switch) supersede a pending
  // reveal-then-scroll so a slow reveal can't land after the user moved on --
  // mirrors useJumpToStart's generationRef.
  const generationRef = useRef(0);
  const invalidate = useCallback(() => {
    generationRef.current += 1;
  }, []);

  const commitSelection = useCallback((next: PromptNavigatorSelection) => {
    selectionRef.current = next;
    setSelection(next);
  }, []);

  useEffect(() => {
    invalidate();
    commitSelection(EMPTY_SELECTION);
  }, [input.agentId, invalidate, commitSelection]);

  useEffect(() => {
    const next = reconcileSelectionOnNewPrompts(selectionRef.current, prompts);
    if (next !== selectionRef.current) commitSelection(next);
  }, [prompts, commitSelection]);

  const hasOlderHistoryRef = useRef(input.hasOlderHistory);
  hasOlderHistoryRef.current = input.hasOlderHistory;
  const isLoadingOlderHistoryRef = useRef(input.isLoadingOlderHistory);
  isLoadingOlderHistoryRef.current = input.isLoadingOlderHistory;
  const loadOlderRef = useRef(input.loadOlder);
  loadOlderRef.current = input.loadOlder;

  const stepBack = useStableEvent(() => {
    const current = selectionRef.current;
    if (current.prompts.length === 0) return;
    invalidate();
    if (canStepBackSelector(current)) {
      commitSelection(stepSelection(current, "back"));
      return;
    }
    if (hasOlderHistoryRef.current && !isLoadingOlderHistoryRef.current) {
      void loadOlderRef.current();
    }
  });

  const stepForward = useStableEvent(() => {
    const current = selectionRef.current;
    if (current.prompts.length === 0) return;
    invalidate();
    commitSelection(stepSelection(current, "forward"));
  });

  const visibleItemIdsRef = useRef(input.visibleItemIds);
  visibleItemIdsRef.current = input.visibleItemIds;
  const revealLoadedItemRef = useRef(input.revealLoadedItem);
  revealLoadedItemRef.current = input.revealLoadedItem;
  const onHighlightRef = useRef(input.onHighlight);
  onHighlightRef.current = input.onHighlight;

  const jumpToSelected = useStableEvent(() => {
    const target = resolveSelectedPrompt(selectionRef.current);
    if (!target) return;
    invalidate();
    const myGeneration = generationRef.current;

    const scrollAndHighlight = () => {
      if (generationRef.current !== myGeneration) return;
      input.viewportRef.current?.scrollToMessage?.(target.id);
      onHighlightRef.current?.(target.id);
    };

    if (visibleItemIdsRef.current && !visibleItemIdsRef.current.has(target.id)) {
      revealLoadedItemRef.current?.(target.id);
      requestAnimationFrame(scrollAndHighlight);
      return;
    }
    scrollAndHighlight();
  });

  return {
    selectedPrompt: resolveSelectedPrompt(selection),
    positionLabel: resolvePositionLabel(selection),
    canStepBack: canStepBackSelector(selection) || (input.hasOlderHistory && prompts.length > 0),
    canStepForward: canStepForwardSelector(selection),
    isLoadingOlder: input.isLoadingOlderHistory,
    stepBack,
    stepForward,
    jumpToSelected,
  };
}
