import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { createTestJevService, type JevFakeBehavior, type JevScriptedAnswer } from "../jev/fake.js";
import type { JevOutcome } from "../jev/contract.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import {
  LOOP_REPEATED_INPUT_COUNT,
  MAX_JUDGMENTS_PER_AGENT_PER_HOUR,
  STALL_JUDGMENT_RECENT_ENTRIES,
  buildStallJudgmentState,
  createJevStallJudge,
  decideStallAction,
  findLoop,
  firstUserMessage,
  newestIsRunningTool,
  readStallJudgment,
  stallActivityQuestions,
  type StallActivity,
} from "./stall-judgment.js";

const T0 = Date.parse("2026-09-29T12:00:00.000Z");
const HOUR = 60 * 60_000;

let seq = 0;
let callSeq = 0;

function row(item: AgentTimelineItem): AgentTimelineRow {
  seq += 1;
  return { seq, timestamp: new Date(T0 + seq * 1000).toISOString(), item };
}

function user(text: string): AgentTimelineRow {
  return row({ type: "user_message", text });
}

function assistant(text: string): AgentTimelineRow {
  return row({ type: "assistant_message", text });
}

function bash(
  command: string,
  status: "running" | "completed" | "failed" = "completed",
  error: unknown = null,
): AgentTimelineRow {
  callSeq += 1;
  const base = {
    type: "tool_call" as const,
    callId: `call-${callSeq}`,
    name: "Bash",
    detail: { type: "shell" as const, command, output: `output ${callSeq}` },
  };
  if (status === "failed") return row({ ...base, status, error });
  return row({ ...base, status, error: null });
}

function tool(name: string, input: unknown): AgentTimelineRow {
  callSeq += 1;
  return row({
    type: "tool_call",
    callId: `call-${callSeq}`,
    name,
    detail: { type: "unknown", input, output: null },
    status: "completed",
    error: null,
  });
}

describe("the state", () => {
  test("carries the title, a clipped assignment, whole quiet minutes and the recent tail, oldest first", () => {
    const rows = [
      user(`Fix the auth tests. ${"x".repeat(1000)}`),
      row({ type: "reasoning", text: "The token refresh path looks wrong." }),
      bash("npm test -- auth", "failed", "3 tests failed: expected 200, got 401"),
      assistant("Retrying with the fixture reset."),
      row({ type: "error", message: "provider hiccup" }),
    ];
    const state = buildStallJudgmentState({
      title: " Auth fixer ",
      assignment: firstUserMessage(rows),
      quietMinutes: 34.7,
      rows,
    });
    expect(state.title).toBe("Auth fixer");
    expect(state.assignment).toHaveLength(800);
    expect(state.assignment.startsWith("Fix the auth tests.")).toBe(true);
    expect(state.quiet_minutes).toBe(34);
    expect(state.recent).toEqual([
      "reasoning: The token refresh path looks wrong.",
      "tool Bash `npm test -- auth` -> failed: 3 tests failed: expected 200, got 401",
      "assistant: Retrying with the fixture reset.",
      "error: provider hiccup",
    ]);
  });

  test("keeps the last 25 entries, one per tool call however many status rows it has", () => {
    const rows: AgentTimelineRow[] = [];
    // Adjacent assistant rows are one message; distinct tool calls are distinct entries.
    for (let index = 0; index < 40; index += 1) rows.push(bash(`echo ${index}`));
    const running = bash("npm run build", "running");
    rows.push(running);
    rows.push({
      ...running,
      seq: running.seq + 1000,
      item: { ...running.item, status: "completed" } as AgentTimelineItem,
    });
    const state = buildStallJudgmentState({ title: null, assignment: null, quietMinutes: 0, rows });
    expect(state.recent).toHaveLength(STALL_JUDGMENT_RECENT_ENTRIES);
    expect(state.recent.at(-1)).toBe("tool Bash `npm run build` -> completed");
    expect(state.recent.filter((line) => line.includes("npm run build"))).toHaveLength(1);
    expect(state.recent[0]).toBe("tool Bash `echo 16` -> completed");
  });

  test("clips long text and long commands", () => {
    const rows = [assistant("a".repeat(500)), bash(`echo ${"b".repeat(500)}`)];
    const state = buildStallJudgmentState({ title: null, assignment: null, quietMinutes: 0, rows });
    expect(state.recent[0]?.length).toBeLessThanOrEqual("assistant: ".length + 160);
    expect(state.recent[1]?.length).toBeLessThanOrEqual("tool Bash `` -> completed".length + 200);
  });

  test("knows whether the newest thing is a tool call still running", () => {
    expect(newestIsRunningTool([assistant("go"), bash("npm test", "running")])).toBe(true);
    expect(newestIsRunningTool([bash("npm test", "completed")])).toBe(false);
    expect(newestIsRunningTool([bash("npm test", "running"), assistant("still here")])).toBe(false);
    expect(newestIsRunningTool([])).toBe(false);
  });

  test("asks one choice with every label and an exit", () => {
    const question = stallActivityQuestions()["activity"];
    expect(question?.type).toBe("choice");
    expect(Object.keys(question?.type === "choice" ? question.criteria : {})).toEqual([
      "progressing",
      "looping",
      "blocked_missing_info",
      "waiting_on_human",
      "other",
    ]);
  });
});

