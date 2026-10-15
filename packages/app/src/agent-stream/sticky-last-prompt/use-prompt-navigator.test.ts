// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "../strategy";
import { usePromptNavigator, type UsePromptNavigatorInput } from "./use-prompt-navigator";

function at(second: number): Date {
  return new Date(`2026-01-01T00:00:${second.toString().padStart(2, "0")}.000Z`);
}

function user(id: string, second: number): StreamItem {
  return { kind: "user_message", id, text: id, timestamp: at(second) };
}

function assistant(id: string, second: number): StreamItem {
  return { kind: "assistant_message", id, text: id, timestamp: at(second) };
}

function waitAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function fivePrompts(): StreamItem[] {
  return [
    user("p1", 1),
    assistant("a1", 2),
    user("p2", 3),
    assistant("a2", 4),
    user("p3", 5),
    assistant("a3", 6),
    user("p4", 7),
    assistant("a4", 8),
    user("p5", 9),
  ];
}

function baseInput(overrides: Partial<UsePromptNavigatorInput> = {}): UsePromptNavigatorInput {
  return {
    agentId: "agent-1",
    items: fivePrompts(),
    hasOlderHistory: false,
    isLoadingOlderHistory: false,
    loadOlder: vi.fn(),
    viewportRef: { current: { scrollToMessage: vi.fn() } as unknown as StreamViewportHandle },
    ...overrides,
  };
}

