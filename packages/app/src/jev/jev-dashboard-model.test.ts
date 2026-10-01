import { describe, expect, it } from "vitest";
import {
  buildJevDashboardDayBars,
  buildJevDashboardFeatureRows,
  buildJevDashboardTiles,
  formatOtherBenefit,
  formatSignedTokens,
  formatTokens,
  formatUsd,
  jevFeatureStateLabel,
} from "@/jev/jev-dashboard-model";
import type { JevSavingsFeatureSummary, JevSavingsSummary } from "@/jev/jev-savings-types";

function featureSummary(overrides: Partial<JevSavingsFeatureSummary>): JevSavingsFeatureSummary {
  const zeroTotals = { involvements: 0, changed: 0, tokens: 0, otherBenefit: null, pending: 0 };
  return {
    feature: "spawnHint",
    state: "shadow",
    benefit: "tokens",
    asked: 0,
    notAsked: {},
    live: { ...zeroTotals },
    shadow: { ...zeroTotals },
    validation: { checked: 0, held: 0, wrong: 0 },
    jevUsd: 0,
    evidence: { rule: "—", observed: "", met: null },
    ...overrides,
  };
}

function summary(overrides: Partial<JevSavingsSummary> = {}): JevSavingsSummary {
  return {
    range: "today",
    from: "2026-09-30T00:00:00.000Z",
    to: "2026-09-30T23:59:59.000Z",
    unit: "opus-equivalent-weighted-tokens",
    live: { involvements: 0, tokensSaved: 0 },
    shadow: { involvements: 0, tokensWouldSave: 0 },
    jevSpend: { calls: 0, usd: 0, tokensEquivalent: 0 },
    net: { live: 0, ifLive: 0 },
    features: [],
    topAgents: [],
    topWorkspaces: [],
    days: [],
    ...overrides,
  };
}

describe("jevFeatureStateLabel", () => {
  it("reads awayReply's shadow state as Dry run", () => {
    expect(jevFeatureStateLabel("awayReply", "shadow")).toBe("Dry run");
  });

  it("reads every other feature's shadow state as Shadow", () => {
    expect(jevFeatureStateLabel("spawnHint", "shadow")).toBe("Shadow");
    expect(jevFeatureStateLabel("readCheck", "shadow")).toBe("Shadow");
  });

  it("reads off, live and dormant the same for every feature", () => {
    expect(jevFeatureStateLabel("awayReply", "off")).toBe("Off");
    expect(jevFeatureStateLabel("agentTools", "live")).toBe("Live");
    expect(jevFeatureStateLabel("compactionTiming", "dormant")).toBe("Dormant");
  });
});

describe("buildJevDashboardTiles", () => {
  it("never sums shadow into live", () => {
    const tiles = buildJevDashboardTiles(
      summary({
        live: { involvements: 10, tokensSaved: 1000 },
        shadow: { involvements: 5, tokensWouldSave: 9000 },
        net: { live: 500, ifLive: 9500 },
      }),
    );
    const saved = tiles.find((tile) => tile.id === "saved");
    const wouldHaveSaved = tiles.find((tile) => tile.id === "would-have-saved");
    expect(saved?.tokens).toBe(1000);
    expect(wouldHaveSaved?.tokens).toBe(9000);
    expect(saved?.tokens).not.toBe((saved?.tokens ?? 0) + (wouldHaveSaved?.tokens ?? 0));
  });

  it("tones the net tile by sign", () => {
    const negative = buildJevDashboardTiles(summary({ net: { live: -50, ifLive: -10 } }));
    expect(negative.find((tile) => tile.id === "net")?.tone).toBe("shadow");
    const positive = buildJevDashboardTiles(summary({ net: { live: 50, ifLive: 10 } }));
    expect(positive.find((tile) => tile.id === "net")?.tone).toBe("live");
  });

  it("carries the JEV cost in both tokens and dollars", () => {
    const tiles = buildJevDashboardTiles(
      summary({ jevSpend: { calls: 3, usd: 0.03, tokensEquivalent: 7500 } }),
    );
    const cost = tiles.find((tile) => tile.id === "cost");
    expect(cost?.usd).toBe(0.03);
    expect(cost?.tokens).toBe(7500);
    expect(cost?.caption).toBe("3 calls");
  });
});

