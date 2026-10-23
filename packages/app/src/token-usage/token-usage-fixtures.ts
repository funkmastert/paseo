import type { TokenUsageBreakdown, TokenUsageRange, TokenUsageRow } from "./token-usage-model";

/**
 * Fixture data for the browser test and screenshots, shaped exactly like the
 * `usage.tokens.get_breakdown` payload. Several Claude and Codex models, three roles, one
 * "unknown" model row, scaled per range so switching ranges visibly changes the screen.
 */
/** $/MTok for the models used below, mirroring packages/server/.../token-usage-pricing.ts. */
const FIXTURE_PRICES = {
  "claude-opus-5-5": { input: 4.0, cacheWrite: 5.0, cacheRead: 0.2, output: 20.0 },
  "claude-sonnet-5-5": { input: 2.0, cacheWrite: 2.5, cacheRead: 0.1, output: 10.0 },
  "claude-haiku-4-5": { input: 1.0, cacheWrite: 1.25, cacheRead: 0.1, output: 5.0 },
  "gpt-5.3-codex": { input: 1.75, cacheWrite: 1.75, cacheRead: 0.175, output: 14.0 },
} as const;

function fixtureCostUsd(
  model: keyof typeof FIXTURE_PRICES,
  counts: { input: number; cacheWrite: number; cacheRead: number; output: number },
): number {
  const price = FIXTURE_PRICES[model];
  return (
    (price.input * counts.input +
      price.cacheWrite * counts.cacheWrite +
      price.cacheRead * counts.cacheRead +
      price.output * counts.output) /
    1_000_000
  );
}

function buildRows(scale: number): TokenUsageRow[] {
  const opusLeader = {
    input: Math.round(12_000_000 * scale),
    cacheWrite: Math.round(8_000_000 * scale),
    cacheRead: Math.round(180_000_000 * scale),
    output: Math.round(4_500_000 * scale),
  };
  const opusWorker = {
    input: Math.round(30_000_000 * scale),
    cacheWrite: Math.round(20_000_000 * scale),
    cacheRead: Math.round(400_000_000 * scale),
    output: Math.round(9_000_000 * scale),
  };
  const sonnetWorker = {
    input: Math.round(5_000_000 * scale),
    cacheWrite: Math.round(2_000_000 * scale),
    cacheRead: Math.round(40_000_000 * scale),
    output: Math.round(1_600_000 * scale),
  };
  const haikuOutside = {
    input: Math.round(800_000 * scale),
    cacheWrite: Math.round(400_000 * scale),
    cacheRead: Math.round(6_000_000 * scale),
    output: Math.round(300_000 * scale),
  };
  const codexLeader = {
    input: Math.round(6_000_000 * scale),
    cacheWrite: 0,
    cacheRead: Math.round(20_000_000 * scale),
    output: Math.round(3_000_000 * scale),
  };
  const codexWorker = {
    input: Math.round(2_500_000 * scale),
    cacheWrite: 0,
    cacheRead: Math.round(9_000_000 * scale),
    output: Math.round(1_200_000 * scale),
  };

  return [
    {
      provider: "claude",
      model: "claude-opus-5-5",
      role: "leader",
      ...opusLeader,
      weighted: Math.round(45_000_000 * scale),
      responses: Math.round(1200 * scale),
      costUsd: fixtureCostUsd("claude-opus-5-5", opusLeader),
    },
    {
      provider: "claude",
      model: "claude-opus-5-5",
      role: "worker",
      ...opusWorker,
      weighted: Math.round(95_000_000 * scale),
      responses: Math.round(3100 * scale),
      costUsd: fixtureCostUsd("claude-opus-5-5", opusWorker),
    },
    {
      provider: "claude",
      model: "claude-sonnet-5-5",
      role: "worker",
      ...sonnetWorker,
      weighted: Math.round(7_400_000 * scale),
      responses: Math.round(900 * scale),
      costUsd: fixtureCostUsd("claude-sonnet-5-5", sonnetWorker),
    },
    {
      provider: "claude",
      model: "claude-haiku-4-5",
      role: "outside",
      ...haikuOutside,
      weighted: Math.round(1_100_000 * scale),
      responses: Math.round(400 * scale),
      costUsd: fixtureCostUsd("claude-haiku-4-5", haikuOutside),
    },
    {
      provider: "codex",
      // Priced: on OpenAI's current pricing page (unlike "gpt-5-codex", which isn't).
      model: "gpt-5.3-codex",
      role: "leader",
      ...codexLeader,
      weighted: Math.round(16_000_000 * scale),
      responses: Math.round(500 * scale),
      costUsd: fixtureCostUsd("gpt-5.3-codex", codexLeader),
    },
    {
      provider: "codex",
      model: "gpt-5.3-codex",
      role: "worker",
      ...codexWorker,
      weighted: Math.round(7_400_000 * scale),
      responses: Math.round(220 * scale),
      costUsd: fixtureCostUsd("gpt-5.3-codex", codexWorker),
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
      // Unpriced: demonstrates the "—" / unpriced-footer path.
      costUsd: null,
    },
  ];
}

