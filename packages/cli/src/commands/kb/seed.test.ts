import { describe, expect, it, vi } from "vitest";

import { runKbSeedCommand } from "./seed.js";

const createAgent = vi.fn(async (input: { title?: string }) => ({
  id: `agent-${input.title}`,
  title: input.title ?? null,
}));
const getKnowledgeBaseStatus = vi.fn(async () => ({
  enabled: true,
  sidecar: { state: "disabled" },
  setupHint: null,
}));
const close = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    getKnowledgeBaseStatus,
    createAgent,
    close,
  })),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

describe("runKbSeedCommand", () => {
  it("refuses and names the config key when the knowledge base is disabled", async () => {
    getKnowledgeBaseStatus.mockResolvedValueOnce({
      enabled: false,
      sidecar: { state: "disabled" },
      setupHint: "Add a knowledgeBase section to config.json and reload.",
    });

    await expect(runKbSeedCommand(["Checkout redesign"], {}, {} as never)).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_DISABLED",
      details: expect.stringContaining("knowledgeBase"),
    });

    expect(createAgent).not.toHaveBeenCalled();
  });

  it("creates one agent per name, each prompt carrying the brief and the name", async () => {
    const result = await runKbSeedCommand(
      ["Checkout redesign", "Widget pricing revamp"],
      {},
      {} as never,
    );

    expect(createAgent).toHaveBeenCalledTimes(2);
    const prompts = createAgent.mock.calls.map((call) => call[0].initialPrompt as string);
    expect(prompts[0]).toContain("Checkout redesign");
    expect(prompts[0]).toContain("kb_search");
    expect(prompts[0]).toContain("recall self-check");
    expect(prompts[1]).toContain("Widget pricing revamp");

    expect(result.data).toEqual([
      {
        name: "Checkout redesign",
        agentId: "agent-Seed: Checkout redesign",
        title: "Seed: Checkout redesign",
      },
      {
        name: "Widget pricing revamp",
        agentId: "agent-Seed: Widget pricing revamp",
        title: "Seed: Widget pricing revamp",
      },
    ]);
  });

  it("includes the hint in every created agent's prompt", async () => {
    await runKbSeedCommand(["Checkout redesign"], { hint: "it's in the mobile repo" }, {} as never);

    const prompt = createAgent.mock.calls.at(-1)?.[0].initialPrompt as string;
    expect(prompt).toContain("it's in the mobile repo");
  });

  it("labels each agent with a standard task class and a budget", async () => {
    await runKbSeedCommand(["Checkout redesign"], {}, {} as never);

    const labels = createAgent.mock.calls.at(-1)?.[0].labels as Record<string, string>;
    expect(labels["paseo.task-class"]).toBe("standard");
    expect(labels["paseo.budget"]).toMatch(/^\d+$/);
  });

  it("rejects with no project names", async () => {
    await expect(runKbSeedCommand([], {}, {} as never)).rejects.toMatchObject({
      code: "MISSING_PROJECT_NAME",
    });
  });
});
