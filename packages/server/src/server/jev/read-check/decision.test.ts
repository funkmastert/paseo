import { describe, expect, test } from "vitest";

import type { JevAnswer } from "../contract.js";
import {
  decideLiveDeny,
  formatReadDenial,
  isLiveShareAgent,
  readCheckAnswerOf,
  type LiveDenyInput,
} from "./decision.js";

function choice(choiceKey: string, confidence: number): JevAnswer {
  return { type: "choice", choice: choiceKey, probabilities: {}, confidence };
}

describe("readCheckAnswerOf", () => {
  test("not_needed at 0.80 or more would skip", () => {
    expect(readCheckAnswerOf(choice("not_needed", 0.8)).verdict).toBe("would-skip");
    expect(readCheckAnswerOf(choice("not_needed", 0.79)).verdict).toBe("needed");
  });

  test("part_needed at 0.80 or more would narrow", () => {
    expect(readCheckAnswerOf(choice("part_needed", 0.85)).verdict).toBe("would-narrow");
    expect(readCheckAnswerOf(choice("part_needed", 0.5)).verdict).toBe("needed");
  });

  test("needed, other, an unknown key, another type or no answer are needed", () => {
    expect(readCheckAnswerOf(choice("needed", 0.99)).verdict).toBe("needed");
    expect(readCheckAnswerOf(choice("other", 0.99)).verdict).toBe("needed");
    expect(readCheckAnswerOf(choice("skip_it", 0.99))).toEqual({
      verdict: "needed",
      choice: null,
      confidence: null,
    });
    expect(readCheckAnswerOf({ type: "noul", noul: 0.1 }).choice).toBeNull();
    expect(readCheckAnswerOf(undefined).verdict).toBe("needed");
  });
});

describe("decideLiveDeny", () => {
  const base: LiveDenyInput = {
    answer: readCheckAnswerOf(choice("not_needed", 0.91)),
    answered: true,
    plainRead: true,
    deniedBefore: false,
    editedBefore: false,
    deniesLastHour: 0,
    regretsLastHour: 0,
    maxDeniesPerAgentPerHour: 5,
    subagentBriefMissing: false,
    named: false,
  };

  test("denies only when every condition holds", () => {
    expect(decideLiveDeny(base)).toEqual({ deny: true });
  });

  test("each failed condition is the reason the read runs", () => {
    expect(decideLiveDeny({ ...base, answered: false })).toEqual({
      deny: false,
      reason: "not-answered",
    });
    expect(
      decideLiveDeny({ ...base, answer: readCheckAnswerOf(choice("not_needed", 0.84)) }),
    ).toEqual({ deny: false, reason: "not-confident" });
    expect(
      decideLiveDeny({ ...base, answer: readCheckAnswerOf(choice("part_needed", 0.99)) }),
    ).toEqual({ deny: false, reason: "not-confident" });
    expect(decideLiveDeny({ ...base, plainRead: false })).toEqual({
      deny: false,
      reason: "not-plain-read",
    });
    expect(decideLiveDeny({ ...base, deniedBefore: true })).toEqual({
      deny: false,
      reason: "denied-before",
    });
    expect(decideLiveDeny({ ...base, editedBefore: true })).toEqual({
      deny: false,
      reason: "edited",
    });
    expect(decideLiveDeny({ ...base, deniesLastHour: 5 })).toEqual({
      deny: false,
      reason: "deny-cap",
    });
    expect(decideLiveDeny({ ...base, regretsLastHour: 2 })).toEqual({
      deny: false,
      reason: "regret-cap",
    });
    expect(decideLiveDeny({ ...base, subagentBriefMissing: true })).toEqual({
      deny: false,
      reason: "subagent-brief-missing",
    });
    expect(decideLiveDeny({ ...base, named: true })).toEqual({
      deny: false,
      reason: "named",
    });
  });

  test("R4, KTD-4: a brief-missing subagent read and a named read are refused before confidence", () => {
    // Neither condition depends on the answer: a low-confidence `needed` answer would already
    // refuse on its own, so this proves the new checks run even on a confident `not_needed`.
    expect(
      decideLiveDeny({
        ...base,
        subagentBriefMissing: true,
        answer: readCheckAnswerOf(choice("not_needed", 0.99)),
      }),
    ).toEqual({ deny: false, reason: "subagent-brief-missing" });
    expect(
      decideLiveDeny({
        ...base,
        named: true,
        answer: readCheckAnswerOf(choice("not_needed", 0.99)),
      }),
    ).toEqual({ deny: false, reason: "named" });
  });

  test("0.85 exactly denies; one regret does not stop denials", () => {
    expect(
      decideLiveDeny({ ...base, answer: readCheckAnswerOf(choice("not_needed", 0.85)) }),
    ).toEqual({ deny: true });
    expect(decideLiveDeny({ ...base, regretsLastHour: 1, deniesLastHour: 4 })).toEqual({
      deny: true,
    });
  });
});

describe("isLiveShareAgent", () => {
  test("0 and 1 are none and all; an id stays on one side", () => {
    expect(isLiveShareAgent("agent-1", 0)).toBe(false);
    expect(isLiveShareAgent("agent-1", 1)).toBe(true);
    expect(isLiveShareAgent("agent-1", 0.5)).toBe(isLiveShareAgent("agent-1", 0.5));
  });

  test("about half of many agents fall in a 0.5 share", () => {
    let live = 0;
    for (let index = 0; index < 1000; index += 1) {
      if (isLiveShareAgent(`agent-${index}`, 0.5)) live += 1;
    }
    expect(live).toBeGreaterThan(430);
    expect(live).toBeLessThan(570);
  });
});

describe("formatReadDenial", () => {
  test("names the path, size and confidence, and how to get the file", () => {
    expect(
      formatReadDenial({
        displayPath: "src/server/session.ts",
        tokens: 14_300,
        confidence: 0.91,
        tool: "Read",
        hasJevFileTools: true,
      }),
    ).toBe(
      "JEV judged src/server/session.ts (about 14,300 tokens) not needed for your task (0.91). If you need it, run the same Read again; it goes through without a check. To ask about it without loading it, use mcp__paseo__ask_jev_file_bool or mcp__paseo__ask_jev_file_choice.",
    );
  });

  test("names the file tools only to agents that have them", () => {
    const text = formatReadDenial({
      displayPath: "a.ts",
      tokens: 9000,
      confidence: 0.9,
      tool: "Bash",
      hasJevFileTools: false,
    });
    expect(text).not.toContain("ask_jev_file");
    expect(text).toContain("run the same command again");
  });
});
