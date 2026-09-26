import { describe, expect, it } from "vitest";
import {
  armObligation,
  canPassToSuccessor,
  DEFAULT_FINISH_REPORT_LADDER,
  gateDelivery,
  markParked,
  markTransferred,
  planObligationStep,
  recordDeliveryAttempt,
  recordOperatorPush,
  recordOutcome,
  summarizeOwedFinishReport,
  type AgentPresence,
  type FinishObligation,
  type ObligationContext,
} from "./finish-obligation.js";

const T0 = Date.parse("2026-09-23T12:00:00.000Z");
const MINUTE = 60_000;
const LADDER = DEFAULT_FINISH_REPORT_LADDER;
const LIMIT_ERROR = "You've hit your weekly limit · resets 7am (America/Los_Angeles)";

function presence(overrides: Partial<AgentPresence> = {}): AgentPresence {
  return { exists: true, archived: false, lifecycle: "idle", ...overrides };
}

function context(overrides: Partial<ObligationContext> = {}): ObligationContext {
  return {
    nowMs: T0,
    child: { ...presence({ lifecycle: null }), parentAgentId: "owner" },
    owner: { ...presence(), agentId: "owner" },
    orchestrator: null,
    config: LADDER,
    ...overrides,
  };
}

function armed(overrides: { requireParentOwnership?: boolean } = {}): FinishObligation {
  return armObligation([], { ownerAgentId: "owner", nowMs: T0, ...overrides }).armed;
}

function owed(reason: "finished" | "errored" = "finished"): FinishObligation {
  const next = recordOutcome(armed(), { generation: 1, reason, nowMs: T0 });
  if (!next) throw new Error("expected an owed obligation");
  return next;
}

function failDelivery(
  obligation: FinishObligation,
  rung: "owner" | "orchestrator",
  nowMs: number,
): FinishObligation {
  return recordDeliveryAttempt(obligation, {
    rung,
    targetAgentId: rung === "owner" ? "owner" : "leader",
    error: "provider unavailable",
    nowMs,
    config: LADDER,
  });
}

describe("arming", () => {
  it("re-arming for the same owner supersedes the older watcher's generation", () => {
    const first = armObligation([], { ownerAgentId: "owner", nowMs: T0 });
    const second = armObligation(first.obligations, { ownerAgentId: "owner", nowMs: T0 + 1 });

    expect(second.obligations).toHaveLength(1);
    expect(second.armed.generation).toBe(2);
    // The first watcher reports too late: its generation no longer settles anything.
    expect(
      recordOutcome(second.armed, { generation: 1, reason: "finished", nowMs: T0 }),
    ).toBeNull();
    expect(
      recordOutcome(second.armed, { generation: 2, reason: "finished", nowMs: T0 })?.state,
    ).toBe("owed");
  });

  it("keeps one obligation per owner when two agents are owed reports", () => {
    const first = armObligation([], { ownerAgentId: "owner", nowMs: T0 });
    const second = armObligation(first.obligations, { ownerAgentId: "other", nowMs: T0 });
    expect(second.obligations.map((entry) => entry.ownerAgentId)).toEqual(["owner", "other"]);
  });
});

describe("the delivery gate", () => {
  it("decides from lifecycle whether a report steers, wakes, waits or cannot be sent", () => {
    expect(gateDelivery(presence({ lifecycle: "running" }))).toBe("steer");
    expect(gateDelivery(presence({ lifecycle: "idle" }))).toBe("wake");
    expect(gateDelivery(presence({ lifecycle: null }))).toBe("wake");
    expect(gateDelivery(presence({ lifecycle: "initializing" }))).toBe("wait");
    // Capped: a turn started now fails, and failover is about to move it.
    expect(gateDelivery(presence({ lifecycle: "error", lastError: LIMIT_ERROR }))).toBe("wait");
    expect(gateDelivery(presence({ lifecycle: "error", lastError: "boom" }))).toBe("wake");
    expect(gateDelivery(presence({ archived: true }))).toBe("unreachable");
    expect(gateDelivery(presence({ exists: false }))).toBe("unreachable");
  });
});

