import { describe, expect, test } from "vitest";

import type { DoneJanitorProject, DoneJanitorWorkspace } from "../agent-done-janitor.js";
import type { DoneJanitorAgentView } from "./done-janitor-detector.js";
import type { WorktreeCoverage } from "../done-janitor-worktree.js";
import {
  checkDeletionInvariant,
  classifyWorkspace,
  idleProjectVerdict,
  isBuildManifest,
  isRegenerablePath,
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
    expect(recent).toMatchObject({ kind: "active", reason: expect.stringContaining("2d 23h") });
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

  test("an archived agent's last activity is activity: archiving it does not age the workspace", () => {
    const verdict = classify({
      workspace: workspace({ createdAt: ago(120 * HOUR), updatedAt: ago(120 * HOUR) }),
      agents: [agent({ archived: true, lastActivityAtMs: NOW - 25 * HOUR })],
    });
    expect(verdict).toEqual({ kind: "active", reason: "active 25h ago; idle after 3d" });
  });

  test("an agent's archive time is activity: the clock runs from when it went", () => {
    const verdict = classify({
      agents: [
        agent({ archived: true, lastActivityAtMs: NOW - 100 * HOUR, archivedAtMs: NOW - HOUR }),
      ],
    });
    expect(verdict).toEqual({ kind: "active", reason: "active 1h ago; idle after 3d" });
  });

  test("a workspace whose agents were all archived long ago is idle from the last archive", () => {
    const verdict = classify({
      agents: [
        agent({
          archived: true,
          lastActivityAtMs: NOW - 120 * HOUR,
          archivedAtMs: NOW - 90 * HOUR,
        }),
      ],
    });
    expect(verdict).toMatchObject({ kind: "idle", idleForMs: 90 * HOUR });
  });

  test("before its directory is read, a workspace whose record is recent is already active", () => {
    const verdict = classify({ workspace: workspace({ updatedAt: ago(HOUR) }), signals: null });
    expect(verdict.kind).toBe("active");
  });

  test("before its directory is read, an old record asks for the directory's signals", () => {
    expect(classify({ signals: null })).toEqual({ kind: "needs-signals" });
  });

  test("a manually pinned workspace is never idle", () => {
    const pinned = workspace({ pinnedAt: ago(500 * HOUR), pinSource: "manual" });
    expect(classify({ workspace: pinned })).toEqual({ kind: "active", reason: "it is pinned" });
  });

  test("a legacy pin, written before pinSource existed, is a manual pin", () => {
    expect(classify({ workspace: workspace({ pinnedAt: ago(500 * HOUR) }) })).toEqual({
      kind: "active",
      reason: "it is pinned",
    });
  });

  test("an auto pin protects nothing: the workspace is idle like any other", () => {
    const autoPinned = workspace({ pinnedAt: ago(200 * HOUR), pinSource: "auto" });
    expect(classify({ workspace: autoPinned })).toMatchObject({ kind: "idle", rule: "idle" });
  });

  test("an auto-pinned workspace holding a paseo.keep agent is kept by the label", () => {
    const autoPinned = workspace({ pinnedAt: ago(200 * HOUR), pinSource: "auto" });
    expect(
      classify({ workspace: autoPinned, agents: [agent({ labels: { "paseo.keep": "" } })] }),
    ).toEqual({ kind: "active", reason: "agent agent-1 is pinned with paseo.keep" });
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

  describe("a subagent whose leader works elsewhere", () => {
    const worker = (overrides: Partial<DoneJanitorAgentView> = {}) =>
      agent({ id: "worker", labels: { "paseo.parent-agent-id": "leader" }, ...overrides });
    const leader = (overrides: Partial<DoneJanitorAgentView> = {}) =>
      agent({ id: "leader", workspaceId: "ws-leader", cwd: "/home/t/leader", ...overrides });

    test("is kept while its leader was active within the idle threshold", () => {
      const views = [worker(), leader({ lastActivityAtMs: NOW - 2 * HOUR })];
      expect(classify({ agents: [views[0]], views })).toEqual({
        kind: "active",
        reason: "agent worker is a subagent of leader, which is still active",
      });
    });

    test("is kept while its leader is loaded, however long it has been idle", () => {
      const views = [worker(), leader({ live: true, lifecycle: "idle" })];
      expect(classify({ agents: [views[0]], views }).kind).toBe("active");
    });

    test("is kept while any ancestor up the chain is active", () => {
      const middle = agent({
        id: "leader",
        workspaceId: "ws-middle",
        labels: { "paseo.parent-agent-id": "root" },
      });
      const root = agent({ id: "root", workspaceId: "ws-root", lastActivityAtMs: NOW - HOUR });
      const views = [worker(), middle, root];
      expect(classify({ agents: [views[0]], views })).toMatchObject({
        kind: "active",
        reason: "agent worker is a subagent of root, which is still active",
      });
    });

    test("is idle once its leader is quiet past the threshold or archived", () => {
      const quiet = [worker(), leader()];
      expect(classify({ agents: [quiet[0]], views: quiet }).kind).toBe("idle");
      const archived = [worker(), leader({ archived: true, lastActivityAtMs: NOW - HOUR })];
      expect(classify({ agents: [archived[0]], views: archived }).kind).toBe("idle");
    });

    test("a leader in the same workspace already dates it, and is not counted twice", () => {
      const views = [worker(), leader({ workspaceId: "ws-1", live: true, lifecycle: "idle" })];
      expect(classify({ agents: views, views }).kind).toBe("idle");
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
      expect(verdict).toMatchObject({
        kind: "idle",
        rule: "fixer",
        reason: expect.stringContaining("self-heal"),
      });
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
      expect(verdict).toMatchObject({ kind: "active", reason: expect.stringContaining("settle") });
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

  describe("agent-made workspaces (R6)", () => {
    const agentMade = workspace({ createdBy: "agent" });
    const archivedAgent = (overrides: Partial<DoneJanitorAgentView> = {}) =>
      agent({ archived: true, lastActivityAtMs: NOW - 100 * HOUR, ...overrides });

    test("is archived by agent-done once every agent in it has been archived for over an hour", () => {
      const verdict = classify({
        workspace: agentMade,
        agents: [archivedAgent({ archivedAtMs: NOW - 61 * 60_000 })],
      });
      expect(verdict).toMatchObject({
        kind: "idle",
        rule: "agent-done",
        idleForMs: 61 * 60_000,
      });
    });

    test("is kept at 59 minutes since the last agent was archived", () => {
      const verdict = classify({
        workspace: agentMade,
        agents: [archivedAgent({ archivedAtMs: NOW - 59 * 60_000 })],
      });
      expect(verdict).toMatchObject({ kind: "active", reason: expect.stringContaining("59m") });
    });

    test("waits on the latest of several agents, not the first", () => {
      const verdict = classify({
        workspace: agentMade,
        agents: [
          archivedAgent({ id: "agent-1", archivedAtMs: NOW - 5 * HOUR }),
          archivedAgent({ id: "agent-2", archivedAtMs: NOW - 59 * 60_000 }),
        ],
      });
      expect(verdict).toMatchObject({ kind: "active" });
    });

    test("is kept while any agent in it is not yet archived", () => {
      const verdict = classify({
        workspace: agentMade,
        agents: [
          archivedAgent({ id: "agent-1", archivedAtMs: NOW - 5 * HOUR }),
          agent({ id: "agent-2", archived: false, lastActivityAtMs: NOW - 5 * HOUR }),
        ],
      });
      expect(verdict).toEqual({
        kind: "active",
        reason: "not every agent in it is archived yet",
      });
    });

    test("a person-made workspace follows idle/empty as today, never agent-done", () => {
      // Same shape as the first case above, but person-made: the ordinary 72h idle rule applies,
      // not the 1h agent-done one.
      const verdict = classify({
        workspace: workspace({ createdBy: "person" }),
        agents: [archivedAgent({ archivedAtMs: NOW - 61 * 60_000 })],
      });
      expect(verdict.kind).toBe("active");

      const noCreatedBy = classify({
        workspace: workspace(),
        agents: [archivedAgent({ archivedAtMs: NOW - 61 * 60_000 })],
      });
      expect(noCreatedBy.kind).toBe("active");
    });
  });
});

describe("checkDeletionInvariant", () => {
  function coverage(overrides: Partial<WorktreeCoverage> = {}): WorktreeCoverage {
    return {
      commit: "abc",
      changed: [],
      untracked: [],
      ignored: [],
      gitlinks: [],
      unbackedCommits: 0,
      hidden: [],
      lfs: [],
      unreadable: [],
      nestedRepositories: [],
      manifestDirectories: [],
      ...overrides,
    };
  }

  test("a clean, pushed tree with only regenerable ignored paths holds", () => {
    expect(
      checkDeletionInvariant(
        coverage({
          ignored: ["node_modules/", "packages/app/dist/", ".DS_Store"],
          manifestDirectories: ["packages/app"],
        }),
        "head",
      ),
    ).toEqual({
      holds: true,
      detail:
        "holds: every file is tracked and pushed; ignored only regenerable (node_modules/, packages/app/dist/, .DS_Store)",
    });
  });

  test.each([
    ["an evidence log", "docs/playtest/evidence/core/run-1.log"],
    ["a data directory", "Clone/.data/"],
    ["local Xcode settings", "apps/mobile/ios/.xcode.env.local"],
    ["an env file", ".env"],
    ["Firebase config", "apps/mobile/android/app/google-services.json"],
    ["tool results", "Clone/tools/queen-safety/results/"],
  ])("%s that is ignored keeps the worktree, whatever else holds", (_name, entry) => {
    for (const basis of ["plan", "head", "snapshot"] as const) {
      expect(
        checkDeletionInvariant(coverage({ ignored: ["node_modules/", entry] }), basis),
      ).toEqual({
        holds: false,
        reason: `1 ignored path(s) that are not regenerable and no backup holds (${entry})`,
        category: "ignored-path",
      });
    }
  });

  test("a listing git could not make holds nothing", () => {
    expect(checkDeletionInvariant(null, "snapshot")).toEqual({
      holds: false,
      reason: "git could not list its files",
    });
  });

  test("a submodule or a nested repository keeps it: a backup holds only a pointer", () => {
    expect(checkDeletionInvariant(coverage({ gitlinks: ["vendor/tool"] }), "snapshot")).toEqual({
      holds: false,
      reason:
        "1 submodule(s) or nested repositor(ies) a backup holds only as a pointer (vendor/tool)",
    });
    expect(checkDeletionInvariant(coverage({ untracked: ["vendor/other/"] }), "plan").holds).toBe(
      false,
    );
  });

  test("planning against HEAD names what the snapshot will have to hold", () => {
    expect(
      checkDeletionInvariant(
        coverage({ changed: ["a.ts"], untracked: ["b.ts"], unbackedCommits: 2 }),
        "plan",
      ),
    ).toEqual({
      holds: true,
      detail:
        "holds once a verified snapshot backs up 2 changed or untracked file(s) and 2 unpushed commit(s)",
    });
  });

  test("a file not in the snapshot keeps it: written since, or left out by the snapshot's own rules", () => {
    expect(
      checkDeletionInvariant(coverage({ untracked: ["src/credentials-form.ts"] }), "snapshot"),
    ).toEqual({
      holds: false,
      reason: "1 file(s) not in the snapshot, changed since or left out (src/credentials-form.ts)",
    });
    expect(checkDeletionInvariant(coverage({ changed: ["README.md"] }), "snapshot").holds).toBe(
      false,
    );
  });

  test("a build directory beside source, not beside a manifest, is somebody's files and keeps it", () => {
    for (const entry of ["src/build/", "src/.cache/"]) {
      expect(checkDeletionInvariant(coverage({ ignored: [entry] }), "head")).toEqual({
        holds: false,
        reason: `1 ignored path(s) that are not regenerable and no backup holds (${entry})`,
        category: "ignored-path",
      });
    }
  });

  test("a nested repository inside a regenerable directory keeps it: its commits are its own", () => {
    expect(
      checkDeletionInvariant(
        coverage({ ignored: [".cache/"], nestedRepositories: [".cache/tool/"] }),
        "head",
      ),
    ).toEqual({
      holds: false,
      reason:
        "1 submodule(s) or nested repositor(ies) a backup holds only as a pointer (.cache/tool/)",
    });
  });

  test("a directory the delete cannot read or empty keeps it: the delete would stop part-way", () => {
    for (const basis of ["plan", "head", "snapshot"] as const) {
      expect(checkDeletionInvariant(coverage({ unreadable: ["notes/"] }), basis)).toEqual({
        holds: false,
        reason: "1 director(ies) it cannot read or empty, so a delete would stop part-way (notes/)",
      });
    }
  });

  test("a change hidden with --assume-unchanged or --skip-worktree keeps it", () => {
    for (const basis of ["plan", "head", "snapshot"] as const) {
      expect(checkDeletionInvariant(coverage({ hidden: ["src/a.ts"] }), basis)).toEqual({
        holds: false,
        reason:
          "1 tracked file(s) git is told not to check, with --assume-unchanged or --skip-worktree (src/a.ts)",
      });
    }
  });

  test("a file stored with Git LFS keeps it: nothing proves its contents are off this machine", () => {
    for (const basis of ["plan", "head", "snapshot"] as const) {
      expect(checkDeletionInvariant(coverage({ lfs: ["assets/hero.png"] }), basis)).toEqual({
        holds: false,
        reason:
          "1 file(s) stored with Git LFS, whose contents nothing shows are off this machine (assets/hero.png)",
      });
    }
  });

  test("with no snapshot, anything that differs from HEAD or is not pushed keeps it", () => {
    expect(checkDeletionInvariant(coverage({ changed: ["README.md"] }), "head").holds).toBe(false);
    expect(checkDeletionInvariant(coverage({ unbackedCommits: 1 }), "head")).toEqual({
      holds: false,
      reason: "1 commit(s) reachable from HEAD are neither pushed nor in pushed HEAD",
    });
  });
});

describe("isRegenerablePath", () => {
  // Directories that hold a build manifest, as readWorktreeCoverage lists them.
  const MANIFESTS = new Set([
    "packages/server",
    "packages/app",
    "ios",
    "game",
    "tools",
    "ios/Packages",
  ]);

  test.each([
    ["node_modules/", true],
    ["packages/server/dist/", true],
    ["ios/Pods/", true],
    ["game/.godot/", true],
    ["tools/__pycache__/", true],
    ["a/b/c.pyc", true],
    [".DS_Store", true],
    ["packages/app/tsc-out/", true],
    ["test-results/", true],
    ["tsconfig.tsbuildinfo", true],
    ["ios/Packages/.build/", true],
    [".swiftpm/", true],
    [".yarn/cache/", true],
    [".yarn/install-state.gz", true],
    ["node_modules/pkg/build/", true],
    [".yarn/", false],
    [".yarn/releases/yarn.cjs", false],
    [".env", false],
    ["notes/", false],
    ["game/content/party.gd.uid", false],
    ["distribution.md", false],
    ["Clone/.data/", false],
    ["src-tauri/binaries/", false],
    ["results/", false],
    ["install-state.gz", false],
    // A regenerable name away from the root and from any manifest is somebody's directory.
    ["src/build/", false],
    ["src/.cache/", false],
    ["src/build/release-signing.json", false],
    ["config/build/hand-written.json", false],
    ["docs/notes/dist/", false],
    ["docs/.yarn/cache/", false],
  ])("%s → %s", (entry, expected) => {
    expect(isRegenerablePath(entry, MANIFESTS)).toBe(expected);
  });
});

describe("isBuildManifest", () => {
  test.each([
    ["package.json", true],
    ["Cargo.toml", true],
    ["build.gradle", true],
    ["build.gradle.kts", true],
    ["settings.gradle", true],
    ["settings.gradle.kts", true],
    ["Package.swift", true],
    ["pyproject.toml", true],
    ["setup.py", true],
    ["App.xcodeproj", true],
    ["go.mod", true],
    ["pom.xml", true],
    ["README.md", false],
    ["package-lock.json", false],
    ["tsconfig.json", false],
  ])("%s → %s", (name, expected) => {
    expect(isBuildManifest(name)).toBe(expected);
  });
});

describe("resolveWorkspaceSweepConfig", () => {
  test("defaults when absent, dry until a person turns it live", () => {
    expect(resolveWorkspaceSweepConfig({})).toEqual({
      enabled: true,
      dryRun: true,
      idleMs: 72 * HOUR,
      emptyIdleMs: 24 * HOUR,
      maxArchivesPerSweep: 10,
      projectGraceMs: 24 * HOUR,
      maxProjectRemovalsPerSweep: 10,
      keptCooldownMs: 6 * HOUR,
    });
  });

  test("only an explicit dryRun: false makes it live, and the janitor's dry run still wins", () => {
    expect(resolveWorkspaceSweepConfig({ dryRun: false }).dryRun).toBe(true);
    expect(resolveWorkspaceSweepConfig({ workspaceSweep: { enabled: true } }).dryRun).toBe(true);
    expect(resolveWorkspaceSweepConfig({ workspaceSweep: { dryRun: false } }).dryRun).toBe(false);
    expect(
      resolveWorkspaceSweepConfig({ dryRun: true, workspaceSweep: { dryRun: false } }).dryRun,
    ).toBe(true);
  });

  test("honours every key", () => {
    expect(
      resolveWorkspaceSweepConfig({
        workspaceSweep: {
          enabled: false,
          dryRun: false,
          idleHours: 96,
          emptyIdleHours: 12,
          maxArchivesPerSweep: 3,
          projectGraceHours: 48,
          maxProjectRemovalsPerSweep: 5,
          keptCooldownHours: 2,
        },
      }),
    ).toEqual({
      enabled: false,
      dryRun: false,
      idleMs: 96 * HOUR,
      emptyIdleMs: 12 * HOUR,
      maxArchivesPerSweep: 3,
      keptCooldownMs: 2 * HOUR,
      projectGraceMs: 48 * HOUR,
      maxProjectRemovalsPerSweep: 5,
    });
  });
});

describe("idleProjectVerdict", () => {
  function project(overrides: Partial<DoneJanitorProject> = {}): DoneJanitorProject {
    return {
      projectId: "project-1",
      rootPath: "/home/t/DayTrader",
      projectKey: null,
      createdAt: ago(300 * HOUR),
      updatedAt: ago(300 * HOUR),
      archivedAt: null,
      ...overrides,
    };
  }
  const gone = (hoursAgo: number) => workspace({ archivedAt: ago(hoursAgo * HOUR) });

  test("the grace runs from when its last workspace went", () => {
    expect(idleProjectVerdict(project(), [gone(30), gone(200)], CONFIG, NOW)).toEqual({
      kind: "remove",
      quietForMs: 30 * HOUR,
      reason: "it has had no active workspace for 30h",
    });
    expect(idleProjectVerdict(project(), [gone(3)], CONFIG, NOW).kind).toBe("keep");
  });

  test("a project with no workspace at all waits out the grace from its own timestamps", () => {
    expect(
      idleProjectVerdict(project({ createdAt: ago(HOUR), updatedAt: ago(HOUR) }), [], CONFIG, NOW)
        .kind,
    ).toBe("keep");
    expect(idleProjectVerdict(project(), [], CONFIG, NOW).kind).toBe("remove");
  });

  test.each([
    ["an active workspace", project(), [workspace()], "it has an active workspace"],
    ["an archived project", project({ archivedAt: ago(HOUR) }), [], "it is archived"],
    [
      "a remote project",
      project({ projectKey: "remote:github.com/x/y" }),
      [],
      "it is a remote project",
    ],
    [
      "no usable timestamp",
      project({ createdAt: "", updatedAt: "" }),
      [],
      "it has no usable activity signal",
    ],
  ])("keeps a project with %s", (_name, candidate, workspaces, reason) => {
    expect(idleProjectVerdict(candidate, workspaces, CONFIG, NOW)).toEqual({
      kind: "keep",
      reason,
    });
  });

  test("an unreadable timestamp reads as just now", () => {
    expect(idleProjectVerdict(project({ updatedAt: "garbage" }), [], CONFIG, NOW).kind).toBe(
      "keep",
    );
  });
});
