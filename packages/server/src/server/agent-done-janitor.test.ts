import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { AgentManager, type DoneJanitorAgentSummary } from "./agent/agent-manager.js";
import type { AgentStreamEvent } from "./agent/agent-sdk-types.js";
import { AgentStorage, type StoredAgentRecord } from "./agent/agent-storage.js";
import { createTestAgentClient } from "./test-utils/fake-agent-client.js";
import {
  AgentDoneJanitor,
  askAgentWhetherDone,
  probeProjectRoot,
  readProviderHealth,
  volumeRootOf,
  type AskAgentResult,
  type DoneJanitorConfig,
  type DoneJanitorDependencies,
  type DoneJanitorProject,
  type DoneJanitorReportEntry,
  type DoneJanitorWorkspace,
  type ProviderHealth,
} from "./agent-done-janitor.js";
import type { WorktreeCoverage, WorktreeDeletionSafety } from "./done-janitor-worktree.js";
import type { ProcessScan } from "./worktree-process-scan.js";
import type { WorkspaceActivitySignals } from "./agent/workspace-sweep-detector.js";
import type { PushPayload } from "./push/index.js";
import type { WorktreeSnapshotResult } from "./remediation/contract.js";
import { ArchiveRefusedError, type ArchiveRecheckStage } from "./workspace-archive-service.js";

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const FOUR_DAYS_AGO = new Date(NOW - 96 * HOUR).toISOString();
const GB = 1024 ** 3;

function record(overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  return {
    id: "agent-1",
    provider: "claude",
    cwd: "/home/t/.paseo/worktrees/h/feature",
    workspaceId: "ws-1",
    createdAt: FOUR_DAYS_AGO,
    updatedAt: FOUR_DAYS_AGO,
    title: "Build the feature",
    labels: {},
    lastStatus: "idle",
    config: null,
    persistence: { provider: "claude", sessionId: "session-1" },
    ...overrides,
  } as StoredAgentRecord;
}

