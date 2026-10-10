import { describe, expect, test } from "vitest";

import type { AgentTimelineItem } from "../../agent/agent-sdk-types.js";
import {
  applyFilters,
  buildReadCheckState,
  describeSize,
  estimateReadTokens,
  outlineOf,
  READ_CHECK_MAX_STATE_BYTES,
  readToolCharacters,
  recentLine,
  sliceRange,
} from "./state.js";

const TEXT = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";

describe("sliceRange", () => {
  test("lines, the end, and bytes", () => {
    expect(sliceRange(TEXT, { kind: "lines", first: 3, last: 4 })).toEqual({
      text: "line 3\nline 4\n",
      firstLine: 3,
      lastLine: 4,
      totalLines: 100,
    });
    expect(sliceRange(TEXT, { kind: "lines", first: 99, last: null }).text).toBe(
      "line 99\nline 100\n",
    );
    expect(sliceRange(TEXT, { kind: "last-lines", count: 2 }).firstLine).toBe(99);
    expect(sliceRange(TEXT, { kind: "first-bytes", count: 6 }).text).toBe("line 1");
    expect(sliceRange(TEXT, { kind: "lines", first: 500, last: 600 }).text).toBe("");
  });

  test("a pipe's filters apply in order", () => {
    expect(
      applyFilters(TEXT, [
        { kind: "lines", first: 1, last: 10 },
        { kind: "last-lines", count: 2 },
      ]),
    ).toBe("line 9\nline 10\n");
  });
});

describe("sizes", () => {
  test("Read counts each line's number prefix", () => {
    expect(readToolCharacters("ab\ncd\n")).toBe(2 * (2 + 1 + 7));
  });

  test("tokens are characters over 2.35", () => {
    expect(estimateReadTokens(2350)).toBe(1000);
  });

  test("the size line says which lines and how many tokens", () => {
    expect(describeSize({ firstLine: 1, lastLine: 1240, totalLines: 3100, tokens: 14_300 })).toBe(
      "lines 1-1240 of 3100, about 14,300 tokens",
    );
    expect(describeSize({ firstLine: 1, lastLine: 10, totalLines: 10, tokens: 50 })).toBe(
      "all 10 lines, about 50 tokens",
    );
  });
});

describe("outlineOf", () => {
  test("keeps declarations and headings, not bodies", () => {
    const source = [
      'import { a } from "./a.js";',
      "const x = 1;",
      "export function run() {",
      "  return x;",
      "}",
      "## Usage",
      "class Thing {}",
    ].join("\n");
    expect(outlineOf(source)).toBe(
      'import { a } from "./a.js";\nexport function run() {\n## Usage\nclass Thing {}',
    );
  });

  test("stops at its cap", () => {
    const source = Array.from({ length: 500 }, (_, index) => `export const v${index} = 1;`).join(
      "\n",
    );
    expect(outlineOf(source).length).toBeLessThanOrEqual(2000);
  });
});

describe("recentLine", () => {
  test("assistant text, tool calls and failures", () => {
    expect(recentLine({ type: "assistant_message", text: "Looking at the auth flow" })).toBe(
      "assistant: Looking at the auth flow",
    );
    const shell: AgentTimelineItem = {
      type: "tool_call",
      callId: "c1",
      name: "Bash",
      status: "failed",
      error: "exit 1",
      detail: { type: "shell", command: "npm test -- auth" },
    };
    expect(recentLine(shell)).toBe("tool Bash `npm test -- auth` -> failed");
    expect(recentLine({ type: "todo", items: [] })).toBeNull();
  });
});

describe("buildReadCheckState", () => {
  test("carries the task, recent rows, path, size, outline and the first 6,000 characters", () => {
    const state = buildReadCheckState({
      title: "Fix login",
      assignment: "Find why login fails".repeat(100),
      recent: [{ type: "assistant_message", text: "Reading the session code" }],
      why: "Show the session module",
      displayPath: "src/session.ts",
      size: "all 10 lines, about 50 tokens",
      rangeText: "x".repeat(9000),
    });
    expect(state.task.startsWith("Fix login\nFind why login fails")).toBe(true);
    expect(state.task.length).toBe("Fix login\n".length + 800);
    expect(state.recent).toEqual(["assistant: Reading the session code"]);
    expect(state.why).toBe("Show the session module");
    expect(state.excerpt.length).toBe(6000);
  });

  test("a subagent with a found brief is judged against its own brief, with the parent as one line", () => {
    const state = buildReadCheckState({
      title: "Fix login",
      assignment: "Find why login fails",
      subagentBrief: {
        description: "Read the persona file, then the template",
        prompt: "Read docs/plans/persona-plan.md, then src/templates/base.hbs",
      },
      recent: [{ type: "assistant_message", text: "Reading the template" }],
      why: null,
      displayPath: "src/templates/base.hbs",
      size: "all 10 lines, about 50 tokens",
      rangeText: "x".repeat(10),
    });
    expect(state.task).toBe(
      "Read the persona file, then the template\n" +
        "Read docs/plans/persona-plan.md, then src/templates/base.hbs\n" +
        "(parent task: Fix login)",
    );
    expect(state.recent).toEqual(["assistant: Reading the template"]);
  });

  test("a subagent's brief is clipped to 800 characters like the legacy assignment", () => {
    const state = buildReadCheckState({
      title: "Fix login",
      assignment: null,
      subagentBrief: { description: "d".repeat(900), prompt: null },
      recent: [],
      why: null,
      displayPath: "a.ts",
      size: "s",
      rangeText: "x",
    });
    expect(state.task).toBe(`${"d".repeat(800)}\n(parent task: Fix login)`);
  });

  test("a main agent's task adds the current turn's latest prompt after the assignment", () => {
    const state = buildReadCheckState({
      title: "Fix login",
      assignment: "Find why login fails",
      latestPrompt: "Also check the session cookie expiry",
      recent: [],
      why: null,
      displayPath: "a.ts",
      size: "s",
      rangeText: "x",
    });
    expect(state.task).toBe(
      "Fix login\nFind why login fails\nAlso check the session cookie expiry",
    );
  });

  test("a pinned recent line survives the row cap, oldest first", () => {
    const recent = Array.from({ length: 8 }, (_, index) => ({
      type: "assistant_message" as const,
      text: `step ${index}`,
    }));
    const state = buildReadCheckState({
      title: "t",
      assignment: null,
      recent,
      pinnedRecentLine: "tool Grep `session cookie`",
      why: null,
      displayPath: "a.ts",
      size: "s",
      rangeText: "x",
    });
    expect(state.recent[0]).toBe("tool Grep `session cookie`");
    expect(state.recent).toHaveLength(8);
    expect(state.recent[state.recent.length - 1]).toBe("assistant: step 7");
  });

  test("never passes 10,000 bytes, however wide the content", () => {
    const state = buildReadCheckState({
      title: "t",
      assignment: "é".repeat(800),
      recent: Array.from({ length: 8 }, () => ({
        type: "assistant_message" as const,
        text: "ü".repeat(600),
      })),
      why: null,
      displayPath: "a.ts",
      size: "s",
      rangeText: Array.from({ length: 400 }, () => "export const ünïcödé = 1;").join("\n"),
    });
    expect(Buffer.byteLength(JSON.stringify(state), "utf8")).toBeLessThanOrEqual(
      READ_CHECK_MAX_STATE_BYTES,
    );
  });
});
