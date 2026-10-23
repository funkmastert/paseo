import { describe, expect, it } from "vitest";

import { parseOfferedOptions, parseQuestionRequest } from "./options.js";

describe("parseOfferedOptions", () => {
  it("reads named options and the one marked recommended", () => {
    const parsed = parseOfferedOptions(
      [
        "Two ways to fix the flaky test:",
        "",
        "**Option A** — add a retry around the socket connect.",
        "Cheap, hides the race.",
        "**Option B (recommended)** — wait for the ready event before connecting.",
        "",
        "Which do you want?",
      ].join("\n"),
    );
    expect(parsed.options.map((option) => option.id)).toEqual(["A", "B"]);
    expect(parsed.options[0].label).toBe("add a retry around the socket connect.");
    expect(parsed.options[1].label).toBe("wait for the ready event before connecting.");
    expect(parsed.recommendedId).toBe("B");
  });

  it("reads a lettered list and a recommendation stated after it", () => {
    const parsed = parseOfferedOptions(
      [
        "A) Keep the old config key",
        "B) Rename it and add a shim",
        "C) Rename it with no shim",
        "",
        "I'd go with B: the shim is one line.",
      ].join("\n"),
    );
    expect(parsed.options.map((option) => option.id)).toEqual(["A", "B", "C"]);
    expect(parsed.recommendedId).toBe("B");
  });

  it("takes the last numbered list, not the steps before it", () => {
    const parsed = parseOfferedOptions(
      [
        "What I did:",
        "1. Read the logs",
        "2. Found the stale cache",
        "",
        "Next, pick one:",
        "1. Clear it on boot",
        "2. Version the cache key",
        "",
        "My recommendation is option 2.",
      ].join("\n"),
    );
    expect(parsed.options.map((option) => option.label)).toEqual([
      "Clear it on boot",
      "Version the cache key",
    ]);
    expect(parsed.recommendedId).toBe("2");
  });

  it("finds no recommendation when none is marked, or when two are", () => {
    expect(parseOfferedOptions("Option A: x\nOption B: y").recommendedId).toBeNull();
    expect(
      parseOfferedOptions("Option A: x (recommended)\nOption B: y (recommended)").recommendedId,
    ).toBeNull();
  });

  it("does not read the article 'a' as option A", () => {
    const parsed = parseOfferedOptions("A) one\nB) two\n\nI recommend a quick look first.");
    expect(parsed.recommendedId).toBeNull();
  });

  it("offers nothing for fewer than two options or plain prose", () => {
    expect(parseOfferedOptions("Option A: only one").options).toEqual([]);
    expect(parseOfferedOptions("All done. The build is green.").options).toEqual([]);
  });
});

describe("parseQuestionRequest", () => {
  const input = {
    questions: [
      {
        question: "Which database should the cache use?",
        header: "Cache store",
        multiSelect: false,
        options: [
          { label: "SQLite (Recommended)", description: "Already a dependency" },
          { label: "JSON file", description: "Simplest" },
        ],
      },
    ],
  };

  it("reads one single-select question with its recommended option", () => {
    const parsed = parseQuestionRequest(input);
    expect(parsed?.header).toBe("Cache store");
    expect(parsed?.options.map((option) => option.label)).toEqual(["SQLite", "JSON file"]);
    expect(parsed?.recommendedId).toBe("1");
    expect(parsed?.descriptions["2"]).toBe("Simplest");
  });

  it("refuses several questions, multi-select, and malformed options", () => {
    expect(
      parseQuestionRequest({ questions: [input.questions[0], input.questions[0]] }),
    ).toBeNull();
    expect(
      parseQuestionRequest({ questions: [{ ...input.questions[0], multiSelect: true }] }),
    ).toBeNull();
    expect(
      parseQuestionRequest({
        questions: [{ ...input.questions[0], options: [{ label: "only" }] }],
      }),
    ).toBeNull();
    expect(parseQuestionRequest(null)).toBeNull();
  });
});
