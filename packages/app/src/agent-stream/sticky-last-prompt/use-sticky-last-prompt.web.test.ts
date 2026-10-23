// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
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
  it("publishes the last prompt", () => {
    const items = [user("p1", 1), assistant("a1", 2)];
    const { result } = renderHook(() => useStickyLastPrompt({ agentId: "agent-1", items }));
    expect(result.current.source.getState()).toEqual({ prompt: items[0] });
  });

  it("recomputes the tracked prompt when a new turn starts", () => {
    const initialItems = [user("p1", 1), assistant("a1", 2)];
    const { result, rerender } = renderHook(
      ({ items }) => useStickyLastPrompt({ agentId: "agent-1", items }),
      { initialProps: { items: initialItems } },
    );
    expect(result.current.source.getState()).toEqual({ prompt: initialItems[0] });

    const nextItems = [...initialItems, user("p2", 3)];
    rerender({ items: nextItems });
    expect(result.current.source.getState()).toEqual({ prompt: nextItems[2] });
  });

  it("publishes no prompt when the timeline has no user_message", () => {
    const items = [assistant("a1", 1)];
    const { result } = renderHook(() => useStickyLastPrompt({ agentId: "agent-1", items }));
    expect(result.current.source.getState()).toEqual({ prompt: null });
  });

  it("finds the last prompt even when it lives in `head` (the still-streaming turn)", () => {
    const items = [assistant("a1", 1)];
    const head = [user("p1", 2)];
    const { result } = renderHook(() => useStickyLastPrompt({ agentId: "agent-1", items, head }));
    expect(result.current.source.getState()).toEqual({ prompt: head[0] });
  });

  it("resets to no prompt when agentId changes even before items catch up", () => {
    // Items intentionally stay the same reference across the rerender, isolating the
    // agentId-keyed reset effect from the items-driven recompute effect: if only the reset
    // effect exists to react to this change, this proves it alone clears the stale prompt.
    const items = [user("p1", 1), assistant("a1", 2)];
    const { result, rerender } = renderHook(
      ({ agentId }) => useStickyLastPrompt({ agentId, items }),
      {
        initialProps: { agentId: "agent-1" },
      },
    );
    expect(result.current.source.getState()).toEqual({ prompt: items[0] });

    rerender({ agentId: "agent-2" });
    expect(result.current.source.getState()).toEqual({ prompt: null });
  });
});
