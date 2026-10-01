import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import type { JevLedgerEntry } from "./ledger.js";
import { JevSavingsLedger } from "./savings.js";
import {
  createStallJudgmentSavingsAdapter,
  createToolUseSavingsAdapter,
  JsonlTail,
  startSavingsAdapters,
} from "./savings-adapters.js";
import { createRemediationSavingsHook, RemediationAgentCosts } from "./savings-hooks.js";

const NOON = new Date(2026, 8, 30, 12, 0, 0).getTime();
const MINUTE = 60_000;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jev-savings-adapters-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function ledger() {
  const dir = tempDir();
  const clock = { now: NOON };
  const calls = new Map<string, JevLedgerEntry>();
  const savings = new JevSavingsLedger({
    dir,
    logger: pino({ level: "silent" }),
    now: () => clock.now,
    findCall: (callId) => calls.get(callId) ?? null,
  });
  await savings.load();
  cleanups.push(() => savings.stop());
  return { savings, calls, clock };
}

describe("JsonlTail", () => {
  test("skips what the file held at start, then delivers whole appended lines, across a rotation", async () => {
    const dir = tempDir();
    const file = path.join(dir, "tool-use.jsonl");
    const rotated = path.join(dir, "tool-use.1.jsonl");
    writeFileSync(file, `${JSON.stringify({ n: 0 })}\n`);
    const seen: unknown[] = [];
    const tail = new JsonlTail(file, rotated, (line) => seen.push(line["n"]));
    await tail.start();

    appendFileSync(file, `${JSON.stringify({ n: 1 })}\n{"n":`);
    await tail.poll();
    expect(seen).toEqual([1]);

    appendFileSync(file, `2}\n`);
    appendFileSync(file, `${JSON.stringify({ n: 3 })}\n`);
    renameSync(file, rotated);
    writeFileSync(file, `${JSON.stringify({ n: 4 })}\n`);
    await tail.poll();
    expect(seen).toEqual([1, 2, 3, 4]);
  });
});