function workspace(overrides: Partial<DoneJanitorWorkspace> = {}): DoneJanitorWorkspace {
  return {
    workspaceId: "ws-1",
    projectId: "project-1",
    kind: "worktree",
    cwd: "/home/t/.paseo/worktrees/h/feature",
    displayName: "feature",
    title: null,
    worktreeRoot: "/home/t/.paseo/worktrees/h/feature",
    isPaseoOwnedWorktree: true,
    mainRepoRoot: "/home/t/repo",
    baseBranch: "main",
    createdAt: FOUR_DAYS_AGO,
    updatedAt: FOUR_DAYS_AGO,
    archivedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

function coverage(overrides: Partial<WorktreeCoverage> = {}): WorktreeCoverage {
  return {
    commit: "head",
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

/** What a hook may change mid-sweep: the records the next read is served from. */
interface HarnessState {
  stored: StoredAgentRecord[];
  workspaces: DoneJanitorWorkspace[];
  now: () => number;
}

interface Harness {
  janitor: AgentDoneJanitor;
  asked: string[];
  archived: string[];
  reclaimed: string[];
  /** Workspaces the idle-workspace sweep archived. */
  archivedWorkspaces: string[];
  /** The directory each deleting archive was told its checks read (`expectedDirectory`). */
  expectedDirectories: string[];
  removedProjects: string[];
  pushes: PushPayload[];
  levels: (string | undefined)[];
  /** Snapshots, archives and reclaims in the order they happened. */
  events: string[];
  stored: StoredAgentRecord[];
  config: DoneJanitorConfig;
  setNow(ms: number): void;
}

function harness(input: {
  stored?: StoredAgentRecord[];
  live?: DoneJanitorAgentSummary[];
  workspaces?: DoneJanitorWorkspace[];
  projects?: DoneJanitorProject[];
  /** Runs as each read of the projects is served; `call` counts from 1. */
  onListProjects?: (
    call: number,
    state: { projects: DoneJanitorProject[]; workspaces: DoneJanitorWorkspace[] },
  ) => void;
  /** Runs before each probe of a project root; `call` counts from 1. */
  onProbeRoot?: (call: number) => void;
  removeProject?: (projectId: string) => void;
  /** Stands in for the mount-point rule, so a temp directory can be a volume. */
  volumeRootOf?: (rootPath: string) => string | null;
  config?: DoneJanitorConfig | undefined;
  answer?: (agentId: string) => AskAgentResult;
  health?: ProviderHealth;
  safety?: WorktreeDeletionSafety;
  checkWorktree?: (worktreePath: string) => WorktreeDeletionSafety;
  scheduled?: string[];
  terminals?: number;
  /** Runs after an answer and before the janitor's re-check. */
  afterAnswer?: (stored: StoredAgentRecord[]) => void;
  /** Runs as each read of the stored agents is served; `call` counts from 1. */
  onListStored?: (call: number, stored: StoredAgentRecord[]) => void;
  snapshot?: (cwd: string) => WorktreeSnapshotResult;
  /** The directory's activity; absent: nothing readable (no git, no directory). */
  signals?: (directory: string) => WorkspaceActivitySignals;
  /** Ignored paths the coverage read lists; null: git could not list them. */
  ignored?: (worktreePath: string) => string[] | null;
  nestedRepositories?: string[];
  /** The whole coverage read; overrides `ignored` and `nestedRepositories`. */
  coverage?: (worktreePath: string, commit: string | null) => WorktreeCoverage | null;
  /** Why a snapshot's backup is not verified; absent: it is. */
  unverifiedBackup?: (snapshot: WorktreeSnapshotResult) => string | null;
  processes?: (directory: string) => ProcessScan;
  scheduledCwds?: string[];
  runningScripts?: number;
  /** Open terminals per read; overrides `terminals`. */
  countTerminals?: (workspaceId: string) => number;
  /** Running scripts per read; overrides `runningScripts`. */
  countRunningScripts?: (workspaceId: string) => number;
  /** Runs once, at the first `du`: after a reclaim's plan and before its archive. */
  whileMeasuring?: (state: HarnessState) => void;
  /** Runs inside the reclaim's archive-by-scope, before its re-check at each stage. */
  duringReclaim?: (stage: ArchiveRecheckStage, state: HarnessState) => void;
  logger?: Logger;
  /** The directory archive-by-scope would delete; absent: its resolution, by path shape. */
  resolveArchiveDirectory?: (workspace: DoneJanitorWorkspace) => string | null;
}): Harness {
  let now = NOW;
  const stored = input.stored ?? [record()];
  const workspaces = input.workspaces ?? [workspace()];
  const asked: string[] = [];
  const archived: string[] = [];
  const reclaimed: string[] = [];
  const archivedWorkspaces: string[] = [];
  const expectedDirectories: string[] = [];
  const removedProjects: string[] = [];
  const projects = input.projects ?? [];
  const pushes: PushPayload[] = [];
  const levels: (string | undefined)[] = [];
  const events: string[] = [];
  let listCalls = 0;
  let listProjectCalls = 0;
  let probeCalls = 0;
  let measured = false;
  const config = input.config;
  const state: HarnessState = { stored, workspaces, now: () => now };
  /** Archive-by-scope's record half: the workspace and every agent in it. */
  const archiveWorkspaceRecords = (workspaceId: string, event: string): void => {
    archivedWorkspaces.push(workspaceId);
    events.push(event);
    const archivedAt = new Date(now).toISOString();
    const index = workspaces.findIndex((candidate) => candidate.workspaceId === workspaceId);
    workspaces[index] = { ...workspaces[index], archivedAt };
    for (const [agentIndex, candidate] of stored.entries()) {
      if (candidate.workspaceId === workspaceId && !candidate.archivedAt) {
        stored[agentIndex] = { ...candidate, archivedAt, updatedAt: archivedAt };
      }
    }
  };
  const deps: DoneJanitorDependencies = {
    listLiveAgents: () => input.live ?? [],
    listStoredAgents: async () => {
      listCalls += 1;
      input.onListStored?.(listCalls, stored);
      return stored;
    },
    listWorkspaces: async () => workspaces,
    listScheduledAgentIds: async () => new Set(input.scheduled ?? []),
    listScheduledCwds: async () => input.scheduledCwds ?? [],
    getProviderHealth: async () => input.health ?? { askable: true },
    askAgent: async ({ agentId }) => {
      asked.push(agentId);
      const result = input.answer?.(agentId) ?? {
        kind: "answered",
        reply: "DONE",
        usedTools: false,
      };
      // The answer is activity: stamp it like the manager would.
      const index = stored.findIndex((candidate) => candidate.id === agentId);
      stored[index] = { ...stored[index], updatedAt: new Date(now).toISOString() };
      input.afterAnswer?.(stored);
      return result;
    },
    archiveAgent: async (agentId) => {
      archived.push(agentId);
      events.push(`archive:${agentId}`);
      const archivedAt = new Date(now).toISOString();
      for (const [index, candidate] of stored.entries()) {
        const cascades =
          candidate.id === agentId || candidate.labels["paseo.parent-agent-id"] === agentId;
        if (cascades) stored[index] = { ...candidate, archivedAt, updatedAt: archivedAt };
      }
    },
    countTerminals: async (workspaceId) =>
      input.countTerminals?.(workspaceId) ?? input.terminals ?? 0,
    isPaseoOwnedWorktreePath: async (path) => path.startsWith("/home/t/.paseo/worktrees/"),
    checkWorktree: async ({ worktreePath }) =>
      input.checkWorktree?.(worktreePath) ??
      input.safety ?? { safe: true, branch: "feature", head: "abc" },
    measureBytes: async () => {
      if (!measured) input.whileMeasuring?.(state);
      measured = true;
      return 3 * GB;
    },
    // Archive-by-scope's order: the re-check, the records (agents with them), the re-check, the
    // directory. A refusal before the records touches nothing; one before the directory keeps it.
    reclaimWorkspace: async (workspaceId, directory, recheck) => {
      expectedDirectories.push(directory);
      input.duringReclaim?.("archive", state);
      const refused = await recheck("archive");
      if (refused) throw new ArchiveRefusedError(refused);
      reclaimed.push(workspaceId);
      events.push(`reclaim:${workspaceId}`);
      const archivedAt = new Date(now).toISOString();
      const index = workspaces.findIndex((candidate) => candidate.workspaceId === workspaceId);
      workspaces[index] = { ...workspaces[index], archivedAt };
      for (const [agentIndex, candidate] of stored.entries()) {
        if (candidate.workspaceId === workspaceId && !candidate.archivedAt) {
          stored[agentIndex] = { ...candidate, archivedAt, updatedAt: archivedAt };
        }
      }
      input.duringReclaim?.("delete", state);
      const kept = await recheck("delete");
      return kept
        ? { removedDirectory: false, keptDirectoryReason: kept }
        : { removedDirectory: true };
    },
    resolveArchiveDirectory: async (candidate) => {
      if (input.resolveArchiveDirectory) return input.resolveArchiveDirectory(candidate);
      // Archive-by-scope's own resolution: the flag, or an older record's path shape.
      if (candidate.isPaseoOwnedWorktree && candidate.worktreeRoot && candidate.mainRepoRoot) {
        return candidate.worktreeRoot;
      }
      if (candidate.kind !== "worktree") return null;
      const owned = /^\/home\/t\/\.paseo\/worktrees\/[^/]+\/[^/]+/u.exec(
        candidate.worktreeRoot ?? candidate.cwd,
      );
      return owned?.[0] ?? null;
    },
    archiveWorkspace: async (workspaceId, directory) => {
      expectedDirectories.push(directory);
      archiveWorkspaceRecords(workspaceId, `archive-workspace:${workspaceId}`);
      return { removedDirectory: true };
    },
    archiveWorkspaceRecord: async (workspaceId) => {
      archiveWorkspaceRecords(workspaceId, `archive-record:${workspaceId}`);
    },
    countRunningScripts: async (workspaceId) =>
      input.countRunningScripts?.(workspaceId) ?? input.runningScripts ?? 0,
    readActivitySignals: async (directory) =>
      input.signals?.(directory) ?? { headCommitMs: null, directoryMtimeMs: null },
    readWorktreeCoverage: async ({ worktreePath, commit }) => {
      if (input.coverage) return input.coverage(worktreePath, commit);
      const ignored = input.ignored ? input.ignored(worktreePath) : [];
      if (ignored === null) return null;
      return coverage({
        commit: commit ?? "head",
        ignored,
        gitlinks: input.nestedRepositories ?? [],
      });
    },
    verifyBackup: async ({ snapshot }) => input.unverifiedBackup?.(snapshot) ?? null,
    listProcessesInside: async (directory) =>
      input.processes?.(directory) ?? { kind: "scanned", processes: [] },
    snapshotWorktree: async ({ cwd }) => {
      events.push(`snapshot:${cwd}`);
      return input.snapshot?.(cwd) ?? { kind: "nothing-at-risk", worktreePath: cwd };
    },
    listProjects: async () => {
      listProjectCalls += 1;
      input.onListProjects?.(listProjectCalls, { projects, workspaces });
      return projects.filter((project) => !removedProjects.includes(project.projectId));
    },
    // The real probe on real files: a fake would only prove the janitor trusts the fake.
    probeProjectRoot: async (rootPath) => {
      probeCalls += 1;
      input.onProbeRoot?.(probeCalls);
      return probeProjectRoot(rootPath, { volumeRootOf: input.volumeRootOf });
    },
    removeProject: async (projectId) => {
      input.removeProject?.(projectId);
      removedProjects.push(projectId);
      events.push(`remove-project:${projectId}`);
    },
  };
  const janitor = new AgentDoneJanitor({
    dependencies: deps,
    getPushNotificationSender: () => ({
      send: async (payload, options) => {
        pushes.push(payload);
        levels.push(options?.level);
      },
    }),
    serverId: "server-1",
    readDaemonConfig: () => ({ doneJanitor: config }),
    logger: input.logger ?? pino({ level: "silent" }),
    now: () => now,
  });
  return {
    janitor,
    asked,
    archived,
    reclaimed,
    archivedWorkspaces,
    expectedDirectories,
    removedProjects,
    pushes,
    levels,
    events,
    stored,
    config: config ?? {},
    setNow: (ms) => {
      now = ms;
    },
  };
}

/** The idle-workspace sweep, off: these suites are about the passes that came before it. */
const SWEEP_OFF = { workspaceSweep: { enabled: false } } as const;

// The ask path, on its own: the dead pass would archive these stored (closed) records unasked.
const ON: DoneJanitorConfig = { enabled: true, archiveDead: false, ...SWEEP_OFF };

describe("AgentDoneJanitor", () => {
  test("absent config does nothing at all — today's behaviour", async () => {
    const h = harness({ config: undefined });
    expect(await h.janitor.tick()).toBeNull();
    expect(h.asked).toEqual([]);
    expect(h.archived).toEqual([]);
  });

  test("a finished agent that answers DONE is archived and its worktree reclaimed, with one push", async () => {
    const h = harness({ config: ON });

    const report = await h.janitor.tick();

    expect(h.asked).toEqual(["agent-1"]);
    expect(h.archived).toEqual(["agent-1"]);
    expect(h.reclaimed).toEqual(["ws-1"]);
    // The archive deletes only the directory the checks read, or throws.
    expect(h.expectedDirectories).toEqual(["/home/t/.paseo/worktrees/h/feature"]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({ action: "deleted", workspaceId: "ws-1", bytes: 3 * GB }),
    );
    expect(h.pushes).toEqual([
      expect.objectContaining({
        title: "Cleaned up finished work",
        body: "Archived 1 finished agent and deleted 1 worktree, freeing 3.0 GB.",
      }),
    ]);
  });

  test("an agent that answered DONE keeps its worktree when a snapshot of work at risk fails", async () => {
    const h = harness({
      config: ON,
      snapshot: (cwd) => ({ kind: "failed", worktreePath: cwd, error: "disk full" }),
    });

    await h.janitor.tick();

    expect(h.archived).toEqual(["agent-1"]);
    expect(h.reclaimed).toEqual([]);
  });

  test("an agent idle overnight is not asked", async () => {
    const lastNight = new Date(NOW - 14 * HOUR).toISOString();
    const h = harness({ config: ON, stored: [record({ updatedAt: lastNight })] });

    const report = await h.janitor.tick();

    expect(h.asked).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({ action: "not-done", reason: "quiet for 14h of the 3d required" }),
    );
    expect(h.pushes).toEqual([]);
  });

  test("a leader whose subagent is still working is not asked", async () => {
    const h = harness({
      config: ON,
      stored: [
        record(),
        record({
          id: "child",
          labels: { "paseo.parent-agent-id": "agent-1" },
          lastStatus: "running",
        }),
      ],
    });

    await h.janitor.tick();

    expect(h.asked).toEqual([]);
  });

  test("a live provider subagent keeps its parent", async () => {
    const h = harness({
      config: ON,
      live: [liveSummary({ runningProviderSubagentCount: 1 })],
    });

    await h.janitor.tick();

    expect(h.asked).toEqual([]);
  });

  test("a pinned agent is never asked", async () => {
    const h = harness({ config: ON, stored: [record({ labels: { "paseo.keep": "" } })] });

    await h.janitor.tick();

    expect(h.asked).toEqual([]);
  });

  test("an unread finish is not done: nobody has read the result", async () => {
    const h = harness({
      config: ON,
      stored: [record({ requiresAttention: true, attentionReason: "finished" })],
    });

    await h.janitor.tick();

    expect(h.asked).toEqual([]);
  });

  test("an agent a heartbeat will wake is not asked", async () => {
    const h = harness({ config: ON, scheduled: ["agent-1"] });

    await h.janitor.tick();

    expect(h.asked).toEqual([]);
  });

  test.each<[string, AskAgentResult]>([
    ["NOT_DONE", { kind: "answered", reply: "NOT_DONE", usedTools: false }],
    ["a softer yes", { kind: "answered", reply: "Done!", usedTools: false }],
    ["a caveat", { kind: "answered", reply: "DONE, but the PR is still open", usedTools: false }],
    [
      "a question back",
      { kind: "answered", reply: "Should I also delete the branch?", usedTools: false },
    ],
    ["DONE after using tools", { kind: "answered", reply: "DONE", usedTools: true }],
    ["silence", { kind: "timeout" }],
    ["a permission request", { kind: "permission" }],
    ["a failed turn", { kind: "failed", error: "boom" }],
  ])("%s is not done: nothing is archived", async (_name, answer) => {
    const h = harness({ config: ON, answer: () => answer });

    await h.janitor.tick();

    expect(h.asked).toEqual(["agent-1"]);
    expect(h.archived).toEqual([]);
    expect(h.reclaimed).toEqual([]);
    expect(h.pushes).toEqual([]);
  });

  test("a negative answer is not asked again until another quiet period, then backs off", async () => {
    const h = harness({
      config: ON,
      answer: () => ({ kind: "answered", reply: "NOT_DONE", usedTools: false }),
    });

    await h.janitor.tick();
    h.setNow(NOW + 71 * HOUR);
    await h.janitor.tick();
    expect(h.asked).toEqual(["agent-1"]);

    h.setNow(NOW + 73 * HOUR);
    await h.janitor.tick();
    expect(h.asked).toEqual(["agent-1", "agent-1"]);

    // Second negative: the next question waits twice as long.
    h.setNow(NOW + 73 * HOUR + 100 * HOUR);
    await h.janitor.tick();
    expect(h.asked).toHaveLength(2);
    h.setNow(NOW + 73 * HOUR + 145 * HOUR);
    await h.janitor.tick();
    expect(h.asked).toHaveLength(3);
  });

  test("an agent that became busy right after answering DONE is left alone", async () => {
    const h = harness({
      config: ON,
      afterAnswer: (stored) => {
        stored[0] = { ...stored[0], lastStatus: "running" };
      },
    });

    const report = await h.janitor.tick();

    expect(h.archived).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({ action: "not-done", reason: "answered DONE, but then is running" }),
    );
  });

  test("an agent with no session is reported and left, never treated as consent", async () => {
    const h = harness({ config: ON, stored: [record({ persistence: null })] });

    const report = await h.janitor.tick();

    expect(h.asked).toEqual([]);
    expect(h.archived).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "cannot-ask",
        reason: "has no provider session to resume",
      }),
    );
  });

  test("an agent on a capped account is reported and left", async () => {
    const h = harness({
      config: ON,
      health: { askable: false, reason: "account claude is at its usage cap" },
    });

    const report = await h.janitor.tick();

    expect(h.asked).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "cannot-ask",
        reason: "account claude is at its usage cap",
      }),
    );
  });

  test("a workspace with unpushed commits: the agent is archived, the worktree kept and reported", async () => {
    const h = harness({
      config: ON,
      safety: {
        safe: false,
        reason: "feature has 2 commit(s) neither merged into main nor pushed to any remote",
      },
    });

    await h.janitor.tick();

    expect(h.archived).toEqual(["agent-1"]);
    expect(h.reclaimed).toEqual([]);
    expect(h.pushes[0]?.body).toBe(
      "Archived 1 finished agent. Kept /home/t/.paseo/worktrees/h/feature: feature has 2 commit(s) neither merged into main nor pushed to any remote.",
    );
  });

  test.each<[string, Partial<Parameters<typeof harness>[0]>, string]>([
    [
      "a local checkout",
      { workspaces: [workspace({ kind: "local_checkout", isPaseoOwnedWorktree: false })] },
      "it is a local_checkout, not a worktree",
    ],
    [
      "a worktree outside the Paseo root",
      {
        workspaces: [
          workspace({
            worktreeRoot: "/home/t/paseo-worktrees/bozeo",
            cwd: "/home/t/paseo-worktrees/bozeo",
          }),
        ],
      },
      "its directory is outside the Paseo worktrees root",
    ],
    [
      "a worktree with another live agent",
      { stored: [record(), record({ id: "other", updatedAt: new Date(NOW).toISOString() })] },
      "agent other in it is not archived",
    ],
    ["a worktree with an open terminal", { terminals: 1 }, "it has 1 open terminal(s)"],
    [
      "a worktree another workspace shares",
      { workspaces: [workspace(), workspace({ workspaceId: "ws-2", kind: "local_checkout" })] },
      "workspace ws-2 (local_checkout) uses the same directory",
    ],
  ])("%s is kept", async (_name, overrides, reason) => {
    const h = harness({ config: ON, ...overrides });

    const report = await h.janitor.tick();

    expect(h.reclaimed).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({ action: "kept-workspace", reason }),
    );
  });

  test("a workspace in a directory above the worktree does not keep it", async () => {
    // A self-heal fixer runs in the home directory; its workspace once kept every worktree.
    const h = harness({
      config: ON,
      workspaces: [
        workspace(),
        workspace({
          workspaceId: "ws-home",
          kind: "directory",
          cwd: "/home/t",
          worktreeRoot: null,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
        }),
      ],
    });

    await h.janitor.tick();

    expect(h.reclaimed).toEqual(["ws-1"]);
  });

  test("a workspace inside the worktree keeps it", async () => {
    const h = harness({
      config: ON,
      workspaces: [
        workspace(),
        workspace({
          workspaceId: "ws-inner",
          kind: "directory",
          cwd: "/home/t/.paseo/worktrees/h/feature/packages/app",
          worktreeRoot: null,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
        }),
      ],
    });

    const report = await h.janitor.tick();

    expect(h.reclaimed).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-workspace",
        reason: "workspace ws-inner (directory) uses the same directory",
      }),
    );
  });

  test("workspace reclamation can be turned off without turning off archiving", async () => {
    const h = harness({ config: { ...ON, reclaimWorkspaces: false } });

    await h.janitor.tick();

    expect(h.archived).toEqual(["agent-1"]);
    expect(h.reclaimed).toEqual([]);
  });

  test("a workspace whose agents were all archived long ago is reclaimed without asking anyone", async () => {
    const h = harness({ config: ON, stored: [record({ archivedAt: FOUR_DAYS_AGO })] });

    await h.janitor.tick();

    expect(h.asked).toEqual([]);
    expect(h.reclaimed).toEqual(["ws-1"]);
    expect(h.pushes[0]?.body).toBe("Deleted 1 worktree, freeing 3.0 GB.");
  });

  test("a worktree kept every sweep does not starve the ones after it", async () => {
    const paths = ["a", "b", "c", "d", "e"].map((name) => `/home/t/.paseo/worktrees/h/${name}`);
    const h = harness({
      config: { ...ON, maxArchivesPerSweep: 1 },
      stored: paths.map((cwd, index) =>
        record({
          id: `agent-${index}`,
          workspaceId: `ws-${index}`,
          cwd,
          archivedAt: FOUR_DAYS_AGO,
        }),
      ),
      workspaces: paths.map((cwd, index) =>
        workspace({ workspaceId: `ws-${index}`, cwd, worktreeRoot: cwd }),
      ),
      checkWorktree: (worktreePath) =>
        worktreePath.endsWith("/e")
          ? { safe: true, branch: "e", head: "abc" }
          : { safe: false, reason: "it has 1 uncommitted or untracked file(s)" },
    });

    await h.janitor.tick();

    expect(h.reclaimed).toEqual(["ws-4"]);
  });

  test("a workspace that never had an agent is not touched", async () => {
    const h = harness({ config: ON, stored: [] });

    await h.janitor.tick();

    expect(h.reclaimed).toEqual([]);
  });

  test("one question per sweep by default", async () => {
    const h = harness({
      config: ON,
      stored: [
        record(),
        record({ id: "agent-2", workspaceId: "ws-2", cwd: "/home/t/.paseo/worktrees/h/two" }),
      ],
      workspaces: [
        workspace(),
        workspace({
          workspaceId: "ws-2",
          cwd: "/home/t/.paseo/worktrees/h/two",
          worktreeRoot: "/home/t/.paseo/worktrees/h/two",
        }),
      ],
    });

    await h.janitor.tick();

    expect(h.asked).toHaveLength(1);
  });

  test("a dry run asks, archives and deletes nothing, reports all three, and sends no push", async () => {
    const h = harness({ config: { ...ON, dryRun: true } });

    const report = await h.janitor.tick();

    expect(h.asked).toEqual([]);
    expect(h.archived).toEqual([]);
    expect(h.reclaimed).toEqual([]);
    expect(h.pushes).toEqual([]);
    expect(report?.entries).toEqual([
      expect.objectContaining({
        action: "would-ask",
        agentId: "agent-1",
        reason: "every mechanical check passed; quiet for 4d",
      }),
      expect.objectContaining({
        action: "would-archive",
        agentId: "agent-1",
        reason: "if it answers DONE",
      }),
      expect.objectContaining({
        action: "would-delete",
        workspaceId: "ws-1",
        path: "/home/t/.paseo/worktrees/h/feature",
        reason: "clean tree and branch feature is merged or pushed",
      }),
    ]);
  });
});