function totalCostUsd(rows: TokenUsageRow[]): number {
  return rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
}

function unpricedTokens(rows: TokenUsageRow[]): number {
  return rows
    .filter((row) => row.costUsd === null)
    .reduce((sum, row) => sum + row.input + row.cacheWrite + row.cacheRead + row.output, 0);
}

const RANGE_SCALE: Record<TokenUsageRange, number> = {
  "24h": 1,
  "7d": 5,
  "30d": 18,
};

/** The steady-state fixture: rows populated, backfill already done. */
export function buildTokenUsageFixture(range: TokenUsageRange): TokenUsageBreakdown {
  const now = Date.now();
  const rows = buildRows(RANGE_SCALE[range]);
  return {
    requestId: `fixture-${range}`,
    generatedAt: new Date(now).toISOString(),
    range,
    rangeStartMs: now - rangeDurationMs(range),
    rows,
    coverage: {
      enabled: true,
      recordingSinceMs: now - rangeDurationMs("30d"),
      backfill: { state: "done", filesDone: 15_500, filesTotal: 15_500 },
    },
    totalCostUsd: totalCostUsd(rows),
    unpricedTokens: unpricedTokens(rows),
  };
}

/** A second fixture showing the backfill-running state (R11), for the empty/progress states. */
export function buildTokenUsageBackfillingFixture(range: TokenUsageRange): TokenUsageBreakdown {
  const now = Date.now();
  return {
    requestId: `fixture-backfilling-${range}`,
    generatedAt: new Date(now).toISOString(),
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

/** A failed read: rows empty, the payload's own `error` set (token-usage-session.ts's catch path). */
export function buildTokenUsageErrorFixture(range: TokenUsageRange): TokenUsageBreakdown {
  const now = Date.now();
  return {
    requestId: `fixture-error-${range}`,
    generatedAt: new Date(now).toISOString(),
    range,
    rangeStartMs: now - rangeDurationMs(range),
    rows: [],
    coverage: {
      enabled: true,
      recordingSinceMs: null,
      backfill: { state: "pending", filesDone: 0, filesTotal: 0 },
    },
    error: "Failed to read token usage: ENOENT: no such file or directory",
  };
}

/** The feature turned off in config (`agents.tokenUsage.enabled: false`). */
export function buildTokenUsageDisabledFixture(range: TokenUsageRange): TokenUsageBreakdown {
  const now = Date.now();
  return {
    requestId: `fixture-disabled-${range}`,
    generatedAt: new Date(now).toISOString(),
    range,
    rangeStartMs: now - rangeDurationMs(range),
    rows: [],
    coverage: {
      enabled: false,
      recordingSinceMs: null,
      backfill: { state: "off", filesDone: 0, filesTotal: 0 },
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