describe("a child that stopped while owing a report (parked)", () => {
  it("parks, then reports for the child once the grace period passes", () => {
    const obligation = armed();
    expect(planObligationStep(obligation, context())).toEqual({ kind: "park" });

    const parked = markParked(obligation, T0);
    expect(planObligationStep(parked, context({ nowMs: T0 + MINUTE }))).toEqual({ kind: "none" });
    expect(planObligationStep(parked, context({ nowMs: T0 + LADDER.parkedGraceMs }))).toEqual({
      kind: "settle",
      reason: "stopped before reporting",
    });
  });

  it("names what the sweep can see: a loaded idle child finished, an errored one errored", () => {
    const parked = markParked(armed(), T0);
    const later = T0 + LADDER.parkedGraceMs;
    const withChild = (lifecycle: AgentPresence["lifecycle"]) =>
      context({ nowMs: later, child: { ...presence({ lifecycle }), parentAgentId: "owner" } });
    expect(planObligationStep(parked, withChild("idle"))).toEqual({
      kind: "settle",
      reason: "finished",
    });
    expect(planObligationStep(parked, withChild("error"))).toEqual({
      kind: "settle",
      reason: "errored",
    });
  });

  it("unparks a child that started working again", () => {
    const parked = markParked(armed(), T0);
    const running = context({
      child: { ...presence({ lifecycle: "running" }), parentAgentId: "owner" },
    });
    expect(planObligationStep(parked, running)).toEqual({ kind: "unpark" });
  });

  it("does not park a child blocked on a permission; that is a live wait, not a stop", () => {
    const blocked = context({
      child: {
        ...presence({ lifecycle: "idle", hasPendingPermission: true }),
        parentAgentId: "owner",
      },
    });
    expect(planObligationStep(armed(), blocked)).toEqual({ kind: "none" });
  });

  it("releases the report of a child detached from the parent that created it", () => {
    const detached = context({ child: { ...presence(), parentAgentId: null } });
    expect(planObligationStep(armed({ requireParentOwnership: true }), detached)).toMatchObject({
      kind: "release",
    });
  });
});

