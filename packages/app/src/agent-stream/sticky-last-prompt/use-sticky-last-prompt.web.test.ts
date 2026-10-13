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
    const { result } = renderHook(() => useStickyLastPrompt({ items }));
    expect(result.current.source.getState()).toEqual({ prompt: items[0], barVisible: false });
  });

  it("shows the bar once the reading position moves past the prompt's row", () => {
    const items = [user("p1", 1), assistant("a1", 2), assistant("a2", 3)];
    const { result } = renderHook(() => useStickyLastPrompt({ items }));

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
    const { result, rerender } = renderHook(({ items }) => useStickyLastPrompt({ items }), {
      initialProps: { items: initialItems },
    });

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
    const { result } = renderHook(() => useStickyLastPrompt({ items }));
    expect(result.current.source.getState()).toEqual({ prompt: null, barVisible: false });
  });
});
