import { describe, expect, it } from "vitest";
import type { UsageHistoryAgent } from "@getpaseo/protocol/usage-history/rpc-schemas";
import {
  SPARKLINE_HEIGHT,
  SPARKLINE_WIDTH,
  buildSpendSparklineModel,
  formatWeightedTokens,
} from "./spend-sparkline-model";

const T0 = Date.UTC(2026, 8, 23, 12, 0, 0);
const MINUTE = 60_000;

function agent(points: Array<[number, number]>): UsageHistoryAgent {
  return {
    agentId: "agent-1",
    totalWeightedTokens: points.at(-1)?.[1] ?? 0,
    points: points.map(([minutes, weightedTokens]) => ({
      at: new Date(T0 + minutes * MINUTE).toISOString(),
      weightedTokens,
    })),
  };
}

describe("buildSpendSparklineModel", () => {
  it("draws nothing without at least two points: one point is a total, not a shape", () => {
    expect(buildSpendSparklineModel(undefined)).toEqual({ kind: "empty" });
    expect(buildSpendSparklineModel(agent([]))).toEqual({ kind: "empty" });
    expect(buildSpendSparklineModel(agent([[0, 100]]))).toEqual({ kind: "empty" });
  });

  it("puts the first point at the bottom left and the last at the top right", () => {
    const model = buildSpendSparklineModel(
      agent([
        [0, 100],
        [30, 600],
        [60, 1_100],
      ]),
    );
    expect(model.kind).toBe("line");
    if (model.kind !== "line") return;
    expect(model.path.startsWith(`M2.0 ${SPARKLINE_HEIGHT - 2}.0`)).toBe(true);
    expect(model.endX).toBe(SPARKLINE_WIDTH - 2);
    expect(model.endY).toBe(2);
    expect(model.spanMs).toBe(60 * MINUTE);
    expect(model.totalWeightedTokens).toBe(1_100);
  });

  it("spaces by time, so a burst after a quiet hour is steep and the quiet hour is flat", () => {
    // Flat for an hour (the daemon's plateau point), then a jump in the final minute.
    const model = buildSpendSparklineModel(
      agent([
        [0, 100],
        [59, 100],
        [60, 900],
      ]),
    );
    if (model.kind !== "line") throw new Error("expected a line");
    const [, second, third] = model.path.split(" L");
    const flatY = Number(second?.split(" ")[1]);
    expect(flatY).toBe(SPARKLINE_HEIGHT - 2);
    expect(Number(third?.split(" ")[1])).toBe(2);
    // The rise happens over about 1/60th of the width, not a third of it.
    const secondX = Number(second?.split(" ")[0]);
    expect(SPARKLINE_WIDTH - 2 - secondX).toBeLessThan(4);
  });

  it("sits a series with no rise on the baseline instead of dividing by zero", () => {
    const model = buildSpendSparklineModel(
      agent([
        [0, 500],
        [10, 500],
      ]),
    );
    if (model.kind !== "line") throw new Error("expected a line");
    expect(model.path).not.toContain("NaN");
    expect(model.endY).toBe(SPARKLINE_HEIGHT - 2);
  });

  it("draws nothing for points that share one instant or carry a bad timestamp", () => {
    expect(
      buildSpendSparklineModel(
        agent([
          [5, 1],
          [5, 2],
        ]),
      ),
    ).toEqual({ kind: "empty" });
    const broken = agent([
      [0, 1],
      [1, 2],
    ]);
    broken.points[0] = { at: "not a date", weightedTokens: 1 };
    expect(buildSpendSparklineModel(broken)).toEqual({ kind: "empty" });
  });
});

describe("formatWeightedTokens", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1_000, "1k"],
    [512_400, "512k"],
    [1_240_000, "1.24M"],
    [12_400_000, "12M"],
  ])("formats %i as %s", (value, expected) => {
    expect(formatWeightedTokens(value)).toBe(expected);
  });
});
