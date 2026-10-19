import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { writeFileAtomic } from "../atomic-file.js";
import type { JevDecisionNote } from "./contract.js";
import { JevDecisionStore, type JevDecisionStoreOptions } from "./decisions.js";

const logger = pino({ level: "silent" });

function note(overrides: Partial<JevDecisionNote> = {}): JevDecisionNote {
  return {
    agentId: "agent-1",
    callId: `call-${Math.random().toString(36).slice(2)}`,
    feature: "spawnHint",
    question: "Does this finish need Tyler?",
    verdict: "routine (0.91)",
    confidence: 0.91,
    action: "sent as a digest notice instead of an alert",
    applied: true,
    ...overrides,
  };
}

describe("JevDecisionStore.record / list", () => {
  test("returns an unknown agent's decisions as an empty list", () => {
    const store = new JevDecisionStore();
    expect(store.list("nobody", null)).toEqual([]);
  });

  test("lists an agent's own decisions, newest first", () => {
    let now = 1000;
    const store = new JevDecisionStore({ now: () => now });
    store.record(note({ callId: "call-1", verdict: "first" }));
    now += 1000;
    store.record(note({ callId: "call-2", verdict: "second" }));
    now += 1000;
    store.record(note({ callId: "call-3", verdict: "third" }));

    const list = store.list("agent-1", null);
    expect(list.map((r) => r.verdict)).toEqual(["third", "second", "first"]);
    expect(list.map((r) => r.at)).toEqual([
      new Date(3000).toISOString(),
      new Date(2000).toISOString(),
      new Date(1000).toISOString(),
    ]);
  });

  test("attaches costUsd from costFor, keyed by callId", () => {
    const store = new JevDecisionStore({
      costFor: (callId) => (callId === "call-1" ? 0.0042 : null),
    });
    store.record(note({ callId: "call-1" }));
    store.record(note({ callId: "call-2" }));
    const list = store.list("agent-1", null);
    const byCallId = new Map(list.map((r) => [r.callId, r.costUsd]));
    expect(byCallId.get("call-1")).toBe(0.0042);
    expect(byCallId.get("call-2")).toBeNull();
  });

  test("never throws even when costFor throws", () => {
    const store = new JevDecisionStore({
      costFor: () => {
        throw new Error("boom");
      },
    });
    expect(() => store.record(note())).not.toThrow();
    expect(store.list("agent-1", null)[0].costUsd).toBeNull();
  });

  test("keeps only the newest 50 notes per agent", () => {
    const store = new JevDecisionStore();
    for (let i = 0; i < 60; i += 1) store.record(note({ callId: `call-${i}`, verdict: `v${i}` }));
    const list = store.list("agent-1", null);
    expect(list).toHaveLength(50);
    expect(list[0].verdict).toBe("v59");
    expect(list[49].verdict).toBe("v10");
  });

  test("evicts the least recently written agent past 500 agents", () => {
    const store = new JevDecisionStore({ maxAgents: 3 });
    store.record(note({ agentId: "a", callId: "call-a" }));
    store.record(note({ agentId: "b", callId: "call-b" }));
    store.record(note({ agentId: "c", callId: "call-c" }));
    // Touch "a" again so "b" becomes the least recently written.
    store.record(note({ agentId: "a", callId: "call-a2" }));
    store.record(note({ agentId: "d", callId: "call-d" }));

    expect(store.list("b", null)).toEqual([]);
    expect(store.list("a", null)).toHaveLength(2);
    expect(store.list("c", null)).toHaveLength(1);
    expect(store.list("d", null)).toHaveLength(1);
  });
});

