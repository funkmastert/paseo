import { describe, expect, it } from "vitest";
import { shouldShowJumpToStart } from "./jump-to-start-visibility";

describe("shouldShowJumpToStart", () => {
  it("hides at the true start of the session", () => {
    expect(shouldShowJumpToStart({ hasOlderHistory: false, isNearHistoryStart: true })).toBe(false);
  });

  it("shows when there is older history still to load, even near the top of the loaded window", () => {
    expect(shouldShowJumpToStart({ hasOlderHistory: true, isNearHistoryStart: true })).toBe(true);
  });

  it("shows when scrolled away from the start, even with nothing older left to load", () => {
    expect(shouldShowJumpToStart({ hasOlderHistory: false, isNearHistoryStart: false })).toBe(true);
  });

  it("shows when both scrolled away and there is older history to load", () => {
    expect(shouldShowJumpToStart({ hasOlderHistory: true, isNearHistoryStart: false })).toBe(true);
  });
});