const DEAD_ON: DoneJanitorConfig = { enabled: true, ...SWEEP_OFF };
const PARENT = "paseo.parent-agent-id";

describe("AgentDoneJanitor dead pass", () => {
  test("a closed, unpinned agent is archived without being asked, and its worktree reclaimed", async () => {
    const h = harness({ config: DEAD_ON });

    const report = await h.janitor.tick();

    expect(h.asked).toEqual([]);
    expect(h.archived).toEqual(["agent-1"]);
    expect(h.reclaimed).toEqual(["ws-1"]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "archived",
        agentId: "agent-1",
        reason: "dead: closed, quiet for 4d",
      }),
    );
    expect(h.pushes).toEqual([
      expect.objectContaining({
        body: "Archived 1 dead session and deleted 1 worktree, freeing 3.0 GB.",
      }),
    ]);
  });

  test("a stored record that still says running is dead once no runtime holds it", async () => {
    const h = harness({ config: DEAD_ON, stored: [record({ lastStatus: "running" })] });

    await h.janitor.tick();

    expect(h.archived).toEqual(["agent-1"]);
  });

  test("a live agent in error is dead", async () => {
    const h = harness({
      config: DEAD_ON,
      live: [
        liveSummary({ lifecycle: "error", requiresAttention: true, attentionReason: "error" }),
      ],
    });

    const report = await h.janitor.tick();

    expect(h.asked).toEqual([]);
    expect(h.archived).toEqual(["agent-1"]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "archived",
        reason: "dead: in error, quiet for 4d; 1 unread flag(s) (error) will be cleared",
      }),
    );
  });

  test("a live idle agent is not dead: it goes to the done check like before", async () => {
    const h = harness({ config: DEAD_ON, live: [liveSummary({})] });

    const report = await h.janitor.tick();

    expect(h.asked).toEqual(["agent-1"]);
    expect(report?.entries.filter((entry) => entry.action === "kept-agent")).toEqual([]);
  });

  test("with the question off, a live idle agent is left entirely alone", async () => {
    const h = harness({ config: { ...DEAD_ON, askFinished: false }, live: [liveSummary({})] });

    await h.janitor.tick();

    expect(h.asked).toEqual([]);
    expect(h.archived).toEqual([]);
  });

  test("a closed agent is never asked, even when the dead pass spares it", async () => {
    const h = harness({
      config: DEAD_ON,
      stored: [record({ labels: { "paseo.keep": "true" } })],
    });

    await h.janitor.tick();

    expect(h.asked).toEqual([]);
    expect(h.archived).toEqual([]);
  });

  test("an agent gone quiet only overnight is spared, reported with how long is left", async () => {
    const lastNight = new Date(NOW - 14 * HOUR).toISOString();
    const h = harness({ config: DEAD_ON, stored: [record({ updatedAt: lastNight })] });

    const report = await h.janitor.tick();

    expect(h.archived).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-agent",
        reason: "quiet for 14h of the 3d required",
      }),
    );
  });

  test("deadQuietHours shortens the wait", async () => {
    const yesterday = new Date(NOW - 30 * HOUR).toISOString();
    const h = harness({
      config: { ...DEAD_ON, deadQuietHours: 24 },
      stored: [record({ updatedAt: yesterday })],
    });

    await h.janitor.tick();

    expect(h.archived).toEqual(["agent-1"]);
  });

  test.each<[string, Partial<StoredAgentRecord>, string]>([
    ["a paseo.keep label", { labels: { "paseo.keep": "" } }, "pinned with paseo.keep"],
  ])("%s pins a dead agent", async (_name, overrides, reason) => {
    const h = harness({ config: DEAD_ON, stored: [record(overrides)] });

    const report = await h.janitor.tick();

    expect(h.archived).toEqual([]);
    expect(h.reclaimed).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({ action: "kept-agent", reason }),
    );
  });

  test("a pinned workspace pins every agent in it, and its worktree", async () => {
    const h = harness({
      config: DEAD_ON,
      workspaces: [workspace({ pinnedAt: "2026-09-01T00:00:00.000Z" })],
    });

    const report = await h.janitor.tick();

    expect(h.archived).toEqual([]);
    expect(h.reclaimed).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({ action: "kept-agent", reason: "its workspace is pinned" }),
    );
  });

  test("a pinned workspace is not reclaimed even when every agent in it is already archived", async () => {
    const h = harness({
      config: DEAD_ON,
      stored: [record({ archivedAt: FOUR_DAYS_AGO })],
      workspaces: [workspace({ pinnedAt: "2026-09-01T00:00:00.000Z" })],
    });

    const report = await h.janitor.tick();

    expect(h.reclaimed).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({ action: "kept-workspace", reason: "its workspace is pinned" }),
    );
  });

  test("an auto-pinned workspace does not pin a dead agent: it reclaims like unpinned", async () => {
    const h = harness({
      config: DEAD_ON,
      workspaces: [workspace({ pinnedAt: "2026-09-01T00:00:00.000Z", pinSource: "auto" })],
    });

    const report = await h.janitor.tick();

    expect(h.archived).toEqual(["agent-1"]);
    expect(h.reclaimed).toEqual(["ws-1"]);
    expect(report?.entries).not.toContainEqual(
      expect.objectContaining({ action: "kept-agent", reason: "its workspace is pinned" }),
    );
  });

  test("a manually pinned workspace still pins every agent in it, and its worktree", async () => {
    const h = harness({
      config: DEAD_ON,
      workspaces: [workspace({ pinnedAt: "2026-09-01T00:00:00.000Z", pinSource: "manual" })],
    });

    const report = await h.janitor.tick();

    expect(h.archived).toEqual([]);
    expect(h.reclaimed).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({ action: "kept-agent", reason: "its workspace is pinned" }),
    );
  });

  test("an auto-pinned workspace is reclaimed once every agent in it is already archived", async () => {
    const h = harness({
      config: DEAD_ON,
      stored: [record({ archivedAt: FOUR_DAYS_AGO })],
      workspaces: [workspace({ pinnedAt: "2026-09-01T00:00:00.000Z", pinSource: "auto" })],
    });

    const report = await h.janitor.tick();

    expect(h.reclaimed).toEqual(["ws-1"]);
    expect(report?.entries).not.toContainEqual(
      expect.objectContaining({ action: "kept-workspace", reason: "its workspace is pinned" }),
    );
  });

  test("an agent a schedule will wake is not dead", async () => {
    const h = harness({ config: DEAD_ON, scheduled: ["agent-1"] });

    await h.janitor.tick();

    expect(h.archived).toEqual([]);
  });

  test("a dead leader with a live child is not archived out from under it", async () => {
    const h = harness({
      config: DEAD_ON,
      stored: [record(), record({ id: "child", labels: { [PARENT]: "agent-1" } })],
      live: [liveSummary({ id: "child", labels: { [PARENT]: "agent-1" } })],
    });

    const report = await h.janitor.tick();

    expect(h.archived).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-agent",
        agentId: "agent-1",
        reason: "subagent child is idle, not dead",
      }),
    );
  });

  test("a dead leader is archived with its dead children by cascade", async () => {
    const h = harness({
      config: DEAD_ON,
      stored: [
        record(),
        record({ id: "child-1", labels: { [PARENT]: "agent-1" } }),
        record({ id: "child-2", labels: { [PARENT]: "agent-1" } }),
      ],
    });

    const report = await h.janitor.tick();

    expect(h.archived).toEqual(["agent-1"]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "archived",
        reason: "dead: closed, quiet for 4d; with 2 subagent(s) by cascade",
      }),
    );
    expect(h.pushes[0]?.body).toContain("Archived 3 dead sessions");
  });

  test("an agent a person opened between the read and the archive is left alone", async () => {
    const h = harness({
      config: DEAD_ON,
      onListStored: (call, stored) => {
        if (call === 2) stored[0] = { ...stored[0], updatedAt: new Date(NOW).toISOString() };
      },
    });

    const report = await h.janitor.tick();

    expect(h.archived).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-agent",
        reason: "dead, but then quiet for 0m of the 3d required",
      }),
    );
  });

  test("a dirty worktree is kept and says why; the agent is still archived", async () => {
    const h = harness({
      config: DEAD_ON,
      safety: { safe: false, reason: "it has 2 uncommitted or untracked file(s)" },
    });

    const report = await h.janitor.tick();

    expect(h.archived).toEqual(["agent-1"]);
    expect(h.reclaimed).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-workspace",
        workspaceId: "ws-1",
        reason: "it has 2 uncommitted or untracked file(s)",
      }),
    );
  });

  test("a worktree another live agent works in is kept", async () => {
    const h = harness({
      config: DEAD_ON,
      stored: [record(), record({ id: "other", workspaceId: "ws-1" })],
      live: [liveSummary({ id: "other", workspaceId: "ws-1", lifecycle: "running", busy: true })],
    });

    const report = await h.janitor.tick();

    expect(h.archived).toEqual(["agent-1"]);
    expect(h.reclaimed).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-workspace",
        reason: "agent other in it is not archived",
      }),
    );
  });

  test("reclaimWorkspaces off archives the agent and keeps every worktree", async () => {
    const h = harness({ config: { ...DEAD_ON, reclaimWorkspaces: false } });

    await h.janitor.tick();

    expect(h.archived).toEqual(["agent-1"]);
    expect(h.reclaimed).toEqual([]);
  });

  test("two dead agents in one workspace: it is reclaimed once, after both are archived", async () => {
    const h = harness({
      config: DEAD_ON,
      stored: [record(), record({ id: "agent-2" })],
    });

    await h.janitor.tick();

    expect(h.archived.sort()).toEqual(["agent-1", "agent-2"]);
    expect(h.reclaimed).toEqual(["ws-1"]);
  });

  test("the archive budget bounds a backlog, oldest dead first", async () => {
    const older = new Date(NOW - 200 * HOUR).toISOString();
    const h = harness({
      config: { ...DEAD_ON, maxDeadArchivesPerSweep: 1 },
      stored: [
        record({ id: "newer", workspaceId: "ws-1" }),
        record({ id: "older", workspaceId: "ws-2", updatedAt: older }),
      ],
      workspaces: [
        workspace(),
        workspace({
          workspaceId: "ws-2",
          cwd: "/home/t/.paseo/worktrees/h/other",
          worktreeRoot: "/home/t/.paseo/worktrees/h/other",
        }),
      ],
    });

    const report = await h.janitor.tick();

    expect(h.archived).toEqual(["older"]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-agent",
        agentId: "newer",
        reason: "dead, but this sweep's archive budget is spent; next sweep",
      }),
    );
  });

  test("the deletion budget leaves the rest of the worktrees for the next sweep", async () => {
    const h = harness({
      config: { ...DEAD_ON, maxArchivesPerSweep: 1 },
      stored: [record({ id: "a", workspaceId: "ws-1" }), record({ id: "b", workspaceId: "ws-2" })],
      workspaces: [
        workspace(),
        workspace({
          workspaceId: "ws-2",
          cwd: "/home/t/.paseo/worktrees/h/other",
          worktreeRoot: "/home/t/.paseo/worktrees/h/other",
        }),
      ],
    });

    const report = await h.janitor.tick();

    expect(h.archived.sort()).toEqual(["a", "b"]);
    expect(h.reclaimed).toHaveLength(1);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-workspace",
        reason: "its agents are archived, but this sweep's deletion budget is spent; next sweep",
      }),
    );
  });

  test("a dry run archives and deletes nothing and reports exactly what a live sweep would do", async () => {
    const h = harness({
      config: { ...DEAD_ON, dryRun: true },
      stored: [
        record({ requiresAttention: true, attentionReason: "finished" }),
        record({ id: "child", labels: { [PARENT]: "agent-1" } }),
        record({
          id: "pinned",
          workspaceId: "ws-2",
          cwd: "/home/t/.paseo/worktrees/h/other",
          labels: { "paseo.keep": "true" },
        }),
      ],
      workspaces: [
        workspace(),
        workspace({
          workspaceId: "ws-2",
          cwd: "/home/t/.paseo/worktrees/h/other",
          worktreeRoot: "/home/t/.paseo/worktrees/h/other",
        }),
      ],
    });

    const report = await h.janitor.tick();

    expect(h.asked).toEqual([]);
    expect(h.archived).toEqual([]);
    expect(h.reclaimed).toEqual([]);
    expect(h.pushes).toEqual([]);
    expect(report?.entries).toEqual([
      expect.objectContaining({
        action: "kept-agent",
        agentId: "pinned",
        reason: "pinned with paseo.keep",
      }),
      expect.objectContaining({
        action: "would-archive",
        agentId: "agent-1",
        reason:
          "dead: closed, quiet for 4d; with 1 subagent(s) by cascade; 1 unread flag(s) (finished) will be cleared",
      }),
      expect.objectContaining({
        action: "would-delete",
        workspaceId: "ws-1",
        path: "/home/t/.paseo/worktrees/h/feature",
        reason:
          "every agent in it is dead or archived; clean tree and branch feature is merged or pushed",
      }),
    ]);
  });

  test("the worktree is snapshotted before the archive and before the reclaim", async () => {
    const h = harness({
      config: DEAD_ON,
      snapshot: (cwd) => ({
        kind: "snapshotted",
        worktreePath: cwd,
        ref: "refs/backup/2026-09-21/feature",
        commit: "abc",
        dirtyFiles: 0,
        unpushedCommits: 1,
        skippedFiles: [],
        offsite: { kind: "bundled", path: "/b/feature.bundle" },
      }),
    });

    const report = await h.janitor.tick();

    const feature = "/home/t/.paseo/worktrees/h/feature";
    expect(h.events).toEqual([
      `snapshot:${feature}`,
      "archive:agent-1",
      `snapshot:${feature}`,
      "reclaim:ws-1",
    ]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "snapshotted",
        path: feature,
        reason: "refs/backup/2026-09-21/feature; bundled at /b/feature.bundle",
      }),
    );
  });

  test("a failed snapshot of work at risk spares the worktree this sweep, and says why", async () => {
    const h = harness({
      config: DEAD_ON,
      snapshot: (cwd) => ({ kind: "failed", worktreePath: cwd, error: "git write-tree failed" }),
    });

    const report = await h.janitor.tick();

    expect(h.archived).toEqual(["agent-1"]);
    expect(h.reclaimed).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-workspace",
        workspaceId: "ws-1",
        reason: "its work is at risk and could not be snapshotted: git write-tree failed",
      }),
    );
  });

  test("a snapshot that could not read the directory at all keeps it: nothing vouches for its files", async () => {
    const h = harness({
      config: DEAD_ON,
      snapshot: () => ({
        kind: "failed",
        worktreePath: null,
        error: "it is not inside a git repository",
      }),
    });
    const report = await h.janitor.tick();
    expect(h.archived).toEqual(["agent-1"]);
    expect(h.reclaimed).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-workspace",
        reason:
          "its work is at risk and could not be snapshotted: it is not inside a git repository",
      }),
    );
  });

  test("a dry run takes no snapshot", async () => {
    const h = harness({ config: { ...DEAD_ON, dryRun: true } });
    await h.janitor.tick();
    expect(h.events).toEqual([]);
  });

  test("a kept worktree is only recorded: it is snapshotted, and the work-at-risk sweep judges it", async () => {
    const h = harness({
      config: DEAD_ON,
      safety: { safe: false, reason: "it has 2 uncommitted or untracked file(s)" },
    });
    await h.janitor.tick();
    expect(h.pushes).toHaveLength(1);
    expect(h.levels).toEqual(["record"]);
  });

  test("archiveDead off leaves closed agents to the question, as before", async () => {
    const h = harness({ config: { enabled: true, archiveDead: false, ...SWEEP_OFF } });

    await h.janitor.tick();

    expect(h.asked).toEqual(["agent-1"]);
  });
});

