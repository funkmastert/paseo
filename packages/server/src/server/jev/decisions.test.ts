import { describe, expect, test } from "vitest";

import type { JevDecisionNote } from "./contract.js";
import { JevDecisionStore } from "./decisions.js";

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