describe("the loop prefilter", () => {
  test("matches one tool with the same input four times in the last 12 calls, whatever its output", () => {
    const rows = [
      bash("npm test -- auth"),
      bash("git status"),
      bash("npm test -- auth"),
      bash("npm test -- auth"),
      bash("npm test -- auth"),
    ];
    expect(findLoop(rows)).toMatchObject({
      kind: "repeated-input",
      count: LOOP_REPEATED_INPUT_COUNT,
      step: "tool Bash `npm test -- auth`",
    });
  });

  test("does not match three repeats", () => {
    expect(findLoop([bash("npm test"), bash("npm test"), bash("npm test"), bash("ls")])).toBeNull();
  });

  test("matches one error text three times across different commands", () => {
    const error = "Error: Cannot find module '@getpaseo/protocol'";
    const rows = [
      bash("npm run typecheck", "failed", error),
      bash("npx tsc -p .", "failed", error),
      bash("npm run build", "failed", error),
    ];
    expect(findLoop(rows)).toMatchObject({ kind: "repeated-error", count: 3 });
    expect(findLoop(rows)?.step).toContain("Cannot find module");
  });

  test("counts only the last 12 tool calls", () => {
    const rows = [bash("npm test"), bash("npm test"), bash("npm test"), bash("npm test")];
    for (let index = 0; index < 12; index += 1) rows.push(bash(`echo ${index}`));
    expect(findLoop(rows)).toBeNull();
  });

  test.each([
    ["paseo wait", () => bash("paseo wait 1f2e3d")],
    ["gh run watch", () => bash("gh run watch 1234567")],
    ["sleep", () => bash("sleep 60 && gh run view 1234567")],
    ["the Paseo wait tool", () => tool("mcp__paseo__wait_for_agent", { agentId: "a1" })],
    ["reading a background shell", () => tool("BashOutput", { bash_id: "shell-1" })],
    ["reading a background task", () => tool("TaskOutput", { task_id: "task-1" })],
    [
      "reading a background task's output file",
      () => bash("cat /private/tmp/claude-501/-Users-x/abc/tasks/b9mwhkqb3.output | tail -20"),
    ],
    ["an orchestrator listing its agents", () => bash("paseo ls -a")],
    ["the repo's CLI listing agents", () => bash("npm run cli -- ls -a -g")],
    ["the Paseo status tool", () => tool("mcp__paseo__get_agent_status", { agentId: "a1" })],
    ["the Paseo activity tool", () => tool("mcp__paseo__get_agent_activity", { agentId: "a1" })],
  ])("skips a known poller: %s", (_name, make) => {
    const rows = [make(), make(), make(), make(), make(), make()];
    expect(findLoop(rows)).toBeNull();
  });

  test("a different tool with the same input is a different step", () => {
    const rows = [
      tool("Read", { file: "a.ts" }),
      tool("Grep", { file: "a.ts" }),
      tool("Read", { file: "a.ts" }),
      tool("Grep", { file: "a.ts" }),
    ];
    expect(findLoop(rows)).toBeNull();
  });
});

