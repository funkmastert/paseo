import { describe, expect, it } from "vitest";
import {
  buildTokenUsageModelBars,
  buildTokenUsageRoleTotals,
  formatCompactTokens,
  hasIncompleteAttribution,
  normalizeTokenUsageRole,
  resolveTokenUsageDisplayState,
  type TokenUsageCoverage,
  type TokenUsageRow,
} from "./token-usage-model";

function row(overrides: Partial<TokenUsageRow>): TokenUsageRow {
  return {
    provider: "claude",
    model: "claude-opus-5-5",
    role: "leader",
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    weighted: 0,
    responses: 0,
    ...overrides,
  };
}

const EMPTY_COVERAGE: TokenUsageCoverage = {
  enabled: true,
  recordingSinceMs: null,
  backfill: { state: "done", filesDone: 10, filesTotal: 10 },
};

describe("buildTokenUsageModelBars", () => {
  it("sorts bars by total with role fractions summing to the bar's share", () => {
    const rows: TokenUsageRow[] = [
      row({
        provider: "claude",
        model: "claude-opus-5-5",
        role: "leader",
        weighted: 600,
        input: 600,
      }),
      row({
        provider: "claude",
        model: "claude-opus-5-5",
        role: "worker",
        weighted: 400,
        input: 400,
      }),
      row({ provider: "codex", model: "gpt-5-codex", role: "leader", weighted: 300, input: 300 }),
      row({ provider: "codex", model: "gpt-5-codex", role: "outside", weighted: 200, input: 200 }),
    ];

    const bars = buildTokenUsageModelBars(rows, "weighted");

    expect(bars.map((bar) => bar.id)).toEqual(["claude/claude-opus-5-5", "codex/gpt-5-codex"]);
    expect(bars[0]?.total).toBe(1000);
    expect(bars[1]?.total).toBe(500);

    for (const bar of bars) {
      const fractionSum = bar.segments.reduce((sum, segment) => sum + segment.fraction, 0);
      expect(fractionSum).toBeCloseTo(bar.share, 10);
    }
  });

  it("changes totals and order between weighted and raw when cache reads dominate a model", () => {
    const rows: TokenUsageRow[] = [
      // Weighted by `weighTokenUsage`-style ratios: cache reads are cheap, so this model's raw
      // total is huge but its weighted total is small.
      row({
        provider: "claude",
        model: "claude-haiku-4-5",
        role: "worker",
        cacheRead: 1_000_000,
        weighted: 50_000,
      }),
      row({
        provider: "claude",
        model: "claude-opus-5-5",
        role: "leader",
        input: 200_000,
        weighted: 200_000,
      }),
    ];

    const weighted = buildTokenUsageModelBars(rows, "weighted");
    expect(weighted.map((bar) => bar.model)).toEqual(["claude-opus-5-5", "claude-haiku-4-5"]);

    const raw = buildTokenUsageModelBars(rows, "raw");
    expect(raw.map((bar) => bar.model)).toEqual(["claude-haiku-4-5", "claude-opus-5-5"]);
    expect(raw[0]?.total).toBe(1_000_000);
  });

  it('trails model "unknown" as a last, unattributed row', () => {
    const rows: TokenUsageRow[] = [
      row({ provider: "claude", model: "claude-opus-5-5", weighted: 100 }),
      row({ provider: "claude", model: "unknown", role: "outside", weighted: 10_000 }),
    ];

    const bars = buildTokenUsageModelBars(rows, "weighted");

    expect(bars.at(-1)?.isUnattributed).toBe(true);
    expect(bars.at(-1)?.label).toBe("Unattributed");
    expect(hasIncompleteAttribution(rows, "weighted")).toBe(true);
    expect(hasIncompleteAttribution(rows, "raw")).toBe(false);
  });
});

