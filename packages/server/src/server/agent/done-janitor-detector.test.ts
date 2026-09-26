import { describe, expect, test } from "vitest";

import {
  DONE_JANITOR_KEEP_LABEL,
  agentNotDeadReason,
  agentNotDoneReason,
  describeUnread,
  isDoneAnswer,
  listRootCandidates,
  nextAskAllowedAtMs,
  recordProbeOutcome,
  treeNotDeadReason,
  treeNotDoneReason,
  type DoneJanitorAgentView,
  type DoneJanitorMemory,
} from "./done-janitor-detector.js";

const HOUR = 60 * 60_000;
const NOW = 1_000 * HOUR;
const QUIET = 72 * HOUR;

function view(overrides: Partial<DoneJanitorAgentView> = {}): DoneJanitorAgentView {
  return {
    id: "root",
    title: "Root",
    provider: "claude",
    workspaceId: "ws-1",
    cwd: "/wt/a",
    internal: false,
    archived: false,
    lifecycle: "closed",
    busy: false,
    pendingPermissionCount: 0,
    requiresAttention: false,
    attentionReason: null,
    hasAlert: false,
    runningProviderSubagentCount: 0,
    lastActivityAtMs: NOW - 100 * HOUR,
    labels: {},
    hasSession: true,
    hasSchedule: false,
    live: false,
    workspacePinned: false,
    ...overrides,
  };
}

describe("isDoneAnswer", () => {
  test.each(["DONE", "DONE.", "  DONE\n"])("accepts %j", (reply) => {
    expect(isDoneAnswer(reply)).toBe(true);
  });

  test.each([
    "NOT_DONE",
    "Done",
    "done",
    "Done!",
    "DONE, but the PR is still open",
    "**DONE**",
    "`DONE`",
    "Is it? DONE",
    "DONE DONE",
    "",
    null,
    undefined,
  ])("rejects %j", (reply) => {
    expect(isDoneAnswer(reply)).toBe(false);
  });
});

describe("agentNotDoneReason", () => {
  test("a closed agent quiet past the period with nothing pending is done", () => {
    expect(agentNotDoneReason(view(), NOW, QUIET)).toBeNull();
  });

  test.each<[string, Partial<DoneJanitorAgentView>, string]>([
    ["running", { lifecycle: "running" }, "is running"],
    ["in error", { lifecycle: "error" }, "is in error"],
    ["busy", { busy: true }, "has a turn in flight"],
    ["permission", { pendingPermissionCount: 1 }, "is waiting on a permission"],
    [
      "unread finish",
      { requiresAttention: true, attentionReason: "finished" },
      "is flagged for attention (finished)",
    ],
    ["alert", { hasAlert: true }, "carries a live token-burn, spend or resource alert"],
    [
      "provider subagent",
      { runningProviderSubagentCount: 2 },
      "has 2 provider subagent(s) still running",
    ],
    ["schedule", { hasSchedule: true }, "has a schedule or heartbeat that will wake it"],
    ["pinned", { labels: { [DONE_JANITOR_KEEP_LABEL]: "false" } }, "pinned with paseo.keep"],
    ["in a pinned workspace", { workspacePinned: true }, "its workspace is pinned"],
    ["no activity time", { lastActivityAtMs: null }, "has no readable last-activity time"],
    ["idle overnight", { lastActivityAtMs: NOW - 14 * HOUR }, "quiet for 14h of the 3d required"],
  ])("%s is not done", (_name, overrides, reason) => {
    expect(agentNotDoneReason(view(overrides), NOW, QUIET)).toBe(reason);
  });
});

describe("treeNotDoneReason", () => {
  test("a working subagent keeps a quiet leader", () => {
    const views = [
      view(),
      view({ id: "child", labels: { "paseo.parent-agent-id": "root" }, lifecycle: "running" }),
    ];
    expect(treeNotDoneReason(views[0], views, NOW, QUIET, QUIET)).toBe("subagent child is running");
  });

  test("a pinned grandchild pins the whole tree", () => {
    const views = [
      view(),
      view({ id: "child", labels: { "paseo.parent-agent-id": "root" } }),
      view({
        id: "grandchild",
        labels: { "paseo.parent-agent-id": "child", [DONE_JANITOR_KEEP_LABEL]: "1" },
      }),
    ];
    expect(treeNotDoneReason(views[0], views, NOW, QUIET, QUIET)).toBe(
      "subagent grandchild pinned with paseo.keep",
    );
  });

  test("an archived subagent does not count", () => {
    const views = [
      view(),
      view({
        id: "child",
        labels: { "paseo.parent-agent-id": "root" },
        archived: true,
        lifecycle: "running",
      }),
    ];
    expect(treeNotDoneReason(views[0], views, NOW, QUIET, QUIET)).toBeNull();
  });

  test("the re-check after an answer skips only the root's quiet check", () => {
    const views = [
      view({ lastActivityAtMs: NOW }),
      view({
        id: "child",
        labels: { "paseo.parent-agent-id": "root" },
        lastActivityAtMs: NOW - HOUR,
      }),
    ];
    expect(treeNotDoneReason(views[0], views, NOW, null, QUIET)).toBe(
      "subagent child quiet for 1h of the 3d required",
    );
  });
});