describe("the decision, for a stall candidate", () => {
  const decide = (
    activity: StallActivity | null,
    confidence: number,
    extra: { running?: boolean; held?: boolean; step?: string | null } = {},
  ) =>
    decideStallAction({
      answer: activity ? { activity, confidence } : null,
      newestIsRunningTool: extra.running ?? false,
      alreadyHeld: extra.held ?? false,
      repeatedStep: extra.step ?? null,
    });

  test("progressing at 0.85 with a tool call running holds once", () => {
    expect(decide("progressing", 0.85, { running: true })).toEqual({ kind: "hold" });
    expect(decide("progressing", 0.95, { running: true, held: true })).toEqual({ kind: "today" });
    expect(decide("progressing", 0.95, { running: false })).toEqual({ kind: "today" });
    expect(decide("progressing", 0.84, { running: true })).toEqual({ kind: "today" });
  });

  test("looping at 0.75 nudges with the repeated step and no person first", () => {
    const action = decide("looping", 0.75, { step: "tool Bash `npm test -- auth`" });
    expect(action).toEqual({
      kind: "nudge",
      line: "You appear to be repeating: tool Bash `npm test -- auth`. Try a different approach, or say what blocks you.",
      personFirst: null,
    });
    expect(decide("looping", 0.8)).toMatchObject({
      kind: "nudge",
      line: expect.stringContaining("repeating the same step"),
    });
    expect(decide("looping", 0.74)).toEqual({ kind: "today" });
  });

  test("blocked on missing information asks it to name what it lacks and puts a person first", () => {
    const action = decide("blocked_missing_info", 0.82);
    expect(action).toMatchObject({
      kind: "nudge",
      line: expect.stringContaining("Name exactly what you are missing"),
      personFirst: { reason: expect.stringContaining("0.82"), confidence: 0.82 },
    });
    expect(decide("blocked_missing_info", 0.7)).toEqual({ kind: "today" });
  });

  test("waiting on a person says to end the turn with the question and puts a person first", () => {
    const action = decide("waiting_on_human", 0.9);
    expect(action).toMatchObject({
      kind: "nudge",
      line: expect.stringContaining("end your turn with the question"),
      personFirst: { confidence: 0.9 },
    });
    expect(decide("waiting_on_human", 0.74)).toEqual({ kind: "today" });
  });

  test("anything else is today's behaviour", () => {
    expect(decide("other", 0.99)).toEqual({ kind: "today" });
    expect(decide(null, 1)).toEqual({ kind: "today" });
  });
});

describe("reading an outcome", () => {
  const meta = {
    model: "jev-fake",
    elapsedMs: 1,
    attempts: 1,
    inputTokens: 10,
    outputTokens: 1,
    stateBytes: 10,
    bodyBytes: 20,
    redactions: 0,
    cost: { usd: 0.0001, source: "fake" as const },
  };
  const answers = {
    activity: {
      type: "choice" as const,
      choice: "looping",
      probabilities: { looping: 0.9, progressing: 0.1 },
      confidence: 0.9,
    },
  };

  test("a shadow carries the answer, not applied", () => {
    const outcome: JevOutcome = { kind: "shadow", callId: "c1", answers, meta };
    expect(readStallJudgment(outcome)).toEqual({
      kind: "judged",
      callId: "c1",
      answer: { activity: "looping", confidence: 0.9 },
      applied: false,
      costUsd: 0.0001,
    });
  });

  test("an answered outcome is applied", () => {
    const outcome: JevOutcome = { kind: "answered", callId: "c2", answers, meta };
    expect(readStallJudgment(outcome)).toMatchObject({ kind: "judged", applied: true });
  });

  test("anything else is no judgment, with the reason", () => {
    expect(
      readStallJudgment({ kind: "unavailable", callId: "c3", reason: "daily-budget" }),
    ).toEqual({
      kind: "none",
      callId: "c3",
      reason: "unavailable:daily-budget",
      costUsd: null,
    });
  });
});

function judgeHarness(
  options: {
    answers?: Record<string, JevScriptedAnswer>;
    config?: Record<string, unknown>;
    behavior?: JevFakeBehavior;
    cwd?: (root: string) => string;
  } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "stall-judgment-"));
  const cwd = options.cwd ? options.cwd(root) : path.join(root, "work", "a1");
  mkdirSync(cwd, { recursive: true });
  let nowMs = T0;
  const jev = createTestJevService({
    answers: options.answers ?? {
      activity: { type: "choice", choice: "looping", confidence: 0.9 },
    },
    behavior: options.behavior,
    paseoHome: path.join(root, "paseo"),
    homeDir: root,
    config: options.config,
    service: {
      now: () => nowMs,
      resolveAgentCwds: async (ids) => (ids.every((id) => id === "a1") ? [cwd] : null),
    },
  });
  let loopWatch: boolean | (() => boolean) = true;
  const judge = createJevStallJudge({
    jev,
    readLoopWatch: () => (typeof loopWatch === "function" ? loopWatch() : loopWatch),
    now: () => nowMs,
  });
  const request = {
    agentId: "a1",
    branch: "candidate" as const,
    title: "Auth fixer",
    assignment: "Fix the auth tests",
    quietMinutes: 34,
    rows: [bash("npm test -- auth", "failed", "3 failed")],
  };
  return {
    jev,
    judge,
    request,
    advance: (ms: number) => {
      nowMs += ms;
    },
    setLoopWatch: (value: boolean | (() => boolean)) => {
      loopWatch = value;
    },
  };
}