describe("usePromptNavigator", () => {
  it("selects the newest prompt on mount with a full position label", () => {
    const { result } = renderHook((props) => usePromptNavigator(props), {
      initialProps: baseInput(),
    });
    expect(result.current.positionLabel).toBe("5/5");
    expect(result.current.selectedPrompt?.id).toBe("p5");
    expect(result.current.canStepForward).toBe(false);
    expect(result.current.canStepBack).toBe(true);
  });

  it("steps back through loaded prompts without pagination when there's no older history", () => {
    const loadOlder = vi.fn();
    const { result } = renderHook((props) => usePromptNavigator(props), {
      initialProps: baseInput({ loadOlder }),
    });

    act(() => result.current.stepBack());
    act(() => result.current.stepBack());
    act(() => result.current.stepBack());
    act(() => result.current.stepBack());
    expect(result.current.positionLabel).toBe("1/5");
    expect(result.current.canStepBack).toBe(false);
    expect(loadOlder).not.toHaveBeenCalled();
  });

  it("calls loadOlder once when stepping back past the oldest loaded prompt with more history available", () => {
    const loadOlder = vi.fn().mockResolvedValue(true);
    const { result, rerender } = renderHook((props) => usePromptNavigator(props), {
      initialProps: baseInput({ loadOlder, hasOlderHistory: true }),
    });

    for (let i = 0; i < 4; i += 1) act(() => result.current.stepBack());
    expect(result.current.positionLabel).toBe("1/5");
    expect(result.current.canStepBack).toBe(true);

    act(() => result.current.stepBack());
    expect(loadOlder).toHaveBeenCalledTimes(1);

    // A repeat press while the load is in flight does not call loadOlder again.
    rerender(baseInput({ loadOlder, hasOlderHistory: true, isLoadingOlderHistory: true }));
    act(() => result.current.stepBack());
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it("keeps the same prompt selected and extends backward once loadOlder grows the loaded tail", () => {
    const loadOlder = vi.fn();
    const olderPrepended = [user("p0", 0), ...fivePrompts()];
    const { result, rerender } = renderHook((props) => usePromptNavigator(props), {
      initialProps: baseInput({ loadOlder, hasOlderHistory: true }),
    });

    for (let i = 0; i < 4; i += 1) act(() => result.current.stepBack());
    expect(result.current.positionLabel).toBe("1/5");

    rerender(baseInput({ items: olderPrepended, loadOlder, hasOlderHistory: false }));
    expect(result.current.positionLabel).toBe("2/6");
    expect(result.current.canStepBack).toBe(true);

    act(() => result.current.stepBack());
    expect(result.current.positionLabel).toBe("1/6");
  });

  it("resets to the newest prompt when a new prompt arrives after stepping back", () => {
    const { result, rerender } = renderHook((props) => usePromptNavigator(props), {
      initialProps: baseInput(),
    });

    act(() => result.current.stepBack());
    act(() => result.current.stepBack());
    expect(result.current.positionLabel).toBe("3/5");

    rerender(baseInput({ items: [...fivePrompts(), assistant("a5", 10), user("p6", 11)] }));
    expect(result.current.positionLabel).toBe("6/6");
    expect(result.current.canStepForward).toBe(false);
  });

  it("stepBack/stepForward are no-ops and never call loadOlder for an empty prompt list", () => {
    const loadOlder = vi.fn();
    const { result } = renderHook((props) => usePromptNavigator(props), {
      initialProps: baseInput({ items: [assistant("a1", 1)], loadOlder, hasOlderHistory: true }),
    });
    expect(result.current.positionLabel).toBeNull();

    act(() => result.current.stepBack());
    act(() => result.current.stepForward());
    expect(loadOlder).not.toHaveBeenCalled();
    expect(result.current.positionLabel).toBeNull();
  });

  it("jumpToSelected scrolls directly when the selected prompt is already visible", () => {
    const scrollToMessage = vi.fn();
    const { result } = renderHook((props) => usePromptNavigator(props), {
      initialProps: baseInput({
        viewportRef: { current: { scrollToMessage } as unknown as StreamViewportHandle },
        visibleItemIds: new Set(["p5"]),
      }),
    });

    act(() => result.current.jumpToSelected());
    expect(scrollToMessage).toHaveBeenCalledWith("p5");
  });

  it("jumpToSelected reveals before scrolling when the selected prompt is loaded but not mounted", async () => {
    const scrollToMessage = vi.fn();
    const revealLoadedItem = vi.fn().mockReturnValue(true);
    const { result } = renderHook((props) => usePromptNavigator(props), {
      initialProps: baseInput({
        viewportRef: { current: { scrollToMessage } as unknown as StreamViewportHandle },
        visibleItemIds: new Set(),
        revealLoadedItem,
      }),
    });

    act(() => result.current.jumpToSelected());
    expect(revealLoadedItem).toHaveBeenCalledWith("p5");
    await act(() => waitAnimationFrame());
    expect(scrollToMessage).toHaveBeenCalledWith("p5");
  });

  it("jumpToSelected only acts on the second jump when two selections are jumped in quick succession", async () => {
    const scrollToMessage = vi.fn();
    const revealLoadedItem = vi.fn().mockReturnValue(true);
    const { result } = renderHook((props) => usePromptNavigator(props), {
      initialProps: baseInput({
        viewportRef: { current: { scrollToMessage } as unknown as StreamViewportHandle },
        visibleItemIds: new Set(),
        revealLoadedItem,
      }),
    });

    act(() => {
      result.current.jumpToSelected(); // selects p5, pending reveal
      result.current.stepBack(); // now selects p4, supersedes the pending jump
      result.current.jumpToSelected(); // jumps to p4
    });
    await act(() => waitAnimationFrame());
    expect(scrollToMessage).toHaveBeenCalledTimes(1);
    expect(scrollToMessage).toHaveBeenCalledWith("p4");
  });

  it("jumpToSelected targets the newly selected prompt after stepBack immediately followed by a jump", () => {
    const scrollToMessage = vi.fn();
    const { result } = renderHook((props) => usePromptNavigator(props), {
      initialProps: baseInput({
        viewportRef: { current: { scrollToMessage } as unknown as StreamViewportHandle },
        visibleItemIds: new Set(["p1", "p2", "p3", "p4", "p5"]),
      }),
    });

    act(() => {
      result.current.stepBack();
      result.current.jumpToSelected();
    });
    expect(scrollToMessage).toHaveBeenCalledWith("p4");
  });
});