describe("JsonlTail edges (review m3)", () => {
  test("a file rewritten in place, as a boot prune does, is not read as a rotation", async () => {
    const dir = tempDir();
    const file = path.join(dir, "stall-judgments.jsonl");
    const rotated = path.join(dir, "stall-judgments.1.jsonl");
    writeFileSync(rotated, `${JSON.stringify({ n: "rotated-old" })}\n`.repeat(20));
    writeFileSync(file, `${JSON.stringify({ n: "old" })}\n`.repeat(10));
    const seen: unknown[] = [];
    const tail = new JsonlTail(file, rotated, (line) => seen.push(line["n"]));
    await tail.start();

    // The prune writes a shorter file and renames it over the old one.
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ n: "old" })}\n`.repeat(2));
    renameSync(`${file}.tmp`, file);
    await tail.poll();
    appendFileSync(file, `${JSON.stringify({ n: "new" })}\n`);
    await tail.poll();
    expect(seen).toEqual(["new"]);
  });

  test("a rotation is seen even when the new file already outgrew the old offset", async () => {
    const dir = tempDir();
    const file = path.join(dir, "tool-use.jsonl");
    const rotated = path.join(dir, "tool-use.1.jsonl");
    writeFileSync(file, `${JSON.stringify({ n: 0 })}\n`);
    const seen: unknown[] = [];
    const tail = new JsonlTail(file, rotated, (line) => seen.push(line["n"]));
    await tail.start();

    appendFileSync(file, `${JSON.stringify({ n: 1 })}\n`);
    renameSync(file, rotated);
    writeFileSync(file, `${JSON.stringify({ n: 2, pad: "x".repeat(200) })}\n`);
    await tail.poll();
    expect(seen).toEqual([1, 2]);
  });

  test("stop polls a last time, so the last lines before shutdown count", async () => {
    const dir = tempDir();
    const { savings } = await ledger();
    const adapters = startSavingsAdapters({
      jevDir: dir,
      savings,
      readAgentModel: () => "claude-sonnet-5",
      logger: pino({ level: "silent" }),
    });
    await adapters.poll();
    appendFileSync(
      path.join(dir, "tool-use.jsonl"),
      `${JSON.stringify({
        v: 1,
        at: new Date(NOON).toISOString(),
        agentId: "agent-1",
        tool: "ask_jev_file_bool",
        outcome: "answered",
        jevCalls: 1,
        jevUsd: 0.0001,
        resultChars: 100,
        readTokensAvoided: 1_000,
        callerContextTokens: null,
        paths: ["/repo/a.ts"],
      })}\n`,
    );
    await adapters.stop();
    expect(savings.events({ range: "today" }).events).toHaveLength(1);
  });
});

describe("the agent tools adapter (tool-use.jsonl)", () => {
  function toolLine(overrides: Record<string, unknown> = {}) {
    return {
      v: 1,
      at: new Date(NOON).toISOString(),
      agentId: "agent-1",
      arm: "on",
      tool: "ask_jev_file_bool",
      outcome: "answered",
      reason: null,
      jevCalls: 1,
      jevAnswered: 1,
      jevUsd: 0.0002,
      jevInputTokens: 2_000,
      resultChars: 470,
      readTokensAvoided: 10_000,
      callerContextTokens: 100_000,
      cwd: "/repo",
      paths: ["/repo/src/a.ts"],
      commandSha256: null,
      diffRisk: null,
      elapsedMs: 900,
      ...overrides,
    };
  }

  /** Feature 16's observer reporting some other read, so a closing window can hold. */
  function observerRead(savings: JevSavingsLedger, atMs: number) {
    savings.noteRead({
      agentId: "agent-other",
      path: "/repo/elsewhere.ts",
      tool: "Read",
      at: new Date(atMs).toISOString(),
      contextTokens: 100,
    });
  }

  test("an answered file tool is live and pending until its regret window closes; a re-read is a regret", async () => {
    const { savings, clock } = await ledger();
    const adapt = createToolUseSavingsAdapter({ savings, readAgentModel: () => "claude-sonnet-5" });

    adapt(toolLine());
    const [record] = savings.events({ range: "today" }).events;
    expect(record).toMatchObject({
      feature: "agentTools",
      mode: "live",
      outcome: "answered",
      jevCostUsd: 0.0002,
      pending: true,
      tokensSavedEstimate: null,
    });
    expect(savings.summary("today").live.tokensSaved).toBe(0);

    clock.now = NOON + 5 * MINUTE;
    savings.noteRead({
      agentId: "agent-1",
      path: "/repo/src/a.ts",
      tool: "Read",
      at: new Date(clock.now).toISOString(),
      contextTokens: 4_000,
    });
    expect(savings.events({ range: "today" }).events[0]).toMatchObject({
      validation: { outcome: "regret" },
      pending: false,
      tokensSavedEstimate: -7_475,
    });
  });

  test("T_avoided is the tools track's own count, used as it is (review example 2)", async () => {
    // The tools branch's `estimateReadTokens` for a 20,000-character, 400-line file: characters
    // plus Read's 7-character line prefix, at 2.35 characters a token (`jev-tool-use-log.ts`).
    const readTokensAvoided = Math.ceil((20_000 + 7 * 400) / 2.35);
    expect(readTokensAvoided).toBe(9_703);
    const { savings, clock } = await ledger();
    const adapt = createToolUseSavingsAdapter({ savings, readAgentModel: () => "claude-sonnet-5" });

    adapt(toolLine({ readTokensAvoided, resultChars: 470, callerContextTokens: 150_000 }));
    observerRead(savings, NOON + 10 * MINUTE);
    clock.now = NOON + 61 * MINUTE;
    savings.sweep();

    const [record] = savings.events({ range: "today" }).events;
    expect(record?.validation).toMatchObject({ outcome: "held" });
    expect(record?.basis?.inputs).toMatchObject({ T_avoided: 9_703, T_result: 200, C: 150_000 });
    // (9,703 - 200) x 13.75 x 0.5 - (0.1 x 150,000 + 2,200) x 0.5
    expect(record?.tokensSavedEstimate).toBe(56_733);
    expect(savings.summary("today").live.tokensSaved).toBe(56_733);
  });

  test("a window nothing watched gives no figure, and neither does a call that sent no path", async () => {
    const { savings, clock } = await ledger();
    const adapt = createToolUseSavingsAdapter({ savings, readAgentModel: () => "claude-sonnet-5" });

    adapt(toolLine());
    adapt(toolLine({ tool: "ask_jev", paths: [], at: new Date(NOON + 1).toISOString() }));
    clock.now = NOON + 61 * MINUTE;
    savings.sweep();

    const events = savings.events({ range: "today" }).events;
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({ pending: false, tokensSavedEstimate: null, validation: null });
    }
    expect(savings.summary("today").live.tokensSaved).toBe(0);
  });

  test("the regret window survives a restart: a re-read after it is still a regret", async () => {
    const dir = tempDir();
    const clock = { now: NOON };
    const open = async () => {
      const savings = new JevSavingsLedger({
        dir,
        logger: pino({ level: "silent" }),
        now: () => clock.now,
        findCall: () => null,
      });
      await savings.load();
      cleanups.push(() => savings.stop());
      return savings;
    };
    const first = await open();
    createToolUseSavingsAdapter({ savings: first, readAgentModel: () => "claude-sonnet-5" })(
      toolLine(),
    );
    await first.stop();

    clock.now = NOON + 20 * MINUTE;
    const second = await open();
    expect(second.events({ range: "today" }).events[0]).toMatchObject({ pending: true });
    second.noteRead({
      agentId: "agent-1",
      path: "/repo/src/a.ts",
      tool: "Read",
      at: new Date(clock.now).toISOString(),
      contextTokens: 4_000,
    });
    const [event] = second.events({ range: "today" }).events;
    expect(event).toMatchObject({ validation: { outcome: "regret" }, tokensSavedEstimate: -7_475 });
    expect(event?.decision.detail).not.toHaveProperty("regretPaths");
  });

  test("a regret read by the real path matches a call that named the file through a symlink", async () => {
    const dir = tempDir();
    const realDir = path.join(dir, "real");
    mkdirSync(realDir);
    writeFileSync(path.join(realDir, "a.ts"), "x");
    symlinkSync(realDir, path.join(dir, "link"));
    const { savings } = await ledger();
    createToolUseSavingsAdapter({ savings, readAgentModel: () => "claude-sonnet-5" })(
      toolLine({ paths: [path.join(dir, "link", "a.ts")] }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    savings.noteRead({
      agentId: "agent-1",
      path: realpathSync(path.join(realDir, "a.ts")),
      tool: "Read",
      at: new Date(NOON + MINUTE).toISOString(),
      contextTokens: 4_000,
    });
    expect(savings.events({ range: "today" }).events[0]?.validation).toMatchObject({
      outcome: "regret",
    });
  });

  test("two different calls of one tool in the same millisecond are two records (review m8)", async () => {
    const { savings } = await ledger();
    const adapt = createToolUseSavingsAdapter({ savings, readAgentModel: () => "claude-sonnet-5" });

    adapt(toolLine({ paths: ["/repo/src/a.ts"] }));
    adapt(toolLine({ paths: ["/repo/src/b.ts"] }));
    adapt(toolLine({ paths: ["/repo/src/b.ts"] }));

    expect(savings.events({ range: "today" }).events).toHaveLength(2);
  });

  test("a refusal is nothing, an unavailable call is a not-asked count, ask_jev_diff_risk claims nothing", async () => {
    const { savings } = await ledger();
    const adapt = createToolUseSavingsAdapter({ savings, readAgentModel: () => "claude-sonnet-5" });

    adapt(toolLine({ outcome: "refused", jevCalls: 0 }));
    adapt(toolLine({ outcome: "unavailable", jevCalls: 1 }));
    adapt(toolLine({ outcome: "unavailable", reason: "unavailable: excluded", jevCalls: 1 }));
    adapt(toolLine({ tool: "ask_jev_diff_risk", at: new Date(NOON + 1).toISOString() }));

    const tools = savings.summary("today").features.find((f) => f.feature === "agentTools");
    expect(tools?.notAsked).toEqual({ inactive: 1, excluded: 1 });
    expect(savings.events({ range: "today" }).events).toMatchObject([
      { benefit: "none", tokensSavedEstimate: null },
    ]);
  });
});

describe("the stall judgment adapter (stall-judgments.jsonl) and its remediation join", () => {
  function entry(callId: string): JevLedgerEntry {
    return {
      callId,
      at: new Date(NOON).toISOString(),
      feature: "stallJudgment",
      lane: "control",
      callSite: "stalls.candidate",
      subjectAgentIds: ["agent-1"],
      outcome: "shadow",
      reason: null,
      exclusionSignal: null,
      model: "jev-1",
      attempts: 1,
      elapsedMs: 300,
      stateBytes: 100,
      bodyBytes: 200,
      redactions: 0,
      questionCount: 1,
      inputTokens: 2_000,
      outputTokens: 5,
      cost: { usd: 0.0001, source: "fake" },
      verdicts: [],
      chargedAgentId: null,
    };
  }

  function judgment(activity: string, confidence: number, callId = "stall-1") {
    return {
      type: "judgment",
      at: new Date(NOON).toISOString(),
      branch: "candidate",
      agentId: "agent-1",
      episodeKey: "stalled-agent:agent-1",
      callId,
      judgment: { activity, confidence, applied: false },
      reason: null,
      action: "nudge",
      wouldAction: "nudge, person first",
      costUsd: 0.0001,
      quietMinutes: 40,
    };
  }

  test("a person-first label waits on the episode's remediation agent, which settles and validates it", async () => {
    const { savings, calls } = await ledger();
    calls.set("stall-1", entry("stall-1"));
    createStallJudgmentSavingsAdapter({ savings })(judgment("blocked_missing_info", 0.8));
    expect(savings.events({ range: "today" }).events[0]).toMatchObject({
      mode: "shadow",
      pending: true,
    });

    const hook = createRemediationSavingsHook({
      savings,
      costs: new RemediationAgentCosts(),
      now: () => NOON,
    });
    hook({
      type: "agent-ended",
      at: new Date(NOON + 30 * MINUTE).toISOString(),
      episode: "ep-1",
      key: "stalled-agent:agent-1",
      kind: "stalled-agent",
      agentId: "fixer-1",
      result: "not-fixed",
      cause: "report",
      agentTotalTokens: 50_000,
      agentModel: "claude-haiku-4-5",
      minutesRunning: 20,
      triageCallId: null,
      triageWouldBe: null,
      triageApplied: null,
    });

    expect(savings.events({ range: "today" }).events[0]).toMatchObject({
      pending: false,
      tokensSavedEstimate: 12_500,
      validation: { outcome: "held", signal: "not-fixed" },
    });
  });

  test("one stalled-agent episode's agent is claimed once: feature 10's person-first label owns it (review M4)", async () => {
    const { savings, calls } = await ledger();
    calls.set("stall-1", entry("stall-1"));
    calls.set("stall-2", entry("stall-2"));
    calls.set("triage-1", {
      ...entry("triage-1"),
      feature: "remediationTriage",
      callSite: "remediation.triage",
    });
    const adapt = createStallJudgmentSavingsAdapter({ savings });
    adapt(judgment("blocked_missing_info", 0.8, "stall-1"));
    // A second judgment of the same episode, after a recheck.
    adapt({
      ...judgment("waiting_on_human", 0.9, "stall-2"),
      at: new Date(NOON + 1).toISOString(),
    });

    const hook = createRemediationSavingsHook({
      savings,
      costs: new RemediationAgentCosts(),
      now: () => NOON,
    });
    const triageEvent = {
      type: "triage" as const,
      at: new Date(NOON + 5 * MINUTE).toISOString(),
      episode: "ep-1",
      key: "stalled-agent:agent-1",
      kind: "stalled-agent",
      level: "alert" as const,
      willPush: true,
      pushPreview: null,
      linkedAgentId: "agent-1",
      triage: {
        callId: "triage-1",
        outcome: "shadow" as const,
        reason: null,
        route: "needs_person",
        routeConfidence: 0.9,
        evidenceCurrent: 0.9,
        costUsd: 0.0001,
      },
      decision: {
        wouldBe: "person" as const,
        action: "start-agent" as const,
        applied: false,
        deferMs: 10 * MINUTE,
      },
    };
    hook(triageEvent);
    hook({
      type: "agent-ended",
      at: new Date(NOON + 40 * MINUTE).toISOString(),
      episode: "ep-1",
      key: "stalled-agent:agent-1",
      kind: "stalled-agent",
      agentId: "fixer-1",
      result: "not-fixed",
      cause: "report",
      agentTotalTokens: 2_000_000,
      agentModel: "claude-sonnet-5",
      minutesRunning: 30,
      triageCallId: "triage-1",
      triageWouldBe: "person",
      triageApplied: false,
    });

    const byCall = new Map(
      savings.events({ range: "today" }).events.map((event) => [event.id, event]),
    );
    const figure = (callId: string) => byCall.get(savings.idForCall(callId) ?? "");
    expect(figure("stall-1")).toMatchObject({ pending: false, tokensSavedEstimate: 1_000_000 });
    expect(figure("stall-2")).toMatchObject({ pending: false, tokensSavedEstimate: 0 });
    expect(figure("triage-1")).toMatchObject({ pending: false, tokensSavedEstimate: 0 });
    expect(figure("triage-1")?.basis?.formula).toContain("feature 10");
    expect(savings.summary("today").shadow.tokensWouldSave).toBe(1_000_000);
  });

  test("a person-first label whose escalation would not push owns nothing: the ladder starts the agent", async () => {
    const { savings, calls } = await ledger();
    calls.set("stall-1", entry("stall-1"));
    calls.set("triage-1", { ...entry("triage-1"), feature: "remediationTriage" });
    createStallJudgmentSavingsAdapter({ savings })(judgment("blocked_missing_info", 0.8));
    const hook = createRemediationSavingsHook({
      savings,
      costs: new RemediationAgentCosts(),
      now: () => NOON,
    });
    hook({
      type: "triage",
      at: new Date(NOON).toISOString(),
      episode: "ep-1",
      key: "stalled-agent:agent-1",
      kind: "stalled-agent",
      level: "alert",
      willPush: false,
      pushPreview: null,
      linkedAgentId: "agent-1",
      triage: {
        callId: "triage-1",
        outcome: "shadow",
        reason: null,
        route: "clearing_on_its_own",
        routeConfidence: 0.9,
        evidenceCurrent: 0.1,
        costUsd: 0.0001,
      },
      decision: {
        wouldBe: "start-agent",
        action: "start-agent",
        applied: false,
        deferMs: 10 * MINUTE,
      },
    });
    hook({
      type: "agent-ended",
      at: new Date(NOON + 40 * MINUTE).toISOString(),
      episode: "ep-1",
      key: "stalled-agent:agent-1",
      kind: "stalled-agent",
      agentId: "fixer-1",
      result: "not-fixed",
      cause: "report",
      agentTotalTokens: 2_000_000,
      agentModel: "claude-sonnet-5",
      minutesRunning: 30,
      triageCallId: "triage-1",
      triageWouldBe: "start-agent",
      triageApplied: false,
    });

    expect(savings.summary("today").shadow.tokensWouldSave).toBe(0);
  });

  test("a stall that closed before rung 2 saves nothing; a progressing hold that stayed stalled is contradicted", async () => {
    const { savings, calls } = await ledger();
    calls.set("stall-1", entry("stall-1"));
    calls.set("stall-2", entry("stall-2"));
    const adapt = createStallJudgmentSavingsAdapter({ savings });

    adapt(judgment("waiting_on_human", 0.9, "stall-1"));
    adapt({
      type: "episode-closed",
      episodeKey: "stalled-agent:agent-1",
      pastRecheck: false,
      held: false,
    });
    adapt({ ...judgment("progressing", 0.9, "stall-2"), episodeKey: "stalled-agent:agent-2" });
    adapt({
      type: "episode-closed",
      episodeKey: "stalled-agent:agent-2",
      pastRecheck: true,
      held: true,
      closedDuringHold: false,
      minutesAfterAct: 30,
    });

    const byCall = new Map(
      savings.events({ range: "today" }).events.map((e) => [e.decision.detail?.["episodeKey"], e]),
    );
    expect(byCall.get("stalled-agent:agent-1")).toMatchObject({
      pending: false,
      tokensSavedEstimate: 0,
    });
    expect(byCall.get("stalled-agent:agent-2")).toMatchObject({
      tokensSavedEstimate: 0,
      validation: { outcome: "contradicted", signal: "still-stalled-after-hold" },
    });
  });
});
