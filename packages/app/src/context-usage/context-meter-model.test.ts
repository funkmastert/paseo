import { describe, expect, it } from "vitest";
import type { AgentContextUsage } from "@getpaseo/protocol/context-usage/rpc-schemas";
import haiku200k from "./test-fixtures/normalized-haiku-200k.json";
import opus1m from "./test-fixtures/normalized-opus-1m.json";
import {
  DEFAULT_CONTEXT_METER_THRESHOLDS,
  buildContextBreakdownView,
  buildReReadAdvice,
  formatContextTokens,
  resolveContextMeterThresholds,
  resolveContextMeterTone,
} from "./context-meter-model";

const opus = opus1m as AgentContextUsage;
const haiku = haiku200k as AgentContextUsage;
const thresholds = DEFAULT_CONTEXT_METER_THRESHOLDS;

describe("resolveContextMeterThresholds", () => {
  it("is the documented defaults without config", () => {
    expect(resolveContextMeterThresholds(undefined)).toEqual({
      amberTokens: 200_000,
      amberPercent: 70,
      redTokens: 400_000,
      redPercent: 80,
      memoryFilesTokens: 10_000,
      memoryFileTokens: 5_000,
    });
  });

  it("merges configured values over the defaults", () => {
    expect(resolveContextMeterThresholds({ amberTokens: 150_000, redPercent: 75 })).toEqual({
      ...thresholds,
      amberTokens: 150_000,
      redPercent: 75,
    });
  });

  it("ignores non-positive and non-finite values", () => {
    expect(
      resolveContextMeterThresholds({
        amberTokens: 0,
        amberPercent: -5,
        redTokens: Number.NaN,
        redPercent: Number.POSITIVE_INFINITY,
        memoryFilesTokens: 12_000,
      }),
    ).toEqual({ ...thresholds, memoryFilesTokens: 12_000 });
  });
});

describe("resolveContextMeterTone", () => {
  it("is neutral below both amber limits", () => {
    expect(resolveContextMeterTone({ usedTokens: 174_085, maxTokens: 1_000_000 }, thresholds)).toBe(
      "neutral",
    );
  });

  it("goes amber past amberTokens on a big window", () => {
    expect(resolveContextMeterTone({ usedTokens: 200_001, maxTokens: 1_000_000 }, thresholds)).toBe(
      "amber",
    );
    expect(resolveContextMeterTone({ usedTokens: 200_000, maxTokens: 1_000_000 }, thresholds)).toBe(
      "neutral",
    );
  });

  it("goes amber at amberPercent of a small window", () => {
    expect(resolveContextMeterTone({ usedTokens: 140_000, maxTokens: 200_000 }, thresholds)).toBe(
      "amber",
    );
    expect(resolveContextMeterTone({ usedTokens: 139_999, maxTokens: 200_000 }, thresholds)).toBe(
      "neutral",
    );
  });

  it("goes red at redPercent of the window or past redTokens", () => {
    expect(resolveContextMeterTone({ usedTokens: 160_000, maxTokens: 200_000 }, thresholds)).toBe(
      "red",
    );
    expect(resolveContextMeterTone({ usedTokens: 400_001, maxTokens: 1_000_000 }, thresholds)).toBe(
      "red",
    );
    expect(resolveContextMeterTone({ usedTokens: 400_000, maxTokens: 1_000_000 }, thresholds)).toBe(
      "amber",
    );
  });

  it("falls back to token limits when the window size is unknown", () => {
    expect(resolveContextMeterTone({ usedTokens: 500_000, maxTokens: 0 }, thresholds)).toBe("red");
    expect(resolveContextMeterTone({ usedTokens: 50_000, maxTokens: Number.NaN }, thresholds)).toBe(
      "neutral",
    );
  });
});

describe("formatContextTokens", () => {
  it("never rounds a figure to a coarser one than it supports", () => {
    expect(formatContextTokens(248)).toBe("248");
    expect(formatContextTokens(8_580)).toBe("8.6k");
    expect(formatContextTokens(8_626)).toBe("8.6k");
    expect(formatContextTokens(1_000)).toBe("1k");
    expect(formatContextTokens(13_437)).toBe("13.4k");
    expect(formatContextTokens(174_085)).toBe("174k");
    expect(formatContextTokens(790_633)).toBe("791k");
    expect(formatContextTokens(1_000_000)).toBe("1m");
    expect(formatContextTokens(1_250_000)).toBe("1.3m");
  });
});