describe("buildJevDashboardFeatureRows", () => {
  it("orders every known feature, zeroed when the summary has nothing for it", () => {
    const rows = buildJevDashboardFeatureRows(summary());
    expect(rows.map((row) => row.feature)).toEqual([
      "spawnHint",
      "remediationTriage",
      "notificationTriage",
      "agentTools",
      "compactionTiming",
      "stallJudgment",
      "awayReply",
      "askJev",
      "readCheck",
    ]);
    expect(rows[0]?.involvements).toBe(0);
    expect(rows[0]?.evidenceMet).toBeNull();
  });

  it("shows no token figure for a feature whose benefit isn't tokens", () => {
    const rows = buildJevDashboardFeatureRows(
      summary({
        features: [
          featureSummary({
            feature: "notificationTriage",
            benefit: "attention",
            live: {
              involvements: 4,
              changed: 1,
              tokens: 999,
              otherBenefit: { unit: "pushes-held", value: 12 },
              pending: 0,
            },
          }),
        ],
      }),
    );
    const row = rows.find((entry) => entry.feature === "notificationTriage");
    expect(row?.liveTokens).toBeNull();
    expect(row?.shadowTokens).toBeNull();
    expect(row?.otherBenefitText).toBe("12 pushes held");
  });

  it("computes the wrong rate from validation counts, null until anything was checked", () => {
    const rows = buildJevDashboardFeatureRows(
      summary({
        features: [
          featureSummary({
            feature: "agentTools",
            validation: { checked: 20, held: 15, wrong: 5 },
          }),
        ],
      }),
    );
    const row = rows.find((entry) => entry.feature === "agentTools");
    expect(row?.wrongRatePct).toBe(25);

    const unchecked = buildJevDashboardFeatureRows(summary());
    expect(unchecked.find((entry) => entry.feature === "agentTools")?.wrongRatePct).toBeNull();
  });

  it("sums the not-asked reasons into one total", () => {
    const rows = buildJevDashboardFeatureRows(
      summary({
        features: [
          featureSummary({
            feature: "readCheck",
            notAsked: { "below-floor": 100, excluded: 5, inactive: 2 },
          }),
        ],
      }),
    );
    expect(rows.find((entry) => entry.feature === "readCheck")?.notAskedTotal).toBe(107);
  });
});

describe("buildJevDashboardDayBars", () => {
  it("normalizes each day to a fraction of the range's tallest day", () => {
    const bars = buildJevDashboardDayBars([
      { day: "2026-09-28", involvements: 1, liveTokens: 100, shadowTokens: 50, jevUsd: 0 },
      { day: "2026-09-29", involvements: 1, liveTokens: 400, shadowTokens: 200, jevUsd: 0 },
    ]);
    expect(bars[0]?.liveFraction).toBeCloseTo(0.25);
    expect(bars[0]?.shadowFraction).toBeCloseTo(0.125);
    expect(bars[1]?.liveFraction).toBe(1);
  });

  it("returns zero fractions instead of dividing by zero when every day is empty", () => {
    const bars = buildJevDashboardDayBars([
      { day: "2026-09-28", involvements: 0, liveTokens: 0, shadowTokens: 0, jevUsd: 0 },
    ]);
    expect(bars[0]?.liveFraction).toBe(0);
    expect(bars[0]?.shadowFraction).toBe(0);
  });
});

describe("formatTokens", () => {
  it("compacts at the thousand and million steps", () => {
    expect(formatTokens(284)).toBe("284");
    expect(formatTokens(12400)).toBe("12.4k");
    expect(formatTokens(3_100_000)).toBe("3.1M");
  });
});

describe("formatSignedTokens", () => {
  it("signs positive and negative, no sign for zero", () => {
    expect(formatSignedTokens(500)).toBe("+500");
    expect(formatSignedTokens(-500)).toBe("-500");
    expect(formatSignedTokens(0)).toBe("0");
  });
});

describe("formatUsd", () => {
  it("expands tiny amounts instead of rounding them to zero", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.0001)).toBe("$0.0001");
    expect(formatUsd(1.2)).toBe("$1.20");
  });
});

describe("formatOtherBenefit", () => {
  it("pluralizes pushes held", () => {
    expect(formatOtherBenefit({ unit: "pushes-held", value: 1 })).toBe("1 push held");
    expect(formatOtherBenefit({ unit: "pushes-held", value: 12 })).toBe("12 pushes held");
  });

  it("switches minutes to hours past an hour", () => {
    expect(formatOtherBenefit({ unit: "minutes", value: 45 })).toBe("45 min of waiting");
    expect(formatOtherBenefit({ unit: "minutes", value: 150 })).toBe("2.5 h of waiting");
  });
});
