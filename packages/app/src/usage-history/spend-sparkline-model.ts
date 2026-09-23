import type { UsageHistoryAgent } from "@getpaseo/protocol/usage-history/rpc-schemas";

export const SPARKLINE_WIDTH = 160;
export const SPARKLINE_HEIGHT = 28;
const PADDING = 2;

export type SpendSparklineModel =
  | { kind: "empty" }
  | {
      kind: "line";
      /** SVG path over a `SPARKLINE_WIDTH` x `SPARKLINE_HEIGHT` box. */
      path: string;
      totalWeightedTokens: number;
      /** First to last recorded point. */
      spanMs: number;
      /** The last point, so the dot marks where the line currently stands. */
      endX: number;
      endY: number;
    };

/**
 * Turns an agent's cumulative weighted spend into a line. The x axis is time, not point index:
 * the daemon holds the line flat through quiet stretches and only records when spend advances, so
 * spacing by index would draw a burst after a quiet hour as the same slope as steady work.
 *
 * Fewer than two distinct points is `empty`: one point is a total, not a shape, and drawing it as
 * a flat line would say the agent's spend never moved.
 */
export function buildSpendSparklineModel(
  agent: UsageHistoryAgent | undefined,
): SpendSparklineModel {
  if (!agent || agent.points.length < 2) return { kind: "empty" };
  const points = agent.points.map((point) => ({
    atMs: Date.parse(point.at),
    weightedTokens: point.weightedTokens,
  }));
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || !Number.isFinite(first.atMs) || !Number.isFinite(last.atMs)) {
    return { kind: "empty" };
  }
  const spanMs = last.atMs - first.atMs;
  if (spanMs <= 0) return { kind: "empty" };
  const floor = first.weightedTokens;
  const rise = last.weightedTokens - floor;
  const innerWidth = SPARKLINE_WIDTH - PADDING * 2;
  const innerHeight = SPARKLINE_HEIGHT - PADDING * 2;
  const toX = (atMs: number) => PADDING + ((atMs - first.atMs) / spanMs) * innerWidth;
  // A flat series (rise 0) sits on the baseline rather than dividing by zero.
  const toY = (weightedTokens: number) =>
    SPARKLINE_HEIGHT - PADDING - (rise > 0 ? ((weightedTokens - floor) / rise) * innerHeight : 0);
  const commands = points.map(
    (point, index) =>
      `${index === 0 ? "M" : "L"}${toX(point.atMs).toFixed(1)} ${toY(point.weightedTokens).toFixed(1)}`,
  );
  return {
    kind: "line",
    path: commands.join(" "),
    totalWeightedTokens: agent.totalWeightedTokens,
    spanMs,
    endX: toX(last.atMs),
    endY: toY(last.weightedTokens),
  };
}

/** 512k, 1.24M: one decimal of precision where it fits, since these are weighted, not raw, counts. */
export function formatWeightedTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 2)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return `${Math.round(value)}`;
}
