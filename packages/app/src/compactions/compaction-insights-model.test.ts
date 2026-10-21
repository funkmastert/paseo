import { describe, expect, it } from "vitest";
import type { CompactionEpisode } from "./use-compaction-episodes";
import {
  buildCompactionInsightsTiles,
  compactionOutcomeLabel,
  compactionOutcomeVariant,
  findMatchingCompactionEpisode,
  formatCompactionTokens,
  formatEpisodeContext,
  formatEpisodeCost,
  formatEpisodeMarkerLine,
  formatEpisodePayback,
  formatEpisodeTrigger,
} from "./compaction-insights-model";

function episode(overrides: Partial<CompactionEpisode> = {}): CompactionEpisode {
  return {
    id: "leader-1:1000",
    agentId: "leader-1",
    agentTitle: "Ship the thing",
    source: "monitor",
    trigger: "line",
    triggerReason: null,
    startedAtMs: 1000,
    endedAtMs: 1700,
    steps: [],
    contextBeforeTokens: 612_000,
    contextAfterTokens: 31_000,
    outcome: "done",
    noteLength: 120,
    costWeightedTokens: 175,
    costBasis: "measured",
    estimatedSavedWeightedTokens: 38_000,
    ...overrides,
  };
}

describe("formatCompactionTokens", () => {
  it("compacts into k/M the same way the JEV dashboard does", () => {
    expect(formatCompactionTokens(1_284)).toBe("1,284");
    expect(formatCompactionTokens(12_400)).toBe("12.4k");
    expect(formatCompactionTokens(3_100_000)).toBe("3.1M");
  });
});

describe("formatEpisodeCost", () => {
  it("renders a measured cost as a token figure", () => {
    expect(formatEpisodeCost(episode({ costBasis: "measured", costWeightedTokens: 175 }))).toBe(
      "175",
    );
  });

  it("renders an unmeasured episode plainly, never a fabricated figure", () => {
    expect(formatEpisodeCost(episode({ costBasis: "unmeasured", costWeightedTokens: null }))).toBe(
      "not measured",
    );
  });
});

describe("formatEpisodePayback", () => {
  it("renders an em dash when nothing has been computed yet", () => {
    expect(formatEpisodePayback(episode({ estimatedSavedWeightedTokens: null }))).toBe("—");
  });

  it("renders the estimate, marked as an estimate", () => {
    expect(formatEpisodePayback(episode({ estimatedSavedWeightedTokens: 38_000 }))).toBe(
      "~38.0k est.",
    );
  });
});

describe("formatEpisodeContext", () => {
  it("renders before and after tokens when both are known", () => {
    expect(
      formatEpisodeContext(episode({ contextBeforeTokens: 612_000, contextAfterTokens: 31_000 })),
    ).toBe("612.0k → 31.0k tokens");
  });

  it("renders just the before figure when after is unknown", () => {
    expect(
      formatEpisodeContext(episode({ contextBeforeTokens: 612_000, contextAfterTokens: null })),
    ).toBe("612.0k tokens");
  });

  it("renders a plain message when neither figure is known", () => {
    expect(
      formatEpisodeContext(episode({ contextBeforeTokens: null, contextAfterTokens: null })),
    ).toBe("unknown context size");
  });
});

describe("formatEpisodeTrigger", () => {
  it("describes each known trigger kind", () => {
    expect(formatEpisodeTrigger(episode({ trigger: "line" }))).toBe("crossed the line");
    expect(
      formatEpisodeTrigger(
        episode({ trigger: "early", triggerReason: "your last turn finished a unit of work" }),
      ),
    ).toBe("your last turn finished a unit of work");
    expect(formatEpisodeTrigger(episode({ trigger: "auto" }))).toBe("Claude Code auto-compact");
    expect(formatEpisodeTrigger(episode({ trigger: "manual" }))).toBe("manual /compact");
  });

  it("falls back to the raw string for a trigger kind this app doesn't know yet", () => {
    expect(formatEpisodeTrigger(episode({ trigger: "future-trigger" }))).toBe("future-trigger");
  });
});

