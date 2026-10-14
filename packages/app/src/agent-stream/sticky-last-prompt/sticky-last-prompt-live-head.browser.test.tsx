// Real Chromium (vitest `browser` project): the bug this guards against only shows up under
// real layout. `reportReadingPosition` (strategy-web.tsx) walks real `getBoundingClientRect()`
// results to find the row at the top of the viewport, and jsdom returns all-zero rects for every
// element -- a jsdom test can't distinguish "found no reading-position row" from "found the wrong
// one," so it would pass or fail for the wrong reason either way.
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
const HARNESS_STYLE = {
  display: "flex",
  flexDirection: "column" as const,
  height: 400,
  width: 600,
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
  const strategyRef = useRef(createWebStreamStrategy({ isMobileBreakpoint: false }));
  // Mirrors the real call site, agent-stream/view.tsx:676.
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

describe("sticky last prompt while the agent is actively streaming", () => {
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

  it("shows the bar once the prompt scrolls off, even while following live output into the streaming tool calls", async () => {
    // The committed turn so far: the user's prompt plus a couple of already-settled rows.
    const tail: StreamItem[] = [
      userMessage("prompt-1", 1),
      assistantMessage("tail-assistant-1", 2),
      assistantMessage("tail-assistant-2", 3),
    ];
    // The agent's still-streaming turn -- rendered, but not yet committed into `tail`. A long
    // leader conversation spends most of its time here: lots of assistant text and tool calls
    // still arriving.
    const head: StreamItem[] = [
      assistantMessage("head-assistant-1", 4),
      assistantMessage("head-assistant-2", 5),
      assistantMessage("head-assistant-3", 6),
      assistantMessage("head-assistant-4", 7),
    ];
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

    // Follow the live output to the bottom, exactly like the real viewport while the agent is
    // actively streaming -- the user's prompt is long gone off the top of the screen.
    act(() => {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });
    await nextFrame();
    await nextFrame();

    expect(apiRef.current?.getState()).toEqual({ prompt: tail[0], barVisible: true });
  });
});
