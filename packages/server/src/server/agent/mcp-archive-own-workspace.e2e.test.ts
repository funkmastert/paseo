import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { z } from "zod";

import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

// An agent archives the workspace it is itself running in. This replaces the deleted
// mcp-parity case "archive_worktree succeeds when caller cwd is inside the archived
// worktree". That bug was a cwd-resolution one (the tool derived the repo root from the
// scoped caller's cwd, so a caller inside the worktree got the worktree as its repo root).
// archive_workspace takes a workspaceId and reads the repo root from the persisted record,
// so the cwd bug cannot recur; what stays live is the self-archive itself. The tool
// tears down the caller's own session and removes the directory the caller is standing
// in, all from inside the caller's in-flight tool call.

let tempRoot: string;
let daemon: TestPaseoDaemon;
let mcpClients: Client[];

beforeEach(async () => {
  tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "mcp-archive-own-workspace-")));
  mcpClients = [];
  daemon = await createTestPaseoDaemon({ agentClients: createTestAgentClients() });
});

afterEach(async () => {
  await Promise.allSettled(mcpClients.map((client) => client.close()));
  await daemon?.close();
  await rm(tempRoot, { recursive: true, force: true });
});

async function connect(callerAgentId?: string): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${daemon.port}/mcp/agents`);
  if (callerAgentId) {
    url.searchParams.set("callerAgentId", callerAgentId);
  }
  const client = new Client({ name: "archive-own-workspace-e2e", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  mcpClients.push(client);
  return client;
}

async function callStructured(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  }
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
}

function createGitRepo(): string {
  const repoDir = path.join(tempRoot, "repo");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "pipe" });
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test User");
  git("config", "commit.gpgsign", "false");
  git("commit", "--allow-empty", "-m", "init");
  return repoDir;
}

async function createWorktreeWorkspaceWithAgent(input: {
  initialPrompt: string;
}): Promise<{ workspaceId: string; worktreePath: string; agentId: string }> {
  const repoDir = createGitRepo();
  const topLevel = await connect();

  const workspace = await callStructured(topLevel, "create_workspace", {
    isolation: "worktree",
    path: repoDir,
    worktreeSlug: "archive-own-workspace",
    baseBranch: "main",
  });
  const workspaceId = z.string().parse(workspace.workspaceId);
  const worktreePath = z.string().parse(workspace.cwd);
  expect(existsSync(worktreePath)).toBe(true);

  const agent = await callStructured(topLevel, "create_agent", {
    relationship: { kind: "detached" },
    workspace: { kind: "existing", workspaceId },
    title: "Self-archiving agent",
    provider: "claude/claude-test-model",
    initialPrompt: input.initialPrompt,
    settings: { modeId: "bypassPermissions" },
    background: true,
  });
  const agentId = z.string().parse(agent.agentId);
  return { workspaceId, worktreePath, agentId };
}

async function expectArchivedEverywhere(input: {
  workspaceId: string;
  worktreePath: string;
  agentId: string;
  result: Record<string, unknown>;
}): Promise<void> {
  expect(input.result).toMatchObject({
    workspaceId: input.workspaceId,
    archivedAgentIds: expect.arrayContaining([input.agentId]),
    removedDirectory: true,
  });
  expect(existsSync(input.worktreePath)).toBe(false);

  const topLevel = await connect();
  const listed = await callStructured(topLevel, "list_workspaces", {});
  const activeIds = z
    .array(z.object({ workspaceId: z.string() }))
    .parse(listed.workspaces)
    .map((workspace) => workspace.workspaceId);
  expect(activeIds).not.toContain(input.workspaceId);

  const stored = await daemon.daemon.agentStorage.get(input.agentId);
  expect(stored?.archivedAt).toBeTruthy();
  expect(daemon.daemon.agentManager.getAgent(input.agentId)).toBeNull();
}

test("an idle agent can archive the worktree workspace it lives in", async () => {
  const { workspaceId, worktreePath, agentId } = await createWorktreeWorkspaceWithAgent({
    initialPrompt: "say done and stop",
  });
  const self = await connect(agentId);

  const result = await callStructured(self, "archive_workspace", { workspaceId });

  await expectArchivedEverywhere({ workspaceId, worktreePath, agentId, result });
}, 60_000);

test("a running agent can archive the worktree workspace it lives in", async () => {
  // "sleep" makes the fake provider start a shell call that holds the turn open until it
  // is interrupted, so the caller is mid-turn when it archives itself.
  const { workspaceId, worktreePath, agentId } = await createWorktreeWorkspaceWithAgent({
    initialPrompt: "run sleep",
  });
  await expect
    .poll(() => daemon.daemon.agentManager.getAgent(agentId)?.lifecycle, { timeout: 15_000 })
    .toBe("running");
  const self = await connect(agentId);

  const result = await callStructured(self, "archive_workspace", { workspaceId });

  await expectArchivedEverywhere({ workspaceId, worktreePath, agentId, result });
}, 60_000);
