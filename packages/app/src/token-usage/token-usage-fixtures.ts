import type { TokenUsageBreakdown, TokenUsageRange, TokenUsageRow } from "./token-usage-model";

/**
 * Realistic fixture data standing in for the real `usage.tokens.get_breakdown` RPC until U3's
 * protocol unit and U5's `use-token-usage.ts` land. Several Claude and Codex models, three roles,
 * one "unknown" model row, scaled per range so switching ranges visibly changes the screen.
 */
function buildRows(scale: number): TokenUsageRow[] {
  return [
    {
      provider: "claude",
      model: "claude-opus-5-5",
      role: "leader",
      input: Math.round(12_000_000 * scale),
      cacheWrite: Math.round(8_000_000 * scale),
      cacheRead: Math.round(180_000_000 * scale),
      output: Math.round(4_500_000 * scale),
      weighted: Math.round(45_000_000 * scale),
      responses: Math.round(1200 * scale),
    },
    {
      provider: "claude",
      model: "claude-opus-5-5",
      role: "worker",
      input: Math.round(30_000_000 * scale),
      cacheWrite: Math.round(20_000_000 * scale),
      cacheRead: Math.round(400_000_000 * scale),
      output: Math.round(9_000_000 * scale),
      weighted: Math.round(95_000_000 * scale),
      responses: Math.round(3100 * scale),
    },
    {
      provider: "claude",
      model: "claude-sonnet-5-5",
      role: "worker",
      input: Math.round(5_000_000 * scale),
      cacheWrite: Math.round(2_000_000 * scale),
      cacheRead: Math.round(40_000_000 * scale),
      output: Math.round(1_600_000 * scale),
      weighted: Math.round(7_400_000 * scale),
      responses: Math.round(900 * scale),
    },
    {
      provider: "claude",
      model: "claude-haiku-4-5",
      role: "outside",
      input: Math.round(800_000 * scale),
      cacheWrite: Math.round(400_000 * scale),
      cacheRead: Math.round(6_000_000 * scale),
      output: Math.round(300_000 * scale),
      weighted: Math.round(1_100_000 * scale),
      responses: Math.round(400 * scale),
    },
    {
      provider: "codex",
      model: "gpt-5-codex",
      role: "leader",
      input: Math.round(6_000_000 * scale),
      cacheWrite: 0,
      cacheRead: Math.round(20_000_000 * scale),
      output: Math.round(3_000_000 * scale),
      weighted: Math.round(16_000_000 * scale),
      responses: Math.round(500 * scale),
    },
    {
      provider: "codex",
      model: "gpt-5-codex",
      role: "worker",
      input: Math.round(2_500_000 * scale),
      cacheWrite: 0,
      cacheRead: Math.round(9_000_000 * scale),
      output: Math.round(1_200_000 * scale),
      weighted: Math.round(7_400_000 * scale),
      responses: Math.round(220 * scale),
    },
    {
      provider: "codex",
      model: "unknown",
      role: "outside",
      input: Math.round(40_000 * scale),
      cacheWrite: 0,
      cacheRead: Math.round(10_000 * scale),
      output: Math.round(6_000 * scale),
      weighted: Math.round(16_000 * scale),
      responses: Math.round(12 * scale),
    },
  ];
}

const RANGE_SCALE: Record<TokenUsageRange, number> = {
  "24h": 1,
  "7d": 5,
  "30d": 18,
};

/** The steady-state fixture: rows populated, backfill already done. */
export function buildTokenUsageFixture(range: TokenUsageRange): TokenUsageBreakdown {
  const now = Date.now();
  return {
    requestId: `fixture-${range}`,
    generatedAt: now,
    range,
    rangeStartMs: now - rangeDurationMs(range),
    rows: buildRows(RANGE_SCALE[range]),
    coverage: {
      enabled: true,
      recordingSinceMs: now - rangeDurationMs("30d"),
      backfill: { state: "done", filesDone: 15_500, filesTotal: 15_500 },
    },
  };
}

/** A second fixture showing the backfill-running state (R11), for the empty/progress states. */
export function buildTokenUsageBackfillingFixture(range: TokenUsageRange): TokenUsageBreakdown {
  const now = Date.now();
  return {
    requestId: `fixture-backfilling-${range}`,
    generatedAt: now,
    range,
    rangeStartMs: now - rangeDurationMs(range),
    rows: [],
    coverage: {
      enabled: true,
      recordingSinceMs: now - rangeDurationMs("30d"),
      backfill: { state: "running", filesDone: 4_200, filesTotal: 15_500 },
    },
  };
}

function rangeDurationMs(range: TokenUsageRange): number {
  switch (range) {
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return 30 * 24 * 60 * 60 * 1000;
  }
}
