import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";
import type { PushPayload } from "./push/index.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createDaemonTestContext, type DaemonTestContext } from "./test-utils/index.js";

// A real daemon on a temp PASEO_HOME and a fixture repository: the janitor's wiring — the
// workspace registry, archive-by-scope, the git gate and the directory removal — runs for real.
// The provider is the fake client, which answers the janitor's question with "Hello world".

const DAY_MS = 24 * 60 * 60 * 1000;

let ctx: DaemonTestContext;
let clockMs: number;
const pushes: PushPayload[] = [];
const tempRoots: string[] = [];

beforeEach(async () => {
  clockMs = Date.now();
  pushes.length = 0;
  ctx = await createDaemonTestContext({
    doneJanitor: { enabled: true },
    doneJanitorOverrides: { sweepIntervalMs: 60 * 60 * 1000, now: () => clockMs },
    pushNotificationSender: { send: async (payload) => void pushes.push(payload) },
  });
});

afterEach(async () => {
  await ctx.cleanup();
  for (const tempRoot of tempRoots.splice(0)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function createGitRepo(): string {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "done-janitor-repo-"));
  tempRoots.push(tempRoot);
  const repoDir = path.join(tempRoot, "repo");
  execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repoDir });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"], {
    cwd: repoDir,
  });
  return repoDir;
}

async function createWorktreeWithAgent(
  repoDir: string,
  slug: string,
): Promise<{ workspaceId: string; dir: string; agentId: string }> {
  const result = await ctx.client.createWorkspace({
    source: { kind: "worktree", cwd: repoDir, worktreeSlug: slug, baseBranch: "main" },
  });
  const workspace = result.workspace;
  if (!workspace?.workspaceDirectory) throw new Error(result.error ?? "no worktree");
  const agent = await ctx.client.createAgent({
    ...getFullAccessConfig("claude"),
    cwd: workspace.workspaceDirectory,
    workspaceId: workspace.id,
    title: `agent in ${slug}`,
    initialPrompt: "say 'state saved'",
  });
  await ctx.client.waitForFinish(agent.id, 30_000);
  // Tyler read the result: the unread flag alone would keep the agent.
  await ctx.client.clearAgentAttention(agent.id);
  // The setup turn's own "Agent finished" push is not the janitor's.
  pushes.length = 0;
  return { workspaceId: workspace.id, dir: workspace.workspaceDirectory, agentId: agent.id };
}

async function sweep() {
  const janitor = ctx.daemon.daemon.getDoneJanitor();
  if (!janitor) throw new Error("done janitor was not started");
  return janitor.tick();
}

async function isArchived(agentId: string): Promise<boolean> {
  const agents = await ctx.client.fetchAgents({ filter: { includeArchived: true } });
  const entry = agents.entries.find((candidate) => candidate.agent.id === agentId);
  return Boolean(entry?.agent.archivedAt);
}

async function activeWorkspaceIds(): Promise<Set<string>> {
  const workspaces = await ctx.client.fetchWorkspaces();
  return new Set(workspaces.entries.map((entry) => entry.id));
}

test("an agent that does not answer DONE keeps itself and its worktree", async () => {
  const repoDir = createGitRepo();
  const { workspaceId, dir, agentId } = await createWorktreeWithAgent(repoDir, "unsure");

  // Idle overnight is not finished: nobody is asked.
  clockMs += 0.5 * DAY_MS;
  expect((await sweep())?.entries).toContainEqual(
    expect.objectContaining({ agentId, action: "not-done" }),
  );

  clockMs += 4 * DAY_MS;
  const report = await sweep();

  expect(report?.entries).toContainEqual(
    expect.objectContaining({ agentId, action: "asked", reason: 'answered "Hello world"' }),
  );
  expect(await isArchived(agentId)).toBe(false);
  expect((await activeWorkspaceIds()).has(workspaceId)).toBe(true);
  expect(existsSync(dir)).toBe(true);
  expect(pushes).toEqual([]);
  // The question left no unread flag behind.
  const agents = await ctx.client.fetchAgents();
  const agent = agents.entries.find((entry) => entry.agent.id === agentId)?.agent;
  expect(agent?.requiresAttention).toBeFalsy();
});

