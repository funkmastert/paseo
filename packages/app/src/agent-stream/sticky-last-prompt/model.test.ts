import { describe, expect, it, vi } from "vitest";
import type { StreamItem, UserMessageItem } from "@/types/stream";
import {
  createSeenThenLeftTracker,
  createStickyLastPromptPublisher,
  isLastPromptAboveViewport,
  selectLastPrompt,
} from "./model";

function at(second: number): Date {
  return new Date(`2026-01-01T00:00:${second.toString().padStart(2, "0")}.000Z`);
}

function user(id: string, second: number): StreamItem {
  return { kind: "user_message", id, text: id, timestamp: at(second) };
}

function assistant(id: string, second: number): StreamItem {
  return { kind: "assistant_message", id, text: id, timestamp: at(second) };
}

describe("selectLastPrompt", () => {
  it("returns the last user_message among a mix of item kinds", () => {
    const items = [user("p1", 1), assistant("a1", 2), user("p2", 3), assistant("a2", 4)];
    expect(selectLastPrompt(items)?.id).toBe("p2");
  });

  it("returns null for an empty list", () => {
    expect(selectLastPrompt([])).toBeNull();
  });

  it("returns null when there is no user_message", () => {
    expect(selectLastPrompt([assistant("a1", 1), assistant("a2", 2)])).toBeNull();
  });

  it("picks up a newly appended prompt once a new turn starts", () => {
    const items = [user("p1", 1), assistant("a1", 2)];
    expect(selectLastPrompt(items)?.id).toBe("p1");
    const next = [...items, user("p2", 3)];
    expect(selectLastPrompt(next)?.id).toBe("p2");
  });
});

describe("isLastPromptAboveViewport", () => {
  const items = [user("p1", 1), assistant("a1", 2), assistant("a2", 3)];

  it("is false when the reading-position row is the prompt's own row", () => {
    expect(
      isLastPromptAboveViewport({ lastPromptId: "p1", readingPositionRowId: "p1", items }),
    ).toBe(false);
  });

  it("is false when the reading-position row comes before the prompt", () => {
    const withHistory = [user("older", 0), ...items];
    expect(
      isLastPromptAboveViewport({
        lastPromptId: "p1",
        readingPositionRowId: "older",
        items: withHistory,
      }),
    ).toBe(false);
  });

  it("is true when the reading-position row comes after the prompt", () => {
    expect(
      isLastPromptAboveViewport({ lastPromptId: "p1", readingPositionRowId: "a2", items }),
    ).toBe(true);
  });

  it("is false when no reading position has been reported yet", () => {
    expect(
      isLastPromptAboveViewport({ lastPromptId: "p1", readingPositionRowId: null, items }),
    ).toBe(false);
  });

  it("is false when either id can't be found in the item list", () => {
    expect(
      isLastPromptAboveViewport({ lastPromptId: "missing", readingPositionRowId: "a2", items }),
    ).toBe(false);
    expect(
      isLastPromptAboveViewport({ lastPromptId: "p1", readingPositionRowId: "missing", items }),
    ).toBe(false);
  });
});

describe("createSeenThenLeftTracker", () => {
  it("does not show on the first call even if not yet visible (never seen, not scrolled past)", () => {
    const tracker = createSeenThenLeftTracker();
    expect(tracker.update("p1", false)).toBe(false);
  });

  it("shows only after being seen visible and then leaving the viewable set", () => {
    const tracker = createSeenThenLeftTracker();
    expect(tracker.update("p1", true)).toBe(false);
    expect(tracker.update("p1", true)).toBe(false);
    expect(tracker.update("p1", false)).toBe(true);
  });

  it("stays hidden across repeated not-visible calls if never seen visible first", () => {
    const tracker = createSeenThenLeftTracker();
    expect(tracker.update("p1", false)).toBe(false);
    expect(tracker.update("p1", false)).toBe(false);
  });

  it("resets when the tracked id changes", () => {
    const tracker = createSeenThenLeftTracker();
    expect(tracker.update("p1", true)).toBe(false);
    expect(tracker.update("p1", false)).toBe(true);
    expect(tracker.update("p2", false)).toBe(false);
  });
});

describe("createStickyLastPromptPublisher", () => {
  it("starts with no prompt and the bar hidden", () => {
    const publisher = createStickyLastPromptPublisher();
    expect(publisher.getState()).toEqual({ prompt: null, barVisible: false });
  });

  it("notifies subscribers only when the published state actually changes", () => {
    const publisher = createStickyLastPromptPublisher();
    const listener = vi.fn();
    publisher.subscribe(listener);

    const prompt = user("p1", 1) as UserMessageItem;
    publisher.publish({ prompt, barVisible: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(publisher.getState()).toEqual({ prompt, barVisible: true });

    publisher.publish({ prompt, barVisible: true });
    expect(listener).toHaveBeenCalledTimes(1);

    publisher.publish({ prompt, barVisible: false });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stops notifying after unsubscribe", () => {
    const publisher = createStickyLastPromptPublisher();
    const listener = vi.fn();
    const unsubscribe = publisher.subscribe(listener);
    unsubscribe();

    publisher.publish({ prompt: user("p1", 1) as UserMessageItem, barVisible: true });
    expect(listener).not.toHaveBeenCalled();
  });
});
