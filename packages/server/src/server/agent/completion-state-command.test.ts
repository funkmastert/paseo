import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  PARENT_AGENT_ID_LABEL,
  COMPLETION_AT_LABEL,
  COMPLETION_LABEL,
  COMPLETION_NOTE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import {
  setCompletionStateCommand,
  type CompletionStateAgentManager,
  type CompletionStateAgentView,
  type CompletionStateWorkspaceRegistry,
  type CompletionStateWorkspaceView,
} from "./completion-state-command.js";

class FakeAgentManager implements CompletionStateAgentManager {
  readonly agents = new Map<string, CompletionStateAgentView>();
  readonly labelUpdates: Array<{ agentId: string; labels: Record<string, string | null> }> = [];

  getAgent(agentId: string): CompletionStateAgentView | null {
    return this.agents.get(agentId) ?? null;
  }

  listAgents(): CompletionStateAgentView[] {
    return Array.from(this.agents.values());
  }

  async setLabels(agentId: string, labels: Record<string, string | null>): Promise<void> {
    this.labelUpdates.push({ agentId, labels });
    const agent = this.agents.get(agentId);
    if (!agent) return;
    const nextLabels = { ...agent.labels };
    for (const [key, value] of Object.entries(labels)) {
      if (value === null) delete nextLabels[key];
      else nextLabels[key] = value;
    }
    this.agents.set(agentId, { ...agent, labels: nextLabels });
  }
}

function agentView(
  overrides: Partial<CompletionStateAgentView> & { id: string },
): CompletionStateAgentView {
  return {
    labels: {},
    pendingPermissionCount: 0,
    lifecycle: "idle",
    ...overrides,
  };
}

class FakeWorkspaceRegistry implements CompletionStateWorkspaceRegistry {
  readonly workspaces = new Map<string, CompletionStateWorkspaceView>();

  async get(workspaceId: string): Promise<CompletionStateWorkspaceView | null> {
    return this.workspaces.get(workspaceId) ?? null;
  }
}

const alwaysSafe = async () => ({ safe: true as const, branch: "feature", head: "abc123" });
const alwaysMerged = async () => ({ merged: true as const });