test("a dry run reports and deletes nothing; a live sweep deletes only the clean worktree", async () => {
  const repoDir = createGitRepo();
  const clean = await createWorktreeWithAgent(repoDir, "clean");
  const dirty = await createWorktreeWithAgent(repoDir, "dirty");
  writeFileSync(path.join(dirty.dir, "notes.txt"), "unsaved thoughts\n");
  // A person archived both agents; archiving an agent never archives its workspace.
  await ctx.client.archiveAgent(clean.agentId);
  await ctx.client.archiveAgent(dirty.agentId);
  clockMs += 4 * DAY_MS;

  await ctx.client.patchDaemonConfig({ doneJanitor: { enabled: true, dryRun: true } });
  const dryRun = await sweep();

  expect(dryRun?.dryRun).toBe(true);
  expect(dryRun?.entries).toContainEqual(
    expect.objectContaining({ action: "would-delete", workspaceId: clean.workspaceId }),
  );
  expect(dryRun?.entries).toContainEqual(
    expect.objectContaining({
      action: "kept-workspace",
      workspaceId: dirty.workspaceId,
      reason: "it has 1 uncommitted or untracked file(s)",
    }),
  );
  expect(existsSync(clean.dir)).toBe(true);
  expect(pushes).toEqual([]);

  await ctx.client.patchDaemonConfig({ doneJanitor: { dryRun: false } });
  const live = await sweep();

  expect(live?.entries).toContainEqual(
    expect.objectContaining({ action: "deleted", workspaceId: clean.workspaceId }),
  );
  expect(existsSync(clean.dir)).toBe(false);
  expect((await activeWorkspaceIds()).has(clean.workspaceId)).toBe(false);
  expect(existsSync(path.join(dirty.dir, "notes.txt"))).toBe(true);
  expect((await activeWorkspaceIds()).has(dirty.workspaceId)).toBe(true);
  expect(pushes).toHaveLength(1);
  expect(pushes[0]?.body).toMatch(/^Deleted 1 worktree, freeing \d+\.\d GB\. Kept /);
});

test("the primary checkout is never touched, even with every agent in it archived", async () => {
  const repoDir = createGitRepo();
  const result = await ctx.client.createWorkspace({
    source: { kind: "directory", path: repoDir },
    title: "main checkout",
  });
  const workspaceId = result.workspace?.id;
  if (!workspaceId) throw new Error(result.error ?? "no workspace");
  const agent = await ctx.client.createAgent({
    ...getFullAccessConfig("claude"),
    cwd: repoDir,
    workspaceId,
    title: "agent in main",
    initialPrompt: "say 'state saved'",
  });
  await ctx.client.waitForFinish(agent.id, 30_000);
  await ctx.client.archiveAgent(agent.id);
  clockMs += 30 * DAY_MS;

  await sweep();

  expect(existsSync(path.join(repoDir, ".git"))).toBe(true);
  expect((await activeWorkspaceIds()).has(workspaceId)).toBe(true);
});

