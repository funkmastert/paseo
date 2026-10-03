import { describe, expect, test, vi } from "vitest";
import pino from "pino";
import { createPaseoToolCatalog } from "./paseo-tools.js";
import type { PaseoToolHostDependencies } from "./types.js";

/**
 * The spend governor's fan-out gate, exercised through the real `create_agent` tool rather
 * than through the planner that decides it. What this pins is the wiring: that the refusal is
 * read from AgentManager at call time, that it happens before a single workspace, worktree or
 * provider session is provisioned, and that the message tells the agent enough not to retry.
 * An agent that retries a refusal in a loop burns exactly the budget the gate is protecting.
 */
function createCatalog(input: {
  fanOutDenial: { budgetTokens: number; spentTokens: number } | null;
  callerAgentId?: string;
}) {
  const createPaseoWorktree = vi.fn();
  const ensureWorkspaceForCreate = vi.fn();
  const agentManager = {
    getSpendFanOutDenial: vi.fn(() => input.fanOutDenial),
    getPaseoToolPolicy: vi.fn(() => undefined),
    createAgent: vi.fn(),
    getAgent: vi.fn(() => null),
    listAgents: vi.fn(() => []),
  };
  const catalog = createPaseoToolCatalog({
    agentManager,
    agentStorage: { get: vi.fn(async () => null) },
    createPaseoWorktree,
    ensureWorkspaceForCreate,
    logger: pino({ level: "silent" }),
    ...(input.callerAgentId !== undefined ? { callerAgentId: input.callerAgentId } : {}),
  } as unknown as PaseoToolHostDependencies);
  return { catalog, agentManager, createPaseoWorktree, ensureWorkspaceForCreate };
}

const VALID_ARGS = {
  title: "Fix the parser",
  provider: "claude/claude-opus-5",
  initialPrompt: "Fix the off-by-one in the tokenizer.",
};

describe("create_agent spend-governor gate", () => {
  test("a caller the governor cut off is refused, and told why", async () => {
    const { catalog } = createCatalog({
      fanOutDenial: { budgetTokens: 300_000, spentTokens: 412_345 },
      callerAgentId: "caller-1",
    });

    await expect(catalog.executeTool("create_agent", VALID_ARGS)).rejects.toThrow(
      /spend governor has cut off this task's fan-out/,
    );
  });

  test("the refusal names the numbers and says retrying will not help", async () => {
    const { catalog } = createCatalog({
      fanOutDenial: { budgetTokens: 300_000, spentTokens: 412_345 },
      callerAgentId: "caller-1",
    });

    const error = await catalog.executeTool("create_agent", VALID_ARGS).catch((e: Error) => e);
    const message = (error as Error).message;
    expect(message).toContain("412345");
    expect(message).toContain("300000");
    expect(message).toContain("retrying will keep failing");
    expect(message).toContain("no agent was created");
    // Names the way out, so a human reading the transcript knows what to change.
    expect(message).toContain("paseo.budget");
  });

  test("nothing is provisioned on the way to being refused", async () => {
    const { catalog, createPaseoWorktree, ensureWorkspaceForCreate } = createCatalog({
      fanOutDenial: { budgetTokens: 300_000, spentTokens: 412_345 },
      callerAgentId: "caller-1",
    });

    await catalog.executeTool("create_agent", VALID_ARGS).catch(() => {});

    expect(createPaseoWorktree).not.toHaveBeenCalled();
    expect(ensureWorkspaceForCreate).not.toHaveBeenCalled();
  });

  test("a caller inside its budget is not stopped here", async () => {
    // Past the gate it fails for an unrelated reason — the fakes go no further — which is the
    // point: the gate is the only thing this test may reject on.
    const { catalog, agentManager } = createCatalog({
      fanOutDenial: null,
      callerAgentId: "caller-1",
    });

    const error = await catalog.executeTool("create_agent", VALID_ARGS).catch((e: Error) => e);

    expect(agentManager.getSpendFanOutDenial).toHaveBeenCalledWith("caller-1");
    expect((error as Error | undefined)?.message ?? "").not.toContain("spend governor");
  });

  test("a top-level create with no caller agent is never gated", async () => {
    // There is no budget to be over: the gate is per-task, and a human-initiated create is
    // nobody's subagent.
    const { catalog, agentManager } = createCatalog({
      fanOutDenial: { budgetTokens: 1, spentTokens: 999_999 },
    });

    const error = await catalog
      .executeTool("create_agent", { ...VALID_ARGS, workspaceId: "wks-1" })
      .catch((e: Error) => e);

    expect(agentManager.getSpendFanOutDenial).not.toHaveBeenCalled();
    expect((error as Error | undefined)?.message ?? "").not.toContain("spend governor");
  });
});
