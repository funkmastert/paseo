import { describe, expect, test } from "vitest";

import type { DoneJanitorWorkspace } from "../agent-done-janitor.js";
import type { DoneJanitorAgentView } from "./done-janitor-detector.js";
import {
  archiveDeletesDirectory,
  classifyWorkspace,
  describeUncoveredWork,
  isBuildOutputPath,
  resolveWorkspaceSweepConfig,
  type WorkspaceActivitySignals,
  type WorkspaceSweepFacts,
} from "./workspace-sweep-detector.js";

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const CONFIG = resolveWorkspaceSweepConfig({});

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

function workspace(overrides: Partial<DoneJanitorWorkspace> = {}): DoneJanitorWorkspace {
  return {
    workspaceId: "ws-1",
    projectId: "project-1",
    kind: "worktree",
    cwd: "/home/t/mobile-worktrees/feature",
    displayName: "feature",
    title: "Build the feature",
    worktreeRoot: "/home/t/mobile-worktrees/feature",
    isPaseoOwnedWorktree: false,
    mainRepoRoot: "/home/t/mobile",
    baseBranch: "main",
    createdAt: ago(200 * HOUR),
    updatedAt: ago(100 * HOUR),
    archivedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

function agent(overrides: Partial<DoneJanitorAgentView> = {}): DoneJanitorAgentView {
  return {
    id: "agent-1",
    title: "Build the feature",
    provider: "claude",
    workspaceId: "ws-1",
    cwd: "/home/t/mobile-worktrees/feature",
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

const OLD_SIGNALS: WorkspaceActivitySignals = {
  headCommitMs: NOW - 150 * HOUR,
  directoryMtimeMs: NOW - 150 * HOUR,
};

function facts(overrides: Partial<WorkspaceSweepFacts> = {}): WorkspaceSweepFacts {
  const agents = overrides.agents ?? [agent()];
  return {
    workspace: workspace(),
    agents,
    views: agents,
    terminalCount: 0,
    runningScriptCount: 0,
    signals: OLD_SIGNALS,
    ...overrides,
  };
}

function classify(input: Partial<WorkspaceSweepFacts> = {}) {
  return classifyWorkspace(facts(input), CONFIG, NOW);
}

describe("classifyWorkspace", () => {
  test("a workspace whose agents are finished and everything is older than 72h is idle", () => {
    expect(classify()).toMatchObject({ kind: "idle", rule: "idle", idleForMs: 100 * HOUR });
  });

  test("the threshold for a workspace with agents is 72h", () => {
    const recent = classify({
      workspace: workspace({ updatedAt: ago(71 * HOUR) }),
    });
    expect(recent).toMatchObject({ kind: "active" });
    expect(recent.reason).toContain("2d 23h");
  });

  test("a workspace with no usable activity signal counts as active", () => {
    const verdict = classify({
      workspace: workspace({ createdAt: "", updatedAt: "" }),
      agents: [],
      views: [],
      signals: { headCommitMs: null, directoryMtimeMs: null },
    });
    expect(verdict).toEqual({ kind: "active", reason: "it has no usable activity signal" });
  });

  test("an unreadable timestamp reads as just now, never as long ago", () => {
    const verdict = classify({ workspace: workspace({ updatedAt: "not a date" }) });
    expect(verdict.kind).toBe("active");
  });

  test("an agent with no readable activity time keeps its workspace", () => {
    const verdict = classify({ agents: [agent({ lastActivityAtMs: null })] });
    expect(verdict).toEqual({
      kind: "active",
      reason: "agent agent-1 has no readable last-activity time",
    });
  });

  test("the newest signal wins: a recent HEAD commit keeps an otherwise idle workspace", () => {
    const verdict = classify({ signals: { ...OLD_SIGNALS, headCommitMs: NOW - 2 * HOUR } });
    expect(verdict.kind).toBe("active");
  });

  test("the newest signal wins: a recent directory mtime keeps an otherwise idle workspace", () => {
    const verdict = classify({ signals: { ...OLD_SIGNALS, directoryMtimeMs: NOW - 2 * HOUR } });
    expect(verdict.kind).toBe("active");
  });

  test("an archived agent's timestamps are not activity: archiving it is not use", () => {
    const verdict = classify({
      agents: [agent({ archived: true, lastActivityAtMs: NOW - HOUR })],
    });
    expect(verdict).toMatchObject({ kind: "idle" });
  });

  test("before its directory is read, a workspace whose record is recent is already active", () => {
    const verdict = classify({ workspace: workspace({ updatedAt: ago(HOUR) }), signals: null });
    expect(verdict.kind).toBe("active");
  });

  test("before its directory is read, an old record asks for the directory's signals", () => {
    expect(classify({ signals: null })).toEqual({ kind: "needs-signals" });
  });

  test("a pinned workspace is never idle", () => {
    expect(classify({ workspace: workspace({ pinnedAt: ago(500 * HOUR) }) })).toEqual({
      kind: "active",
      reason: "it is pinned",
    });
  });

  test("an agent labelled paseo.keep pins its workspace", () => {
    expect(classify({ agents: [agent({ labels: { "paseo.keep": "false" } })] })).toEqual({
      kind: "active",
      reason: "agent agent-1 is pinned with paseo.keep",
    });
  });

  test.each([
    ["running", { lifecycle: "running" as const, live: true }, "is running"],
    ["initializing", { lifecycle: "initializing" as const, live: true }, "is initializing"],
    ["mid-turn", { lifecycle: "idle" as const, live: true, busy: true }, "has a turn in flight"],
    [
      "waiting on a permission",
      { lifecycle: "idle" as const, live: true, pendingPermissionCount: 1 },
      "is waiting on a permission",
    ],
    [
      "running provider subagents",
      { lifecycle: "idle" as const, live: true, runningProviderSubagentCount: 2 },
      "has 2 provider subagent(s) still running",
    ],
    [
      "cut off by a daemon stop",
      { interruptedMidTurn: true },
      "was cut off mid-turn by a daemon stop",
    ],
  ])("a %s agent keeps its workspace", (_name, overrides, reason) => {
    const verdict = classify({ agents: [agent(overrides)] });
    expect(verdict).toEqual({ kind: "active", reason: `agent agent-1 ${reason}` });
  });

  test("a schedule or heartbeat that targets an agent keeps its workspace", () => {
    expect(classify({ agents: [agent({ hasSchedule: true })] })).toEqual({
      kind: "active",
      reason: "agent agent-1 has a schedule or heartbeat that will wake it",
    });
  });

  test("an orchestrator with a live subagent elsewhere keeps its workspace", () => {
    const leader = agent({ id: "leader", live: true, lifecycle: "idle" });
    const child = agent({
      id: "child",
      workspaceId: "ws-2",
      live: true,
      lifecycle: "idle",
      labels: { "paseo.parent-agent-id": "leader" },
    });
    expect(classify({ agents: [leader], views: [leader, child] })).toEqual({
      kind: "active",
      reason: "agent leader leads subagent child, which is live",
    });
  });

  test("a closed leader whose subagents are all closed is not an orchestrator at work", () => {
    const leader = agent({ id: "leader" });
    const child = agent({
      id: "child",
      workspaceId: "ws-2",
      labels: { "paseo.parent-agent-id": "leader" },
    });
    expect(classify({ agents: [leader], views: [leader, child] }).kind).toBe("idle");
  });

  test("an open terminal keeps the workspace", () => {
    expect(classify({ terminalCount: 2 })).toEqual({
      kind: "active",
      reason: "it has 2 open terminal(s)",
    });
  });

  test("a running script keeps the workspace", () => {
    expect(classify({ runningScriptCount: 1 })).toEqual({
      kind: "active",
      reason: "it has 1 running script(s)",
    });
  });

  test("a workspace with no agents and no git is idle after 24h", () => {
    const directory = workspace({
      kind: "directory",
      cwd: "/home/t/notes",
      worktreeRoot: null,
      mainRepoRoot: null,
      updatedAt: ago(25 * HOUR),
      createdAt: ago(25 * HOUR),
    });
    const noGit = { headCommitMs: null, directoryMtimeMs: NOW - 30 * HOUR };
    expect(classify({ workspace: directory, agents: [], views: [], signals: noGit })).toMatchObject(
      { kind: "idle", rule: "empty" },
    );
    const fresh = { ...directory, updatedAt: ago(23 * HOUR), createdAt: ago(23 * HOUR) };
    expect(classify({ workspace: fresh, agents: [], views: [], signals: noGit }).kind).toBe(
      "active",
    );
  });

  test("a workspace whose agents are all archived counts as having none", () => {
    const directory = workspace({ kind: "directory", updatedAt: ago(25 * HOUR) });
    const verdict = classify({
      workspace: directory,
      agents: [agent({ archived: true })],
      signals: { headCommitMs: null, directoryMtimeMs: null },
    });
    expect(verdict).toMatchObject({ kind: "idle", rule: "empty" });
  });

  test("a git checkout with no agents still waits the full 72h", () => {
    const checkout = workspace({ kind: "local_checkout", updatedAt: ago(30 * HOUR) });
    const verdict = classify({
      workspace: checkout,
      agents: [],
      views: [],
      signals: { headCommitMs: NOW - 40 * HOUR, directoryMtimeMs: null },
    });
    expect(verdict.kind).toBe("active");
  });

  describe("self-heal fixer workspaces", () => {
    const home = workspace({
      kind: "directory",
      cwd: "/home/t",
      worktreeRoot: null,
      mainRepoRoot: null,
      title: "Remediate disk-falling condition",
      createdAt: ago(2 * HOUR),
      updatedAt: ago(2 * HOUR),
    });
    // The home directory's mtime moves all day; it must not hold a finished fixer.
    const busyHome = { headCommitMs: null, directoryMtimeMs: NOW - 60_000 };
    const fixer = (overrides: Partial<DoneJanitorAgentView> = {}) =>
      agent({
        id: "fixer",
        cwd: "/home/t",
        lastActivityAtMs: NOW - HOUR,
        labels: { "paseo.remediation": "disk-falling" },
        ...overrides,
      });

    test("is idle the moment its fixer is finished, however fresh its directory", () => {
      const verdict = classify({ workspace: home, agents: [fixer()], signals: busyHome });
      expect(verdict).toMatchObject({ kind: "idle", rule: "fixer" });
      expect(verdict.reason).toContain("self-heal");
    });

    test("is idle when the ladder already archived its fixer", () => {
      const verdict = classify({
        workspace: home,
        agents: [fixer({ archived: true, lastActivityAtMs: NOW - 60_000 })],
        signals: busyHome,
      });
      expect(verdict).toMatchObject({ kind: "idle", rule: "fixer" });
    });

    test("is kept while its fixer works", () => {
      const verdict = classify({
        workspace: home,
        agents: [fixer({ lifecycle: "running", live: true })],
        signals: busyHome,
      });
      expect(verdict).toEqual({ kind: "active", reason: "agent fixer is running" });
    });

    test("is kept for a few minutes after its fixer stops, so the ladder reads the report first", () => {
      const verdict = classify({
        workspace: home,
        agents: [fixer({ lifecycle: "idle", live: true, lastActivityAtMs: NOW - 2 * 60_000 })],
        signals: busyHome,
      });
      expect(verdict.kind).toBe("active");
      expect(verdict.reason).toContain("settle");
    });

    test("is an ordinary workspace once someone starts their own agent in it", () => {
      const verdict = classify({
        workspace: home,
        agents: [fixer(), agent({ id: "mine", cwd: "/home/t", lastActivityAtMs: NOW - HOUR })],
        signals: busyHome,
      });
      expect(verdict.kind).toBe("active");
    });

    test("a pinned fixer workspace is kept", () => {
      const verdict = classify({
        workspace: { ...home, pinnedAt: ago(HOUR) },
        agents: [fixer()],
        signals: busyHome,
      });
      expect(verdict).toEqual({ kind: "active", reason: "it is pinned" });
    });
  });
});

describe("archiveDeletesDirectory", () => {
  test("a Paseo-owned worktree's directory is deleted by archive", () => {
    expect(
      archiveDeletesDirectory({
        workspace: workspace({ isPaseoOwnedWorktree: true }),
        pathInsidePaseoWorktrees: true,
      }),
    ).toBe(true);
  });

  test("a worktree record without the owned flag but under the Paseo root is treated as owned", () => {
    // Archive-by-scope's legacy path discovers ownership from the path and deletes it.
    expect(
      archiveDeletesDirectory({ workspace: workspace(), pathInsidePaseoWorktrees: true }),
    ).toBe(true);
  });

  test("an external worktree, a local checkout and a directory keep their directory", () => {
    expect(
      archiveDeletesDirectory({ workspace: workspace(), pathInsidePaseoWorktrees: false }),
    ).toBe(false);
    for (const kind of ["local_checkout", "directory"] as const) {
      expect(
        archiveDeletesDirectory({
          workspace: workspace({ kind, isPaseoOwnedWorktree: true }),
          pathInsidePaseoWorktrees: true,
        }),
      ).toBe(false);
    }
  });
});

describe("describeUncoveredWork", () => {
  const snapshotted = {
    kind: "snapshotted" as const,
    worktreePath: "/w",
    ref: "refs/backup/2026-09-29/w",
    commit: "abc",
    dirtyFiles: 2,
    unpushedCommits: 1,
    skippedFiles: [],
    offsite: { kind: "bundled" as const, path: "/b" },
  };

  test("a snapshot with nothing left out and only build output ignored covers everything", () => {
    expect(
      describeUncoveredWork({
        snapshot: snapshotted,
        ignoredEntries: ["node_modules/", "packages/app/dist/", ".DS_Store"],
      }),
    ).toBeNull();
  });

  test("an ignored file outside build output is not covered", () => {
    expect(
      describeUncoveredWork({ snapshot: snapshotted, ignoredEntries: [".env", "node_modules/"] }),
    ).toBe("1 ignored file(s) outside build output that no snapshot covers (.env)");
  });

  test("an untracked file left out of the snapshot for its size is not covered", () => {
    expect(
      describeUncoveredWork({
        snapshot: { ...snapshotted, skippedFiles: ["data/big.bin"] },
        ignoredEntries: [],
      }),
    ).toBe("1 untracked file(s) too large for the snapshot (data/big.bin)");
  });

  test("a failed snapshot covers nothing", () => {
    expect(
      describeUncoveredWork({
        snapshot: { kind: "failed", worktreePath: "/w", error: "disk full" },
        ignoredEntries: [],
      }),
    ).toBe("its work is at risk and could not be snapshotted: disk full");
  });

  test("an ignored-file listing that failed covers nothing", () => {
    expect(describeUncoveredWork({ snapshot: snapshotted, ignoredEntries: null })).toBe(
      "its ignored files could not be listed",
    );
  });
});

describe("isBuildOutputPath", () => {
  test.each([
    ["node_modules/", true],
    ["packages/server/dist/", true],
    ["ios/Pods/", true],
    ["game/.godot/", true],
    ["tools/__pycache__/", true],
    ["a/b/c.pyc", true],
    [".DS_Store", true],
    [".env", false],
    ["notes/", false],
    ["game/content/party.gd.uid", false],
    ["distribution.md", false],
  ])("%s → %s", (entry, expected) => {
    expect(isBuildOutputPath(entry)).toBe(expected);
  });
});

describe("resolveWorkspaceSweepConfig", () => {
  test("defaults when absent", () => {
    expect(resolveWorkspaceSweepConfig({})).toEqual({
      enabled: true,
      dryRun: false,
      idleMs: 72 * HOUR,
      emptyIdleMs: 24 * HOUR,
      maxArchivesPerSweep: 10,
      projectGraceMs: 24 * HOUR,
      maxProjectRemovalsPerSweep: 10,
    });
  });

  test("the janitor's dry run makes the sweep dry too", () => {
    expect(resolveWorkspaceSweepConfig({ dryRun: true }).dryRun).toBe(true);
    expect(resolveWorkspaceSweepConfig({ workspaceSweep: { dryRun: true } }).dryRun).toBe(true);
  });

  test("honours every key", () => {
    expect(
      resolveWorkspaceSweepConfig({
        workspaceSweep: {
          enabled: false,
          idleHours: 96,
          emptyIdleHours: 12,
          maxArchivesPerSweep: 3,
          projectGraceHours: 48,
          maxProjectRemovalsPerSweep: 5,
        },
      }),
    ).toEqual({
      enabled: false,
      dryRun: false,
      idleMs: 96 * HOUR,
      emptyIdleMs: 12 * HOUR,
      maxArchivesPerSweep: 3,
      projectGraceMs: 48 * HOUR,
      maxProjectRemovalsPerSweep: 5,
    });
  });
});