describe("the judge", () => {
  test("defaults to shadow: the answer comes back, not applied", async () => {
    const h = judgeHarness();
    expect(h.judge.isActive()).toBe(true);
    const judgment = await h.judge.judge(h.request);
    expect(judgment).toMatchObject({
      kind: "judged",
      answer: { activity: "looping", confidence: 0.9 },
      applied: false,
    });
    expect(h.jev.transport.calls).toHaveLength(1);
    const sent = h.jev.transport.calls[0];
    expect(sent?.state).toMatchObject({ title: "Auth fixer", quiet_minutes: 34 });
    expect(Object.keys(sent?.questions ?? {})).toEqual(["activity"]);
  });

  test("with shadow off the answer is applied", async () => {
    const h = judgeHarness({ config: { stallJudgment: { shadow: false } } });
    expect(await h.judge.judge(h.request)).toMatchObject({ kind: "judged", applied: true });
  });

  test("an agent in company code sends nothing (D7)", async () => {
    const h = judgeHarness({ cwd: (root) => path.join(root, "backend-net", "wt") });
    expect(await h.judge.judge(h.request)).toEqual({
      kind: "none",
      callId: null,
      reason: "excluded",
      costUsd: null,
    });
    expect(h.jev.transport.calls).toHaveLength(0);
  });

  test("an agent the daemon has no record of sends nothing", async () => {
    const h = judgeHarness();
    expect(await h.judge.judge({ ...h.request, agentId: "ghost" })).toMatchObject({
      kind: "none",
      reason: "excluded",
    });
    expect(h.jev.transport.calls).toHaveLength(0);
  });

  test("fails open on a timeout, an HTTP error and a contract violation", async () => {
    for (const behavior of [
      { kind: "timeout" as const },
      { kind: "http" as const, status: 500 },
      { kind: "contract-violation" as const },
    ]) {
      const h = judgeHarness({ behavior });
      expect(await h.judge.judge(h.request)).toMatchObject({ kind: "none" });
    }
  });

  test("the master switch off sends nothing and reads inactive", async () => {
    const h = judgeHarness({ config: { enabled: false } });
    expect(h.judge.isActive()).toBe(false);
    expect(await h.judge.judge(h.request)).toMatchObject({
      kind: "none",
      reason: "unavailable:disabled",
    });
    expect(h.jev.transport.calls).toHaveLength(0);
  });

  test("the feature switch off sends nothing", async () => {
    const h = judgeHarness({ config: { stallJudgment: { enabled: false } } });
    expect(h.judge.isActive()).toBe(false);
    expect(await h.judge.judge(h.request)).toMatchObject({ kind: "none" });
    expect(h.jev.transport.calls).toHaveLength(0);
  });

  test(`holds each agent to ${MAX_JUDGMENTS_PER_AGENT_PER_HOUR} calls an hour`, async () => {
    const h = judgeHarness();
    for (let index = 0; index < MAX_JUDGMENTS_PER_AGENT_PER_HOUR; index += 1) {
      expect(await h.judge.judge(h.request)).toMatchObject({ kind: "judged" });
      h.advance(60_000);
    }
    expect(await h.judge.judge(h.request)).toEqual({
      kind: "none",
      callId: null,
      reason: "agent-hourly-cap",
      costUsd: null,
    });
    expect(h.jev.transport.calls).toHaveLength(MAX_JUDGMENTS_PER_AGENT_PER_HOUR);
    h.advance(HOUR);
    expect(await h.judge.judge(h.request)).toMatchObject({ kind: "judged" });
  });

  test("redacts a secret in a command line before it leaves", async () => {
    const h = judgeHarness();
    const token = `ghp_${"A1b2C3d4E5f6G7h8".repeat(3)}`;
    await h.judge.judge({
      ...h.request,
      rows: [bash(`gh auth login --with-token ${token}`)],
    });
    const body = JSON.stringify(h.jev.transport.calls[0]);
    expect(body).not.toContain(token);
    expect(body).toContain("[redacted");
  });

  test("records a decision note in the decision store, never the timeline", async () => {
    const h = judgeHarness();
    h.judge.record({
      agentId: "a1",
      callId: "c1",
      feature: "stallJudgment",
      question: "What is this stalled agent doing?",
      verdict: "looping (0.90)",
      confidence: 0.9,
      action: "would have: nudged with a line about the repeat",
      applied: false,
    });
    expect(h.jev.listDecisions("a1")).toEqual([
      expect.objectContaining({ callId: "c1", feature: "stallJudgment", applied: false }),
    ]);
  });

  test("reads the loop watch switch fresh, and a throw as off", () => {
    const h = judgeHarness();
    expect(h.judge.loopWatchEnabled()).toBe(true);
    h.setLoopWatch(false);
    expect(h.judge.loopWatchEnabled()).toBe(false);
    h.setLoopWatch(() => {
      throw new Error("config unreadable");
    });
    expect(h.judge.loopWatchEnabled()).toBe(false);
  });
});