describe("JevDecisionStore spawn-hint attachment", () => {
  const JEV_CALL_LABEL = "paseo.jev-call";
  const TASK_CLASS_SOURCE_LABEL = "paseo.task-class-source";

  test("attaches a pending spawn hint to the agent named by its jev-call label, applied when the source is jev", () => {
    const store = new JevDecisionStore();
    store.record(
      note({
        agentId: null,
        callId: "spawn-call-1",
        feature: "spawnHint",
        verdict: "mechanical (0.88)",
        action: "would set task class to mechanical",
        applied: false,
      }),
    );

    const applied = store.list("new-agent", {
      [JEV_CALL_LABEL]: "spawn-call-1",
      [TASK_CLASS_SOURCE_LABEL]: "jev",
    });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      agentId: "new-agent",
      callId: "spawn-call-1",
      applied: true,
      action: "task class set by JEV at create",
    });
  });

  test("attaches with applied false and keeps the original action when the source is not jev", () => {
    const store = new JevDecisionStore();
    store.record(
      note({
        agentId: null,
        callId: "spawn-call-2",
        action: "would set task class to mechanical",
        applied: false,
      }),
    );

    const notApplied = store.list("new-agent", {
      [JEV_CALL_LABEL]: "spawn-call-2",
      [TASK_CLASS_SOURCE_LABEL]: "declared",
    });
    expect(notApplied).toHaveLength(1);
    expect(notApplied[0]).toMatchObject({
      agentId: "new-agent",
      applied: false,
      action: "would set task class to mechanical",
    });
  });

  test("does not attach when labels are null or name no pending call", () => {
    const store = new JevDecisionStore();
    store.record(note({ agentId: null, callId: "spawn-call-3" }));

    expect(store.list("new-agent", null)).toEqual([]);
    expect(store.list("new-agent", { [JEV_CALL_LABEL]: "unknown-call" })).toEqual([]);
    expect(store.list("new-agent", { other: "label" })).toEqual([]);
  });

  test("bounds pending notes to maxPending, evicting the oldest", () => {
    const store = new JevDecisionStore({ maxPending: 2 });
    store.record(note({ agentId: null, callId: "spawn-1" }));
    store.record(note({ agentId: null, callId: "spawn-2" }));
    store.record(note({ agentId: null, callId: "spawn-3" }));

    expect(store.list("agent-x", { [JEV_CALL_LABEL]: "spawn-1" })).toEqual([]);
    expect(store.list("agent-x", { [JEV_CALL_LABEL]: "spawn-2" })).toHaveLength(1);
    expect(store.list("agent-x", { [JEV_CALL_LABEL]: "spawn-3" })).toHaveLength(1);
  });
});

describe("savings fields", () => {
  test("a note's mode, wouldBe and savingsId come back from list", () => {
    const store = new JevDecisionStore();
    store.record(note({ mode: "shadow", wouldBe: "notice", savingsId: "sv_1", applied: false }));

    expect(store.list("agent-1", null)[0]).toMatchObject({
      mode: "shadow",
      wouldBe: "notice",
      savingsId: "sv_1",
      applied: false,
    });
  });

  test("an attached spawn hint takes its wouldBe from paseo.jev-spawn", () => {
    const store = new JevDecisionStore();
    store.record(note({ agentId: null, callId: "call-9", mode: "shadow", applied: false }));

    const [attached] = store.list("child-1", {
      "paseo.jev-call": "call-9",
      "paseo.jev-spawn":
        "v1;base=-/claude-sonnet-5;would=mechanical/claude-haiku-4-5;move=down;applied=0",
    });

    expect(attached).toMatchObject({
      agentId: "child-1",
      mode: "shadow",
      wouldBe: "mechanical on claude-haiku-4-5",
    });
  });
});

