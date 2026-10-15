import { memo, useCallback, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { FullPromptViewer, StickyPromptBar } from "./sticky-prompt-bar";
import type { StickyLastPromptSource } from "./model";
import type { UserMessageItem } from "@/types/stream";

export interface StickyPromptOverlayProps {
  source: StickyLastPromptSource;
  compact: boolean;
  onJumpToOriginal: () => void;
  /** The navigator's selected prompt -- defaults to the newest, steps back/forward through
   * loaded prompts. Falls back to the sticky-last-prompt source's own prompt when absent
   * (e.g. before the navigator has anything selected yet). */
  selectedPrompt: UserMessageItem | null;
  positionLabel: string | null;
  canStepBack: boolean;
  canStepForward: boolean;
  onStepBack: () => void;
  onStepForward: () => void;
  onJumpToSelected: () => void;
}

// Subscribes to the publisher itself (mirroring ChatOutlineRail's
// `useSyncExternalStore(activePrompt.subscribe, activePrompt.getActiveSeq)`) so a visibility
// change re-renders only this leaf, not the whole AgentStreamView.
//
// The viewer's open/snapshot state lives here, above the `barVisible` gate, so a visibility flip
// alone (e.g. a streaming layout shift bringing the prompt back on screen) never closes an open
// viewer — only `!state.prompt` unmounts this leaf, and the caller remounts it on an agent switch
// via `key={agentId}` (this component's own `return null` on a momentary null prompt does not
// reset its hooks, so the key is what actually guarantees the switch closes the viewer).
export const StickyPromptOverlay = memo(function StickyPromptOverlay({
  source,
  compact,
  onJumpToOriginal,
  selectedPrompt,
  positionLabel,
  canStepBack,
  canStepForward,
  onStepBack,
  onStepForward,
  onJumpToSelected,
}: StickyPromptOverlayProps): ReactNode {
  const state = useSyncExternalStore(source.subscribe, source.getState);
  const displayedPrompt = selectedPrompt ?? state.prompt;
  const [viewerPrompt, setViewerPrompt] = useState<UserMessageItem | null>(null);
  const pendingJumpRef = useRef(false);

  const handleOpenViewer = useCallback(() => {
    pendingJumpRef.current = false;
    setViewerPrompt(displayedPrompt);
  }, [displayedPrompt]);
  const handleCloseViewer = useCallback(() => {
    pendingJumpRef.current = false;
    setViewerPrompt(null);
  }, []);
  const handleJumpFromViewer = useCallback(() => {
    pendingJumpRef.current = true;
    setViewerPrompt(null);
  }, []);
  const handleViewerDismissed = useCallback(() => {
    if (!pendingJumpRef.current) return;
    pendingJumpRef.current = false;
    onJumpToSelected();
  }, [onJumpToSelected]);

  if (!state.prompt) return null;
  return (
    <>
      {state.barVisible ? (
        <StickyPromptBar
          // Guaranteed non-null here: displayedPrompt falls back to state.prompt, and the guard
          // above already returned when state.prompt was null.
          prompt={displayedPrompt as UserMessageItem}
          compact={compact}
          positionLabel={positionLabel}
          canStepBack={canStepBack}
          canStepForward={canStepForward}
          onStepBack={onStepBack}
          onStepForward={onStepForward}
          onJumpToSelected={onJumpToSelected}
          onJumpToOriginal={onJumpToOriginal}
          onOpenViewer={handleOpenViewer}
        />
      ) : null}
      <FullPromptViewer
        visible={viewerPrompt != null}
        text={viewerPrompt?.text ?? ""}
        onClose={handleCloseViewer}
        onJumpToOriginal={handleJumpFromViewer}
        onDismiss={handleViewerDismissed}
      />
    </>
  );
});
