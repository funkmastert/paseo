import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { JevSavingsInput } from "./contract.js";
import type { JevLedgerEntry } from "./ledger.js";
import { JevSavingsLedger, savingsIdForCall, type JevSavingsLedgerOptions } from "./savings.js";
import { DROP_JEV_SAVINGS } from "./service.js";

const logger = pino({ level: "silent" });
const NOON = new Date(2026, 8, 30, 12, 0, 0).getTime();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const tempDirs: string[] = [];
const ledgers: JevSavingsLedger[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jev-savings-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const ledger of ledgers.splice(0)) await ledger.stop();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function entry(callId: string, overrides: Partial<JevLedgerEntry> = {}): JevLedgerEntry {
  return {
    callId,
    at: new Date(NOON).toISOString(),
    feature: "remediationTriage",
    lane: "control",
    callSite: "remediation.triage",
    subjectAgentIds: [],
    outcome: "shadow",
    reason: null,
    exclusionSignal: null,
    model: "jev-1",
    attempts: 1,
    elapsedMs: 200,
    stateBytes: 100,
    bodyBytes: 200,
    redactions: 0,
    questionCount: 1,
    inputTokens: 300,
    outputTokens: 5,
    cost: { usd: 0.0001, source: "fake" },
    verdicts: [],
    chargedAgentId: null,
    ...overrides,
  };
}

interface Harness {
  ledger: JevSavingsLedger;
  calls: Map<string, JevLedgerEntry>;
  clock: { now: number };
  dir: string;
  options: JevSavingsLedgerOptions;
}

async function harness(
  overrides: Partial<JevSavingsLedgerOptions> & {
    dir?: string;
    calls?: Map<string, JevLedgerEntry>;
  } = {},
): Promise<Harness> {
  const dir = overrides.dir ?? tempDir();
  const calls = overrides.calls ?? new Map<string, JevLedgerEntry>();
  const clock = { now: NOON };
  const options: JevSavingsLedgerOptions = {
    dir,
    logger,
    now: () => clock.now,
    findCall: (callId) => calls.get(callId) ?? null,
    featureState: () => "shadow",
    agentTitle: (agentId) => `title of ${agentId}`,
    ...overrides,
  };
  const ledger = new JevSavingsLedger(options);
  ledgers.push(ledger);
  await ledger.load();
  return { ledger, calls, clock, dir, options };
}

function skipInput(callId: string, overrides: Partial<JevSavingsInput> = {}): JevSavingsInput {
  return {
    feature: "remediationTriage",
    callSite: "remediation.triage",
    callId,
    agentId: "agent-1",
    workspaceId: "ws-1",
    involvement: "Should a remediation agent handle this?",
    decision: { did: "start-agent", wouldBe: "person", changed: false },
    facts: { kind: "stalled-agent" },
    pending: true,
    ...overrides,
  };
}

