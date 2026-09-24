import { describe, expect, test } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { ScheduleCondition } from "@getpaseo/protocol/schedule/condition";
import type { DoneJanitorAgentView } from "../agent/done-janitor-detector.js";
import { evaluateScheduleCondition, type ConditionInput } from "./conditions.js";

const MINUTE = 60_000;
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

function view(overrides: Partial<DoneJanitorAgentView> = {}): DoneJanitorAgentView {
  return {
    id: "agent",
    title: null,
    provider: "claude",
    workspaceId: "ws-1",
    cwd: "/wt/a",
    internal: false,
    archived: false,
    lifecycle: "idle",
    busy: false,
    pendingPermissionCount: 0,
    requiresAttention: false,
    attentionReason: null,
    hasAlert: false,
    runningProviderSubagentCount: 0,
    lastActivityAtMs: T0,
    labels: {},
    hasSession: true,
    hasSchedule: false,
    live: true,
    workspacePinned: false,
    ...overrides,
  };
}

function child(id: string, overrides: Partial<DoneJanitorAgentView> = {}): DoneJanitorAgentView {
  return view({ id, labels: { [PARENT_AGENT_ID_LABEL]: "leader" }, ...overrides });
}

function input(
  leader: DoneJanitorAgentView | null,
  children: DoneJanitorAgentView[],
  overrides: Partial<ConditionInput> = {},
): ConditionInput {
  return {
    target: leader,
    views: leader ? [leader, ...children] : children,
    createdAtMs: T0 - 10 * MINUTE,
    lastRunAtMs: null,
    ...overrides,
  };
}

const running: ScheduleCondition = { type: "hasActiveChildren" };
const finished: ScheduleCondition = { type: "childFinishedSince" };
const either: ScheduleCondition = { type: "any", conditions: [running, finished] };