describe("AgentDoneJanitor reclaims on what is true at the reclaim, not at the plan", () => {
  const JUST_NOW = new Date(NOW).toISOString();
  // Every pass that deletes a worktree plans it, then snapshots and measures it for minutes.
  const PASSES = [
    { pass: "the question", config: ON, stored: () => [record()] },
    { pass: "the dead pass", config: DEAD_ON, stored: () => [record()] },
    {
      pass: "the orphan pass",
      config: ON,
      stored: () => [record({ archivedAt: FOUR_DAYS_AGO })],
    },
  ];

  /** Someone starts an agent in the worktree: its record, and a runtime at work. */
  function startAgent(
    state: HarnessState,
    live: DoneJanitorAgentSummary[],
    overrides: Partial<StoredAgentRecord> = {},
  ): void {
    const started = record({ id: "late", title: "Started meanwhile", updatedAt: JUST_NOW });
    state.stored.push({ ...started, ...overrides });
    live.push(
      liveSummary({
        id: "late",
        workspaceId: overrides.workspaceId ?? "ws-1",
        cwd: overrides.cwd ?? started.cwd,
        lifecycle: "running",
        busy: true,
        lastActivityAt: JUST_NOW,
      }),
    );
  }

  test.each(PASSES)(
    "$pass: an agent that starts between the plan and the reclaim keeps the workspace and is not archived",
    async ({ config, stored }) => {
      const live: DoneJanitorAgentSummary[] = [];
      const h = harness({
        config,
        stored: stored(),
        live,
        whileMeasuring: (state) => startAgent(state, live),
      });

      const report = await h.janitor.tick();

      expect(h.reclaimed).toEqual([]);
      expect(h.stored.find((agent) => agent.id === "late")?.archivedAt).toBeFalsy();
      expect(report?.entries).toContainEqual(
        expect.objectContaining({
          action: "kept-workspace",
          workspaceId: "ws-1",
          reason: "planned for deletion, but since then agent late in it is not archived",
        }),
      );
      expect(report?.entries.filter((entry) => entry.action === "deleted")).toEqual([]);
    },
  );

  test("an archived agent that is running again keeps the workspace", async () => {
    const live: DoneJanitorAgentSummary[] = [];
    const h = harness({
      config: ON,
      stored: [record({ archivedAt: FOUR_DAYS_AGO })],
      live,
      whileMeasuring: () => {
        live.push(liveSummary({ lifecycle: "running", busy: true, lastActivityAt: JUST_NOW }));
      },
    });

    const report = await h.janitor.tick();

    expect(h.reclaimed).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-workspace",
        reason: "planned for deletion, but since then agent agent-1 in it is running",
      }),
    );
  });

  test("a terminal opened between the plan and the reclaim keeps the workspace", async () => {
    let terminals = 0;
    const h = harness({
      config: ON,
      stored: [record({ archivedAt: FOUR_DAYS_AGO })],
      countTerminals: () => terminals,
      whileMeasuring: () => {
        terminals = 1;
      },
    });

    const report = await h.janitor.tick();

    expect(h.reclaimed).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-workspace",
        workspaceId: "ws-1",
        reason: "planned for deletion, but since then it has 1 open terminal(s)",
      }),
    );
  });

  test("a script started between the plan and the reclaim keeps the workspace", async () => {
    let scripts = 0;
    const h = harness({
      config: DEAD_ON,
      countRunningScripts: () => scripts,
      whileMeasuring: () => {
        scripts = 1;
      },
    });

    const report = await h.janitor.tick();

    expect(h.archived).toEqual(["agent-1"]);
    expect(h.reclaimed).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-workspace",
        reason: "planned for deletion, but since then 1 script(s) run in it",
      }),
    );
  });

  test("activity newer than the plan keeps the workspace", async () => {
    const h = harness({
      config: ON,
      stored: [record({ archivedAt: FOUR_DAYS_AGO })],
      whileMeasuring: (state) => {
        state.stored[0] = { ...state.stored[0], lastActivityAt: JUST_NOW };
      },
    });

    const report = await h.janitor.tick();

    expect(h.reclaimed).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-workspace",
        reason: "planned for deletion, but since then agent agent-1 in it was active",
      }),
    );
  });

  test("an agent that starts inside the archive, after the janitor's last look, stops it before anything is touched", async () => {
    const live: DoneJanitorAgentSummary[] = [];
    const h = harness({
      config: ON,
      stored: [record({ archivedAt: FOUR_DAYS_AGO })],
      live,
      duringReclaim: (stage, state) => {
        if (stage === "archive") startAgent(state, live);
      },
    });

    const report = await h.janitor.tick();

    expect(h.reclaimed).toEqual([]);
    expect(h.stored.find((agent) => agent.id === "late")?.archivedAt).toBeFalsy();
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-workspace",
        workspaceId: "ws-1",
        reason: "planned for deletion, but since then agent late in it is not archived",
      }),
    );
  });

  test("an agent that starts in the directory after the archive took the records keeps the directory", async () => {
    const live: DoneJanitorAgentSummary[] = [];
    const h = harness({
      config: ON,
      stored: [record({ archivedAt: FOUR_DAYS_AGO })],
      live,
      duringReclaim: (stage, state) => {
        if (stage === "delete") startAgent(state, live, { workspaceId: "ws-new" });
      },
    });

    const report = await h.janitor.tick();

    expect(h.stored.find((agent) => agent.id === "late")?.archivedAt).toBeFalsy();
    expect(report?.entries.filter((entry) => entry.action === "deleted")).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-workspace",
        workspaceId: "ws-1",
        reason: "archived the workspace, but kept its directory: agent late runs inside it",
      }),
    );
  });

  test("a kept workspace is logged once while its reason holds, not every sweep", async () => {
    const lines: { workspaceId?: string }[] = [];
    const logger = pino(
      { level: "info" },
      { write: (line: string) => lines.push(JSON.parse(line) as { workspaceId?: string }) },
    );
    const h = harness({
      config: ON,
      stored: [record({ archivedAt: FOUR_DAYS_AGO })],
      safety: { safe: false, reason: "it has 2 uncommitted or untracked file(s)" },
      logger,
    });

    await h.janitor.tick();
    await h.janitor.tick();

    expect(lines.filter((line) => line.workspaceId === "ws-1")).toHaveLength(1);
  });
});

/** An agent on the fake provider, idle after one finished turn, with its finishes recorded. */
async function askFixture() {
  const logger = pino({ level: "silent" });
  const workdir = mkdtempSync(join(tmpdir(), "done-janitor-ask-"));
  const agentStorage = new AgentStorage(join(workdir, "agents"), logger);
  const attentionReasons: string[] = [];
  const finishedTurns: string[] = [];
  const agentManager = new AgentManager({
    clients: { claude: createTestAgentClient("claude") },
    registry: agentStorage,
    logger,
    onAgentAttention: ({ reason }) => attentionReasons.push(reason),
    onAgentTurnFinished: ({ agentId }) => finishedTurns.push(agentId),
  });
  const agent = await agentManager.createAgent(
    { provider: "claude", cwd: workdir, title: "Asked" },
    undefined,
    { workspaceId: undefined },
  );
  await agentManager.runAgent(agent.id, "say 'state saved'");
  await agentManager.flush();
  await agentManager.clearAgentAttention(agent.id);
  attentionReasons.length = 0;
  finishedTurns.length = 0;
  return { logger, agentStorage, agentManager, agentId: agent.id, attentionReasons, finishedTurns };
}