describe("the ladder", () => {
  it("delivers to the owner, then retries on the interval, then goes to the orchestrator", () => {
    let obligation = owed();
    expect(planObligationStep(obligation, context())).toEqual({
      kind: "deliver",
      rung: "owner",
      targetAgentId: "owner",
      gate: "wake",
    });

    obligation = failDelivery(obligation, "owner", T0);
    expect(obligation).toMatchObject({ state: "owed", rung: "owner", attempts: 1 });
    // Not before the retry interval.
    expect(planObligationStep(obligation, context({ nowMs: T0 + MINUTE }))).toEqual({
      kind: "none",
    });
    const retryAt = T0 + LADDER.retryIntervalMs;
    expect(planObligationStep(obligation, context({ nowMs: retryAt })).kind).toBe("deliver");

    obligation = failDelivery(obligation, "owner", retryAt);
    obligation = failDelivery(obligation, "owner", retryAt + LADDER.retryIntervalMs);
    expect(obligation).toMatchObject({ state: "owed", rung: "orchestrator", attempts: 3 });

    const withLeader = context({
      orchestrator: { agentId: "leader", presence: presence({ lifecycle: "running" }) },
    });
    expect(planObligationStep(obligation, withLeader)).toEqual({
      kind: "deliver",
      rung: "orchestrator",
      targetAgentId: "leader",
      gate: "steer",
    });
  });

  it("ends at one operator push when nobody above the owner can be told — never a loop", () => {
    let obligation = owed();
    for (let attempt = 0; attempt < LADDER.maxOwnerAttempts; attempt += 1) {
      obligation = failDelivery(obligation, "owner", T0 + attempt * LADDER.retryIntervalMs);
    }
    expect(planObligationStep(obligation, context())).toEqual({
      kind: "escalate",
      to: "operator",
      why: "no live agent above its owner",
    });

    obligation = { ...obligation, rung: "operator" };
    expect(planObligationStep(obligation, context())).toEqual({ kind: "push" });

    const pushed = recordOperatorPush(obligation, { nowMs: T0, error: null });
    expect(pushed.state).toBe("escalated");
    expect(planObligationStep(pushed, context())).toEqual({ kind: "none" });
  });

  it("an orchestrator that cannot be told sends the report straight to the operator", () => {
    const atOrchestrator: FinishObligation = { ...owed(), rung: "orchestrator", rungSince: "x" };
    expect(failDelivery(atOrchestrator, "orchestrator", T0)).toMatchObject({ rung: "operator" });
  });

  it("waits for a capped owner, but only for as long as the owner rung's budget", () => {
    const capped = context({
      owner: { ...presence({ lifecycle: "error", lastError: LIMIT_ERROR }), agentId: "owner" },
    });
    expect(planObligationStep(owed(), capped)).toEqual({ kind: "none" });
    const deadline = T0 + LADDER.retryIntervalMs * LADDER.maxOwnerAttempts;
    expect(planObligationStep(owed(), { ...capped, nowMs: deadline })).toMatchObject({
      kind: "escalate",
      to: "orchestrator",
    });
  });

  it("delivers to the successor account failover retired the owner into", () => {
    const retiredOwner = context({
      owner: { ...presence({ lifecycle: "running" }), agentId: "owner-successor" },
    });
    expect(planObligationStep(owed(), retiredOwner)).toMatchObject({
      kind: "deliver",
      targetAgentId: "owner-successor",
      gate: "steer",
    });
  });

  it("releases a report whose owner was archived", () => {
    const archivedOwner = context({ owner: { ...presence({ archived: true }), agentId: "owner" } });
    expect(planObligationStep(owed(), archivedOwner)).toMatchObject({ kind: "release" });
  });
});

describe("successors", () => {
  it("pass on unfinished work, including work already reported as errored", () => {
    expect(canPassToSuccessor(armed())).toBe(true);
    const erroredAndDelivered = recordDeliveryAttempt(owed("errored"), {
      rung: "owner",
      targetAgentId: "owner",
      error: null,
      nowMs: T0,
      config: LADDER,
    });
    expect(erroredAndDelivered.state).toBe("delivered");
    expect(canPassToSuccessor(erroredAndDelivered)).toBe(true);
  });

  it("do not pass on work already reported as finished, or passed on once", () => {
    const finished = recordDeliveryAttempt(owed("finished"), {
      rung: "owner",
      targetAgentId: "owner",
      error: null,
      nowMs: T0,
      config: LADDER,
    });
    expect(canPassToSuccessor(finished)).toBe(false);
    const transferred = markTransferred(armed(), { successorId: "next", nowMs: T0 });
    expect(transferred.state).toBe("transferred");
    expect(canPassToSuccessor(transferred)).toBe(false);
  });
});

describe("what the panel is told", () => {
  it("says nothing about a child that is simply working", () => {
    expect(summarizeOwedFinishReport([armed()])).toBeUndefined();
    expect(summarizeOwedFinishReport([owed()])).toBeUndefined();
  });

  it("flags a parked child and an undelivered report", () => {
    expect(summarizeOwedFinishReport([markParked(armed(), T0)])).toEqual({
      ownerAgentId: "owner",
      state: "parked",
      since: new Date(T0).toISOString(),
    });
    expect(summarizeOwedFinishReport([failDelivery(owed(), "owner", T0)])).toMatchObject({
      ownerAgentId: "owner",
      state: "undelivered",
      attempts: 1,
    });
  });
});
