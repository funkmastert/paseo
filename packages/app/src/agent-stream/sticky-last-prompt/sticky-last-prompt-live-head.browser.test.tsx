// Real Chromium (vitest `browser` project): exercises `useStickyLastPrompt` through the real
// stream strategy's render tree, not fabricated items, so a tail/head split that doesn't match
// what the strategy actually renders would show up here.
import React, { useRef } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { createWebStreamStrategy } from "@/agent-stream/strategy-web";
import type { StreamViewportHandle } from "@/agent-stream/strategy";
import { useStickyLastPrompt } from "./use-sticky-last-prompt.web";
import {
  assistantMessage,
  createRenderers,
  nextFrame,
  type PromptStateHarnessApi,
  userMessage,
  waitForState,
} from "./browser-test-harness";

const ROW_STYLE = { height: 300 };
const HARNESS_STYLE = {
  display: "flex",
  flexDirection: "column" as const,
  height: 400,
  width: 600,
};

function Harness({
  tail,
  head,
  apiRef,
}: {
  tail: StreamItem[];
  head: StreamItem[];
  apiRef: { current: PromptStateHarnessApi | null };
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
        renderers: createRenderers(ROW_STYLE),
        listEmptyComponent: null,
        viewportRef,
        routeBottomAnchorRequest: null,
        isAuthoritativeHistoryReady: true,
        onNearBottomChange: () => {},
        onNearHistoryStartChange: () => {},
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

  it("finds the user's prompt in the committed tail while the turn is still streaming in the live head", async () => {
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
    const apiRef: { current: PromptStateHarnessApi | null } = { current: null };

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
    // actively streaming.
    act(() => {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });

    const expected = { prompt: tail[0] };
    expect(await waitForState(apiRef, expected)).toEqual(expected);
  });
});
