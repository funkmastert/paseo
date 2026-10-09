import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveExistingRunWorkspace,
  resolveRunCallerAgentId,
  resolveRunWorkspace,
  runRunCommand,
  type AgentRunOptions,
} from "./run";

describe("managed agent caller context", () => {
  it("propagates a trimmed PASEO_AGENT_ID", () => {
    expect(resolveRunCallerAgentId({ PASEO_AGENT_ID: "  parent-agent  " })).toBe("parent-agent");
  });

  it("omits blank caller ids", () => {
    expect(resolveRunCallerAgentId({ PASEO_AGENT_ID: "   " })).toBeUndefined();
  });
});

describe("existing run workspace resolution", () => {
  it("queries the daemon for an exact workspace id and uses its directory", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [{ id: "workspace-2", workspaceDirectory: "/workspace/two" }],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "workspace-2")).resolves.toEqual({
      id: "workspace-2",
      cwd: "/workspace/two",
    });
    expect(fetchWorkspaces).toHaveBeenCalledWith({
      filter: { query: "workspace-2" },
      page: { limit: 200 },
    });
  });

  it("rejects a workspace id absent from daemon state", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "missing")).rejects.toMatchObject(
      {
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace not found: missing",
      },
    );
  });
});

describe("resolveRunWorkspace minting a new workspace", () => {
  const originalAgentId = process.env.PASEO_AGENT_ID;

  afterEach(() => {
    if (originalAgentId === undefined) {
      delete process.env.PASEO_AGENT_ID;
    } else {
      process.env.PASEO_AGENT_ID = originalAgentId;
    }
  });

  function fakeClient(createWorkspace: ReturnType<typeof vi.fn>) {
    return { fetchWorkspaces: vi.fn(), createWorkspace };
  }

  // paseo run --new-workspace <kind> inside an agent (PASEO_AGENT_ID set) must tell the daemon
  // who is creating the workspace, or the daemon's workspace-create RPC auto-pins it — a pin
  // Tyler never made, that then shows in his sidebar's Pinned section.
  it("passes PASEO_AGENT_ID as callerAgentId when minting a new workspace", async () => {
    process.env.PASEO_AGENT_ID = "parent-agent";
    const createWorkspace = vi
      .fn()
      .mockResolvedValue({ workspace: { id: "ws-new", name: "New workspace" } });

    await resolveRunWorkspace(fakeClient(createWorkspace), { newWorkspace: "worktree" }, "/cwd");

    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ callerAgentId: "parent-agent" }),
    );
  });

  it("omits callerAgentId when PASEO_AGENT_ID is not set", async () => {
    delete process.env.PASEO_AGENT_ID;
    const createWorkspace = vi
      .fn()
      .mockResolvedValue({ workspace: { id: "ws-new", name: "New workspace" } });

    await resolveRunWorkspace(fakeClient(createWorkspace), { newWorkspace: "worktree" }, "/cwd");

    const callArgs = createWorkspace.mock.calls[0]?.[0];
    expect(callArgs).not.toHaveProperty("callerAgentId");
  });
});

// validateRunOptions runs before the CLI ever connects to a daemon, so these
// invalid combinations reject without one running.
describe("runRunCommand option validation", () => {
  const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;

  beforeEach(() => {
    delete process.env.PASEO_WORKSPACE_ID;
  });

  afterEach(() => {
    if (originalWorkspaceId === undefined) {
      delete process.env.PASEO_WORKSPACE_ID;
    } else {
      process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
    }
  });

  async function expectInvalidOptions(options: AgentRunOptions, messageMatch: RegExp) {
    await expect(runRunCommand("do something", options, {} as never)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: expect.stringMatching(messageMatch),
    });
  }

  it("rejects --new-workspace combined with --workspace", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", workspace: "ws-1" },
      /--new-workspace and --workspace cannot be combined/,
    );
  });

  it("allows explicit worktree workspace creation through validation", async () => {
    // Explicit workspace creation with no --workspace
    // must clear validation. It still fails later (provider resolution), which
    // is enough to prove the new guard did not reject it.
    await expect(
      runRunCommand("do something", { newWorkspace: "worktree", provider: undefined }, {} as never),
    ).rejects.not.toMatchObject({ code: "INVALID_OPTIONS" });
  });

  it("rejects unknown new workspace kinds", async () => {
    await expectInvalidOptions({ newWorkspace: "container" }, /Unsupported new workspace kind/);
  });

  it("rejects two workspace creation flags", async () => {
    await expectInvalidOptions(
      { newWorkspace: "local", worktree: "legacy-slug" },
      /--new-workspace and --worktree cannot be combined/,
    );
  });

  it("rejects an unknown worktree creation mode before connecting", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", worktreeMode: "container" },
      /Unsupported worktree mode/,
    );
  });
});
