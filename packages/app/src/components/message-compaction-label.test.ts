import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n/i18next";
import type { CompactionEpisode } from "@/compactions/use-compaction-episodes";
import { getCompactionMarkerLabel } from "./message-compaction-label";

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

describe("getCompactionMarkerLabel", () => {
  it("renders loading, automatic, manual, tokenized, and fallback labels (no matched episode)", () => {
    expect(getCompactionMarkerLabel({ status: "loading" })).toBe("Compacting...");
    expect(getCompactionMarkerLabel({ status: "completed", trigger: "auto" })).toBe(
      "Context automatically compacted",
    );
    expect(getCompactionMarkerLabel({ status: "completed", trigger: "manual" })).toBe(
      "Context manually compacted",
    );
    expect(getCompactionMarkerLabel({ status: "completed", preTokens: 12_345 })).toBe(
      "Context compacted (12K tokens)",
    );
    expect(getCompactionMarkerLabel({ status: "completed" })).toBe("Context compacted");
  });

  it("renders labels in the active app language", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      expect(getCompactionMarkerLabel({ status: "loading" })).toBe("正在压缩...");
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("renders the joined episode's before -> after tokens, trigger and cost when matched", () => {
    expect(
      getCompactionMarkerLabel({ status: "completed", trigger: "manual", episode: episode() }),
    ).toBe("612.0k → 31.0k tokens, crossed the line, cost 175");
  });

  it("still shows loading first, even with a matched episode", () => {
    expect(getCompactionMarkerLabel({ status: "loading", episode: episode() })).toBe(
      "Compacting...",
    );
  });

  it("falls back to today's string when no episode matched (regression)", () => {
    expect(getCompactionMarkerLabel({ status: "completed", trigger: "auto", episode: null })).toBe(
      "Context automatically compacted",
    );
  });
});