function lines(dir: string, name = "savings.jsonl"): Array<Record<string, unknown>> {
  const file = path.join(dir, name);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function flushed(h: Harness): Promise<void> {
  await h.ledger.stop();
}

describe("writing", () => {
  test("record appends one involvement line, 0600, and returns a time-ordered sv_ id", async () => {
    const h = await harness();
    h.calls.set("c1", entry("c1"));

    const id = h.ledger.record(skipInput("c1"));
    await flushed(h);

    expect(id).toMatch(/^sv_[0-9a-z]+$/);
    const [line] = lines(h.dir);
    expect(line).toMatchObject({
      v: 1,
      type: "involvement",
      id,
      callId: "c1",
      mode: "shadow",
      pending: true,
    });
    if (process.platform !== "win32") {
      expect(statSync(path.join(h.dir, "savings.jsonl")).mode & 0o777).toBe(0o600);
    }
  });

  test("mode comes from the call's outcome, never from what the decision says", async () => {
    const h = await harness();
    h.calls.set("live", entry("live", { outcome: "answered" }));
    h.calls.set("shadow", entry("shadow", { outcome: "shadow" }));

    // A live answer that kept today's behaviour: changed false, still live.
    h.ledger.record(
      skipInput("live", {
        decision: { did: "start-agent", wouldBe: "start-agent", changed: false },
      }),
    );
    h.ledger.record(
      skipInput("shadow", { decision: { did: "start-agent", wouldBe: "person", changed: true } }),
    );

    const events = h.ledger.events({ range: "today" }).events;
    expect(
      events.find(
        (event) => event.decision.did === "start-agent" && event.decision.wouldBe === "start-agent",
      )?.mode,
    ).toBe("live");
    expect(events.find((event) => event.decision.wouldBe === "person")?.mode).toBe("shadow");
  });

  test("a call the ledger does not hold is dropped with one log line", async () => {
    const info = vi.fn();
    const spyLogger = Object.assign(Object.create(logger), { info, warn: vi.fn() });
    const h = await harness({ logger: spyLogger });

    expect(h.ledger.record(skipInput("ghost"))).toBe("");
    expect(h.ledger.record(skipInput("ghost"))).toBe("");
    await flushed(h);

    expect(info).toHaveBeenCalledTimes(1);
    expect(lines(h.dir)).toEqual([]);
  });

  test("an unavailable call is a not-asked counter in the rollup, never a line", async () => {
    const h = await harness();
    h.calls.set("off", entry("off", { outcome: "unavailable", reason: "no-key", attempts: 0 }));
    h.calls.set("d7", entry("d7", { outcome: "unavailable", reason: "excluded", attempts: 0 }));

    h.ledger.record(skipInput("off"));
    h.ledger.record(skipInput("d7"));
    h.ledger.countNotAsked("readCheck", "below-floor");
    await flushed(h);

    expect(lines(h.dir)).toEqual([]);
    const summary = h.ledger.summary("today");
    const remediation = summary.features.find((f) => f.feature === "remediationTriage");
    expect(remediation?.notAsked).toEqual({ inactive: 1, excluded: 1 });
    expect(remediation?.asked).toBe(0);
    expect(summary.features.find((f) => f.feature === "readCheck")?.notAsked).toEqual({
      "below-floor": 1,
    });
  });

  test("a failure before sending is no record; one after sending takes the feature's mode", async () => {
    const h = await harness({ featureShadow: () => true });
    h.calls.set("unsent", entry("unsent", { outcome: "failed", reason: "redaction", attempts: 0 }));
    h.calls.set("sent", entry("sent", { outcome: "failed", reason: "timeout", attempts: 1 }));

    expect(h.ledger.record(skipInput("unsent"))).toBe("");
    const id = h.ledger.record(skipInput("sent"));

    expect(h.ledger.events({ range: "today" }).events).toMatchObject([
      { id, mode: "shadow", outcome: "failed" },
    ]);
  });

  test("one record per call: a second record returns the first id", async () => {
    const h = await harness();
    h.calls.set("c1", entry("c1"));

    const first = h.ledger.record(skipInput("c1"));
    const second = h.ledger.record(skipInput("c1"));

    expect(second).toBe(first);
    expect(h.ledger.idForCall("c1")).toBe(first);
    expect(savingsIdForCall(h.ledger, "c1")).toBe(first);
    expect(savingsIdForCall(DROP_JEV_SAVINGS, "c1")).toBeNull();
  });
});

describe("settling and validating", () => {
  test("settle reprices with the later facts; validate lands once", async () => {
    const h = await harness();
    h.calls.set("c1", entry("c1"));
    const id = h.ledger.record(skipInput("c1"));

    h.ledger.settle(id, { fixed: false, agentTotalTokens: 40_000, agentModel: "claude-sonnet-5" });
    h.ledger.validate(id, { outcome: "held", signal: "not-fixed", afterMinutes: 30 });
    h.ledger.validate(id, { outcome: "contradicted", signal: "fixed", afterMinutes: 31 });
    await flushed(h);

    const [event] = h.ledger.events({ range: "today" }).events;
    expect(event).toMatchObject({
      tokensSavedEstimate: 20_000,
      pending: false,
      validation: { outcome: "held" },
    });
    expect(lines(h.dir).map((line) => line["type"])).toEqual([
      "involvement",
      "settled",
      "validated",
    ]);
    expect(lines(h.dir)[1]).toMatchObject({ tokensSavedEstimate: 20_000, facts: { fixed: false } });
  });

  test("a record still pending after 7 days settles partial", async () => {
    const h = await harness();
    h.calls.set("c1", entry("c1"));
    const id = h.ledger.record(skipInput("c1"));

    h.clock.now = NOON + 7 * DAY;
    h.ledger.sweep();

    const event = h.ledger.events({ range: "all" }).events.find((e) => e.id === id);
    expect(event).toMatchObject({ pending: false, tokensSavedEstimate: null });
    expect(event?.basis?.formula).toContain("partial");
  });

  test("a read of a watched path is a regret; a window closed while reads are reported holds", async () => {
    const h = await harness();
    const toolInput = (callId: string): JevSavingsInput => ({
      feature: "agentTools",
      callSite: "tools.ask_jev_file_bool",
      callId,
      agentId: "agent-1",
      involvement: "ask_jev_file_bool",
      decision: { did: "answered", wouldBe: null, changed: true },
      facts: {
        tool: "ask_jev_file_bool",
        answered: true,
        tAvoided: 10_000,
        tResult: 200,
        callerContextTokens: 100_000,
        model: "claude-sonnet-5",
      },
    });
    const regretId = h.ledger.recordObserved(toolInput("t1"), {
      mode: "live",
      outcome: "answered",
      jevCostUsd: 0.0001,
    });
    const heldId = h.ledger.recordObserved(toolInput("t2"), {
      mode: "live",
      outcome: "answered",
      jevCostUsd: 0.0001,
    });
    h.ledger.watchReads(regretId, "agent-1", ["/repo/a.ts"], 60 * MINUTE);
    h.ledger.watchReads(heldId, "agent-1", ["/repo/b.ts"], 60 * MINUTE);

    h.clock.now = NOON + 5 * MINUTE;
    h.ledger.noteRead({
      agentId: "agent-1",
      path: "/repo/a.ts",
      tool: "Read",
      at: new Date(h.clock.now).toISOString(),
      contextTokens: 900,
    });
    h.clock.now = NOON + 61 * MINUTE;
    h.ledger.sweep();

    const byId = new Map(
      h.ledger.events({ range: "today" }).events.map((event) => [event.id, event]),
    );
    expect(byId.get(regretId)).toMatchObject({
      validation: { outcome: "regret" },
      tokensSavedEstimate: -7_550,
    });
    expect(byId.get(heldId)).toMatchObject({
      validation: { outcome: "held" },
      tokensSavedEstimate: 64_950,
    });
  });

  test("with no read observer reporting, a closed window validates nothing", async () => {
    const h = await harness();
    const id = h.ledger.recordObserved(
      {
        feature: "agentTools",
        callSite: "tools.ask_jev_files",
        callId: "t1",
        involvement: "ask_jev_files",
        decision: { did: "answered", wouldBe: null, changed: true },
        facts: { tool: "ask_jev_files", answered: true },
      },
      { mode: "live", outcome: "answered", jevCostUsd: null },
    );
    h.ledger.watchReads(id, "agent-1", ["/repo/a.ts"], 60 * MINUTE);

    h.clock.now = NOON + 61 * MINUTE;
    h.ledger.sweep();

    expect(h.ledger.events({ range: "today" }).events[0]?.validation).toBeNull();
  });
});

describe("storage", () => {
  test("a restart folds the file back and keeps the rollup, not-asked counts included", async () => {
    const dir = tempDir();
    const calls = new Map([
      ["c1", entry("c1")],
      ["c2", entry("c2", { outcome: "answered" })],
    ]);
    const first = await harness({ dir, calls });
    const id = first.ledger.record(skipInput("c1"));
    first.ledger.record(
      skipInput("c2", {
        decision: { did: "person", wouldBe: "person", changed: true },
        facts: { medianTokens: 9_000 },
      }),
    );
    first.ledger.settle(id, {
      fixed: false,
      agentTotalTokens: 40_000,
      agentModel: "claude-opus-5-5",
    });
    first.ledger.countNotAsked("remediationTriage", "inactive");
    const before = first.ledger.summary("today");
    await flushed(first);

    const second = await harness({ dir, calls: new Map() });

    expect(second.ledger.summary("today")).toEqual(before);
    expect(second.ledger.idForCall("c1")).toBe(id);
    expect(before.shadow.tokensWouldSave).toBe(40_000);
    expect(before.live.tokensSaved).toBe(9_000);
    expect(before.features.find((f) => f.feature === "remediationTriage")?.notAsked).toEqual({
      inactive: 1,
    });
  });

  test("a settle after a restart reprices from the persisted facts", async () => {
    const dir = tempDir();
    const calls = new Map([["c1", entry("c1")]]);
    const first = await harness({ dir, calls });
    const id = first.ledger.record(skipInput("c1"));
    await flushed(first);

    const second = await harness({ dir, calls: new Map() });
    second.ledger.settle(id, {
      fixed: false,
      agentTotalTokens: 10_000,
      agentModel: "claude-haiku-4-5",
    });

    expect(second.ledger.summary("today").shadow.tokensWouldSave).toBe(2_500);
  });

  test("rotates once at maxBytes", async () => {
    const h = await harness({ maxBytes: 1_500 });
    for (let index = 0; index < 6; index += 1) {
      h.calls.set(`c${index}`, entry(`c${index}`));
      h.ledger.record(skipInput(`c${index}`));
    }
    await flushed(h);

    expect(existsSync(path.join(h.dir, "savings.jsonl.1"))).toBe(true);
    const kept = lines(h.dir).length + lines(h.dir, "savings.jsonl.1").length;
    expect(kept).toBeLessThan(6);

    // Both files load back after a restart.
    const again = await harness({ dir: h.dir, calls: new Map() });
    expect(again.ledger.events({ range: "today" }).events).toHaveLength(kept);
  });

  test("lines older than 30 days are pruned at boot; the rollup keeps their day", async () => {
    const dir = tempDir();
    const old = new Date(NOON - 40 * DAY);
    const calls = new Map([
      ["old", entry("old", { at: old.toISOString() })],
      ["new", entry("new")],
    ]);
    const first = await harness({ dir, calls });
    first.ledger.record(skipInput("old"));
    first.ledger.record(skipInput("new"));
    await flushed(first);

    const second = await harness({ dir, calls: new Map() });

    expect(lines(dir).map((line) => line["callId"])).toEqual(["new"]);
    const all = second.ledger.summary("all");
    expect(all.shadow.involvements).toBe(2);
    expect(second.ledger.events({ range: "all" }).events.map((event) => event.id)).toHaveLength(1);
  });

  test("a malformed rollup or line is skipped, not fatal", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "savings-days.json"), "{not json");
    writeFileSync(path.join(dir, "savings.jsonl"), "garbage\n");

    const h = await harness({ dir });

    expect(h.ledger.summary("today").shadow.involvements).toBe(0);
    expect(lines(dir)).toEqual([]);
  });
});

