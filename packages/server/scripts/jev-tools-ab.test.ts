import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { JevToolUseRecord } from "../src/server/agent/tools/jev-tool-use-log.js";
import {
  bashReadPaths,
  buildReport,
  evaluateKillRule,
  indexTranscripts,
  parseTranscript,
  readStoredAgents,
  renderMarkdown,
  type GroupSummary,
} from "./jev-tools-ab.js";

let root: string;
let paseoHome: string;
let claudeDir: string;
const cwd = "/work/project";

function at(minute: number): string {
  return new Date(Date.UTC(2026, 8, 29, 12, minute)).toISOString();
}

function writeAgent(id: string, arm: string, taskClass: string, sessionId: string): void {
  const dir = path.join(paseoHome, "agents", "-work-project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      provider: "claude",
      cwd,
      createdAt: at(0),
      updatedAt: at(60),
      labels: { "paseo.jev-tools": arm, "paseo.task-class": taskClass },
      persistence: { provider: "claude", sessionId },
    }),
  );
}

interface Line {
  minute: number;
  messageId?: string;
  toolUse?: { id: string; name: string; input: Record<string, unknown> };
  toolResult?: { id: string; text: string };
  usage?: { input: number; cacheRead: number; output: number };
}

function writeTranscript(sessionId: string, lines: Line[]): void {
  const dir = path.join(claudeDir, "projects", "-work-project");
  mkdirSync(dir, { recursive: true });
  const text = lines
    .map((line) => {
      if (line.toolResult) {
        return JSON.stringify({
          type: "user",
          timestamp: at(line.minute),
          cwd,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: line.toolResult.id,
                content: line.toolResult.text,
              },
            ],
          },
        });
      }
      return JSON.stringify({
        type: "assistant",
        timestamp: at(line.minute),
        cwd,
        message: {
          id: line.messageId ?? `m-${line.minute}`,
          role: "assistant",
          content: line.toolUse
            ? [
                {
                  type: "tool_use",
                  id: line.toolUse.id,
                  name: line.toolUse.name,
                  input: line.toolUse.input,
                },
              ]
            : [{ type: "text", text: "ok" }],
          usage: line.usage
            ? {
                input_tokens: line.usage.input,
                cache_read_input_tokens: line.usage.cacheRead,
                cache_creation_input_tokens: 0,
                output_tokens: line.usage.output,
              }
            : undefined,
        },
      });
    })
    .join("\n");
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${text}\n`);
}

function record(
  partial: Partial<JevToolUseRecord> & Pick<JevToolUseRecord, "agentId" | "tool" | "at">,
): JevToolUseRecord {
  return {
    v: 1,
    arm: "on",
    outcome: "answered",
    reason: null,
    jevCalls: 1,
    jevAnswered: 1,
    jevUsd: 0.00004,
    jevInputTokens: 800,
    resultChars: 80,
    readTokensAvoided: 3000,
    callerContextTokens: 40_000,
    cwd,
    paths: [],
    commandSha256: null,
    diffRisk: null,
    elapsedMs: 400,
    ...partial,
  };
}

beforeEach(() => {
  const cache = path.join(os.homedir(), ".cache");
  mkdirSync(cache, { recursive: true });
  root = mkdtempSync(path.join(cache, "jev-ab-test-"));
  paseoHome = path.join(root, "paseo");
  claudeDir = path.join(root, ".claude-test");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function report(records: JevToolUseRecord[]) {
  return buildReport({
    agents: readStoredAgents(paseoHome),
    records,
    transcripts: indexTranscripts([claudeDir]),
    readText: (file) => readFileSync(file, "utf8"),
    now: new Date(at(90)),
  });
}

describe("transcripts", () => {
  test("usage is counted once per message and weighted", () => {
    const text = [
      { minute: 0, messageId: "a", usage: { input: 100, cacheRead: 1000, output: 10 } },
      { minute: 0, messageId: "a", usage: { input: 100, cacheRead: 1000, output: 10 } },
      { minute: 1, messageId: "b", usage: { input: 0, cacheRead: 2000, output: 0 } },
    ]
      .map((line) =>
        JSON.stringify({
          type: "assistant",
          timestamp: at(line.minute),
          message: {
            id: line.messageId,
            content: [{ type: "text", text: "x" }],
            usage: {
              input_tokens: line.usage.input,
              cache_read_input_tokens: line.usage.cacheRead,
              output_tokens: line.usage.output,
            },
          },
        }),
      )
      .join("\n");
    // a: 100 + 1000·0.1 + 10·5 = 250; b: 2000·0.1 = 200.
    expect(parseTranscript(text).weightedTokens).toBe(450);
  });

  test("a relative cat resolves against the cwd; sed -n counts, a write does not", () => {
    expect(bashReadPaths("cd sub && cat src/a.ts | head -5", "/w")).toEqual(["/w/sub/src/a.ts"]);
    expect(bashReadPaths("head -n 40 src/a.ts", "/w")).toEqual(["/w/src/a.ts"]);
    expect(bashReadPaths("sed -n '1,40p' lib/b.ts", "/w")).toEqual(["/w/lib/b.ts"]);
    expect(bashReadPaths("sed -i s/a/b/ lib/b.ts", "/w")).toEqual([]);
    expect(bashReadPaths("npm test", "/w")).toEqual([]);
  });
});

describe("the report", () => {
  test("groups by arm and task class, and finds regret reads", () => {
    writeAgent("on-1", "on", "standard", "s-on-1");
    writeAgent("on-2", "on", "standard", "s-on-2");
    writeAgent("ctl-1", "control", "standard", "s-ctl-1");
    writeAgent("ctl-2", "control", "standard", "s-ctl-2");
    writeAgent("unlabelled", "", "standard", "s-x");
    const command = "npm test -- --run";
    writeTranscript("s-on-1", [
      { minute: 0, usage: { input: 1000, cacheRead: 0, output: 0 } },
      { minute: 1, toolUse: { id: "t1", name: "ToolSearch", input: {} } },
      { minute: 2, toolUse: { id: "t2", name: "mcp__paseo__ask_jev_file_bool", input: {} } },
      { minute: 3, toolUse: { id: "t3", name: "Read", input: { file_path: `${cwd}/src/a.ts` } } },
      { minute: 3, toolResult: { id: "t3", text: "x".repeat(400) } },
      { minute: 10, toolUse: { id: "t4", name: "mcp__paseo__ask_jev", input: { command } } },
      { minute: 11, toolUse: { id: "t5", name: "Bash", input: { command: "git status" } } },
      { minute: 12, toolUse: { id: "t6", name: "Bash", input: { command } } },
      { minute: 30, usage: { input: 1000, cacheRead: 0, output: 0 } },
    ]);
    writeTranscript("s-on-2", [
      { minute: 0, usage: { input: 2000, cacheRead: 0, output: 0 } },
      { minute: 2, toolUse: { id: "u1", name: "mcp__paseo__ask_jev_file_bool", input: {} } },
      { minute: 5, toolUse: { id: "u2", name: "Bash", input: { command: "cat src/b.ts" } } },
      { minute: 5, toolResult: { id: "u2", text: "y".repeat(800) } },
      { minute: 30, usage: { input: 0, cacheRead: 0, output: 0 } },
    ]);
    writeTranscript("s-ctl-1", [
      { minute: 0, usage: { input: 5000, cacheRead: 0, output: 0 } },
      { minute: 30, usage: { input: 0, cacheRead: 0, output: 0 } },
    ]);
    writeTranscript("s-ctl-2", [
      { minute: 0, usage: { input: 6000, cacheRead: 0, output: 0 } },
      { minute: 30, usage: { input: 0, cacheRead: 0, output: 0 } },
    ]);
    const result = report([
      record({ agentId: "on-1", tool: "ask_jev_file_bool", at: at(2), paths: [`${cwd}/src/a.ts`] }),
      record({
        agentId: "on-1",
        tool: "ask_jev",
        at: at(10),
        commandSha256: createHash("sha256").update(command).digest("hex"),
      }),
      record({ agentId: "on-2", tool: "ask_jev_file_bool", at: at(2), paths: [`${cwd}/src/b.ts`] }),
    ]);
    expect(result.agents).toEqual({ labelled: 4, withTranscript: 4, withoutTranscript: 0 });
    const on = result.groups.find((group) => group.arm === "on")!;
    const control = result.groups.find((group) => group.arm === "control")!;
    expect(on).toMatchObject({
      agents: 2,
      jevToolCalls: 3,
      toolSearchSteps: 1,
      readTokens: 100,
      bashReadTokens: 200,
    });
    expect(control.agents).toBe(2);
    expect(on.meanWeightedPerHour).toBeLessThan(control.meanWeightedPerHour);
    const bool = result.tools.find((tool) => tool.tool === "ask_jev_file_bool")!;
    expect(bool).toMatchObject({ calls: 2, regretted: 2, switchOff: true });
    expect(result.tools.find((tool) => tool.tool === "ask_jev")).toMatchObject({
      calls: 1,
      regretted: 1,
    });
    expect(result.killRule.text).toBe("not enough agents yet (4 of 50)");
    expect(renderMarkdown(result)).toContain("not enough agents yet (4 of 50)");
  });

  test("a command run again after 5 other steps is not a regret", () => {
    writeAgent("on-1", "on", "standard", "s-on-1");
    const command = "npm test";
    writeTranscript("s-on-1", [
      { minute: 1, toolUse: { id: "a", name: "mcp__paseo__ask_jev", input: { command } } },
      ...[2, 3, 4, 5, 6].map((minute) => ({
        minute,
        toolUse: { id: `b${minute}`, name: "Bash", input: { command: "ls" } },
      })),
      { minute: 7, toolUse: { id: "c", name: "Bash", input: { command } } },
    ]);
    const result = report([
      record({
        agentId: "on-1",
        tool: "ask_jev",
        at: at(1),
        commandSha256: createHash("sha256").update(command).digest("hex"),
      }),
    ]);
    expect(result.tools.find((tool) => tool.tool === "ask_jev")).toMatchObject({
      calls: 1,
      regretted: 0,
    });
  });
});

describe("the kill rule", () => {
  function group(arm: "on" | "control", mean: number, se: number, agents = 10): GroupSummary {
    return {
      arm,
      taskClass: "standard",
      agents,
      agentHours: agents,
      meanWeightedPerHour: mean,
      seWeightedPerHour: se,
      jevToolCalls: 0,
      toolSearchSteps: 0,
      jevResultTokens: 0,
      readTokens: 0,
      bashReadTokens: 0,
      netReadTokensAvoided: 0,
    };
  }

  test("keeps the tools only when on is lower by more than the noise", () => {
    expect(evaluateKillRule([group("on", 80, 5), group("control", 100, 5)], 60).verdict).toBe(
      "keep",
    );
    expect(evaluateKillRule([group("on", 95, 5), group("control", 100, 5)], 60).verdict).toBe(
      "switch-off",
    );
    expect(evaluateKillRule([group("on", 80, 5), group("control", 100, 5)], 49).verdict).toBe(
      "not-enough-agents",
    );
  });
});
