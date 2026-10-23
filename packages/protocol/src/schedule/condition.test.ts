import { describe, expect, it } from "vitest";
import {
  conditionFromNames,
  conditionNames,
  parseConditionNames,
  ScheduleConditionSchema,
} from "./condition.js";
import { StoredScheduleSchema } from "./types.js";

describe("schedule condition", () => {
  it("reads one name as that leaf and several as any-of", () => {
    expect(conditionFromNames(["hasActiveChildren"])).toEqual({ type: "hasActiveChildren" });
    expect(conditionFromNames(["hasActiveChildren", "childFinishedSince"])).toEqual({
      type: "any",
      conditions: [{ type: "hasActiveChildren" }, { type: "childFinishedSince" }],
    });
  });

  it("parses a comma list and rejects unknown names", () => {
    expect(parseConditionNames("hasActiveChildren, childFinishedSince")).toEqual([
      "hasActiveChildren",
      "childFinishedSince",
    ]);
    expect(() => parseConditionNames("whenever")).toThrow('Unknown condition "whenever"');
    expect(() => parseConditionNames(" , ")).toThrow("Condition is empty");
  });

  it("round-trips names through the wire schema", () => {
    const condition = conditionFromNames(["hasActiveChildren", "childFinishedSince"]);
    expect(conditionNames(ScheduleConditionSchema.parse(condition))).toEqual([
      "hasActiveChildren",
      "childFinishedSince",
    ]);
  });

  it("does not nest any-of inside any-of", () => {
    expect(
      ScheduleConditionSchema.safeParse({
        type: "any",
        conditions: [{ type: "any", conditions: [{ type: "always" }] }],
      }).success,
    ).toBe(false);
  });

  it("leaves a stored schedule written before conditions valid", () => {
    const parsed = StoredScheduleSchema.parse({
      id: "abc",
      name: null,
      prompt: "tick",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "00000000-0000-4000-8000-000000000000" },
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });
    expect(parsed.condition).toBeUndefined();
  });
});