describe("buildContextBreakdownView (opus, 1M window)", () => {
  const view = buildContextBreakdownView(opus, thresholds);

  it("lists used rows in provider order, then the buffer, then free space", () => {
    expect(view.rows.map((row) => row.id)).toEqual([
      "system_prompt",
      "system_tools",
      "memory_files",
      "skills",
      "messages",
      "autocompact_buffer",
      "free_space",
    ]);
    expect(view.rows.map((row) => row.kind)).toEqual([
      "used",
      "used",
      "used",
      "used",
      "used",
      "buffer",
      "free",
    ]);
  });

  it("keeps the provider's labels and formats tokens and percent of the window", () => {
    const skills = view.rows.find((row) => row.id === "skills");
    expect(skills).toMatchObject({
      label: "Skills",
      tokens: 8_626,
      formattedTokens: "8.6k",
      percent: 0.8626,
      formattedPercent: "0.9%",
    });
    const messages = view.rows.find((row) => row.id === "messages");
    expect(messages).toMatchObject({ formattedTokens: "130k", formattedPercent: "13%" });
    const prompt = view.rows.find((row) => row.id === "system_prompt");
    expect(prompt?.formattedPercent).toBe("<0.1%");
  });

  it("builds bar segments for used rows and the buffer; free is the remainder", () => {
    expect(view.segments.map((segment) => segment.id)).toEqual([
      "system_prompt",
      "system_tools",
      "memory_files",
      "skills",
      "messages",
      "autocompact_buffer",
    ]);
    const sum = view.segments.reduce((total, segment) => total + segment.fraction, 0);
    expect(sum).toBeCloseTo((248 + 23_754 + 13_437 + 8_626 + 130_302 + 33_000) / 1_000_000, 6);
    expect(view.segments.find((s) => s.id === "messages")?.fraction).toBeCloseTo(0.130302, 6);
  });

  it("splits messages into non-zero sub-rows, largest first", () => {
    expect(view.messageRows.map((row) => row.id)).toEqual([
      "toolResults",
      "attachments",
      "assistant",
      "toolCalls",
      "user",
    ]);
    expect(view.messageRows[0]).toMatchObject({ tokens: 59_559, formattedTokens: "59.6k" });
  });

  it("flags the memory total and the one file over its limit, with a short path", () => {
    expect(view.memory.total).toEqual({
      tokens: 13_437,
      formattedTokens: "13.4k",
      limitFormatted: "10k",
    });
    expect(view.memory.files).toEqual([
      {
        path: "/Users/tylerthackray/.paseo/worktrees/3jvw4yw6/cpu-policing/CLAUDE.md",
        shortPath: "cpu-policing/CLAUDE.md",
        tokens: 8_580,
        formattedTokens: "8.6k",
        limitFormatted: "5k",
      },
    ]);
  });

  it("carries the capture time", () => {
    expect(view.capturedAt).toBe(Date.parse("2026-09-24T23:21:54.742Z"));
  });

  it("has no deferred rows", () => {
    expect(view.deferredRows).toEqual([]);
  });
});

describe("buildContextBreakdownView (haiku, 200K window)", () => {
  const view = buildContextBreakdownView(haiku, thresholds);

  it("keeps deferred rows out of the list, the bar and the percentages", () => {
    expect(view.rows.map((row) => row.id)).not.toContain("system_tools_deferred");
    expect(view.segments.map((segment) => segment.id)).not.toContain("system_tools_deferred");
    expect(view.deferredRows).toEqual([
      expect.objectContaining({
        id: "system_tools_deferred",
        label: "System tools (deferred)",
        kind: "deferred",
        tokens: 15_940,
        formattedTokens: "15.9k",
        percent: null,
        formattedPercent: null,
      }),
    ]);
  });

  it("drops zero rows: a message row of 8 tokens stays, empty sub-rows do not", () => {
    expect(view.rows.find((row) => row.id === "messages")?.formattedTokens).toBe("8");
    expect(view.messageRows.map((row) => row.id)).toEqual(["attachments"]);
  });

  it("warns about the memory total only, when no single file is over its limit", () => {
    expect(view.memory.total).toBeNull();
    expect(view.memory.files).toEqual([
      expect.objectContaining({ shortPath: "context-meter/CLAUDE.md", tokens: 5_974 }),
    ]);
  });
});

describe("buildContextBreakdownView edge cases", () => {
  it("treats an unknown kind as used", () => {
    const view = buildContextBreakdownView(
      {
        ...opus,
        categories: [{ id: "new_thing", label: "New thing", tokens: 500, kind: "quantum" }],
      },
      thresholds,
    );
    expect(view.rows).toEqual([expect.objectContaining({ id: "new_thing", kind: "used" })]);
    expect(view.segments).toEqual([expect.objectContaining({ id: "new_thing" })]);
  });

  it("omits percentages when the window size is unknown", () => {
    const view = buildContextBreakdownView({ ...opus, maxTokens: 0 }, thresholds);
    expect(view.rows.every((row) => row.percent === null && row.formattedPercent === null)).toBe(
      true,
    );
    expect(view.segments).toEqual([]);
  });

  it("scales the bar down when the rows overshoot the window", () => {
    const view = buildContextBreakdownView(
      {
        ...opus,
        maxTokens: 100,
        categories: [
          { id: "a", label: "A", tokens: 90, kind: "used" },
          { id: "b", label: "B", tokens: 30, kind: "buffer" },
        ],
      },
      thresholds,
    );
    expect(view.segments.reduce((total, segment) => total + segment.fraction, 0)).toBeCloseTo(1);
  });

  it("has no memory warnings for a session whose memory is small", () => {
    const view = buildContextBreakdownView(
      {
        ...opus,
        categories: [{ id: "memory_files", label: "Memory files", tokens: 900, kind: "used" }],
        memoryFiles: [{ path: "CLAUDE.md", type: "Project", tokens: 900 }],
      },
      thresholds,
    );
    expect(view.memory).toEqual({ total: null, files: [] });
  });

  it("respects configured memory thresholds", () => {
    const view = buildContextBreakdownView(
      opus,
      resolveContextMeterThresholds({ memoryFilesTokens: 20_000, memoryFileTokens: 1_000 }),
    );
    expect(view.memory.total).toBeNull();
    expect(view.memory.files.map((file) => file.shortPath)).toEqual([
      ".claude-personal/CLAUDE.md",
      "cpu-policing/CLAUDE.md",
    ]);
  });
});

describe("buildReReadAdvice", () => {
  it("is null while the tone is neutral", () => {
    expect(buildReReadAdvice(150_000, "neutral")).toBeNull();
  });

  it("names the honest token figure once the tone is amber or red", () => {
    expect(buildReReadAdvice(250_000, "amber")).toBe("250k");
    expect(buildReReadAdvice(568_412, "red")).toBe("568k");
  });
});