describe("listRootCandidates", () => {
  test("subagents of an active parent are decided with their parent", () => {
    const views = [view(), view({ id: "child", labels: { "paseo.parent-agent-id": "root" } })];
    expect(listRootCandidates(views).map((candidate) => candidate.id)).toEqual(["root"]);
  });

  test("a child whose parent is archived stands on its own", () => {
    const views = [
      view({ archived: true }),
      view({ id: "child", labels: { "paseo.parent-agent-id": "root" } }),
    ];
    expect(listRootCandidates(views).map((candidate) => candidate.id)).toEqual(["child"]);
  });

  test("internal agents are never candidates", () => {
    expect(listRootCandidates([view({ internal: true })])).toEqual([]);
  });
});

describe("backoff", () => {
  test("each negative answer doubles the spacing, capped at 8x", () => {
    const memory: DoneJanitorMemory = new Map();
    const spacing = [1, 2, 3, 4, 5].map((attempt) => {
      const record = recordProbeOutcome(memory, "a", 0, "not-done");
      expect(record.consecutiveNegatives).toBe(attempt);
      return nextAskAllowedAtMs(record, QUIET) / QUIET;
    });
    expect(spacing).toEqual([1, 2, 4, 8, 8]);
  });

  test("never asked means ask now", () => {
    expect(nextAskAllowedAtMs(undefined, QUIET)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("agentNotDeadReason", () => {
  test("a closed agent quiet past the period is dead", () => {
    expect(agentNotDeadReason(view(), NOW, QUIET)).toBeNull();
  });

  test("a live agent in error is dead", () => {
    expect(agentNotDeadReason(view({ live: true, lifecycle: "error" }), NOW, QUIET)).toBeNull();
  });

  test("an unread flag does not spare it: a failed agent is flagged the moment it fails", () => {
    const flagged = view({ requiresAttention: true, attentionReason: "error" });
    expect(agentNotDeadReason(flagged, NOW, QUIET)).toBeNull();
  });

  test("a stored record that still says running is dead once nothing holds it", () => {
    expect(agentNotDeadReason(view({ lifecycle: "running" }), NOW, QUIET)).toBeNull();
  });

  test("an agent a daemon stop cut off mid-turn is left to restart recovery", () => {
    const interrupted = view({ lifecycle: "running", interruptedMidTurn: true });
    expect(agentNotDeadReason(interrupted, NOW, QUIET)).toBe(
      "was cut off mid-turn by a daemon stop; restart recovery owns it",
    );
    expect(agentNotDoneReason({ ...interrupted, lifecycle: "idle" }, NOW, QUIET)).toBe(
      "was cut off mid-turn by a daemon stop; restart recovery owns it",
    );
  });

  test.each<[string, Partial<DoneJanitorAgentView>, string]>([
    ["idle", { live: true, lifecycle: "idle" }, "is idle, not dead"],
    ["running", { live: true, lifecycle: "running" }, "is running, not dead"],
    ["pinned by label", { labels: { [DONE_JANITOR_KEEP_LABEL]: "" } }, "pinned with paseo.keep"],
    ["pinned by workspace", { workspacePinned: true }, "its workspace is pinned"],
    [
      "errored but mid-turn",
      { live: true, lifecycle: "error", busy: true },
      "has a turn in flight",
    ],
    [
      "errored with a provider subagent",
      { live: true, lifecycle: "error", runningProviderSubagentCount: 1 },
      "has 1 provider subagent(s) still running",
    ],
    ["scheduled", { hasSchedule: true }, "has a schedule or heartbeat that will wake it"],
    ["no activity time", { lastActivityAtMs: null }, "has no readable last-activity time"],
    [
      "touched yesterday",
      { lastActivityAtMs: NOW - 24 * HOUR },
      "quiet for 24h of the 3d required",
    ],
  ])("%s is not dead", (_name, overrides, reason) => {
    expect(agentNotDeadReason(view(overrides), NOW, QUIET)).toBe(reason);
  });
});

describe("treeNotDeadReason", () => {
  test("a live idle child spares a dead leader", () => {
    const views = [
      view(),
      view({
        id: "child",
        labels: { "paseo.parent-agent-id": "root" },
        live: true,
        lifecycle: "idle",
      }),
    ];
    expect(treeNotDeadReason(views[0], views, NOW, QUIET)).toBe("subagent child is idle, not dead");
  });

  test("a pinned grandchild pins the whole tree", () => {
    const views = [
      view(),
      view({ id: "child", labels: { "paseo.parent-agent-id": "root" } }),
      view({
        id: "grandchild",
        labels: { "paseo.parent-agent-id": "child", [DONE_JANITOR_KEEP_LABEL]: "1" },
      }),
    ];
    expect(treeNotDeadReason(views[0], views, NOW, QUIET)).toBe(
      "subagent grandchild pinned with paseo.keep",
    );
  });

  test("a recently touched child spares the tree, an archived one does not count", () => {
    const child = view({
      id: "child",
      labels: { "paseo.parent-agent-id": "root" },
      lastActivityAtMs: NOW - HOUR,
    });
    expect(treeNotDeadReason(view(), [view(), child], NOW, QUIET)).toBe(
      "subagent child quiet for 1h of the 3d required",
    );
    expect(
      treeNotDeadReason(view(), [view(), { ...child, archived: true }], NOW, QUIET),
    ).toBeNull();
  });
});

describe("describeUnread", () => {
  test("says nothing when nothing is unread", () => {
    expect(describeUnread([view()])).toBeNull();
  });

  test("counts the flags that archiving will clear", () => {
    const flagged = [
      view({ requiresAttention: true, attentionReason: "finished" }),
      view({ id: "b", requiresAttention: true, attentionReason: "error" }),
      view({ id: "c" }),
    ];
    expect(describeUnread(flagged)).toBe("2 unread flag(s) (finished, error) will be cleared");
  });
});