test("a closed agent archives itself and frees its clean worktree; a pinned workspace keeps both", async () => {
  const repoDir = createGitRepo();
  const dead = await createWorktreeWithAgent(repoDir, "dead");
  const pinned = await createWorktreeWithAgent(repoDir, "pinned");
  const dirty = await createWorktreeWithAgent(repoDir, "dirty");
  writeFileSync(path.join(dirty.dir, "notes.txt"), "unsaved thoughts\n");
  // A daemon restart closes every agent; closing them here is the same state.
  const { agentManager } = ctx.daemon.daemon;
  for (const agent of [dead, pinned, dirty]) await agentManager.closeAgent(agent.agentId);
  await ctx.client.setWorkspacePinned(pinned.workspaceId, true);
  clockMs += 4 * DAY_MS;

  await ctx.client.patchDaemonConfig({ doneJanitor: { enabled: true, dryRun: true } });
  const dryRun = await sweep();

  expect(dryRun?.entries).toContainEqual(
    expect.objectContaining({ action: "would-archive", agentId: dead.agentId }),
  );
  expect(dryRun?.entries).toContainEqual(
    expect.objectContaining({ action: "would-delete", workspaceId: dead.workspaceId }),
  );
  expect(dryRun?.entries).toContainEqual(
    expect.objectContaining({
      action: "kept-agent",
      agentId: pinned.agentId,
      reason: "its workspace is pinned",
    }),
  );
  expect(await isArchived(dead.agentId)).toBe(false);
  expect(existsSync(dead.dir)).toBe(true);

  await ctx.client.patchDaemonConfig({ doneJanitor: { dryRun: false } });
  await sweep();

  expect(await isArchived(dead.agentId)).toBe(true);
  expect(existsSync(dead.dir)).toBe(false);
  expect(await isArchived(pinned.agentId)).toBe(false);
  expect(existsSync(pinned.dir)).toBe(true);
  // Archived, but the unsaved file keeps its worktree.
  expect(await isArchived(dirty.agentId)).toBe(true);
  expect(existsSync(path.join(dirty.dir, "notes.txt"))).toBe(true);
  expect((await activeWorkspaceIds()).has(dirty.workspaceId)).toBe(true);
  expect(pushes[0]?.body).toMatch(/^Archived 2 dead sessions and deleted 1 worktree, freeing/);
});

test("an empty project whose directory is gone leaves every connected sidebar without a reload", async () => {
  const gone = realpathSync(mkdtempSync(path.join(tmpdir(), "done-janitor-gone-")));
  const alive = realpathSync(mkdtempSync(path.join(tmpdir(), "done-janitor-alive-")));
  tempRoots.push(gone, alive);
  const goneProject = (await ctx.client.addProject(gone)).project;
  const aliveProject = (await ctx.client.addProject(alive)).project;
  if (!goneProject || !aliveProject) throw new Error("addProject returned no project");
  rmSync(gone, { recursive: true, force: true });

  // A second client: the update reaches every session, not the one that asked.
  const other = new DaemonClient({ url: `ws://127.0.0.1:${ctx.daemon.port}/ws` });
  await other.connect();
  try {
    await other.fetchAgents({ subscribe: { subscriptionId: "other-agents" } });
    const removedBy = new Map<string, string[]>();
    for (const [name, client] of [
      ["first", ctx.client],
      ["second", other],
    ] as const) {
      removedBy.set(name, []);
      client.on("workspace_update", (message) => {
        if (message.payload.kind === "remove" && message.payload.removedProjectId) {
          removedBy.get(name)?.push(message.payload.removedProjectId);
        }
      });
      const listing = await client.fetchWorkspaces({
        subscribe: { subscriptionId: `${name}-workspaces` },
      });
      expect(listing.emptyProjects.map((project) => project.projectId)).toContain(
        goneProject.projectId,
      );
    }
    clockMs += 2 * 60 * 60 * 1000;

    await ctx.client.patchDaemonConfig({ doneJanitor: { enabled: true, dryRun: true } });
    const dryRun = await sweep();
    expect(dryRun?.entries).toEqual([
      expect.objectContaining({ action: "would-remove-project", projectId: goneProject.projectId }),
    ]);
    expect(pushes).toEqual([]);
    expect(removedBy.get("first")).toEqual([]);

    await ctx.client.patchDaemonConfig({ doneJanitor: { dryRun: false } });
    const live = await sweep();

    expect(live?.removedProjectCount).toBe(1);
    expect(live?.entries).toEqual([
      expect.objectContaining({ action: "removed-project", projectId: goneProject.projectId }),
    ]);
    await vi.waitFor(() => {
      expect(removedBy.get("first")).toContain(goneProject.projectId);
      expect(removedBy.get("second")).toContain(goneProject.projectId);
    });
    const after = await other.fetchWorkspaces();
    expect(after.emptyProjects.map((project) => project.projectId)).toEqual([
      aliveProject.projectId,
    ]);
    expect(pushes.map((push) => push.body)).toEqual(["Removed 1 empty project."]);
  } finally {
    await other.close();
  }
}, 30_000);
