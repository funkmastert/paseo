// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { useStickyLastPrompt } from "./use-sticky-last-prompt.web";

function at(second: number): Date {
  return new Date(`2026-01-01T00:00:${second.toString().padStart(2, "0")}.000Z`);
}

function user(id: string, second: number): StreamItem {
  return { kind: "user_message", id, text: id, timestamp: at(second) };
}

function assistant(id: string, second: number): StreamItem {
  return { kind: "assistant_message", id, text: id, timestamp: at(second) };
}

describe("useStickyLastPrompt", () => {
  it("publishes the last prompt hidden by default", () => {
    const items = [user("p1", 1), assistant("a1", 2)];
    const { result } = renderHook(() => useStickyLastPrompt({ agentId: "agent-1", items }));
    expect(result.current.source.getState()).toEqual({ prompt: items[0], barVisible: false });
  });

  it("shows the bar once the reading position moves past the prompt's row", () => {
    const items = [user("p1", 1), assistant("a1", 2), assistant("a2", 3)];
    const { result } = renderHook(() => useStickyLastPrompt({ agentId: "agent-1", items }));

    act(() => {
      result.current.reportReadingPosition("a2");
    });
    expect(result.current.source.getState()).toEqual({ prompt: items[0], barVisible: true });

    act(() => {
      result.current.reportReadingPosition("p1");
    });
    expect(result.current.source.getState()).toEqual({ prompt: items[0], barVisible: false });
  });

  it("recomputes the tracked prompt and hides the bar when a new turn starts", () => {
    const initialItems = [user("p1", 1), assistant("a1", 2)];
    const { result, rerender } = renderHook(
      ({ items }) => useStickyLastPrompt({ agentId: "agent-1", items }),
      { initialProps: { items: initialItems } },
    );

    act(() => {
      result.current.reportReadingPosition("a1");
    });
    expect(result.current.source.getState().barVisible).toBe(true);

    const nextItems = [...initialItems, user("p2", 3)];
    rerender({ items: nextItems });
    expect(result.current.source.getState()).toEqual({ prompt: nextItems[2], barVisible: false });
  });

  it("publishes no prompt when the timeline has no user_message", () => {
    const items = [assistant("a1", 1)];
    const { result } = renderHook(() => useStickyLastPrompt({ agentId: "agent-1", items }));
    expect(result.current.source.getState()).toEqual({ prompt: null, barVisible: false });
  });

  it("shows the bar once the reading position moves past the prompt's row, even when that row lives in `head` (the still-streaming turn)", () => {
    const items = [user("p1", 1), assistant("a1", 2)];
    const head = [assistant("h1", 3)];
    const { result } = renderHook(() => useStickyLastPrompt({ agentId: "agent-1", items, head }));

    act(() => {
      result.current.reportReadingPosition("h1");
    });
    expect(result.current.source.getState()).toEqual({ prompt: items[0], barVisible: true });
  });

  it("resets to hidden when agentId changes even before items catch up", () => {
    // Items intentionally stay the same reference across the rerender, isolating the
    // agentId-keyed reset effect from the items-driven recompute effect: if only the reset
    // effect exists to react to this change, this proves it alone clears the stale prompt.
    const items = [user("p1", 1), assistant("a1", 2), assistant("a2", 3)];
    const { result, rerender } = renderHook(
      ({ agentId }) => useStickyLastPrompt({ agentId, items }),
      {
        initialProps: { agentId: "agent-1" },
      },
    );

    act(() => {
      result.current.reportReadingPosition("a2");
    });
    expect(result.current.source.getState()).toEqual({ prompt: items[0], barVisible: true });

    rerender({ agentId: "agent-2" });
    expect(result.current.source.getState()).toEqual({ prompt: null, barVisible: false });
  });
});