describe("the reader", () => {
  async function seeded() {
    const h = await harness({
      daySpends: () => [{ day: "2026-09-30", calls: 9, usd: 0.0008 }],
      workspaceLabel: (id) => `ws ${id}`,
    });
    const add = (
      callId: string,
      input: Partial<JevSavingsInput>,
      outcome: JevLedgerEntry["outcome"] = "shadow",
    ) => {
      h.calls.set(callId, entry(callId, { outcome }));
      return h.ledger.record(skipInput(callId, input));
    };
    const a = add("c1", { agentId: "agent-1" });
    h.ledger.settle(a, { fixed: false, agentTotalTokens: 40_000, agentModel: "claude-opus-5-5" });
    add(
      "c2",
      {
        agentId: "agent-2",
        decision: { did: "person", wouldBe: "person", changed: true },
        facts: { medianTokens: 5_000 },
      },
      "answered",
    );
    add("c3", {
      feature: "notificationTriage",
      callSite: "attention.finish",
      agentId: "agent-1",
      decision: { did: "alert", wouldBe: "notice", changed: false },
      facts: {},
    });
    add(
      "c4",
      {
        feature: "askJev",
        callSite: "app.ask-jev",
        agentId: null,
        workspaceId: null,
        decision: { did: "answered", wouldBe: null, changed: false },
        facts: {},
      },
      "answered",
    );
    return h;
  }

  test("summary keeps shadow out of live, nets JEV's spend, and gives non-token features no tokens", async () => {
    const h = await seeded();

    const summary = h.ledger.summary("today");

    expect(summary.unit).toBe("opus-equivalent-weighted-tokens");
    expect(summary.live).toEqual({ involvements: 2, tokensSaved: 5_000 });
    expect(summary.shadow).toEqual({ involvements: 2, tokensWouldSave: 40_000 });
    expect(summary.jevSpend).toEqual({ calls: 9, usd: 0.0008, tokensEquivalent: 200 });
    expect(summary.net).toEqual({ live: 4_800, ifLive: 44_800 });
    const finish = summary.features.find((f) => f.feature === "notificationTriage");
    expect(finish).toMatchObject({
      benefit: "attention",
      shadow: { tokens: 0, otherBenefit: { unit: "pushes-held", value: 1 } },
    });
    expect(summary.features.find((f) => f.feature === "askJev")).toMatchObject({
      benefit: "none",
      asked: 1,
    });
    expect(summary.features.map((f) => f.feature)).toContain("readCheck");
  });

  test("top agents and workspaces by involvements, with labels", async () => {
    const h = await seeded();

    const summary = h.ledger.summary("7d");

    expect(summary.topAgents[0]).toEqual({
      id: "agent-1",
      label: "title of agent-1",
      involvements: 2,
      liveTokens: 0,
      shadowTokens: 40_000,
    });
    expect(summary.topWorkspaces[0]).toMatchObject({
      id: "ws-1",
      label: "ws ws-1",
      involvements: 3,
    });
    expect(summary.days).toHaveLength(7);
    expect(summary.days.at(-1)).toMatchObject({
      day: "2026-09-30",
      involvements: 4,
      liveTokens: 5_000,
      shadowTokens: 40_000,
    });
  });

  test("events: newest first, paged by cursor, filtered by feature and agent", async () => {
    const h = await seeded();

    const first = h.ledger.events({ range: "today", limit: 2 });
    const second = h.ledger.events({
      range: "today",
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });

    expect(first.events.map((event) => event.feature)).toEqual(["askJev", "notificationTriage"]);
    expect(second.events.map((event) => event.decision.did)).toEqual(["person", "start-agent"]);
    expect(second.nextCursor).toBeNull();
    expect(h.ledger.events({ range: "today", feature: "notificationTriage" }).events).toHaveLength(
      1,
    );
    expect(h.ledger.events({ range: "today", agentId: "agent-2" }).events).toMatchObject([
      { agentTitle: "title of agent-2" },
    ]);
  });

  test("ranges: today excludes yesterday, 7d includes it", async () => {
    const h = await harness();
    h.calls.set("y", entry("y", { at: new Date(NOON - DAY).toISOString() }));
    h.ledger.record(skipInput("y"));

    expect(h.ledger.summary("today").shadow.involvements).toBe(0);
    expect(h.ledger.summary("7d").shadow.involvements).toBe(1);
    expect(h.ledger.events({ range: "today" }).events).toEqual([]);
  });

  test("evidence reports not enough data until the rule's minimum", async () => {
    const h = await seeded();

    const remediation = h.ledger
      .summary("all")
      .features.find((f) => f.feature === "remediationTriage");

    expect(remediation?.evidence).toMatchObject({ met: null });
    expect(remediation?.evidence.observed).toContain("1 would-be skips");
  });
});
