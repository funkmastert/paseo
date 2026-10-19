// Real Chromium (vitest `browser` project). Regression guard for the bug behind Tyler's report
// "i dont see my pinned prompts at the top" (2026-10-15): before
// f89896f6b (PR #48, "keep the prompt navigator pinned, scan only the head per tick"), the bar
// only rendered once `barVisible` flipped true, which required the last prompt to have scrolled
// off the top of the viewport first. A user who just sent a prompt and is still looking at it
// on screen would never see the bar at all -- there was nothing to scroll away from.
//
// The two sibling browser tests in this directory (`sticky-last-prompt-live-head` and
// `-mobile-breakpoint`) only mount `useStickyLastPrompt` plus the stream strategy and assert the
// hook's internal `getState()`; they never render `StickyPromptOverlay`, so neither would fail if
// the old visibility gate were reintroduced around the real bar markup. This test mounts the
// actual rendered chain (strategy -> useStickyLastPrompt -> usePromptNavigator ->
// StickyPromptOverlay) and asserts the DOM bar is present without any scroll at all -- the exact
// shape of the original bug.
import React, { useRef } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import { createWebStreamStrategy } from "@/agent-stream/strategy-web";
import type { StreamViewportHandle } from "@/agent-stream/strategy";
import { StickyPromptOverlay } from "./sticky-prompt-overlay";
import { useStickyLastPrompt } from "./use-sticky-last-prompt.web";
import { usePromptNavigator } from "./use-prompt-navigator";
import { assistantMessage, createRenderers, nextFrame, userMessage } from "./browser-test-harness";

// FullPromptViewer (rendered unconditionally, just hidden, by StickyPromptOverlay) opens through
// AdaptiveModalSheet, which pulls in react-native-reanimated. This test is only about whether the
// bar itself renders, not the viewer sheet, so stub the sheet the same way
// sticky-prompt-overlay.test.tsx already does for its jsdom coverage.
vi.mock("@/components/adaptive-modal-sheet", async () => {
  const ReactModule = await import("react");
  function AdaptiveModalSheet(props: { visible: boolean }) {
    return props.visible
      ? ReactModule.createElement("div", { "data-testid": "sticky-prompt-viewer" })
      : null;
  }
  return { AdaptiveModalSheet };
});

const ROW_STYLE = { height: 40 };
// Tall enough that nothing needs to scroll -- every row, including the newest prompt, is
// already fully on screen from the first paint.
const HARNESS_STYLE = {
  position: "relative" as const,
  display: "flex",
  flexDirection: "column" as const,
  height: 2000,
  width: 600,
};

function noop(): void {}

function Harness({ items }: { items: StreamItem[] }) {
  const viewportRef = useRef<StreamViewportHandle>(null);
  const strategyRef = useRef(createWebStreamStrategy({ isMobileBreakpoint: false }));
  const stickyLastPrompt = useStickyLastPrompt({ agentId: "agent-1", items });
  const promptNavigator = usePromptNavigator({
    agentId: "agent-1",
    items,
    hasOlderHistory: false,
    isLoadingOlderHistory: false,
    loadOlder: () => false,
    viewportRef,
  });

  return (
    <div style={HARNESS_STYLE}>
      {strategyRef.current.render({
        agentId: "agent-1",
        segments: { historyVirtualized: [], historyMounted: items, liveHead: [] },
        boundary: {
          hasVirtualizedHistory: false,
          hasMountedHistory: items.length > 0,
          hasLiveHead: false,
        },
        renderers: createRenderers(ROW_STYLE),
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
      <StickyPromptOverlay
        source={stickyLastPrompt.source}
        compact={false}
        onJumpToOriginal={noop}
        selectedPrompt={promptNavigator.selectedPrompt}
        positionLabel={promptNavigator.positionLabel}
        canStepBack={promptNavigator.canStepBack}
        canStepForward={promptNavigator.canStepForward}
        onStepBack={promptNavigator.stepBack}
        onStepForward={promptNavigator.stepForward}
        onJumpToSelected={promptNavigator.jumpToSelected}
      />
    </div>
  );
}

describe("sticky prompt bar renders without any scroll", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    vi.stubGlobal("React", React);
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

  it("shows the bar the moment a prompt exists, with the prompt still fully on screen", async () => {
    const items: StreamItem[] = [userMessage("prompt-1", 1), assistantMessage("assistant-1", 2)];

    act(() => {
      root?.render(<Harness items={items} />);
    });
    await nextFrame();
    await nextFrame();

    const scrollContainer = container?.querySelector<HTMLElement>(
      '[data-testid="agent-chat-scroll"]',
    );
    // The harness is tall enough that the content never needs to scroll -- the regression this
    // guards against only reproduces when the prompt is still fully visible.
    expect(scrollContainer?.scrollHeight).toBeLessThanOrEqual(scrollContainer?.clientHeight ?? 0);

    const bar = container?.querySelector('[data-testid="sticky-prompt-bar"]');
    expect(bar).not.toBeNull();
  });
});
