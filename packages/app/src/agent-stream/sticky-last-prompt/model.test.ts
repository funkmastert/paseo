import { describe, expect, it, vi } from "vitest";
import type { StreamItem, UserMessageItem } from "@/types/stream";
import { createStickyLastPromptPublisher, selectLastPrompt } from "./model";

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

describe("createStickyLastPromptPublisher", () => {
  it("starts with no prompt", () => {
    const publisher = createStickyLastPromptPublisher();
    expect(publisher.getState()).toEqual({ prompt: null });
  });

  it("notifies subscribers only when the published state actually changes", () => {
    const publisher = createStickyLastPromptPublisher();
    const listener = vi.fn();
    publisher.subscribe(listener);

    const promptOne = user("p1", 1) as UserMessageItem;
    publisher.publish({ prompt: promptOne });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(publisher.getState()).toEqual({ prompt: promptOne });

    publisher.publish({ prompt: promptOne });
    expect(listener).toHaveBeenCalledTimes(1);

    const promptTwo = user("p2", 2) as UserMessageItem;
    publisher.publish({ prompt: promptTwo });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stops notifying after unsubscribe", () => {
    const publisher = createStickyLastPromptPublisher();
    const listener = vi.fn();
    const unsubscribe = publisher.subscribe(listener);
    unsubscribe();

    publisher.publish({ prompt: user("p1", 1) as UserMessageItem });
    expect(listener).not.toHaveBeenCalled();
  });
});