async function drain(stream: AsyncGenerator<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("askAgentWhetherDone against a real AgentManager", () => {
  test("never joins a turn someone else started, and leaves it running", async () => {
    const f = await askFixture();
    // Someone else's turn, held on a permission until they answer it.
    const theirs = drain(f.agentManager.streamAgent(f.agentId, "rm -f permission.txt"));
    const waiting = await f.agentManager.waitForAgentEvent(f.agentId, { waitForActive: true });
    if (!waiting.permission) throw new Error("expected their turn to wait on a permission");

    const result = await askAgentWhetherDone(
      { agentManager: f.agentManager, agentStorage: f.agentStorage, logger: f.logger },
      { agentId: f.agentId, prompt: "Are you finished?", timeoutMs: 30_000 },
    );

    expect(result).toEqual({ kind: "busy" });
    expect(f.agentManager.getPendingPermissions(f.agentId)).toHaveLength(1);
    await f.agentManager.respondToPermission(f.agentId, waiting.permission.id, {
      behavior: "allow",
    });
    const types = (await theirs).map((event) => event.type);
    expect(types).toContain("turn_completed");
    expect(types).not.toContain("turn_canceled");
    await f.agentManager.flush();
    // The question never started, so nothing silenced the end of theirs.
    expect(f.finishedTurns).toEqual([f.agentId]);
  });

  test.each([
    { ending: "a permission", prompt: "rm -f permission.txt", timeoutMs: 30_000 },
    { ending: "a timeout", prompt: "hold the turn open", timeoutMs: 200 },
  ])(
    "cancels its own question's turn on $ending, quietly, and the next finish still flags",
    async ({ ending, prompt, timeoutMs }) => {
      const f = await askFixture();

      const result = await askAgentWhetherDone(
        { agentManager: f.agentManager, agentStorage: f.agentStorage, logger: f.logger },
        { agentId: f.agentId, prompt, timeoutMs },
      );
      await f.agentManager.flush();

      expect(result).toEqual({ kind: ending === "a permission" ? "permission" : "timeout" });
      expect(f.agentManager.getAgent(f.agentId)?.lifecycle).toBe("idle");
      expect(f.agentManager.getPendingPermissions(f.agentId)).toEqual([]);
      // The question's end is not the agent finishing. (A permission request still flags as one.)
      expect(f.finishedTurns).toEqual([]);
      expect(f.attentionReasons).not.toContain("finished");

      await f.agentManager.runAgent(f.agentId, "say hello");
      await f.agentManager.flush();
      expect(f.finishedTurns).toEqual([f.agentId]);
    },
  );

  test("reads the answer from the question's own turn and raises no finish", async () => {
    const logger = pino({ level: "silent" });
    const workdir = mkdtempSync(join(tmpdir(), "done-janitor-ask-"));
    const agentStorage = new AgentStorage(join(workdir, "agents"), logger);
    const attentionReasons: string[] = [];
    const agentManager = new AgentManager({
      clients: { claude: createTestAgentClient("claude") },
      registry: agentStorage,
      logger,
      onAgentAttention: ({ reason }) => attentionReasons.push(reason),
    });
    const agent = await agentManager.createAgent(
      { provider: "claude", cwd: workdir, title: "Asked" },
      undefined,
      { workspaceId: undefined },
    );
    await agentManager.runAgent(agent.id, "say 'state saved'");
    await agentManager.clearAgentAttention(agent.id);
    attentionReasons.length = 0;

    const result = await askAgentWhetherDone(
      { agentManager, agentStorage, logger },
      { agentId: agent.id, prompt: "Are you finished?", timeoutMs: 30_000 },
    );
    await agentManager.flush();

    // The fake provider answers anything it does not recognise with "Hello world" — an
    // ambiguous reply, which is exactly what must never read as DONE.
    expect(result).toEqual({ kind: "answered", reply: "Hello world", usedTools: false });
    expect(attentionReasons).toEqual([]);
    expect((await agentStorage.get(agent.id))?.requiresAttention).toBeFalsy();
  });
});

describe("readProviderHealth", () => {
  const base = {
    provider: "claude-b",
    isAvailable: async () => true,
    listUsage: async () => [],
    lastErrorsByProvider: new Map<string, (string | undefined)[]>(),
  };

  test("a healthy account is askable", async () => {
    expect(await readProviderHealth(base)).toEqual({ askable: true });
  });

  test("a capped usage window is not", async () => {
    const result = await readProviderHealth({
      ...base,
      listUsage: async () => [
        {
          providerId: "claude-b",
          displayName: "B",
          status: "available" as const,
          planLabel: null,
          windows: [{ id: "5h", label: "5h", usedPct: 100 }],
        },
      ],
    });
    expect(result).toEqual({ askable: false, reason: "account claude-b is at its usage cap" });
  });

  test("a spend-limit error on any agent of the account is not", async () => {
    const result = await readProviderHealth({
      ...base,
      lastErrorsByProvider: new Map([["claude-b", ["You've hit your monthly spend limit"]]]),
    });
    expect(result.askable).toBe(false);
  });

  test("an unavailable provider is not", async () => {
    const result = await readProviderHealth({ ...base, isAvailable: async () => false });
    expect(result).toEqual({ askable: false, reason: "provider claude-b is unavailable" });
  });
});

function liveSummary(overrides: Partial<DoneJanitorAgentSummary>): DoneJanitorAgentSummary {
  return {
    id: "agent-1",
    provider: "claude",
    cwd: "/home/t/.paseo/worktrees/h/feature",
    workspaceId: "ws-1",
    internal: false,
    lifecycle: "idle",
    busy: false,
    pendingPermissionCount: 0,
    requiresAttention: false,
    attentionReason: null,
    hasAlert: false,
    runningProviderSubagentCount: 0,
    lastActivityAt: FOUR_DAYS_AGO,
    labels: {},
    title: "Build the feature",
    sessionId: "session-1",
    ...overrides,
  };
}

describe("AgentDoneJanitor empty projects", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "done-janitor-projects-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Nothing but projects: no agents, so the other passes have nothing to do.
  const ON_PROJECTS: DoneJanitorConfig = { enabled: true, ...SWEEP_OFF };
  const TWO_HOURS_AGO = new Date(NOW - 2 * HOUR).toISOString();

  /** A project whose root was never created: the shape of a deleted worktree's leftover. */
  function project(id: string, overrides: Partial<DoneJanitorProject> = {}): DoneJanitorProject {
    return {
      projectId: id,
      rootPath: join(dir, id),
      projectKey: null,
      createdAt: FOUR_DAYS_AGO,
      updatedAt: FOUR_DAYS_AGO,
      archivedAt: null,
      ...overrides,
    };
  }

  function projectsHarness(input: Parameters<typeof harness>[0]): Harness {
    return harness({ stored: [], workspaces: [], config: ON_PROJECTS, ...input });
  }

  test("a project with no workspaces and a missing root is removed, and the report says why", async () => {
    const h = projectsHarness({ projects: [project("wt4-gone")] });

    const report = await h.janitor.tick();

    expect(h.removedProjects).toEqual(["wt4-gone"]);
    expect(report?.removedProjectCount).toBe(1);
    expect(report?.entries).toEqual([
      expect.objectContaining({
        action: "removed-project",
        projectId: "wt4-gone",
        path: join(dir, "wt4-gone"),
        reason: "it has no workspaces and its directory no longer exists",
      }),
    ]);
  });

  test("several empty projects go in one sweep, with one push at record level", async () => {
    const h = projectsHarness({
      projects: [project("a"), project("b"), project("c")],
    });

    const report = await h.janitor.tick();

    expect(h.removedProjects).toEqual(["a", "b", "c"]);
    expect(report?.removedProjectCount).toBe(3);
    expect(h.pushes).toEqual([
      expect.objectContaining({
        title: "Cleaned up finished work",
        body: "Removed 3 empty projects.",
      }),
    ]);
    expect(h.levels).toEqual(["record"]);
  });

  test("the summary line carries the project count beside agents and worktrees", async () => {
    const h = harness({
      config: ON,
      projects: [project("a"), project("b")],
    });

    await h.janitor.tick();

    expect(h.pushes).toEqual([
      expect.objectContaining({
        body: "Archived 1 finished agent, deleted 1 worktree, freeing 3.0 GB and removed 2 empty projects.",
      }),
    ]);
  });

  test("a project that still has an archived workspace is kept", async () => {
    const h = projectsHarness({
      projects: [project("p1")],
      workspaces: [workspace({ projectId: "p1", archivedAt: FOUR_DAYS_AGO })],
    });

    const report = await h.janitor.tick();

    expect(h.removedProjects).toEqual([]);
    expect(report?.removedProjectCount).toBe(0);
    expect(h.pushes).toEqual([]);
  });

  test("a project whose root still exists is kept", async () => {
    mkdirSync(join(dir, "alive"));
    const h = projectsHarness({ projects: [project("alive")] });

    await h.janitor.tick();

    expect(h.removedProjects).toEqual([]);
  });

  test("a remote-keyed project is kept and its root is never checked", async () => {
    const h = projectsHarness({
      projects: [
        project("remote:github.com/acme/app", { projectKey: "remote:github.com/acme/app" }),
        project("prj_1", { projectKey: "remote:github.com/acme/other#subdir:web" }),
        project("remote:github.com/acme/legacy", { projectKey: null }),
      ],
      onProbeRoot: () => {
        throw new Error("a remote project's root must not be probed");
      },
    });

    await h.janitor.tick();

    expect(h.removedProjects).toEqual([]);
  });

  test("a root that fails to stat for any reason but ENOENT is kept", async () => {
    // ENOTDIR: a parent is a file.
    writeFileSync(join(dir, "a-file"), "x");
    const h = projectsHarness({
      projects: [project("under-a-file", { rootPath: join(dir, "a-file", "child") })],
    });

    await h.janitor.tick();

    expect(h.removedProjects).toEqual([]);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an unreadable parent (EACCES) keeps the project",
    async () => {
      const locked = join(dir, "locked");
      mkdirSync(join(locked, "child"), { recursive: true });
      chmodSync(locked, 0o000);
      try {
        const h = projectsHarness({
          projects: [project("locked-child", { rootPath: join(locked, "child") })],
        });

        await h.janitor.tick();

        expect(h.removedProjects).toEqual([]);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );

  test("a project made in the last hour is kept", async () => {
    const tenMinutesAgo = new Date(NOW - 10 * 60_000).toISOString();
    const h = projectsHarness({
      projects: [
        project("just-created", { createdAt: tenMinutesAgo, updatedAt: tenMinutesAgo }),
        project("just-touched", { updatedAt: tenMinutesAgo }),
        project("bad-clock", { createdAt: "not a date" }),
        project("two-hours-old", { createdAt: TWO_HOURS_AGO, updatedAt: TWO_HOURS_AGO }),
      ],
    });

    await h.janitor.tick();

    expect(h.removedProjects).toEqual(["two-hours-old"]);
  });

  test("an archived project is not on the sidebar and is left alone", async () => {
    const h = projectsHarness({ projects: [project("shelved", { archivedAt: FOUR_DAYS_AGO })] });

    await h.janitor.tick();

    expect(h.removedProjects).toEqual([]);
  });

  test("a workspace that appears between the sweep's read and the removal spares the project", async () => {
    const h = projectsHarness({
      projects: [project("p1"), project("p2")],
      // Call 1 is the sweep's read; call 2 is the fresh read before p1's removal.
      onListProjects: (call, { workspaces }) => {
        if (call === 2) {
          workspaces.push(workspace({ workspaceId: "ws-new", projectId: "p1", kind: "directory" }));
        }
      },
    });

    const report = await h.janitor.tick();

    expect(h.removedProjects).toEqual(["p2"]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-project",
        projectId: "p1",
        reason: "it was empty and its directory was gone, but then it gained a workspace",
      }),
    );
  });

  test("a root that reappears between the sweep's read and the removal spares the project", async () => {
    const h = projectsHarness({
      projects: [project("p1")],
      // Probe 1 is the sweep's; probe 2 is the fresh one before the removal.
      onProbeRoot: (call) => {
        if (call === 2) mkdirSync(join(dir, "p1"));
      },
    });

    const report = await h.janitor.tick();

    expect(h.removedProjects).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-project",
        projectId: "p1",
        reason: "it was empty and its directory was gone, but then its directory exists",
      }),
    );
  });

  test("a project someone else removed in the meantime is skipped without a line", async () => {
    const h = projectsHarness({
      projects: [project("p1"), project("p2")],
      onListProjects: (call, { projects }) => {
        if (call === 2) projects.splice(0, 1);
      },
    });

    const report = await h.janitor.tick();

    expect(h.removedProjects).toEqual(["p2"]);
    expect(report?.entries.map((entry) => entry.projectId)).toEqual(["p2"]);
  });

  test("a root on a mounted volume is judged like any other", async () => {
    const volume = join(dir, "Volumes", "disk");
    mkdirSync(volume, { recursive: true });
    const h = projectsHarness({
      projects: [project("on-disk", { rootPath: join(volume, "wt4-gone") })],
      volumeRootOf: () => volume,
    });

    await h.janitor.tick();

    expect(h.removedProjects).toEqual(["on-disk"]);
  });

  test("a root whose volume is not mounted is kept, and the report says so", async () => {
    const volume = join(dir, "Volumes", "unplugged");
    const rootPath = join(volume, "wt4-gone");
    const h = projectsHarness({
      projects: [project("on-usb", { rootPath })],
      volumeRootOf: () => volume,
    });

    const report = await h.janitor.tick();

    expect(h.removedProjects).toEqual([]);
    expect(report?.removedProjectCount).toBe(0);
    expect(report?.entries).toEqual([
      expect.objectContaining({
        action: "kept-project",
        projectId: "on-usb",
        path: rootPath,
        reason: `its volume ${volume} is not mounted, so its directory may still exist on it`,
      }),
    ]);
    expect(h.pushes).toEqual([]);
  });

  test("a volume that unmounts between the sweep's read and the removal spares the project", async () => {
    const volume = join(dir, "Volumes", "flaky");
    mkdirSync(volume, { recursive: true });
    const h = projectsHarness({
      projects: [project("on-flaky", { rootPath: join(volume, "wt4-gone") })],
      volumeRootOf: () => volume,
      // Probe 1 is the sweep's; the volume goes away before the fresh probe 2.
      onProbeRoot: (call) => {
        if (call === 2) rmSync(volume, { recursive: true });
      },
    });

    const report = await h.janitor.tick();

    expect(h.removedProjects).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-project",
        reason: `it was empty and its directory was gone, but then its volume ${volume} is not mounted`,
      }),
    );
  });

  test("a dry run reports an unmounted volume as kept, not as a removal", async () => {
    const volume = join(dir, "Volumes", "unplugged");
    const h = projectsHarness({
      projects: [project("on-usb", { rootPath: join(volume, "x") })],
      volumeRootOf: () => volume,
      config: { ...ON_PROJECTS, dryRun: true },
    });

    const report = await h.janitor.tick();

    expect(report?.entries.map((entry) => entry.action)).toEqual(["kept-project"]);
  });

  test("a failed removal is reported and does not stop the rest", async () => {
    const h = projectsHarness({
      projects: [project("bad"), project("good")],
      removeProject: (projectId) => {
        if (projectId === "bad") throw new Error("disk full");
      },
    });

    const report = await h.janitor.tick();

    expect(h.removedProjects).toEqual(["good"]);
    expect(report?.removedProjectCount).toBe(1);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-project",
        projectId: "bad",
        reason: "removal failed: disk full",
      }),
    );
  });

  test("a dry run removes nothing and reports would-remove-project, with no push", async () => {
    const h = projectsHarness({
      projects: [project("wt4-gone"), project("alive-here")],
      config: { ...ON_PROJECTS, dryRun: true },
    });
    mkdirSync(join(dir, "alive-here"));

    const report = await h.janitor.tick();

    expect(h.removedProjects).toEqual([]);
    expect(report?.removedProjectCount).toBe(0);
    expect(report?.entries).toEqual([
      expect.objectContaining({
        action: "would-remove-project",
        projectId: "wt4-gone",
        path: join(dir, "wt4-gone"),
        reason: "it has no workspaces and its directory no longer exists",
      }),
    ]);
    expect(h.pushes).toEqual([]);
  });

  test("removals do not spend the archive budget", async () => {
    const h = projectsHarness({
      projects: [project("a"), project("b"), project("c"), project("d")],
      config: { ...ON_PROJECTS, maxArchivesPerSweep: 1, maxDeadArchivesPerSweep: 1 },
    });

    await h.janitor.tick();

    expect(h.removedProjects).toEqual(["a", "b", "c", "d"]);
  });

  test("one sweep removes at most 50, and the rest wait for the next", async () => {
    const projects = Array.from({ length: 55 }, (_, index) => project(`p${index}`));
    const h = projectsHarness({ projects });

    const first = await h.janitor.tick();
    expect(h.removedProjects).toHaveLength(50);
    expect(first?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-project",
        reason: "5 more empty projects wait for the next sweep",
      }),
    );

    const second = await h.janitor.tick();
    expect(h.removedProjects).toHaveLength(55);
    expect(second?.removedProjectCount).toBe(5);
  });

  test("a project pass runs even when the janitor has no agents to look at", async () => {
    const h = projectsHarness({
      projects: [project("wt4-gone")],
      config: {
        enabled: true,
        archiveDead: false,
        askFinished: false,
        reclaimWorkspaces: false,
        ...SWEEP_OFF,
      },
    });

    await h.janitor.tick();

    expect(h.removedProjects).toEqual(["wt4-gone"]);
  });

  test("a disabled janitor removes nothing", async () => {
    const h = projectsHarness({
      projects: [project("wt4-gone")],
      config: { enabled: false },
    });

    expect(await h.janitor.tick()).toBeNull();
    expect(h.removedProjects).toEqual([]);
  });
});

