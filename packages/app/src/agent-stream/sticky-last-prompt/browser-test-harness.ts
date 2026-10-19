// Shared by the `*.browser.test.tsx` files in this directory (real Chromium, vitest `browser`
// project). Fixture builders and real-layout timing helpers only -- component harnesses differ
// enough per test (which hooks they wire, what they mount) that extracting those too would cost
// more in indirection than the duplication it would remove.
import { createElement } from "react";
import type { StreamItem } from "@/types/stream";
import type { StreamSegmentRenderers } from "@/agent-stream/strategy";
import type { StickyLastPromptState } from "./model";

export function at(second: number): Date {
  return new Date(`2026-01-01T00:00:${second.toString().padStart(2, "0")}.000Z`);
}

export function userMessage(id: string, second: number): StreamItem {
  return { kind: "user_message", id, text: id, timestamp: at(second) };
}

export function assistantMessage(id: string, second: number): StreamItem {
  return { kind: "assistant_message", id, text: id, timestamp: at(second) };
}

export function createRenderers(rowStyle: { height: number }): StreamSegmentRenderers {
  // Plain `createElement`, not JSX: this module's JSX transform needs a global `React` that the
  // callers (the `*.browser.test.tsx` files that render it) don't all stub.
  const renderRow = (item: StreamItem) => createElement("div", { style: rowStyle }, item.id);
  return {
    renderHistoryVirtualizedRow: renderRow,
    renderHistoryMountedRow: renderRow,
    renderLiveHeadRow: renderRow,
    renderLiveAuxiliary: () => null,
  };
}

// A real Chromium paint happens asynchronously after the frame the triggering render committed
// in; `await nextFrame()` lets a test observe post-paint state (real `getBoundingClientRect()`
// results, real scroll geometry) instead of racing it.
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export interface PromptStateHarnessApi {
  getState: () => StickyLastPromptState;
}

// The settle this waits for (the 'scroll' event's async dispatch, then reportReadingPosition's
// layout read) has no fixed frame count -- a real browser's scroll event and the follow-output
// settle timeout in strategy-web.tsx both land whenever the event loop gets to them, which
// stretches out under machine load. Poll the actual state instead of guessing a frame count, so
// the test passes as soon as the real condition lands rather than racing a fixed wait.
export async function waitForState(
  apiRef: { current: PromptStateHarnessApi | null },
  expected: { prompt: StreamItem; barVisible: boolean },
  maxFrames = 120,
): Promise<StickyLastPromptState> {
  const getState = () => {
    if (!apiRef.current) {
      throw new Error("Expected harness api");
    }
    return apiRef.current.getState();
  };
  let state = getState();
  for (let frame = 0; frame < maxFrames; frame++) {
    if (state.barVisible === expected.barVisible && state.prompt?.id === expected.prompt?.id) {
      return state;
    }
    await nextFrame();
    state = getState();
  }
  return state;
}