describe("evaluateScheduleCondition", () => {
  test("always fires, whatever the agents are doing", () => {
    const leader = view({ id: "leader", lifecycle: "running" });
    expect(evaluateScheduleCondition({ type: "always" }, input(leader, [])).fire).toBe(true);
  });

  test("an idle leader with no children has nothing due under either condition", () => {
    const leader = view({ id: "leader" });
    expect(evaluateScheduleCondition(either, input(leader, [])).fire).toBe(false);
  });

  test("a busy leader is never woken, even with work outstanding", () => {
    const leader = view({ id: "leader", lifecycle: "running" });
    const runningChild = child("c1", { lifecycle: "running" });
    expect(evaluateScheduleCondition(either, input(leader, [runningChild]))).toEqual({
      fire: false,
      reason: "target is busy",
    });
  });

  test("a leader blocked on a permission is not woken", () => {
    const leader = view({ id: "leader", pendingPermissionCount: 1 });
    const runningChild = child("c1", { lifecycle: "running" });
    expect(evaluateScheduleCondition(running, input(leader, [runningChild])).fire).toBe(false);
  });

  describe("hasActiveChildren", () => {
    test("fires while a child is running", () => {
      const leader = view({ id: "leader" });
      const verdict = evaluateScheduleCondition(
        running,
        input(leader, [child("c1", { lifecycle: "running" })]),
      );
      expect(verdict.fire).toBe(true);
    });

    test("fires while a child has a turn in flight", () => {
      const leader = view({ id: "leader" });
      const verdict = evaluateScheduleCondition(
        running,
        input(leader, [child("c1", { busy: true })]),
      );
      expect(verdict.fire).toBe(true);
    });

    test("fires while the leader's own provider subagents are running", () => {
      const leader = view({ id: "leader", runningProviderSubagentCount: 2 });
      expect(evaluateScheduleCondition(running, input(leader, [])).fire).toBe(true);
    });

    test("ignores idle children, archived children, and children of other agents", () => {
      const leader = view({ id: "leader" });
      const verdict = evaluateScheduleCondition(
        running,
        input(leader, [
          child("idle", { lifecycle: "idle" }),
          child("archived", { lifecycle: "running", archived: true }),
          view({
            id: "stranger",
            lifecycle: "running",
            labels: { [PARENT_AGENT_ID_LABEL]: "someone-else" },
          }),
        ]),
      );
      expect(verdict.fire).toBe(false);
    });

    test("a stored record still saying running is not a running child", () => {
      const leader = view({ id: "leader" });
      const verdict = evaluateScheduleCondition(
        running,
        input(leader, [child("c1", { lifecycle: "running", live: false })]),
      );
      expect(verdict.fire).toBe(false);
    });
  });

  describe("childFinishedSince", () => {
    test("fires when a child finished after the leader last acted", () => {
      const leader = view({ id: "leader", lastActivityAtMs: T0 });
      const verdict = evaluateScheduleCondition(
        finished,
        input(leader, [child("c1", { lastActivityAtMs: T0 + MINUTE })]),
      );
      expect(verdict.fire).toBe(true);
    });

    test("stays quiet for a finish the leader has already seen", () => {
      const leader = view({ id: "leader", lastActivityAtMs: T0 + 5 * MINUTE });
      const verdict = evaluateScheduleCondition(
        finished,
        input(leader, [child("c1", { lastActivityAtMs: T0 + MINUTE })]),
      );
      expect(verdict.fire).toBe(false);
    });

    test("stays quiet for a finish from before the heartbeat was created", () => {
      const leader = view({ id: "leader", lastActivityAtMs: null });
      const verdict = evaluateScheduleCondition(
        finished,
        input(leader, [child("c1", { lastActivityAtMs: T0 })], { createdAtMs: T0 + MINUTE }),
      );
      expect(verdict.fire).toBe(false);
    });

    test("stays quiet for a finish that the last fire already covered", () => {
      const leader = view({ id: "leader", lastActivityAtMs: T0 });
      const verdict = evaluateScheduleCondition(
        finished,
        input(leader, [child("c1", { lastActivityAtMs: T0 + MINUTE })], {
          lastRunAtMs: T0 + 2 * MINUTE,
        }),
      );
      expect(verdict.fire).toBe(false);
    });

    test("counts an errored child and ignores one that is still running", () => {
      const leader = view({ id: "leader", lastActivityAtMs: T0 });
      const later = T0 + MINUTE;
      expect(
        evaluateScheduleCondition(
          finished,
          input(leader, [child("c1", { lifecycle: "error", lastActivityAtMs: later })]),
        ).fire,
      ).toBe(true);
      expect(
        evaluateScheduleCondition(
          finished,
          input(leader, [child("c1", { lifecycle: "running", lastActivityAtMs: later })]),
        ).fire,
      ).toBe(false);
    });
  });

  test("any of several conditions fires when one holds", () => {
    const leader = view({ id: "leader" });
    const verdict = evaluateScheduleCondition(
      either,
      input(leader, [child("c1", { lifecycle: "running" })]),
    );
    expect(verdict.fire).toBe(true);
  });

  test("a target that is gone fires so the executor can complete the schedule", () => {
    expect(evaluateScheduleCondition(either, input(null, [])).fire).toBe(true);
    expect(
      evaluateScheduleCondition(either, input(view({ id: "leader", archived: true }), [])).fire,
    ).toBe(true);
  });

  test("a child cut off by a daemon restart counts as news, not as still running", () => {
    const leader = view({ id: "leader", live: false, lifecycle: "closed" });
    const verdict = evaluateScheduleCondition(
      finished,
      input(leader, [
        child("c1", { live: false, lifecycle: "running", lastActivityAtMs: T0 + MINUTE }),
      ]),
    );
    expect(verdict.fire).toBe(true);
  });

  test("a closed leader is evaluated on its stored state, not treated as busy", () => {
    const leader = view({ id: "leader", live: false, lifecycle: "running" });
    const verdict = evaluateScheduleCondition(
      finished,
      input(leader, [
        child("c1", { live: false, lifecycle: "idle", lastActivityAtMs: T0 + MINUTE }),
      ]),
    );
    expect(verdict.fire).toBe(true);
  });
});