describe("probeProjectRoot", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "done-janitor-probe-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("an existing directory exists", async () => {
    expect(await probeProjectRoot(dir)).toEqual({ kind: "exists" });
  });

  test("an existing file exists too: the janitor only asks whether the path is gone", async () => {
    writeFileSync(join(dir, "f"), "x");
    expect(await probeProjectRoot(join(dir, "f"))).toEqual({ kind: "exists" });
  });

  test("ENOENT is missing", async () => {
    expect(await probeProjectRoot(join(dir, "nope"))).toEqual({ kind: "missing" });
  });

  test("ENOTDIR is unknown, not missing", async () => {
    writeFileSync(join(dir, "f"), "x");
    expect(await probeProjectRoot(join(dir, "f", "child"))).toEqual({
      kind: "unknown",
      error: expect.stringContaining("ENOTDIR"),
    });
  });

  test("a missing root under a volume that is not there is the volume's absence, not the project's", async () => {
    const volume = `/Volumes/paseo-test-${process.pid}-${Date.now()}`;
    expect(await probeProjectRoot(`${volume}/work/app`)).toEqual({
      kind: "volume-absent",
      volumeRoot: volume,
    });
  });
});

describe("volumeRootOf", () => {
  test.each([
    ["/Volumes/Backup/work/app", "/Volumes/Backup"],
    ["/Volumes/Backup", "/Volumes/Backup"],
    ["/media/tyler/usb/work/app", "/media/tyler/usb"],
    ["/mnt/data/work/app", "/mnt/data"],
    ["D:\\work\\app", "D:\\"],
    ["d:/work/app", "d:\\"],
    ["C:\\Users\\t\\app", "C:\\"],
  ])("%s sits on the volume %s", (rootPath, expected) => {
    expect(volumeRootOf(rootPath)).toBe(expected);
  });

  test.each([
    "/Users/tyler/work/app",
    "/home/tyler/work/app",
    "/tmp/app",
    "/Volumes",
    "/media/tyler",
    "/mnt",
    "/mnt-not/x",
    "relative/Volumes/x/y",
    "",
  ])("%s is on the system volume", (rootPath) => {
    expect(volumeRootOf(rootPath)).toBeNull();
  });
});

function projectIdsReported(
  report: Awaited<ReturnType<AgentDoneJanitor["tick"]>>,
  action: DoneJanitorReportEntry["action"],
): string[] {
  const entries = report?.entries ?? [];
  return entries
    .flatMap((entry) => (entry.action === action && entry.projectId ? [entry.projectId] : []))
    .sort();
}

