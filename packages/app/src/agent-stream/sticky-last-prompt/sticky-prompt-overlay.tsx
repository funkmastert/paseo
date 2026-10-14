import { memo, useCallback, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { FullPromptViewer, StickyPromptBar } from "./sticky-prompt-bar";
import type { StickyLastPromptSource } from "./model";
import type { UserMessageItem } from "@/types/stream";

export interface StickyPromptOverlayProps {
  source: StickyLastPromptSource;
  compact: boolean;
  onJumpToOriginal: () => void;
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
}: StickyPromptOverlayProps): ReactNode {
  const state = useSyncExternalStore(source.subscribe, source.getState);
  const [viewerPrompt, setViewerPrompt] = useState<UserMessageItem | null>(null);
  const pendingJumpRef = useRef(false);

  const handleOpenViewer = useCallback(() => {
    pendingJumpRef.current = false;
    setViewerPrompt(state.prompt);
  }, [state.prompt]);
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
    onJumpToOriginal();
  }, [onJumpToOriginal]);

  if (!state.prompt) return null;
  return (
    <>
      {state.barVisible ? (
        <StickyPromptBar
          prompt={state.prompt}
          compact={compact}
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