describe("setCompletionStateCommand: targeting and permission", () => {
  test("with no agentId, targets the caller", async () => {
    const agentManager = new FakeAgentManager();
    agentManager.agents.set("self-1", agentView({ id: "self-1" }));

    const result = await setCompletionStateCommand(
      {
        agentManager,
        checkWorktreeDeletionSafety: alwaysSafe,
        checkMergedIntoRemoteBase: alwaysMerged,
      },
      { callerAgentId: "self-1", state: "ready-to-merge" },
    );

    expect(result.state).toBe("ready-to-merge");
    expect(agentManager.labelUpdates[0]?.agentId).toBe("self-1");
  });

  test("a parent may set state on its own child", async () => {
    const agentManager = new FakeAgentManager();
    agentManager.agents.set("parent-1", agentView({ id: "parent-1" }));
    agentManager.agents.set(
      "child-1",
      agentView({ id: "child-1", labels: { [PARENT_AGENT_ID_LABEL]: "parent-1" } }),
    );

    const result = await setCompletionStateCommand(
      {
        agentManager,
        checkWorktreeDeletionSafety: alwaysSafe,
        checkMergedIntoRemoteBase: alwaysMerged,
      },
      { callerAgentId: "parent-1", agentId: "child-1", state: "done" },
    );

    expect(result.state).toBe("done");
    expect(agentManager.labelUpdates[0]?.agentId).toBe("child-1");
  });

  test("refuses a stranger: the caller is not the target's parent", async () => {
    const agentManager = new FakeAgentManager();
    agentManager.agents.set("caller-1", agentView({ id: "caller-1" }));
    agentManager.agents.set(
      "other-1",
      agentView({ id: "other-1", labels: { [PARENT_AGENT_ID_LABEL]: "someone-else" } }),
    );

    await expect(
      setCompletionStateCommand(
        { agentManager },
        { callerAgentId: "caller-1", agentId: "other-1", state: "ready-to-merge" },
      ),
    ).rejects.toThrow(/not the parent/);
    expect(agentManager.labelUpdates).toHaveLength(0);
  });

  test("clear always succeeds regardless of pending permission, children, or git state", async () => {
    const agentManager = new FakeAgentManager();
    agentManager.agents.set(
      "self-1",
      agentView({
        id: "self-1",
        pendingPermissionCount: 1,
        labels: {
          [COMPLETION_LABEL]: "ready-to-merge",
          [COMPLETION_NOTE_LABEL]: "old note",
          [COMPLETION_AT_LABEL]: "2026-01-01T00:00:00.000Z",
        },
      }),
    );
    agentManager.agents.set(
      "child-1",
      agentView({
        id: "child-1",
        lifecycle: "running",
        labels: { [PARENT_AGENT_ID_LABEL]: "self-1" },
      }),
    );

    const result = await setCompletionStateCommand(
      { agentManager },
      { callerAgentId: "self-1", state: "clear" },
    );

    expect(result).toEqual({ success: true, state: null, note: null, completionAt: null });
    expect(agentManager.getAgent("self-1")?.labels).toEqual({});
  });

  test("refuses when the target has a pending permission or open question", async () => {
    const agentManager = new FakeAgentManager();
    agentManager.agents.set("self-1", agentView({ id: "self-1", pendingPermissionCount: 1 }));

    await expect(
      setCompletionStateCommand(
        { agentManager },
        { callerAgentId: "self-1", state: "ready-to-merge" },
      ),
    ).rejects.toThrow(/pending permission or question/);
    expect(agentManager.labelUpdates).toHaveLength(0);
  });

  test("refuses when a direct child is still running", async () => {
    const agentManager = new FakeAgentManager();
    agentManager.agents.set("self-1", agentView({ id: "self-1" }));
    agentManager.agents.set(
      "child-1",
      agentView({
        id: "child-1",
        lifecycle: "running",
        labels: { [PARENT_AGENT_ID_LABEL]: "self-1" },
      }),
    );

    await expect(
      setCompletionStateCommand(
        { agentManager },
        { callerAgentId: "self-1", state: "ready-to-merge" },
      ),
    ).rejects.toThrow(/child agent child-1 is still running/);
  });

  test("refuses when a grandchild is initializing", async () => {
    const agentManager = new FakeAgentManager();
    agentManager.agents.set("self-1", agentView({ id: "self-1" }));
    agentManager.agents.set(
      "child-1",
      agentView({ id: "child-1", labels: { [PARENT_AGENT_ID_LABEL]: "self-1" } }),
    );
    agentManager.agents.set(
      "grandchild-1",
      agentView({
        id: "grandchild-1",
        lifecycle: "initializing",
        labels: { [PARENT_AGENT_ID_LABEL]: "child-1" },
      }),
    );

    await expect(
      setCompletionStateCommand({ agentManager }, { callerAgentId: "self-1", state: "done" }),
    ).rejects.toThrow(/child agent grandchild-1 is still initializing/);
  });

  test("a non-worktree workspace allows through with a note", async () => {
    const agentManager = new FakeAgentManager();
    agentManager.agents.set("self-1", agentView({ id: "self-1", workspaceId: "ws-1" }));
    const workspaceRegistry = new FakeWorkspaceRegistry();
    workspaceRegistry.workspaces.set("ws-1", {
      kind: "local_checkout",
      cwd: "/tmp/does-not-matter",
      worktreeRoot: null,
      baseBranch: null,
    });

    const result = await setCompletionStateCommand(
      { agentManager, workspaceRegistry },
      { callerAgentId: "self-1", state: "ready-to-merge" },
    );

    expect(result).toMatchObject({
      success: true,
      state: "ready-to-merge",
      gateNote: "not a worktree, allowing",
    });
  });

  test("a missing workspace registry allows through with a note", async () => {
    const agentManager = new FakeAgentManager();
    agentManager.agents.set("self-1", agentView({ id: "self-1", workspaceId: "ws-1" }));

    const result = await setCompletionStateCommand(
      { agentManager },
      { callerAgentId: "self-1", state: "ready-to-merge" },
    );

    expect(result.success).toBe(true);
    expect(result.gateNote).toContain("skipped");
  });
});

