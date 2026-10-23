import { describe, expect, it } from "vitest";
import type { StreamItem, UserMessageItem } from "@/types/stream";
import { selectRecentPrompts } from "./model";
import {
  canStepBack,
  canStepForward,
  reconcileSelectionOnNewPrompts,
  resolveInitialSelection,
  resolvePositionLabel,
  resolveSelectedPrompt,
  stepSelection,
} from "./navigator-model";

function at(second: number): Date {
  return new Date(`2026-01-01T00:00:${second.toString().padStart(2, "0")}.000Z`);
}

function user(id: string, second: number): UserMessageItem {
  return { kind: "user_message", id, text: id, timestamp: at(second) };
}

function assistant(id: string, second: number): StreamItem {
  return { kind: "assistant_message", id, text: id, timestamp: at(second) };
}

describe("selectRecentPrompts", () => {
  it("returns all user_message items in order across a mixed list", () => {
    const items = [user("p1", 1), assistant("a1", 2), user("p2", 3), assistant("a2", 4)];
    expect(selectRecentPrompts(items).map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("returns an empty array when there are no user messages", () => {
    expect(selectRecentPrompts([assistant("a1", 1), assistant("a2", 2)])).toEqual([]);
  });

  it("returns an empty array for an empty list", () => {
    expect(selectRecentPrompts([])).toEqual([]);
  });
});

describe("resolveInitialSelection", () => {
  it("selects the newest prompt", () => {
    const prompts = [user("p1", 1), user("p2", 2), user("p3", 3)];
    expect(resolveInitialSelection(prompts).selectedIndex).toBe(2);
  });

  it("is the empty selection for no prompts", () => {
    expect(resolveInitialSelection([]).selectedIndex).toBe(-1);
  });
});

describe("stepSelection", () => {
  const prompts = [user("p1", 1), user("p2", 2), user("p3", 3)];

  it("steps back and is a no-op at index 0", () => {
    const selection = { prompts, selectedIndex: 1 };
    expect(stepSelection(selection, "back").selectedIndex).toBe(0);
    expect(stepSelection({ prompts, selectedIndex: 0 }, "back").selectedIndex).toBe(0);
  });

  it("steps forward and is a no-op at the last index", () => {
    const selection = { prompts, selectedIndex: 1 };
    expect(stepSelection(selection, "forward").selectedIndex).toBe(2);
    expect(stepSelection({ prompts, selectedIndex: 2 }, "forward").selectedIndex).toBe(2);
  });
});

describe("canStepBack / canStepForward", () => {
  it("reflects the bounds for a multi-prompt list", () => {
    const prompts = [user("p1", 1), user("p2", 2), user("p3", 3)];
    expect(canStepBack({ prompts, selectedIndex: 0 })).toBe(false);
    expect(canStepBack({ prompts, selectedIndex: 1 })).toBe(true);
    expect(canStepForward({ prompts, selectedIndex: 2 })).toBe(false);
    expect(canStepForward({ prompts, selectedIndex: 1 })).toBe(true);
  });

  it("reflects the bounds for a single-prompt list", () => {
    const prompts = [user("p1", 1)];
    expect(canStepBack({ prompts, selectedIndex: 0 })).toBe(false);
    expect(canStepForward({ prompts, selectedIndex: 0 })).toBe(false);
  });

  it("is false in both directions for an empty list", () => {
    expect(canStepBack({ prompts: [], selectedIndex: -1 })).toBe(false);
    expect(canStepForward({ prompts: [], selectedIndex: -1 })).toBe(false);
  });
});

describe("resolvePositionLabel", () => {
  it("renders 1-based position/total", () => {
    const prompts = [user("p1", 1)];
    expect(resolvePositionLabel({ prompts, selectedIndex: 0 })).toBe("1/1");

    const seven = Array.from({ length: 7 }, (_, i) => user(`p${i}`, i));
    expect(resolvePositionLabel({ prompts: seven, selectedIndex: 2 })).toBe("3/7");
  });

  it("is null for the empty selection", () => {
    expect(resolvePositionLabel({ prompts: [], selectedIndex: -1 })).toBeNull();
  });
});

describe("reconcileSelectionOnNewPrompts", () => {
  it("resets to the new newest when the newest prompt id changed", () => {
    const previous = resolveInitialSelection([user("p1", 1), user("p2", 2)]);
    const next = [user("p1", 1), user("p2", 2), user("p3", 3)];
    const reconciled = reconcileSelectionOnNewPrompts(previous, next);
    expect(resolveSelectedPrompt(reconciled)?.id).toBe("p3");
  });

  it("keeps the same prompt selected when older history is prepended", () => {
    const initial = [user("p3", 3), user("p4", 4), user("p5", 5)];
    const previous = stepSelection(resolveInitialSelection(initial), "back"); // selects p4
    expect(resolveSelectedPrompt(previous)?.id).toBe("p4");

    const grown = [user("p1", 1), user("p2", 2), ...initial];
    const reconciled = reconcileSelectionOnNewPrompts(previous, grown);
    expect(resolveSelectedPrompt(reconciled)?.id).toBe("p4");
    expect(reconciled.selectedIndex).toBe(3);
  });

  it("is referentially stable when the prompt list is unchanged", () => {
    const prompts = [user("p1", 1), user("p2", 2)];
    const previous = resolveInitialSelection(prompts);
    expect(reconcileSelectionOnNewPrompts(previous, prompts)).toBe(previous);
  });

  it("is referentially stable even when passed a new array with the same prompts in the same order", () => {
    // A streaming tick rebuilds the combined tail+head array (and re-filters it) on every
    // chunk even when no user message changed -- the result must still be a no-op so the
    // navigator hook's `next !== selectionRef.current` check can skip a re-render.
    const original = [user("p1", 1), user("p2", 2), user("p3", 3)];
    const previous = resolveInitialSelection(original);
    const recomputed = [user("p1", 1), user("p2", 2), user("p3", 3)];
    expect(reconcileSelectionOnNewPrompts(previous, recomputed)).toBe(previous);
  });

  it("resets to empty when the next prompt list is empty", () => {
    const previous = resolveInitialSelection([user("p1", 1)]);
    expect(reconcileSelectionOnNewPrompts(previous, []).selectedIndex).toBe(-1);
  });
});
