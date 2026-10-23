import { useEffect, useRef, useState } from "react";

import {
  advanceTextReveal,
  beginTextReveal,
  completeTextReveal,
  isTextRevealPacingSupported,
  isTextRevealSettled,
  nextTextRevealFrame,
  retargetTextReveal,
  type TextRevealState,
  visibleRevealedText,
} from "@/agent-stream/text-reveal";
import type { MarkdownPhase } from "@/components/markdown/fence/types";
import { useRetainedPanelActive } from "@/components/retained-panel";

/**
 * Binds the paced reveal in @/agent-stream/text-reveal to a frame clock.
 *
 * All of the policy — what is revealed when, and where it is safe to cut — lives
 * in that module and is tested there. This hook only owns the requestAnimationFrame
 * wiring, so the rendered behavior is covered end to end by
 * `packages/app/e2e/browser/agent-stream-smoothness.spec.ts`.
 *
 * A `requestAnimationFrame` keeps firing for a `RetainedPanel` hidden behind
 * `display: none` — only a hidden *tab* stops the frame clock. Without the
 * active check below, every streaming message row in every background agent
 * paces its reveal at full frame rate whether anyone can see it or not, so
 * main-thread cost scales with the number of agents streaming, not the number
 * visible. Nobody is watching an inactive panel, so it settles immediately
 * instead and picks the paced reveal back up for whatever arrives once active.
 */
export function useRevealedText(text: string, phase: MarkdownPhase): string {
  const pacingSupported = isTextRevealPacingSupported();
  const isPanelActive = useRetainedPanelActive();
  const stateRef = useRef<TextRevealState>(beginTextReveal(text));
  const [, forceRender] = useState(0);
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);

  stateRef.current = retargetTextReveal(stateRef.current, text);

  useEffect(() => {
    const settle = () => {
      lastFrameAtRef.current = null;
      const next = completeTextReveal(stateRef.current);
      if (next !== stateRef.current) {
        stateRef.current = next;
        forceRender((tick) => tick + 1);
      }
    };

    if (!pacingSupported || phase !== "streaming" || !isPanelActive) {
      settle();
      return;
    }
    if (isTextRevealSettled(stateRef.current)) {
      lastFrameAtRef.current = null;
      return;
    }
    if (typeof requestAnimationFrame !== "function") {
      settle();
      return;
    }

    const tick = (timestamp: number) => {
      frameRef.current = null;
      const frame = nextTextRevealFrame(lastFrameAtRef.current, timestamp);
      if (!frame) {
        frameRef.current = requestAnimationFrame(tick);
        return;
      }
      lastFrameAtRef.current = frame.frameAtMs;

      const next = advanceTextReveal(stateRef.current, frame.elapsedMs);
      if (next !== stateRef.current) {
        stateRef.current = next;
        forceRender((count) => count + 1);
      }
      if (!isTextRevealSettled(stateRef.current)) {
        frameRef.current = requestAnimationFrame(tick);
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [text, pacingSupported, phase, isPanelActive]);

  return pacingSupported
    ? visibleRevealedText(stateRef.current, { streaming: phase === "streaming" })
    : text;
}