describe("buildTokenUsageRoleTotals", () => {
  it("always returns leader, worker and outside, zeroed when absent", () => {
    const rows: TokenUsageRow[] = [row({ role: "leader", weighted: 500 })];
    const totals = buildTokenUsageRoleTotals(rows, "weighted");
    expect(totals.map((entry) => entry.role)).toEqual(["leader", "worker", "outside"]);
    expect(totals.find((entry) => entry.role === "worker")?.total).toBe(0);
  });

  it("books a role the app doesn't recognize yet under outside", () => {
    // `role` is an open string on the wire (docs/protocol-compatibility.md): a daemon may add a
    // fourth role before this app knows about it.
    const rows: TokenUsageRow[] = [row({ role: "reviewer", weighted: 500 })];
    const totals = buildTokenUsageRoleTotals(rows, "weighted");
    expect(totals.find((entry) => entry.role === "outside")?.total).toBe(500);
    expect(totals.find((entry) => entry.role === "leader")?.total).toBe(0);
    expect(totals.find((entry) => entry.role === "worker")?.total).toBe(0);
  });
});

describe("normalizeTokenUsageRole", () => {
  it("passes leader and worker through unchanged", () => {
    expect(normalizeTokenUsageRole("leader")).toBe("leader");
    expect(normalizeTokenUsageRole("worker")).toBe("worker");
  });

  it("maps outside, and anything it doesn't recognize, to outside", () => {
    expect(normalizeTokenUsageRole("outside")).toBe("outside");
    expect(normalizeTokenUsageRole("reviewer")).toBe("outside");
    expect(normalizeTokenUsageRole("")).toBe("outside");
  });
});

describe("resolveTokenUsageDisplayState", () => {
  it("shows the progress state while backfill runs with no rows yet", () => {
    const state = resolveTokenUsageDisplayState({
      rows: [],
      coverage: { ...EMPTY_COVERAGE, backfill: { state: "running", filesDone: 3, filesTotal: 10 } },
    });
    expect(state).toEqual({ kind: "backfilling", filesDone: 3, filesTotal: 10 });
  });

  it("shows the empty state once backfill is done with no rows", () => {
    const state = resolveTokenUsageDisplayState({ rows: [], coverage: EMPTY_COVERAGE });
    expect(state).toEqual({ kind: "empty" });
  });

  it("shows data once rows exist, regardless of backfill state", () => {
    const state = resolveTokenUsageDisplayState({
      rows: [row({ weighted: 1 })],
      coverage: { ...EMPTY_COVERAGE, backfill: { state: "running", filesDone: 1, filesTotal: 10 } },
    });
    expect(state).toEqual({ kind: "data" });
  });

  it('treats a backfill state it doesn\'t recognize yet as "done" — no progress banner', () => {
    // `backfill.state` is an open string too (docs/protocol-compatibility.md): a daemon may add a
    // state this app predates.
    const state = resolveTokenUsageDisplayState({
      rows: [],
      coverage: { ...EMPTY_COVERAGE, backfill: { state: "paused", filesDone: 3, filesTotal: 10 } },
    });
    expect(state).toEqual({ kind: "empty" });
  });

  it("shows the error state when the payload carries one, even with rows present", () => {
    // The daemon's error path still carries rows: [] today, but the error check must not depend
    // on that — a future response could carry stale rows alongside a read failure.
    const state = resolveTokenUsageDisplayState({
      rows: [row({ weighted: 1 })],
      coverage: EMPTY_COVERAGE,
      error: "Failed to read token usage: ENOENT",
    });
    expect(state).toEqual({ kind: "error", message: "Failed to read token usage: ENOENT" });
  });

  it("shows the disabled state when coverage.enabled is false, ahead of the empty fallback", () => {
    const state = resolveTokenUsageDisplayState({
      rows: [],
      coverage: {
        enabled: false,
        recordingSinceMs: null,
        backfill: { state: "off", filesDone: 0, filesTotal: 0 },
      },
    });
    expect(state).toEqual({ kind: "disabled" });
  });
});

describe("formatCompactTokens", () => {
  it.each([
    [245_000_000, "245M"],
    [7_400_000, "7.4M"],
    [16_000, "16K"],
    [900, "900"],
  ])("formats %d as %s", (value, expected) => {
    expect(formatCompactTokens(value)).toBe(expected);
  });
});
