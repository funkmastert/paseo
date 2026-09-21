import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";

import { AgentManager, type DoneJanitorAgentSummary } from "./agent/agent-manager.js";
import { AgentStorage, type StoredAgentRecord } from "./agent/agent-storage.js";
import { createTestAgentClient } from "./test-utils/fake-agent-client.js";
import {
  AgentDoneJanitor,
  askAgentWhetherDone,
  readProviderHealth,
  type AskAgentResult,
  type DoneJanitorConfig,
  type DoneJanitorDependencies,
  type DoneJanitorWorkspace,
  type ProviderHealth,
} from "./agent-done-janitor.js";
import type { WorktreeDeletionSafety } from "./done-janitor-worktree.js";
import type { PushPayload } from "./push/index.js";

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
    ...overrides,
  };
}

interface Harness {
  janitor: AgentDoneJanitor;
  asked: string[];
  archived: string[];
  reclaimed: string[];
  pushes: PushPayload[];
  stored: StoredAgentRecord[];
  config: DoneJanitorConfig;
  setNow(ms: number): void;
}

function harness(input: {
  stored?: StoredAgentRecord[];
  live?: DoneJanitorAgentSummary[];
  workspaces?: DoneJanitorWorkspace[];
  config?: DoneJanitorConfig | undefined;
  answer?: (agentId: string) => AskAgentResult;
  health?: ProviderHealth;
  safety?: WorktreeDeletionSafety;
  checkWorktree?: (worktreePath: string) => WorktreeDeletionSafety;
  scheduled?: string[];
  terminals?: number;
  /** Runs after an answer and before the janitor's re-check. */
  afterAnswer?: (stored: StoredAgentRecord[]) => void;
}): Harness {
  let now = NOW;
  const stored = input.stored ?? [record()];
  const workspaces = input.workspaces ?? [workspace()];
  const asked: string[] = [];
  const archived: string[] = [];
  const reclaimed: string[] = [];
  const pushes: PushPayload[] = [];
  const config = input.config;
  const deps: DoneJanitorDependencies = {
    listLiveAgents: () => input.live ?? [],
    listStoredAgents: async () => stored,
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
      const index = workspaces.findIndex((candidate) => candidate.workspaceId === workspaceId);
      workspaces[index] = { ...workspaces[index], archivedAt: new Date(now).toISOString() };
      return { removedDirectory: true };
    },
  };
  const janitor = new AgentDoneJanitor({
    dependencies: deps,
    getPushNotificationSender: () => ({ send: async (payload) => void pushes.push(payload) }),
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
    pushes,
    stored,
    config: config ?? {},
    setNow: (ms) => {
      now = ms;
    },
  };
}

const ON: DoneJanitorConfig = { enabled: true };

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
