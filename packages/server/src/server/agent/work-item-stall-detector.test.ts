import { describe, expect, test } from "vitest";
import {
  buildItemStallNudgePrompt,
  notStalledItemReason,
  recordItemObservation,
  type StallItemMemory,
  type StallItemView,
} from "./work-item-stall-detector.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = 1_000 * HOUR;
const THRESHOLD = 4 * HOUR;

function item(overrides: Partial<StallItemView> = {}): StallItemView {
  return {
    id: "wi_1",
    title: "Review",
    owner: "agent-a",
    state: "in-progress",
    revision: 3,
    updatedAtMs: NOW - 5 * HOUR,
    ...overrides,
  };
}

function freshMemory(overrides: Partial<StallItemMemory> = {}): StallItemMemory {
  return { revision: 3, sweepsAtRevision: 2, alreadyFound: false, ...overrides };
}

describe("recordItemObservation", () => {
  test("a first sighting starts at one sweep with no finding", () => {
    expect(recordItemObservation(undefined, 3)).toEqual({
      revision: 3,
      sweepsAtRevision: 1,
      alreadyFound: false,
    });
  });

  test("the same revision again counts another sweep", () => {
    const previous: StallItemMemory = { revision: 3, sweepsAtRevision: 1, alreadyFound: false };
    expect(recordItemObservation(previous, 3)).toEqual({
      revision: 3,
      sweepsAtRevision: 2,
      alreadyFound: false,
    });
  });

  test("a new revision resets the count and re-arms a closed finding", () => {
    const previous: StallItemMemory = { revision: 3, sweepsAtRevision: 5, alreadyFound: true };
    expect(recordItemObservation(previous, 4)).toEqual({
      revision: 4,
      sweepsAtRevision: 1,
      alreadyFound: false,
    });
  });
});

describe("notStalledItemReason", () => {
  function evaluate(overrides: {
    item?: Partial<StallItemView>;
    ownerIsLocalAgent?: boolean;
    ownerIdle?: boolean;
    memory?: Partial<StallItemMemory>;
    nowMs?: number;
  }): string | null {
    return notStalledItemReason({
      item: item(overrides.item),
      ownerIsLocalAgent: overrides.ownerIsLocalAgent ?? true,
      ownerIdle: overrides.ownerIdle ?? true,
      memory: freshMemory(overrides.memory),
      nowMs: overrides.nowMs ?? NOW,
      thresholdMs: THRESHOLD,
    });
  }

  test("a stalled item past every threshold is a finding", () => {
    expect(evaluate({})).toBeNull();
  });

  test.each<["pending" | "blocked" | "done"]>([["pending"], ["blocked"]])(
    "a %s item is not a stall candidate",
    (state) => {
      expect(evaluate({ item: { state } })).toBe(`is ${state}, not in-progress`);
    },
  );

  test("a human-owned or cross-host item is excluded", () => {
    expect(evaluate({ ownerIsLocalAgent: false })).toBe("owner is human or not a local agent");
  });

  test("a busy owner is never nudged", () => {
    expect(evaluate({ ownerIdle: false })).toBe("owner is busy");
  });

  test("one sweep at a revision is not enough", () => {
    expect(evaluate({ memory: { sweepsAtRevision: 1 } })).toBe(
      "seen unchanged for 1 sweep(s) of 2 required",
    );
  });

  test("an item unchanged but still inside the threshold is not overdue", () => {
    expect(evaluate({ item: { updatedAtMs: NOW - MINUTE } })).toBe(
      "unchanged for 1m of 240m required",
    );
  });

  test("a revision already nudged is not re-found until it changes", () => {
    expect(evaluate({ memory: { alreadyFound: true } })).toBe(
      "already nudged this revision; re-arms once the item changes",
    );
  });
});

describe("buildItemStallNudgePrompt", () => {
  test("names the item and teaches the closure marker", () => {
    const prompt = buildItemStallNudgePrompt({
      item: { id: "wi_1", title: "Review" },
      unchangedForMs: 5 * HOUR,
    });
    expect(prompt).toContain("wi_1");
    expect(prompt).toContain("Review");
    expect(prompt).toContain("queue: wi_1 done no-follow-on");
  });
});