describe("persistence", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "jev-decisions-"));
    filePath = path.join(dir, "jev", "decisions.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function persisted(options: JevDecisionStoreOptions = {}): JevDecisionStore {
    return new JevDecisionStore({ filePath, logger, flushIntervalMs: 60_000, ...options });
  }

  /** A store that has read the file, as `JevService.start()` leaves it. */
  async function opened(options: JevDecisionStoreOptions = {}): Promise<JevDecisionStore> {
    const store = persisted(options);
    await store.load();
    return store;
  }

  test("a new store on the same file lists what the old one recorded", async () => {
    let now = 1000;
    const before = await opened({ now: () => now, costFor: () => 0.0042 });
    before.record(note({ callId: "call-1", verdict: "first", mode: "shadow", wouldBe: "notice" }));
    now += 1000;
    before.record(note({ callId: "call-2", verdict: "second", savingsId: "sv_2" }));
    before.record(note({ agentId: "agent-2", callId: "call-3", verdict: "other" }));
    await before.stop();

    const after = await opened();
    expect(after.list("agent-1", null)).toEqual(before.list("agent-1", null));
    expect(after.list("agent-2", null)).toEqual(before.list("agent-2", null));
    expect(after.list("agent-1", null)[1]).toMatchObject({
      callId: "call-1",
      at: new Date(1000).toISOString(),
      costUsd: 0.0042,
      mode: "shadow",
      wouldBe: "notice",
    });
  });

  test("writes on its own once the debounce passes, without a stop", async () => {
    let writes = 0;
    let wrote = () => {};
    const written = new Promise<void>((resolve) => (wrote = resolve));
    const writeFile = async (target: string, data: string) => {
      writes += 1;
      await writeFileAtomic(target, data);
      wrote();
    };
    const store = await opened({ writeFile, flushIntervalMs: 10_000 });
    vi.useFakeTimers();
    try {
      store.record(note({ callId: "call-1" }));
      store.record(note({ callId: "call-2" }));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(writes).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
    } finally {
      vi.useRealTimers();
    }
    await written;
    expect(writes).toBe(1);

    const after = await opened();
    expect(after.list("agent-1", null).map((r) => r.callId)).toEqual(["call-2", "call-1"]);
  });

  test("recomputes each summary on load: the file never carries one", async () => {
    const before = await opened();
    before.record(note({ callId: "call-1" }));
    await before.stop();
    const expected = before.list("agent-1", null)[0].summary;
    expect(expected).toEqual(expect.any(String));
    const file = JSON.parse(readFileSync(filePath, "utf8"));
    expect(file.agents[0].decisions[0]).not.toHaveProperty("summary");
    file.agents[0].decisions[0].summary = "stale wording from an older daemon";
    writeFileSync(filePath, JSON.stringify(file));

    const after = await opened();
    expect(after.list("agent-1", null)[0].summary).toBe(expected);
  });

  test("does not persist pending spawn hints", async () => {
    const before = await opened();
    before.record(note({ agentId: null, callId: "spawn-call-1" }));
    await before.stop();

    const after = await opened();
    expect(after.list("new-agent", { "paseo.jev-call": "spawn-call-1" })).toEqual([]);
  });

  test("applies the caps to what it loads, keeping the newest and the eviction order", async () => {
    const before = await opened();
    for (const agentId of ["a", "b", "c"]) {
      for (let i = 0; i < 5; i += 1) before.record(note({ agentId, callId: `${agentId}-${i}` }));
    }
    // "a" becomes the most recently written agent.
    before.record(note({ agentId: "a", callId: "a-5" }));
    await before.stop();

    const after = await opened({ maxPerAgent: 3, maxAgents: 2 });
    expect(after.list("b", null)).toEqual([]);
    expect(after.list("c", null).map((r) => r.callId)).toEqual(["c-4", "c-3", "c-2"]);
    expect(after.list("a", null).map((r) => r.callId)).toEqual(["a-5", "a-4", "a-3"]);
    // "c" is now the least recently written, so the next new agent evicts it.
    after.record(note({ agentId: "d", callId: "d-0" }));
    expect(after.list("c", null)).toEqual([]);
    expect(after.list("a", null)).toHaveLength(3);
  });

  test("bounds the file by dropping the least recently written agents", async () => {
    const store = await opened({ maxFileBytes: 2500 });
    const long = "x".repeat(400);
    for (const agentId of ["a", "b", "c", "d"]) {
      for (let i = 0; i < 2; i += 1) {
        store.record(note({ agentId, callId: `${agentId}-${i}`, question: long }));
      }
    }
    await store.stop();

    expect(readFileSync(filePath, "utf8").length).toBeLessThanOrEqual(2500);
    // The store itself keeps every agent; only the file is bounded.
    expect(store.list("a", null)).toHaveLength(2);
    const after = await opened();
    expect(after.list("d", null)).toHaveLength(2);
    expect(after.list("a", null)).toEqual([]);
  });

  test("starts empty from a missing file, and from a corrupt one it then replaces", async () => {
    const fromMissing = await opened();
    expect(fromMissing.list("agent-1", null)).toEqual([]);
    mkdirSync(path.dirname(filePath), { recursive: true });

    for (const corrupt of ["{not json", JSON.stringify({ version: 2, agents: "nope" })]) {
      writeFileSync(filePath, corrupt);
      const store = await opened();
      expect(store.list("agent-1", null)).toEqual([]);
      store.record(note({ callId: "call-fresh" }));
      await store.stop();
      const after = await opened();
      expect(after.list("agent-1", null).map((r) => r.callId)).toEqual(["call-fresh"]);
    }
  });

  test("drops a malformed record or an unknown feature and keeps the rest", async () => {
    const before = await opened();
    before.record(note({ callId: "call-good" }));
    await before.stop();
    const file = JSON.parse(readFileSync(filePath, "utf8"));
    const good = file.agents[0].decisions[0];
    file.agents[0].decisions.push({ ...good, callId: "call-unknown", feature: "fromTheFuture" });
    file.agents[0].decisions.push({ ...good, callId: "call-broken", applied: "yes" });
    file.agents.push({ agentId: 7, decisions: [] });
    writeFileSync(filePath, JSON.stringify(file));

    const after = await opened();
    expect(after.list("agent-1", null).map((r) => r.callId)).toEqual(["call-good"]);
  });

  test("never writes over the file before it has loaded it", async () => {
    const before = await opened();
    before.record(note({ callId: "call-1" }));
    await before.stop();

    const early = persisted();
    early.record(note({ callId: "call-early" }));
    await early.flush();
    await early.stop();

    const after = await opened();
    expect(after.list("agent-1", null).map((r) => r.callId)).toEqual(["call-1"]);
  });

  test("keeps a decision recorded while it was loading, ahead of the loaded ones", async () => {
    const before = await opened();
    before.record(note({ callId: "call-old" }));
    await before.stop();

    const store = persisted();
    const loading = store.load();
    store.record(note({ callId: "call-new" }));
    await loading;
    expect(store.list("agent-1", null).map((r) => r.callId)).toEqual(["call-new", "call-old"]);
  });

  test("overlapping writes leave the newest state on disk and no temp files", async () => {
    let writes = 0;
    const writeFile = async (target: string, data: string) => {
      // The first write is the slowest: unserialized, it would land last and win.
      const delayMs = writes === 0 ? 40 : 0;
      writes += 1;
      await sleep(delayMs);
      await writeFileAtomic(target, data);
    };
    const store = await opened({ writeFile });
    const flushes: Promise<void>[] = [];
    for (let i = 0; i < 5; i += 1) {
      store.record(note({ callId: `call-${i}` }));
      flushes.push(store.flush());
    }
    await Promise.all(flushes);
    await store.stop();

    const after = await opened();
    expect(after.list("agent-1", null).map((r) => r.callId)).toEqual([
      "call-4",
      "call-3",
      "call-2",
      "call-1",
      "call-0",
    ]);
    expect(readdirSync(path.dirname(filePath))).toEqual(["decisions.json"]);
  });

  test("a failed write is retried by the next flush", async () => {
    let fail = true;
    const writeFile = async (target: string, data: string) => {
      if (fail) throw new Error("disk full");
      await writeFileAtomic(target, data);
    };
    const store = await opened({ writeFile });
    store.record(note({ callId: "call-1" }));
    await expect(store.flush()).resolves.toBeUndefined();
    fail = false;
    await store.stop();

    const after = await opened();
    expect(after.list("agent-1", null).map((r) => r.callId)).toEqual(["call-1"]);
  });
});
