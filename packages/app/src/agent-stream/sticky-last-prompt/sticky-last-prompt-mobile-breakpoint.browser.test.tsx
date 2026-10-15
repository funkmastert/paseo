// Real Chromium (vitest `browser` project): checks whether the sticky bar's visibility
// computation (reportReadingPosition -> isLastPromptAboveViewport) behaves the same at the
// mobile breakpoint as it does at the desktop breakpoint covered by
// sticky-last-prompt-live-head.browser.test.tsx. Mirrors that harness exactly except for
// `isMobileBreakpoint: true` and a phone-width viewport.
import React, { useRef } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { createWebStreamStrategy } from "@/agent-stream/strategy-web";
import type { StreamSegmentRenderers, StreamViewportHandle } from "@/agent-stream/strategy";
import type { StickyLastPromptState } from "./model";
import { useStickyLastPrompt } from "./use-sticky-last-prompt.web";

function at(second: number): Date {
  return new Date(`2026-01-01T00:00:${second.toString().padStart(2, "0")}.000Z`);
}

function userMessage(id: string, second: number): StreamItem {
  return { kind: "user_message", id, text: id, timestamp: at(second) };
}

function assistantMessage(id: string, second: number): StreamItem {
  return { kind: "assistant_message", id, text: id, timestamp: at(second) };
}

const ROW_STYLE = { height: 300 };
// Phone-width viewport (iPhone SE/8 class), matching the compact breakpoint.
const HARNESS_STYLE = {
  display: "flex",
  flexDirection: "column" as const,
  height: 600,
  width: 375,
};

function createRenderers(): StreamSegmentRenderers {
  const renderRow = (item: StreamItem) => <div style={ROW_STYLE}>{item.id}</div>;
  return {
    renderHistoryVirtualizedRow: renderRow,
    renderHistoryMountedRow: renderRow,
    renderLiveHeadRow: renderRow,
    renderLiveAuxiliary: () => null,
  };
}

interface HarnessApi {
  getState: () => StickyLastPromptState;
}

function Harness({
  tail,
  head,
  apiRef,
}: {
  tail: StreamItem[];
  head: StreamItem[];
  apiRef: { current: HarnessApi | null };
}) {
  const viewportRef = useRef<StreamViewportHandle>(null);
  const strategyRef = useRef(createWebStreamStrategy({ isMobileBreakpoint: true }));
  const stickyLastPrompt = useStickyLastPrompt({ agentId: "agent-1", items: tail, head });
  apiRef.current = { getState: stickyLastPrompt.source.getState };

  return (
    <div style={HARNESS_STYLE}>
      {strategyRef.current.render({
        agentId: "agent-1",
        segments: { historyVirtualized: [], historyMounted: tail, liveHead: head },
        boundary: {
          hasVirtualizedHistory: false,
          hasMountedHistory: tail.length > 0,
          hasLiveHead: head.length > 0,
        },
        renderers: createRenderers(),
        listEmptyComponent: null,
        viewportRef,
        routeBottomAnchorRequest: null,
        isAuthoritativeHistoryReady: true,
        onNearBottomChange: () => {},
        onNearHistoryStartChange: () => {},
        onReadingPositionChange: stickyLastPrompt.reportReadingPosition,
        onNearHistoryStart: () => true,
        isLoadingOlderHistory: false,
        hasOlderHistory: false,
        olderHistoryProgressKey: null,
        scrollEnabled: true,
        listStyle: null,
        baseListContentContainerStyle: null,
        forwardListContentContainerStyle: null,
      })}
    </div>
  );
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe("sticky last prompt at the mobile breakpoint", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
  });

  it("shows the bar once the prompt scrolls off at a phone-width viewport", async () => {
    const tail: StreamItem[] = [
      userMessage("prompt-1", 1),
      assistantMessage("tail-assistant-1", 2),
      assistantMessage("tail-assistant-2", 3),
      assistantMessage("tail-assistant-3", 4),
      assistantMessage("tail-assistant-4", 5),
    ];
    const head: StreamItem[] = [];
    // Harness is a plain, unmemoized test harness -- there's no memo boundary for this
    // object-identity prop to break.
    /* oxlint-disable react-perf/jsx-no-new-object-as-prop */
    const apiRef: { current: HarnessApi | null } = { current: null };

    act(() => {
      root?.render(<Harness tail={tail} head={head} apiRef={apiRef} />);
    });
    /* oxlint-enable react-perf/jsx-no-new-object-as-prop */
    await nextFrame();

    const scrollContainer = container?.querySelector<HTMLElement>(
      '[data-testid="agent-chat-scroll"]',
    );
    if (!scrollContainer) {
      throw new Error("Expected agent chat scroll container");
    }
    expect(scrollContainer.scrollHeight).toBeGreaterThan(scrollContainer.clientHeight);

    act(() => {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });
    await nextFrame();
    await nextFrame();

    expect(apiRef.current?.getState()).toEqual({ prompt: tail[0], barVisible: true });
  });

  it("shows the bar for an already-finished conversation with no further interaction", async () => {
    // Mirrors a phone user opening an already-scrolled-to-bottom, finished conversation and
    // never touching the screen -- no live head, no extra scroll gesture beyond the initial
    // mount-time settle.
    const tail: StreamItem[] = [
      userMessage("prompt-1", 1),
      assistantMessage("tail-assistant-1", 2),
      assistantMessage("tail-assistant-2", 3),
      assistantMessage("tail-assistant-3", 4),
      assistantMessage("tail-assistant-4", 5),
    ];
    /* oxlint-disable react-perf/jsx-no-new-object-as-prop */
    const apiRef: { current: HarnessApi | null } = { current: null };

    act(() => {
      root?.render(<Harness tail={tail} head={[]} apiRef={apiRef} />);
    });
    /* oxlint-enable react-perf/jsx-no-new-object-as-prop */
    await nextFrame();
    await nextFrame();
    await nextFrame();

    const scrollContainer = container?.querySelector<HTMLElement>(
      '[data-testid="agent-chat-scroll"]',
    );
    if (!scrollContainer) {
      throw new Error("Expected agent chat scroll container");
    }

    expect(apiRef.current?.getState()).toEqual({ prompt: tail[0], barVisible: true });
  });
});