describe("compaction outcome", () => {
  it("maps every known outcome to a label and a status variant", () => {
    expect(compactionOutcomeLabel("done")).toBe("Done");
    expect(compactionOutcomeVariant("done")).toBe("success");
    expect(compactionOutcomeLabel("gaveUp")).toBe("Gave up");
    expect(compactionOutcomeVariant("gaveUp")).toBe("warning");
    expect(compactionOutcomeLabel("cancelled")).toBe("Cancelled");
    expect(compactionOutcomeVariant("cancelled")).toBe("error");
    expect(compactionOutcomeLabel("interrupted")).toBe("Interrupted");
    expect(compactionOutcomeVariant("interrupted")).toBe("warning");
  });

  it("falls back to a muted unknown for an outcome this app doesn't know yet", () => {
    expect(compactionOutcomeLabel("future-outcome")).toBe("Unknown");
    expect(compactionOutcomeVariant("future-outcome")).toBe("muted");
  });
});

describe("buildCompactionInsightsTiles", () => {
  it("builds the four totals tiles from a summary", () => {
    const tiles = buildCompactionInsightsTiles({
      count: 3,
      totalCostWeightedTokens: 525,
      averageCostWeightedTokens: 175,
      totalEstimatedSavedWeightedTokens: 114_000,
      measuredCount: 3,
      unmeasuredCount: 0,
    });

    expect(tiles.map((tile) => tile.id)).toEqual([
      "count",
      "total-cost",
      "average-cost",
      "estimated-saved",
    ]);
    expect(tiles.find((tile) => tile.id === "count")).toMatchObject({
      value: "3",
      caption: "all measured",
    });
    expect(tiles.find((tile) => tile.id === "total-cost")).toMatchObject({ value: "525" });
    expect(tiles.find((tile) => tile.id === "average-cost")).toMatchObject({ value: "175" });
    expect(tiles.find((tile) => tile.id === "estimated-saved")).toMatchObject({
      value: "114.0k",
    });
  });

  it("names the partial-measurement count when some episodes are unmeasured", () => {
    const tiles = buildCompactionInsightsTiles({
      count: 4,
      totalCostWeightedTokens: 525,
      averageCostWeightedTokens: 175,
      totalEstimatedSavedWeightedTokens: 114_000,
      measuredCount: 3,
      unmeasuredCount: 1,
    });

    expect(tiles.find((tile) => tile.id === "count")).toMatchObject({
      caption: "3 of 4 measured",
    });
  });
});

describe("findMatchingCompactionEpisode", () => {
  it("matches a timestamp that falls inside an episode's span", () => {
    const target = episode({ id: "a", startedAtMs: 1000, endedAtMs: 2000 });
    expect(findMatchingCompactionEpisode([target], 1500)).toBe(target);
  });

  it("matches a timestamp just outside the span, within tolerance", () => {
    const target = episode({ id: "a", startedAtMs: 1000, endedAtMs: 2000 });
    expect(findMatchingCompactionEpisode([target], 2000 + 60_000)).toBe(target);
  });

  it("returns null when nothing is within tolerance", () => {
    const target = episode({ id: "a", startedAtMs: 1000, endedAtMs: 2000 });
    expect(findMatchingCompactionEpisode([target], 2000 + 60 * 60_000, 10 * 60_000)).toBeNull();
  });

  it("picks the closest episode among several for the same agent, not the first or last", () => {
    const early = episode({ id: "early", startedAtMs: 1000, endedAtMs: 1100 });
    const middle = episode({ id: "middle", startedAtMs: 500_000, endedAtMs: 500_100 });
    const late = episode({ id: "late", startedAtMs: 900_000, endedAtMs: 900_100 });

    expect(findMatchingCompactionEpisode([early, middle, late], 500_050, 10 * 60_000)).toBe(middle);
  });

  it("returns null for an empty episode list", () => {
    expect(findMatchingCompactionEpisode([], 1000)).toBeNull();
  });
});

describe("formatEpisodeMarkerLine", () => {
  it("composes context, trigger and cost into one line", () => {
    expect(
      formatEpisodeMarkerLine(
        episode({ contextBeforeTokens: 612_000, contextAfterTokens: 31_000, trigger: "line" }),
      ),
    ).toBe("612.0k → 31.0k tokens, crossed the line, cost 175");
  });

  it("says a cost is not measured rather than fabricating one", () => {
    expect(
      formatEpisodeMarkerLine(episode({ costBasis: "unmeasured", costWeightedTokens: null })),
    ).toContain("cost not measured");
  });
});
