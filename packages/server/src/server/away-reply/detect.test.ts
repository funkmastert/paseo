import { describe, expect, it } from "vitest";

import { formatSystemNotificationPrompt } from "../agent/agent-prompt.js";
import { detectWaiting, leaderSkipReason } from "./detect.js";
import {
  MINUTE,
  T0,
  assistant,
  leaderView,
  planRequest,
  questionRequest,
  rowsOf,
  toolRequest,
  user,
} from "./test-utils/fixtures.js";

const NO_PINS = { pinnedWorkspaceIds: new Set<string>(), skipPinnedWorkspaces: false };

describe("detectWaiting", () => {
  it("a finished turn whose last message is the agent's own", () => {
    const rows = rowsOf([
      user("Fix the flaky test", T0),
      assistant("Two options. Option A: retry. ", T0 + MINUTE),
      assistant("Option B: wait for ready. Which?", T0 + MINUTE),
      { at: T0 + 2 * MINUTE, item: { type: "reasoning", text: "done" } },
    ]);
    const detection = detectWaiting(leaderView(), rows);
    expect(detection.waiting).toBe(true);
    if (!detection.waiting) return;
    expect(detection.episode.kind).toBe("turn-ended");
    expect(detection.episode.waitingSinceMs).toBe(T0 + 2 * MINUTE);
    expect(detection.episode.lastMessage).toBe(
      "Two options. Option A: retry. Option B: wait for ready. Which?",
    );
    expect(detection.episode.request).toBeNull();
  });

  it("not when the newest message is Tyler's or a system envelope", () => {
    const tyler = rowsOf([assistant("Which?", T0), user("B please", T0 + MINUTE)]);
    expect(detectWaiting(leaderView(), tyler)).toEqual({
      waiting: false,
      reason: "last-message-not-agent",
    });
    const envelope = rowsOf([
      assistant("Which?", T0),
      user(formatSystemNotificationPrompt("child finished"), T0 + MINUTE),
    ]);
    expect(detectWaiting(leaderView(), envelope).waiting).toBe(false);
  });

  it("not while a turn is running", () => {
    const rows = rowsOf([assistant("Working on it", T0)]);
    expect(detectWaiting(leaderView({ lifecycle: "running", busy: true }), rows)).toEqual({
      waiting: false,
      reason: "turn-running",
    });
    expect(detectWaiting(leaderView({ busy: true }), rows).waiting).toBe(false);
  });

  it("not for a closed or errored agent, or one with no timeline", () => {
    const rows = rowsOf([assistant("Which?", T0)]);
    expect(detectWaiting(leaderView({ lifecycle: "closed" }), rows).waiting).toBe(false);
    expect(detectWaiting(leaderView({ lifecycle: "error" }), rows).waiting).toBe(false);
    expect(detectWaiting(leaderView(), []).waiting).toBe(false);
  });

  it("a pending question, keyed by its request", () => {
    const request = questionRequest();
    const rows = rowsOf([assistant("One question first.", T0)]);
    const detection = detectWaiting(
      leaderView({ lifecycle: "running", busy: true, pendingPermissions: [request] }),
      rows,
    );
    expect(detection.waiting).toBe(true);
    if (!detection.waiting) return;
    expect(detection.episode.kind).toBe("question");
    expect(detection.episode.key).toBe("leader-1:question:perm-question");
    expect(detection.episode.waitingSinceMs).toBe(T0);
    expect(detection.episode.request).toBe(request);
  });

  it("a pending plan approval and a pending tool permission", () => {
    const rows = rowsOf([assistant("Plan ready.", T0)]);
    const plan = detectWaiting(
      leaderView({
        lifecycle: "running",
        busy: true,
        pendingPermissions: [planRequest("1. edit")],
      }),
      rows,
    );
    expect(plan.waiting && plan.episode.kind).toBe("plan");
    const tool = detectWaiting(
      leaderView({
        lifecycle: "running",
        busy: true,
        pendingPermissions: [toolRequest("Read", { file_path: "/tmp/x" })],
      }),
      rows,
    );
    expect(tool.waiting && tool.episode.kind).toBe("permission");
  });

  it("not for several pending requests, or a mode request", () => {
    const rows = rowsOf([assistant("x", T0)]);
    expect(
      detectWaiting(leaderView({ pendingPermissions: [questionRequest(), planRequest("p")] }), rows)
        .waiting,
    ).toBe(false);
    expect(
      detectWaiting(
        leaderView({ pendingPermissions: [{ ...questionRequest(), kind: "mode" }] }),
        rows,
      ).waiting,
    ).toBe(false);
  });
});

describe("leaderSkipReason", () => {
  it("answers only root leaders", () => {
    const child = leaderView({ id: "child", labels: { "paseo.parent-agent-id": "leader-1" } });
    expect(leaderSkipReason(child, [child], NO_PINS)).toBe("not-a-leader");
    expect(leaderSkipReason(leaderView({ internal: true }), [], NO_PINS)).toBe("internal");
  });

  it("skips remediation, schedule and retired agents, and opt-outs", () => {
    expect(
      leaderSkipReason(leaderView({ labels: { "paseo.remediation": "disk" } }), [], NO_PINS),
    ).toBe("remediation-agent");
    expect(
      leaderSkipReason(leaderView({ labels: { "paseo.schedule-id": "s1" } }), [], NO_PINS),
    ).toBe("schedule-agent");
    expect(
      leaderSkipReason(
        leaderView({ labels: { "paseo.account-failover.migrated-to": "next" } }),
        [],
        NO_PINS,
      ),
    ).toBe("retired-by-failover");
    expect(
      leaderSkipReason(leaderView({ labels: { "paseo.away-reply": "off" } }), [], NO_PINS),
    ).toBe("opted-out");
  });

  it("skips archived agents", () => {
    expect(leaderSkipReason(leaderView({ archivedAt: "2026-09-29T07:00:00Z" }), [], NO_PINS)).toBe(
      "archived",
    );
  });

  it("skips a pinned workspace only when Tyler opted pinned workspaces out", () => {
    const pins = new Set(["ws-1"]);
    expect(
      leaderSkipReason(leaderView(), [], { pinnedWorkspaceIds: pins, skipPinnedWorkspaces: false }),
    ).toBeNull();
    expect(
      leaderSkipReason(leaderView(), [], { pinnedWorkspaceIds: pins, skipPinnedWorkspaces: true }),
    ).toBe("pinned-workspace");
  });

  it("skips a leader still waiting on its own children or subagents", () => {
    const leader = leaderView();
    const child = leaderView({
      id: "child",
      lifecycle: "running",
      busy: true,
      labels: { "paseo.parent-agent-id": "leader-1" },
    });
    expect(leaderSkipReason(leader, [leader, child], NO_PINS)).toBe("children-running");
    const idleChild = { ...child, lifecycle: "idle" as const, busy: false };
    expect(leaderSkipReason(leader, [leader, idleChild], NO_PINS)).toBeNull();
    expect(leaderSkipReason(leaderView({ runningProviderSubagentCount: 1 }), [], NO_PINS)).toBe(
      "subagents-running",
    );
  });
});
