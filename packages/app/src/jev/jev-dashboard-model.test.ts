import { describe, expect, it } from "vitest";
import {
  buildJevDashboardDayBars,
  buildJevDashboardFeatureRows,
  buildJevDashboardTiles,
  formatOtherBenefit,
  formatSignedTokens,
  formatTokens,
  formatTokensWithEstimate,
  formatTileUsd,
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
    expect(cost?.usdKind).toBe("billed");
    expect(cost?.tokens).toBe(7500);
    expect(cost?.caption).toBe("3 calls");
  });

  it("prices saved, would-have-saved and net at Opus 5.5 list prices ($4 per million)", () => {
    const tiles = buildJevDashboardTiles(
      summary({
        live: { involvements: 4, tokensSaved: 250_000 },
        shadow: { involvements: 9, tokensWouldSave: 6_908_965 },
        net: { live: 120_000, ifLive: 6_000_000 },
      }),
    );
    const byId = (id: string) => tiles.find((tile) => tile.id === id);
    expect(byId("saved")?.usd).toBeCloseTo(1, 6);
    expect(byId("would-have-saved")?.usd).toBeCloseTo(27.63586, 4);
    expect(byId("net")?.usd).toBeCloseTo(0.48, 6);
    for (const id of ["saved", "would-have-saved", "net"]) {
      expect(byId(id)?.usdKind).toBe("list-price");
    }
  });

  it("carries a negative net into its dollar line with the sign kept", () => {
    const tiles = buildJevDashboardTiles(summary({ net: { live: -50_000, ifLive: -10_000 } }));
    const net = tiles.find((tile) => tile.id === "net");
    expect(net?.usd).toBeCloseTo(-0.2, 6);
    expect(net && formatTileUsd(net)).toBe("≈ -$0.20 at API prices");
  });

  it("names the estimated share in the caption, summed across every feature", () => {
    const tiles = buildJevDashboardTiles(
      summary({
        live: { involvements: 10, tokensSaved: 1000 },
        shadow: { involvements: 5, tokensWouldSave: 9000 },
        features: [
          featureSummary({
            feature: "spawnHint",
            live: {
              involvements: 6,
              changed: 0,
              tokens: 600,
              otherBenefit: null,
              pending: 0,
              estimatedTokens: 200,
            },
            shadow: {
              involvements: 2,
              changed: 0,
              tokens: 4000,
              otherBenefit: null,
              pending: 0,
              estimatedTokens: 1000,
            },
          }),
          featureSummary({
            feature: "readCheck",
            live: {
              involvements: 4,
              changed: 0,
              tokens: 400,
              otherBenefit: null,
              pending: 0,
              estimatedTokens: 50,
            },
            shadow: {
              involvements: 3,
              changed: 0,
              tokens: 5000,
              otherBenefit: null,
              pending: 0,
              estimatedTokens: 0,
            },
          }),
        ],
      }),
    );
    expect(tiles.find((tile) => tile.id === "saved")?.caption).toBe(
      "10 involvements · ~250 estimated",
    );
    expect(tiles.find((tile) => tile.id === "would-have-saved")?.caption).toBe(
      "5 in shadow · ~1,000 estimated",
    );
  });

  it("leaves the caption plain when nothing is estimated", () => {
    const tiles = buildJevDashboardTiles(summary({ live: { involvements: 1, tokensSaved: 100 } }));
    expect(tiles.find((tile) => tile.id === "saved")?.caption).toBe("1 involvement");
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
      "titleRefresh",
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

  it("carries each side's estimated tokens separately from the measured total", () => {
    const rows = buildJevDashboardFeatureRows(
      summary({
        features: [
          featureSummary({
            feature: "titleRefresh",
            live: {
              involvements: 5,
              changed: 2,
              tokens: 300,
              otherBenefit: null,
              pending: 0,
              estimatedTokens: 120,
            },
            shadow: {
              involvements: 1,
              changed: 0,
              tokens: 60,
              otherBenefit: null,
              pending: 0,
              estimatedTokens: 0,
            },
          }),
        ],
      }),
    );
    const row = rows.find((entry) => entry.feature === "titleRefresh");
    expect(row?.liveEstimatedTokens).toBe(120);
    expect(row?.shadowEstimatedTokens).toBe(0);
  });

  it("defaults estimated tokens to zero when the ledger omits them", () => {
    const rows = buildJevDashboardFeatureRows(
      summary({ features: [featureSummary({ feature: "spawnHint" })] }),
    );
    const row = rows.find((entry) => entry.feature === "spawnHint");
    expect(row?.liveEstimatedTokens).toBe(0);
    expect(row?.shadowEstimatedTokens).toBe(0);
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

describe("formatTokensWithEstimate", () => {
  it("names the estimated share in parentheses", () => {
    expect(formatTokensWithEstimate(1000, 200)).toBe("1,000 (~200 est.)");
  });

  it("falls back to the plain figure when nothing is estimated", () => {
    expect(formatTokensWithEstimate(1000, 0)).toBe("1,000");
  });
});

describe("formatSignedTokens", () => {
  it("signs positive and negative, no sign for zero", () => {
    expect(formatSignedTokens(500)).toBe("+500");
    expect(formatSignedTokens(-500)).toBe("-500");
    expect(formatSignedTokens(0)).toBe("0");
  });
});

describe("formatTileUsd", () => {
  it("marks a list-price figure as a comparison and shows real spend as is", () => {
    expect(formatTileUsd({ usd: 27.64, usdKind: "list-price" })).toBe("≈ $27.64 at API prices");
    expect(formatTileUsd({ usd: 0.53, usdKind: "billed" })).toBe("$0.53");
    expect(formatTileUsd({ usd: null, usdKind: "list-price" })).toBeNull();
  });

  it("keeps the sign of a negative net", () => {
    expect(formatTileUsd({ usd: -0.2, usdKind: "list-price" })).toBe("≈ -$0.20 at API prices");
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
