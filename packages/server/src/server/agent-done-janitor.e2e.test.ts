import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";
import type { PushPayload } from "./push/index.js";
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