describe("setCompletionStateCommand: the worktree git gate (real git)", () => {
  let root: string;
  let repo: string;
  let remote: string;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
  }

  function commit(cwd: string, file: string, content: string): void {
    writeFileSync(join(cwd, file), content);
    git(cwd, "add", file);
    git(cwd, "commit", "-q", "-m", `edit ${file}`);
  }

  function addWorktree(name: string, branch: string): string {
    const path = join(root, "worktrees", name);
    git(repo, "worktree", "add", "-q", "-b", branch, path, "main");
    return path;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "completion-state-command-"));
    repo = join(root, "repo");
    remote = join(root, "remote.git");
    git(root, "init", "-q", "--bare", remote);
    git(root, "init", "-q", "-b", "main", repo);
    commit(repo, "README.md", "hello\n");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "origin", "main");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function setUp(worktreePath: string, baseBranch: string | null = "main") {
    const agentManager = new FakeAgentManager();
    agentManager.agents.set("self-1", agentView({ id: "self-1", workspaceId: "ws-1" }));
    const workspaceRegistry = new FakeWorkspaceRegistry();
    workspaceRegistry.workspaces.set("ws-1", {
      kind: "worktree",
      cwd: worktreePath,
      worktreeRoot: worktreePath,
      baseBranch,
    });
    return { agentManager, workspaceRegistry };
  }

  test("ready-to-merge succeeds on a clean, pushed worktree", async () => {
    const worktree = addWorktree("pushed", "feature");
    commit(worktree, "a.txt", "a\n");
    git(worktree, "push", "-q", "origin", "feature");
    const { agentManager, workspaceRegistry } = setUp(worktree);

    const result = await setCompletionStateCommand(
      { agentManager, workspaceRegistry },
      { callerAgentId: "self-1", state: "ready-to-merge" },
    );

    expect(result).toMatchObject({ success: true, state: "ready-to-merge" });
  });

  test("ready-to-merge refuses an uncommitted worktree", async () => {
    const worktree = addWorktree("dirty", "feature");
    writeFileSync(join(worktree, "notes.txt"), "draft\n");
    const { agentManager, workspaceRegistry } = setUp(worktree);

    await expect(
      setCompletionStateCommand(
        { agentManager, workspaceRegistry },
        { callerAgentId: "self-1", state: "ready-to-merge" },
      ),
    ).rejects.toThrow(/uncommitted or untracked/);
  });

  test("ready-to-merge refuses a branch that exists nowhere remote", async () => {
    const worktree = addWorktree("local-only", "feature");
    commit(worktree, "a.txt", "a\n");
    const { agentManager, workspaceRegistry } = setUp(worktree);

    await expect(
      setCompletionStateCommand(
        { agentManager, workspaceRegistry },
        { callerAgentId: "self-1", state: "ready-to-merge" },
      ),
    ).rejects.toThrow(/neither merged into main nor pushed/);
  });

  test("done succeeds once the branch is merged and pushed to the remote base", async () => {
    const worktree = addWorktree("merged", "feature");
    commit(worktree, "a.txt", "a\n");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge", "feature");
    git(repo, "push", "-q", "origin", "main");
    const { agentManager, workspaceRegistry } = setUp(worktree);

    const result = await setCompletionStateCommand(
      { agentManager, workspaceRegistry },
      { callerAgentId: "self-1", state: "done", note: "PR merged" },
    );

    expect(result).toMatchObject({ success: true, state: "done", note: "PR merged" });
  });

  test("done refuses when the worktree is clean and pushed but not merged into the remote base", async () => {
    const worktree = addWorktree("pushed-unmerged", "feature");
    commit(worktree, "a.txt", "a\n");
    git(worktree, "push", "-q", "origin", "feature");
    const { agentManager, workspaceRegistry } = setUp(worktree);

    // ready-to-merge would succeed on this same tree state.
    const readyResult = await setCompletionStateCommand(
      { agentManager, workspaceRegistry },
      { callerAgentId: "self-1", state: "ready-to-merge" },
    );
    expect(readyResult.success).toBe(true);

    await expect(
      setCompletionStateCommand(
        { agentManager, workspaceRegistry },
        { callerAgentId: "self-1", state: "done" },
      ),
    ).rejects.toThrow(/not yet merged/);
  });

  test("done allows through when the base branch can't be told apart (no remote base)", async () => {
    const worktree = addWorktree("no-remote-base", "feature");
    commit(worktree, "a.txt", "a\n");
    git(worktree, "push", "-q", "origin", "feature");
    const { agentManager, workspaceRegistry } = setUp(worktree, "develop");

    const result = await setCompletionStateCommand(
      { agentManager, workspaceRegistry },
      { callerAgentId: "self-1", state: "done" },
    );

    expect(result.success).toBe(true);
    expect(result.gateNote).toContain("no remote holds a develop branch");
  });
});
