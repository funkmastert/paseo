import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
      readTokensAvoided: 6_714,
      callerContextTokens: 100_000,
      cwd: "/repo",
      paths: ["/repo/src/a.ts"],
      commandSha256: null,
      diffRisk: null,
      elapsedMs: 900,
      ...overrides,
    };
  }

  test("an answered file tool is live, priced at 2.35 characters a token, and watched for a regret", async () => {
    const { savings, clock } = await ledger();
    const adapt = createToolUseSavingsAdapter({ savings, readAgentModel: () => "claude-sonnet-5" });

    adapt(toolLine());
    const [held] = savings.events({ range: "today" }).events;
    expect(held).toMatchObject({
      feature: "agentTools",
      mode: "live",
      outcome: "answered",
      jevCostUsd: 0.0002,
      tokensSavedEstimate: 64_950,
    });
    expect(held?.basis?.inputs).toMatchObject({ T_avoided: 10_000, T_result: 200 });

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
      tokensSavedEstimate: -7_550,
    });
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
