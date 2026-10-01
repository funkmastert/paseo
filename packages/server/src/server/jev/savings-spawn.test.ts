import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import type { JevLedgerEntry } from "./ledger.js";
import { JevSavingsLedger } from "./savings.js";
import {
  createSpawnHintSavingsRecorder,
  parseJevSpawnLabel,
  type SpawnHintAgentView,
} from "./savings-spawn.js";

const NOON = new Date(2026, 8, 30, 12, 0, 0).getTime();
const HOUR = 60 * 60_000;
const LABEL = "v1;base=-/claude-sonnet-5;would=mechanical/claude-haiku-4-5;move=down;applied=0";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jev-spawn-savings-"));
  const clock = { now: NOON };
  const calls = new Map<string, JevLedgerEntry>();
  const savings = new JevSavingsLedger({
    dir,
    logger: pino({ level: "silent" }),
    now: () => clock.now,
    findCall: (callId) => calls.get(callId) ?? null,
  });
  await savings.load();
  cleanups.push(async () => {
    await savings.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const agents = new Map<string, SpawnHintAgentView>();
  const recorder = createSpawnHintSavingsRecorder({
    savings,
    startedAtMs: NOON - HOUR,
    readAgent: (id) => agents.get(id) ?? null,
    now: () => clock.now,
  });
  calls.set("call-7", {
    callId: "call-7",
    at: new Date(NOON).toISOString(),
    feature: "spawnHint",
    lane: "control",
    callSite: "classifier.spawn-hint",
    subjectAgentIds: [],
    outcome: "shadow",
    reason: null,
    exclusionSignal: null,
    model: "jev-1",
    attempts: 1,
    elapsedMs: 300,
    stateBytes: 100,
    bodyBytes: 200,
    redactions: 0,
    questionCount: 3,
    inputTokens: 400,
    outputTokens: 10,
    cost: { usd: 0.0001, source: "fake" },
    verdicts: [],
    chargedAgentId: null,
  });
  return { savings, recorder, agents, clock };
}

function child(overrides: Partial<SpawnHintAgentView> = {}): SpawnHintAgentView {
  return {
    id: "child-1",
    labels: {
      "paseo.jev-call": "call-7",
      "paseo.jev-spawn": LABEL,
      "paseo.task-class-source": "default",
    },
    workspaceId: "ws-1",
    createdAtMs: NOON,
    closed: false,
    totalTokens: 0,
    model: "claude-sonnet-5",
    ...overrides,
  };
}

describe("paseo.jev-spawn", () => {
  test("parses the role router's label; a missing class is null", () => {
    expect(parseJevSpawnLabel(LABEL)).toEqual({
      baseClass: null,
      baseModel: "claude-sonnet-5",
      wouldClass: "mechanical",
      wouldModel: "claude-haiku-4-5",
      move: "down",
      applied: false,
    });
  });

  test("rejects another version or a broken field", () => {
    expect(parseJevSpawnLabel("v2;base=a/b;would=c/d;move=down;applied=0")).toBeNull();
    expect(parseJevSpawnLabel("v1;base=a;would=c/d;move=down;applied=0")).toBeNull();
    expect(parseJevSpawnLabel("v1;base=a/b;would=c/d;move=sideways;applied=0")).toBeNull();
    expect(parseJevSpawnLabel(undefined)).toBeNull();
  });
});

describe("the spawn hint's savings record", () => {
  test("a new child is recorded pending, and its close prices the would-be move", async () => {
    const { savings, recorder } = await setup();

    recorder.onAgent(child());
    const [pending] = savings.events({ range: "today" }).events;
    expect(pending).toMatchObject({
      feature: "spawnHint",
      mode: "shadow",
      agentId: "child-1",
      workspaceId: "ws-1",
      pending: true,
      decision: { wouldBe: "mechanical on claude-haiku-4-5", changed: false },
    });

    recorder.onAgent(child({ closed: true, totalTokens: 100_000 }));
    const [settled] = savings.events({ range: "today" }).events;
    expect(settled).toMatchObject({ pending: false, tokensSavedEstimate: 25_000 });
    expect(savings.summary("today").shadow.tokensWouldSave).toBe(25_000);
    expect(savings.summary("today").live.tokensSaved).toBe(0);
  });

  test("a child that outlived a restart settles partial: its tokens restarted at zero", async () => {
    const { savings, recorder } = await setup();
    recorder.onAgent(child());

    recorder.onAgent(child({ createdAtMs: NOON - 2 * HOUR, closed: true, totalTokens: 3_000 }));

    const [event] = savings.events({ range: "today" }).events;
    expect(event).toMatchObject({ pending: false, tokensSavedEstimate: null });
    expect(event?.basis?.formula).toContain("partial");
  });

  test("a child still open after 24 hours settles with what it has spent", async () => {
    const { savings, recorder, agents, clock } = await setup();
    recorder.onAgent(child());
    agents.set("child-1", child({ totalTokens: 40_000 }));

    clock.now = NOON + 25 * HOUR;
    recorder.sweep();

    expect(savings.events({ range: "7d" }).events[0]).toMatchObject({
      tokensSavedEstimate: 10_000,
    });
  });

  test("an agent with no spawn label, or created before the daemon with no record, is left alone", async () => {
    const { savings, recorder } = await setup();

    recorder.onAgent(child({ labels: { "paseo.jev-call": "call-7" } }));
    recorder.onAgent(child({ createdAtMs: NOON - 2 * HOUR }));

    expect(savings.events({ range: "today" }).events).toEqual([]);
  });
});
