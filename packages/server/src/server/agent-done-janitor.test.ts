import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { AgentManager, type DoneJanitorAgentSummary } from "./agent/agent-manager.js";
import { AgentStorage, type StoredAgentRecord } from "./agent/agent-storage.js";
import { createTestAgentClient } from "./test-utils/fake-agent-client.js";
import {
  AgentDoneJanitor,
  askAgentWhetherDone,
  probeProjectRoot,
  readProviderHealth,
  type AskAgentResult,
  type DoneJanitorConfig,
  type DoneJanitorDependencies,
  type DoneJanitorProject,
  type DoneJanitorWorkspace,
  type ProviderHealth,
} from "./agent-done-janitor.js";
import type { WorktreeDeletionSafety } from "./done-janitor-worktree.js";
import type { PushPayload } from "./push/index.js";
import type { WorktreeSnapshotResult } from "./remediation/contract.js";

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

interface Harness {
  janitor: AgentDoneJanitor;
  asked: string[];
  archived: string[];
  reclaimed: string[];
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
}): Harness {
  let now = NOW;
  const stored = input.stored ?? [record()];
  const workspaces = input.workspaces ?? [workspace()];
  const asked: string[] = [];
  const archived: string[] = [];
  const reclaimed: string[] = [];
  const removedProjects: string[] = [];
  const projects = input.projects ?? [];
  const pushes: PushPayload[] = [];
  const levels: (string | undefined)[] = [];
  const events: string[] = [];
  let listCalls = 0;
  let listProjectCalls = 0;
  let probeCalls = 0;
  const config = input.config;
  const deps: DoneJanitorDependencies = {
    listLiveAgents: () => input.live ?? [],
    listStoredAgents: async () => {
      listCalls += 1;
      input.onListStored?.(listCalls, stored);
      return stored;
    },
    listWorkspaces: async () => workspaces,
    listScheduledAgentIds: async () => new Set(input.scheduled ?? []),
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
    countTerminals: async () => input.terminals ?? 0,
    isPaseoOwnedWorktreePath: async (path) => path.startsWith("/home/t/.paseo/worktrees/"),
    checkWorktree: async ({ worktreePath }) =>
      input.checkWorktree?.(worktreePath) ??
      input.safety ?? { safe: true, branch: "feature", head: "abc" },
    measureBytes: async () => 3 * GB,
    reclaimWorkspace: async (workspaceId) => {
      reclaimed.push(workspaceId);
      events.push(`reclaim:${workspaceId}`);
      const index = workspaces.findIndex((candidate) => candidate.workspaceId === workspaceId);
      workspaces[index] = { ...workspaces[index], archivedAt: new Date(now).toISOString() };
      return { removedDirectory: true };
    },
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
      return probeProjectRoot(rootPath);
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
    logger: pino({ level: "silent" }),
    now: () => now,
  });
  return {
    janitor,
    asked,
    archived,
    reclaimed,
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

// The ask path, on its own: the dead pass would archive these stored (closed) records unasked.
const ON: DoneJanitorConfig = { enabled: true, archiveDead: false };

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

const DEAD_ON: DoneJanitorConfig = { enabled: true };
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

  test("a snapshot that could not read the directory at all spares nothing", async () => {
    const h = harness({
      config: DEAD_ON,
      snapshot: () => ({
        kind: "failed",
        worktreePath: null,
        error: "the directory does not exist",
      }),
    });
    await h.janitor.tick();
    expect(h.reclaimed).toEqual(["ws-1"]);
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
    const h = harness({ config: { enabled: true, archiveDead: false } });

    await h.janitor.tick();

    expect(h.asked).toEqual(["agent-1"]);
  });
});

describe("askAgentWhetherDone against a real AgentManager", () => {
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
  const ON_PROJECTS: DoneJanitorConfig = { enabled: true };
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
      config: { enabled: true, archiveDead: false, askFinished: false, reclaimWorkspaces: false },
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
});
