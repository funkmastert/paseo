import { describe, expect, it } from "vitest";
import { conditionFromWake, HEARTBEAT_WAKE_ORDER, wakeFromCondition } from "./schedule-wake";

describe("schedule wake choices", () => {
  it("round-trips every choice through the wire condition", () => {
    for (const wake of HEARTBEAT_WAKE_ORDER) {
      expect(wakeFromCondition(conditionFromWake(wake) ?? undefined)).toBe(wake);
    }
  });

  it("reads a heartbeat with no condition as firing every tick", () => {
    expect(wakeFromCondition(undefined)).toBe("always");
    expect(conditionFromWake("always")).toBeNull();
  });

  it("reads a condition that includes always as firing every tick", () => {
    expect(
      wakeFromCondition({
        type: "any",
        conditions: [{ type: "always" }, { type: "hasActiveChildren" }],
      }),
    ).toBe("always");
  });
});