describe("AgentDoneJanitor idle-workspace sweep", () => {
  // Only the sweep: nothing is asked, nothing dead is archived, so each test sees the sweep alone.
  const SWEEP: DoneJanitorConfig = {
    enabled: true,
    archiveDead: false,
    askFinished: false,
    workspaceSweep: { dryRun: false },
  };
  const OLD_SIGNALS: WorkspaceActivitySignals = {
    headCommitMs: NOW - 120 * HOUR,
    directoryMtimeMs: NOW - 120 * HOUR,
  };
  const EXTERNAL = "/home/t/mobile-worktrees/feature";

  function external(overrides: Partial<DoneJanitorWorkspace> = {}): DoneJanitorWorkspace {
    return workspace({
      cwd: EXTERNAL,
      worktreeRoot: EXTERNAL,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: "/home/t/mobile",
      ...overrides,
    });
  }

  function sweepHarness(input: Parameters<typeof harness>[0] = {}): Harness {
    return harness({
      config: SWEEP,
      stored: [record({ cwd: EXTERNAL })],
      workspaces: [external()],
      signals: () => OLD_SIGNALS,
      ...input,
    });
  }

  const snapshotted = (cwd: string): WorktreeSnapshotResult => ({
    kind: "snapshotted",
    worktreePath: cwd,
    ref: "refs/backup/2026-09-21/feature",
    commit: "abc",
    dirtyFiles: 1,
    unpushedCommits: 0,
    skippedFiles: [],
    offsite: { kind: "bundled", path: "/b/feature.bundle" },
  });

  test("an idle external worktree is archived, record only: its directory stays", async () => {
    const h = sweepHarness();

    const report = await h.janitor.tick();

    expect(h.archivedWorkspaces).toEqual(["ws-1"]);
    // The archive that keeps the directory: record only cannot delete anything.
    expect(h.events).toEqual(["archive-record:ws-1"]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "archived-workspace",
        workspaceId: "ws-1",
        path: EXTERNAL,
        reason: "idle past 3d; record only, its directory stays",
        rule: "idle",
        idleFor: "4d",
      }),
    );
    expect(h.pushes).toEqual([expect.objectContaining({ body: "Archived 1 idle workspace." })]);
  });

  test("an external worktree with uncommitted work is archived record only, without a git gate", async () => {
    const h = sweepHarness({
      checkWorktree: () => {
        throw new Error("an external worktree never goes through the deletion gate");
      },
    });

    await h.janitor.tick();

    expect(h.archivedWorkspaces).toEqual(["ws-1"]);
  });

  test("a workspace used recently is left alone and not reported", async () => {
    const h = sweepHarness({
      signals: () => ({ ...OLD_SIGNALS, headCommitMs: NOW - 5 * HOUR }),
    });

    const report = await h.janitor.tick();

    expect(h.archivedWorkspaces).toEqual([]);
    expect(report?.entries).toEqual([]);
  });

  test("a running agent keeps its workspace", async () => {
    const h = sweepHarness({ live: [liveSummary({ cwd: EXTERNAL, lifecycle: "running" })] });

    await h.janitor.tick();

    expect(h.archivedWorkspaces).toEqual([]);
  });

  test("a pinned workspace is kept", async () => {
    const h = sweepHarness({ workspaces: [external({ pinnedAt: FOUR_DAYS_AGO })] });

    await h.janitor.tick();

    expect(h.archivedWorkspaces).toEqual([]);
  });

  test("a running script keeps its workspace", async () => {
    const h = sweepHarness({ runningScripts: 1 });

    await h.janitor.tick();

    expect(h.archivedWorkspaces).toEqual([]);
  });

  test("an agent that starts between the sweep's read and the archive keeps the workspace", async () => {
    const h = sweepHarness({
      onListStored: (call, stored) => {
        // The sweep's own read is the second; everything after it sees the agent at work.
        if (call >= 3) stored[0] = { ...stored[0], lastStatus: "running" };
      },
    });

    const report = await h.janitor.tick();

    expect(h.archivedWorkspaces).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "kept-idle-workspace",
        workspaceId: "ws-1",
        reason: "it was idle, but then agent agent-1 is running",
      }),
    );
  });

  describe("agents archived this sweep", () => {
    const FIVE_DAYS_AGO = new Date(NOW - 120 * HOUR).toISOString();
    const DIRTY: WorktreeDeletionSafety = {
      safe: false,
      reason: "it has 1 uncommitted or untracked file(s)",
      atRisk: "dirty",
    };

    test("the dead pass archives a 24h-quiet agent; its dirty worktree is not deleted in the same sweep", async () => {
      const h = sweepHarness({
        config: {
          enabled: true,
          askFinished: false,
          deadQuietHours: 24,
          workspaceSweep: { dryRun: false },
        },
        stored: [record({ updatedAt: new Date(NOW - 25 * HOUR).toISOString() })],
        workspaces: [workspace({ createdAt: FIVE_DAYS_AGO, updatedAt: FIVE_DAYS_AGO })],
        safety: DIRTY,
        snapshot: snapshotted,
      });

      const report = await h.janitor.tick();

      expect(h.archived).toEqual(["agent-1"]);
      expect(h.archivedWorkspaces).toEqual([]);
      expect(report?.entries).not.toContainEqual(expect.objectContaining({ action: "deleted" }));
    });

    test("an agent that answered DONE a minute ago does not take its dirty worktree with it", async () => {
      const h = sweepHarness({
        config: { enabled: true, archiveDead: false, workspaceSweep: { dryRun: false } },
        live: [liveSummary({})],
        stored: [record()],
        workspaces: [workspace({ createdAt: FIVE_DAYS_AGO, updatedAt: FIVE_DAYS_AGO })],
        safety: DIRTY,
        snapshot: snapshotted,
      });

      await h.janitor.tick();

      expect(h.archived).toEqual(["agent-1"]);
      expect(h.archivedWorkspaces).toEqual([]);
    });

    test("a dry run reports the same: the would-be archive keeps the worktree this sweep", async () => {
      const h = sweepHarness({
        config: { enabled: true, askFinished: false, deadQuietHours: 24, dryRun: true },
        stored: [record({ updatedAt: new Date(NOW - 25 * HOUR).toISOString() })],
        workspaces: [workspace({ createdAt: FIVE_DAYS_AGO, updatedAt: FIVE_DAYS_AGO })],
        safety: DIRTY,
      });

      const report = await h.janitor.tick();

      expect(report?.entries).toContainEqual(
        expect.objectContaining({ action: "would-archive", agentId: "agent-1" }),
      );
      expect(report?.entries).not.toContainEqual(
        expect.objectContaining({ action: "would-delete" }),
      );
    });

    test("an agent archived long ago still dates the workspace from its archive", async () => {
      const h = sweepHarness({
        stored: [
          record({
            updatedAt: new Date(NOW - 200 * HOUR).toISOString(),
            archivedAt: new Date(NOW - 30 * HOUR).toISOString(),
          }),
        ],
        workspaces: [workspace({ createdAt: FIVE_DAYS_AGO, updatedAt: FIVE_DAYS_AGO })],
        safety: DIRTY,
        snapshot: snapshotted,
      });

      await h.janitor.tick();

      expect(h.archivedWorkspaces).toEqual([]);
    });
  });

  describe("Paseo-owned worktrees, whose directory the archive deletes", () => {
    test("clean and pushed: snapshotted, archived and its directory deleted", async () => {
      const h = sweepHarness({ stored: [record()], workspaces: [workspace()] });

      const report = await h.janitor.tick();

      expect(h.events).toEqual([
        "snapshot:/home/t/.paseo/worktrees/h/feature",
        "archive-workspace:ws-1",
      ]);
      expect(report?.entries).toContainEqual(
        expect.objectContaining({
          action: "deleted",
          workspaceId: "ws-1",
          bytes: 3 * GB,
          reason: "idle past 3d; clean tree and branch feature is merged or pushed",
          rule: "idle",
          idleFor: "4d",
          invariant: "holds: every file is tracked and pushed",
        }),
      );
      expect(h.pushes[0]?.body).toBe("Deleted 1 worktree, freeing 3.0 GB.");
    });

    test("dirty with no backup: kept, and reported", async () => {
      const h = sweepHarness({
        stored: [record()],
        workspaces: [workspace()],
        safety: {
          safe: false,
          reason: "it has 1 uncommitted or untracked file(s)",
          atRisk: "dirty",
        },
        snapshot: (cwd) => ({ kind: "failed", worktreePath: cwd, error: "disk full" }),
      });

      const report = await h.janitor.tick();

      expect(h.archivedWorkspaces).toEqual([]);
      expect(report?.entries).toContainEqual(
        expect.objectContaining({
          action: "kept-idle-workspace",
          workspaceId: "ws-1",
          reason: "its work is at risk and could not be snapshotted: disk full",
        }),
      );
    });

    test("dirty with ignored files that are not regenerable: kept, before any snapshot", async () => {
      const h = sweepHarness({
        stored: [record()],
        workspaces: [workspace()],
        safety: {
          safe: false,
          reason: "it has 1 uncommitted or untracked file(s)",
          atRisk: "dirty",
        },
        snapshot: snapshotted,
        ignored: () => ["node_modules/", ".env"],
      });

      const report = await h.janitor.tick();

      expect(h.archivedWorkspaces).toEqual([]);
      // The work-at-risk sweep snapshots a kept worktree; this pass does not every 30 minutes.
      expect(h.events).toEqual([]);
      expect(report?.entries).toContainEqual(
        expect.objectContaining({
          action: "kept-idle-workspace",
          reason: "1 ignored path(s) that are not regenerable and no backup holds (.env)",
        }),
      );
    });

    test("dirty with an untracked nested repository: kept", async () => {
      const h = sweepHarness({
        stored: [record()],
        workspaces: [workspace()],
        safety: {
          safe: false,
          reason: "it has 1 uncommitted or untracked file(s)",
          atRisk: "dirty",
        },
        snapshot: snapshotted,
        nestedRepositories: ["vendor/tool/"],
      });

      await h.janitor.tick();

      expect(h.archivedWorkspaces).toEqual([]);
    });

    test("unpushed with a backup of that exact state: archived after the snapshot", async () => {
      const h = sweepHarness({
        stored: [record()],
        workspaces: [workspace()],
        safety: {
          safe: false,
          reason: "feature has 2 commit(s) neither merged into main nor pushed to any remote",
          atRisk: "unpushed",
        },
        snapshot: snapshotted,
        coverage: (_path, commit) =>
          coverage({
            commit: commit ?? "head",
            ignored: ["node_modules/", "ios/Pods/"],
            manifestDirectories: ["ios"],
          }),
      });

      const report = await h.janitor.tick();

      expect(h.events).toEqual([
        "snapshot:/home/t/.paseo/worktrees/h/feature",
        "archive-workspace:ws-1",
      ]);
      expect(report?.entries).toContainEqual(
        expect.objectContaining({
          action: "deleted",
          reason:
            "idle past 3d; feature has 2 commit(s) neither merged into main nor pushed to any remote",
          invariant:
            "holds: every file is in the verified snapshot; ignored only regenerable (node_modules/, ios/Pods/); backed up at refs/backup/2026-09-21/feature, bundled at /b/feature.bundle",
        }),
      );
    });

    test("refused by the gate for anything but saveable work: kept, nothing snapshotted", async () => {
      const h = sweepHarness({
        stored: [record()],
        workspaces: [workspace()],
        safety: { safe: false, reason: "it is locked with git worktree lock" },
      });

      const report = await h.janitor.tick();

      expect(h.events).toEqual([]);
      expect(report?.entries).toContainEqual(
        expect.objectContaining({
          action: "kept-idle-workspace",
          reason: "it is locked with git worktree lock",
        }),
      );
    });

    test("with reclamation off, nothing whose archive deletes a directory is touched", async () => {
      const h = sweepHarness({
        config: { ...SWEEP, reclaimWorkspaces: false },
        stored: [record()],
        workspaces: [workspace()],
      });

      await h.janitor.tick();

      expect(h.archivedWorkspaces).toEqual([]);
    });

    test("a worktree whose directory is gone is archived, record only", async () => {
      const h = sweepHarness({
        stored: [record()],
        workspaces: [workspace()],
        safety: { safe: false, reason: "the directory does not exist", gone: true },
      });

      const report = await h.janitor.tick();

      expect(h.archivedWorkspaces).toEqual(["ws-1"]);
      // Through the archive that keeps the directory, so a directory back by then stays.
      expect(h.events).toEqual(["archive-record:ws-1"]);
      expect(report?.entries).toContainEqual(
        expect.objectContaining({
          action: "archived-workspace",
          reason: "idle past 3d; its directory is gone",
        }),
      );
    });
  });

  describe("an older record without the ownership flag, whose cwd is a missing subdirectory", () => {
    // Archive-by-scope deletes the worktree root above the cwd (workspace-archive-service.ts,
    // COMPAT(archiveMissingWorkspacePlacement)): the root is what every check must read.
    const ROOT = "/home/t/.paseo/worktrees/h1/slug";
    const CWD = `${ROOT}/packages/app`;
    const GONE: WorktreeDeletionSafety = {
      safe: false,
      reason: "the directory does not exist",
      gone: true,
    };
    const legacy = (): DoneJanitorWorkspace =>
      workspace({
        cwd: CWD,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      });
    const legacyHarness = (input: Parameters<typeof harness>[0] = {}) => {
      const checked: string[] = [];
      const h = sweepHarness({
        stored: [record({ cwd: CWD })],
        workspaces: [legacy()],
        checkWorktree: (path) => {
          checked.push(path);
          return path === ROOT
            ? {
                safe: false,
                reason: "it has 1 uncommitted or untracked file(s)",
                atRisk: "dirty",
              }
            : GONE;
        },
        ...input,
      });
      return { h, checked };
    };

    test("the dry run checks the root and names it: a would-delete, never 'record only'", async () => {
      const { h, checked } = legacyHarness({
        config: { ...SWEEP, workspaceSweep: {} },
        coverage: (_path, commit) =>
          coverage({ commit: commit ?? "head", untracked: ["src/only-copy.txt"] }),
      });

      const report = await h.janitor.tick();

      expect(checked).toEqual([ROOT]);
      expect(report?.entries).toEqual([
        expect.objectContaining({
          action: "would-delete",
          workspaceId: "ws-1",
          path: ROOT,
          reason: "idle past 3d; it has 1 uncommitted or untracked file(s)",
          invariant: "holds once a verified snapshot backs up 1 changed or untracked file(s)",
          dryRun: true,
        }),
      ]);
    });

    test("a root holding files nothing backs up is kept, and the line names the root", async () => {
      const { h, checked } = legacyHarness({ ignored: () => ["src/only-copy.env"] });

      const report = await h.janitor.tick();

      expect(checked).toEqual([ROOT]);
      expect(h.archivedWorkspaces).toEqual([]);
      expect(h.events).toEqual([]);
      expect(report?.entries).toContainEqual(
        expect.objectContaining({
          action: "kept-idle-workspace",
          path: ROOT,
          reason:
            "1 ignored path(s) that are not regenerable and no backup holds (src/only-copy.env)",
        }),
      );
    });

    test("a live run snapshots and verifies the root before archive-by-scope deletes it", async () => {
      const { h } = legacyHarness({
        snapshot: snapshotted,
        coverage: (_path, commit) =>
          coverage({
            commit: commit ?? "head",
            untracked: commit === null ? ["src/only-copy.txt"] : [],
          }),
      });

      const report = await h.janitor.tick();

      expect(h.events).toEqual([`snapshot:${ROOT}`, "archive-workspace:ws-1"]);
      expect(h.expectedDirectories).toEqual([ROOT]);
      expect(report?.entries).toContainEqual(
        expect.objectContaining({ action: "deleted", path: ROOT }),
      );
    });

    test("with the root gone too, only the record goes, and the line names the root", async () => {
      const { h, checked } = legacyHarness({ checkWorktree: () => GONE });

      const report = await h.janitor.tick();

      expect(checked).toEqual([]);
      expect(h.events).toEqual(["archive-record:ws-1"]);
      expect(report?.entries).toContainEqual(
        expect.objectContaining({
          action: "archived-workspace",
          path: ROOT,
          reason: "idle past 3d; its directory is gone",
        }),
      );
    });

    test("a record that changes its directory between the plan and the archive is kept", async () => {
      let resolutions = 0;
      const { h } = legacyHarness({
        snapshot: snapshotted,
        resolveArchiveDirectory: () => {
          resolutions += 1;
          return resolutions === 1 ? ROOT : "/home/t/.paseo/worktrees/h1/other";
        },
      });

      const report = await h.janitor.tick();

      expect(h.events).toEqual([]);
      expect(report?.entries).toContainEqual(
        expect.objectContaining({
          action: "kept-idle-workspace",
          reason: `it was idle, but then the directory its archive deletes changed from ${ROOT} to /home/t/.paseo/worktrees/h1/other`,
        }),
      );
    });
  });
  describe("the deletion invariant", () => {
    const PASEO = "/home/t/.paseo/worktrees/h/feature";
    const DIRTY: WorktreeDeletionSafety = {
      safe: false,
      reason: "it has 1 uncommitted or untracked file(s)",
      atRisk: "dirty",
    };
    const owned = (input: Parameters<typeof harness>[0] = {}) =>
      sweepHarness({ stored: [record()], workspaces: [workspace()], ...input });
    /** Coverage against HEAD shows the dirty file; against the snapshot, `afterSnapshot`. */
    const dirtyCoverage =
      (afterSnapshot: Partial<WorktreeCoverage> = {}) =>
      (_path: string, commit: string | null): WorktreeCoverage =>
        coverage({
          commit: commit ?? "head",
          changed: commit === null ? ["src/app.ts"] : [],
          ignored: ["node_modules/"],
          ...(commit === null ? {} : afterSnapshot),
        });

    test("a clean, pushed worktree holding a non-regenerable ignored file is kept, unsnapshotted", async () => {
      const h = owned({ ignored: () => ["node_modules/", "apps/mobile/ios/.xcode.env.local"] });

      const report = await h.janitor.tick();

      expect(h.archivedWorkspaces).toEqual([]);
      expect(h.events).toEqual([]);
      expect(report?.entries).toContainEqual(
        expect.objectContaining({
          action: "kept-idle-workspace",
          reason:
            "1 ignored path(s) that are not regenerable and no backup holds (apps/mobile/ios/.xcode.env.local)",
        }),
      );
    });

    test("the same holds for the older passes: a dead agent's clean worktree with a .env stays", async () => {
      const h = harness({ config: DEAD_ON, ignored: () => [".env"] });

      await h.janitor.tick();

      expect(h.archived).toEqual(["agent-1"]);
      expect(h.reclaimed).toEqual([]);
    });

    test("a file the snapshot left out keeps the worktree, whatever rule left it out", async () => {
      // The secret filter (1c82709a9) drops such a file without saying so; the read against the
      // snapshot finds it anyway.
      const h = owned({
        safety: DIRTY,
        snapshot: snapshotted,
        coverage: dirtyCoverage({ untracked: ["src/CredentialsForm.kt"] }),
      });

      const report = await h.janitor.tick();

      expect(h.archivedWorkspaces).toEqual([]);
      expect(report?.entries).toContainEqual(
        expect.objectContaining({
          action: "kept-idle-workspace",
          reason:
            "1 file(s) not in the snapshot, changed since or left out (src/CredentialsForm.kt)",
        }),
      );
    });

    test.each([
      [
        "over its size cap",
        { skippedFiles: ["data/big.bin"] },
        "the snapshot left out untracked files: 1 over its size cap (data/big.bin)",
      ],
      [
        "reported as possible secrets",
        { possibleSecrets: [".env.local"] },
        "the snapshot left out untracked files: 1 possible secret(s) (.env.local)",
      ],
    ])("a snapshot that reports files %s keeps the worktree", async (_name, omitted, reason) => {
      const h = owned({
        safety: DIRTY,
        snapshot: (cwd) => ({ ...snapshotted(cwd), ...omitted }) as WorktreeSnapshotResult,
        coverage: dirtyCoverage(),
      });

      const report = await h.janitor.tick();

      expect(h.archivedWorkspaces).toEqual([]);
      expect(report?.entries).toContainEqual(
        expect.objectContaining({ action: "kept-idle-workspace", reason }),
      );
    });

    test("a backup that does not verify keeps the worktree", async () => {
      const h = owned({
        safety: DIRTY,
        snapshot: snapshotted,
        coverage: dirtyCoverage(),
        unverifiedBackup: () => "its bundle /b/feature.bundle fails git bundle verify",
      });

      const report = await h.janitor.tick();

      expect(h.archivedWorkspaces).toEqual([]);
      expect(report?.entries).toContainEqual(
        expect.objectContaining({
          action: "kept-idle-workspace",
          reason:
            "its backup is not verified: its bundle /b/feature.bundle fails git bundle verify",
        }),
      );
    });

    test("a file changed after the snapshot keeps the worktree until a later sweep snapshots it", async () => {
      const h = owned({
        safety: DIRTY,
        snapshot: snapshotted,
        coverage: dirtyCoverage({ changed: ["src/app.ts"] }),
      });

      const report = await h.janitor.tick();

      expect(h.archivedWorkspaces).toEqual([]);
      expect(report?.entries).toContainEqual(
        expect.objectContaining({
          action: "kept-idle-workspace",
          reason: "1 file(s) not in the snapshot, changed since or left out (src/app.ts)",
        }),
      );
    });

    test("a clean tree that changed after it was planned is not deleted on the stale read", async () => {
      let reads = 0;
      const h = owned({
        coverage: (_path, commit) => {
          reads += 1;
          return coverage({ commit: commit ?? "head", changed: reads > 1 ? ["notes.md"] : [] });
        },
      });

      await h.janitor.tick();

      expect(h.archivedWorkspaces).toEqual([]);
    });

    test.each([
      [
        "a process inside it",
        {
          kind: "scanned",
          processes: [{ pid: 42, command: "bun", path: `${PASEO}/Clone` }],
        } as ProcessScan,
        "a process runs inside it: bun (pid 42)",
      ],
      [
        "a process scan that failed",
        { kind: "failed", error: "lsof is not available on Windows" } as ProcessScan,
        "the processes inside it could not be listed: lsof is not available on Windows",
      ],
    ])("%s keeps the worktree, in a dry run too", async (_name, scan, reason) => {
      for (const dryRun of [false, true]) {
        const h = owned({
          config: { ...SWEEP, workspaceSweep: { dryRun } },
          processes: () => scan,
        });

        const report = await h.janitor.tick();

        expect(h.archivedWorkspaces).toEqual([]);
        expect(report?.entries).toContainEqual(
          expect.objectContaining({ action: "kept-idle-workspace", reason }),
        );
      }
    });

    test("a schedule that starts agents in the worktree keeps it", async () => {
      const h = owned({ scheduledCwds: [`${PASEO}/packages/app`, "/home/t/elsewhere"] });

      const report = await h.janitor.tick();

      expect(h.archivedWorkspaces).toEqual([]);
      expect(report?.entries).toContainEqual(
        expect.objectContaining({
          action: "kept-idle-workspace",
          reason: "1 schedule(s) start agents in it",
        }),
      );
    });

    test("a schedule elsewhere keeps nothing", async () => {
      const h = owned({ scheduledCwds: ["/home/t/.paseo/worktrees/h/feature-2"] });

      await h.janitor.tick();

      expect(h.archivedWorkspaces).toEqual(["ws-1"]);
    });
  });

  describe("the dry run lists everything a live run could delete", () => {
    const DIRTY: WorktreeDeletionSafety = {
      safe: false,
      reason: "it has 1 uncommitted or untracked file(s)",
      atRisk: "dirty",
    };
    const dirtyCoverage = (_path: string, commit: string | null): WorktreeCoverage =>
      coverage({
        commit: commit ?? "head",
        changed: commit === null ? ["src/app.ts"] : [],
        ignored: ["node_modules/"],
        unbackedCommits: commit === null ? 2 : 0,
      });

    test("one line per would-delete, with its rule, idle age and invariant", async () => {
      const h = sweepHarness({
        config: { ...SWEEP, workspaceSweep: { dryRun: true } },
        stored: [record()],
        workspaces: [workspace()],
        safety: DIRTY,
        coverage: dirtyCoverage,
      });

      const report = await h.janitor.tick();

      expect(report?.entries).toEqual([
        {
          action: "would-delete",
          workspaceId: "ws-1",
          title: "feature",
          path: "/home/t/.paseo/worktrees/h/feature",
          reason: "idle past 3d; it has 1 uncommitted or untracked file(s)",
          rule: "idle",
          idleFor: "4d",
          invariant:
            "holds once a verified snapshot backs up 1 changed or untracked file(s) and 2 unpushed commit(s); ignored only regenerable (node_modules/)",
          dryRun: true,
        },
      ]);
    });

    test("a live run spends the budget on every attempt, so it never deletes past the dry run", async () => {
      const two = (): DoneJanitorWorkspace[] => [
        workspace(),
        workspace({
          workspaceId: "ws-2",
          cwd: "/home/t/.paseo/worktrees/h/feature-2",
          worktreeRoot: "/home/t/.paseo/worktrees/h/feature-2",
          createdAt: new Date(NOW - 90 * HOUR).toISOString(),
          updatedAt: new Date(NOW - 90 * HOUR).toISOString(),
        }),
      ];
      const common = {
        stored: [],
        safety: DIRTY,
        coverage: dirtyCoverage,
        // The older worktree's snapshot fails: only a live run can find that out.
        snapshot: (cwd: string): WorktreeSnapshotResult =>
          cwd.endsWith("feature")
            ? { kind: "failed", worktreePath: cwd, error: "disk full" }
            : snapshotted(cwd),
      };
      const dry = sweepHarness({
        ...common,
        workspaces: two(),
        config: { ...SWEEP, workspaceSweep: { dryRun: true, maxArchivesPerSweep: 1 } },
      });
      const live = sweepHarness({
        ...common,
        workspaces: two(),
        config: { ...SWEEP, workspaceSweep: { dryRun: false, maxArchivesPerSweep: 1 } },
      });

      const dryReport = await dry.janitor.tick();
      await live.janitor.tick();

      expect(dryReport?.entries).toContainEqual(
        expect.objectContaining({ action: "would-delete", workspaceId: "ws-1" }),
      );
      expect(dryReport?.entries).not.toContainEqual(
        expect.objectContaining({ action: "would-delete", workspaceId: "ws-2" }),
      );
      expect(live.archivedWorkspaces).toEqual([]);
    });

    test("with no workspaceSweep key at all, the sweep only reports", async () => {
      const h = sweepHarness({
        config: { enabled: true, archiveDead: false, askFinished: false },
        stored: [record()],
        workspaces: [workspace()],
      });

      const report = await h.janitor.tick();

      expect(h.archivedWorkspaces).toEqual([]);
      expect(h.events).toEqual([]);
      expect(report?.entries).toContainEqual(
        expect.objectContaining({ action: "would-delete", workspaceId: "ws-1", dryRun: true }),
      );
    });
  });

  test("a self-heal fixer's workspace goes as soon as its fixer finished, however fresh its directory", async () => {
    const home = workspace({
      kind: "directory",
      cwd: "/home/t",
      worktreeRoot: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
      createdAt: new Date(NOW - 2 * HOUR).toISOString(),
      updatedAt: new Date(NOW - 2 * HOUR).toISOString(),
    });
    const h = sweepHarness({
      workspaces: [home],
      stored: [
        record({
          cwd: "/home/t",
          updatedAt: new Date(NOW - HOUR).toISOString(),
          labels: { "paseo.remediation": "disk-falling" },
        }),
      ],
      signals: () => ({ headCommitMs: null, directoryMtimeMs: NOW - 60_000 }),
    });

    const report = await h.janitor.tick();

    expect(h.archivedWorkspaces).toEqual(["ws-1"]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({
        action: "archived-workspace",
        reason:
          "a self-heal fixer's workspace, and every fixer in it is finished; record only, its directory stays",
      }),
    );
  });

  test("a sweep archives at most maxArchivesPerSweep, the longest idle first", async () => {
    const ids = ["a", "b", "c", "d"];
    const h = sweepHarness({
      config: { ...SWEEP, workspaceSweep: { dryRun: false, maxArchivesPerSweep: 2 } },
      stored: [],
      workspaces: ids.map((id, index) =>
        external({
          workspaceId: id,
          cwd: `/home/t/mobile-worktrees/${id}`,
          worktreeRoot: `/home/t/mobile-worktrees/${id}`,
          createdAt: new Date(NOW - (100 + index) * HOUR).toISOString(),
          updatedAt: new Date(NOW - (100 + index) * HOUR).toISOString(),
        }),
      ),
    });

    const report = await h.janitor.tick();

    expect(h.archivedWorkspaces).toEqual(["d", "c"]);
    expect(report?.entries.filter((entry) => entry.action === "kept-idle-workspace")).toEqual([
      expect.objectContaining({
        workspaceId: "b",
        reason: "idle, but this sweep's archive budget is spent; next sweep",
      }),
      expect.objectContaining({
        workspaceId: "a",
        reason: "idle, but this sweep's archive budget is spent; next sweep",
      }),
    ]);
  });

  test("a dry run archives, snapshots and deletes nothing, and says what it would do", async () => {
    const h = sweepHarness({
      config: { ...SWEEP, workspaceSweep: { dryRun: true } },
      stored: [record(), record({ id: "agent-2", workspaceId: "ws-2", cwd: EXTERNAL })],
      workspaces: [workspace(), external({ workspaceId: "ws-2" })],
    });

    const report = await h.janitor.tick();

    expect(h.archivedWorkspaces).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.pushes).toEqual([]);
    expect(report?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "would-delete", workspaceId: "ws-1" }),
        expect.objectContaining({ action: "would-archive-workspace", workspaceId: "ws-2" }),
      ]),
    );
  });

  test("the janitor's own dry run makes the sweep dry", async () => {
    const h = sweepHarness({ config: { ...SWEEP, dryRun: true } });

    const report = await h.janitor.tick();

    expect(h.archivedWorkspaces).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({ action: "would-archive-workspace", workspaceId: "ws-1" }),
    );
  });

  test("the sweep can be turned off on its own", async () => {
    const h = sweepHarness({ config: { ...SWEEP, workspaceSweep: { enabled: false } } });

    await h.janitor.tick();

    expect(h.archivedWorkspaces).toEqual([]);
  });

  describe("projects with no active workspace", () => {
    function idleProject(id: string, overrides: Partial<DoneJanitorProject> = {}) {
      return {
        projectId: id,
        // A root that exists, so the older rule (no workspace and a root that is gone) spares it.
        rootPath: tmpdir(),
        projectKey: null,
        createdAt: FOUR_DAYS_AGO,
        updatedAt: FOUR_DAYS_AGO,
        archivedAt: null,
        ...overrides,
      } satisfies DoneJanitorProject;
    }
    const archivedAgo = (hours: number) =>
      external({
        workspaceId: `ws-${hours}`,
        projectId: "p1",
        archivedAt: new Date(NOW - hours * HOUR).toISOString(),
      });

    test("are removed once their last workspace has been gone for the grace period", async () => {
      const h = sweepHarness({
        stored: [],
        workspaces: [archivedAgo(30)],
        projects: [idleProject("p1")],
      });

      const report = await h.janitor.tick();

      expect(h.removedProjects).toEqual(["p1"]);
      expect(report?.entries).toContainEqual(
        expect.objectContaining({
          action: "removed-project",
          projectId: "p1",
          reason: "it has had no active workspace for 30h",
        }),
      );
      expect(h.pushes[0]?.body).toBe("Removed 1 empty project.");
    });

    test("stay within the grace period, so a project just emptied or opened is not pulled away", async () => {
      const h = sweepHarness({
        stored: [],
        workspaces: [archivedAgo(2)],
        projects: [
          idleProject("p1"),
          idleProject("p2", {
            createdAt: new Date(NOW - HOUR).toISOString(),
            updatedAt: new Date(NOW - HOUR).toISOString(),
          }),
        ],
      });

      await h.janitor.tick();

      expect(h.removedProjects).toEqual([]);
    });

    test("a project with an active workspace is never removed", async () => {
      const h = sweepHarness({
        stored: [],
        workspaces: [external({ projectId: "p1", pinnedAt: FOUR_DAYS_AGO })],
        projects: [idleProject("p1")],
      });

      await h.janitor.tick();

      expect(h.removedProjects).toEqual([]);
    });

    test("a dry run says which it would remove, once each, and removes none", async () => {
      const h = sweepHarness({
        config: { ...SWEEP, dryRun: true },
        stored: [],
        workspaces: [archivedAgo(30)],
        // p2 has no workspace at all and a root that is gone: the older rule reports it first.
        projects: [idleProject("p1"), idleProject("p2", { rootPath: "/nonexistent/p2-root" })],
      });

      const report = await h.janitor.tick();

      expect(h.removedProjects).toEqual([]);
      expect(projectIdsReported(report, "would-remove-project")).toEqual(["p1", "p2"]);
    });

    test("a sweep removes at most maxProjectRemovalsPerSweep", async () => {
      const h = sweepHarness({
        config: { ...SWEEP, workspaceSweep: { dryRun: false, maxProjectRemovalsPerSweep: 1 } },
        stored: [],
        workspaces: [],
        projects: [idleProject("p1"), idleProject("p2"), idleProject("p3")],
      });

      await h.janitor.tick();

      expect(h.removedProjects).toHaveLength(1);
    });
  });
});
