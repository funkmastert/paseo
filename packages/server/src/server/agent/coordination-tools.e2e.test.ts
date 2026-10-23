import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

/**
 * The coordination tools against a real daemon (real AgentManager and storage, fake provider),
 * over the same MCP endpoint an agent uses. The unit tests cover the decisions; this proves the
 * wiring: that an agent-scoped session is who it says it is, and that a broadcast to idle
 * children starts no turn unless asked.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Structured tool output is untyped JSON.
type Loose = any;

interface McpClient {
  callTool: (input: {
    name: string;
    args?: Record<string, unknown>;
  }) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
}

async function connect(url: string): Promise<McpClient> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const raw = await experimental_createMCPClient({ transport });
  return {
    callTool: Reflect.get(raw, "callTool").bind(raw),
    close: () => raw.close(),
  };
}

async function callStructured(
  client: McpClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, Loose>> {
  const result = (await client.callTool({ name, args })) as Record<string, Loose>;
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  return result.structuredContent ?? result.content?.[0]?.structuredContent ?? result.content?.[0];
}

async function waitUntil(check: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let tempRoot: string;
let daemon: TestPaseoDaemon;
let topLevel: McpClient;
let parent: McpClient;
let child: McpClient;
let parentId: string;
let childId: string;

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "coordination-e2e-"));
  daemon = await createTestPaseoDaemon({ agentClients: createTestAgentClients() });
  const base = `http://127.0.0.1:${daemon.port}/mcp/agents`;
  topLevel = await connect(base);

  const created = await callStructured(topLevel, "create_agent", {
    relationship: { kind: "detached" },
    workspace: { kind: "create", source: { kind: "directory", path: tempRoot } },
    title: "Coordination parent",
    provider: "claude/claude-test-model",
    initialPrompt: "say done and stop",
    settings: { modeId: "bypassPermissions" },
    background: true,
  });
  parentId = String(created.agentId);
  parent = await connect(`${base}?callerAgentId=${parentId}`);

  const kid = await callStructured(parent, "create_agent", {
    relationship: { kind: "subagent" },
    workspace: { kind: "current" },
    title: "Coordination child",
    provider: "claude/claude-test-model",
    initialPrompt: "say done and stop",
    notifyOnFinish: false,
    labels: { "paseo.agent-role": "reviewer" },
  });
  childId = String(kid.agentId);
  child = await connect(`${base}?callerAgentId=${childId}`);
  await waitUntil(
    () => daemon.daemon.agentManager.getAgent(childId)?.lifecycle === "idle",
    "the child to go idle",
  );
}, 30_000);

afterAll(async () => {
  await child?.close();
  await parent?.close();
  await topLevel?.close();
  await daemon?.close();
  await rm(tempRoot, { recursive: true, force: true });
});

/** Every turn the fake provider runs appends assistant output, so growth means a turn ran. */
function timelineLengthOf(agentId: string): number {
  return daemon.daemon.agentManager.getTimeline(agentId).length;
}

describe("coordination tools over MCP", () => {
  test("whoami answers for the agent the URL names, with its parent", async () => {
    const who = await callStructured(child, "whoami");

    expect(who.id).toBe(childId);
    expect(who.parent).toMatchObject({ id: parentId, title: "Coordination parent" });
    expect(who.account.provider).toBe("claude");
    expect(who.classifier.role).toBe("reviewer");
  });

  test("the parent sees the child as a peer, and whoami counts it", async () => {
    const peers = await callStructured(parent, "list_peers");
    expect(peers.agents.map((agent: { id: string }) => agent.id)).toEqual([childId]);

    const who = await callStructured(parent, "whoami");
    expect(who.children).toMatchObject({ count: 1, byState: { idle: 1 } });
  });

  test("a broadcast to an idle child starts no turn; wakeIdle starts exactly one", async () => {
    const before = timelineLengthOf(childId);

    const skipped = await callStructured(parent, "broadcast_agent_prompt", {
      prompt: "Please re-check your findings.",
      labels: { "paseo.agent-role": "reviewer" },
    });
    expect(skipped).toMatchObject({
      matched: 1,
      steered: 0,
      woken: 0,
      skipped: 1,
      turnsStarted: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(timelineLengthOf(childId)).toBe(before);
    expect(daemon.daemon.agentManager.getAgent(childId)?.lifecycle).toBe("idle");

    const woken = await callStructured(parent, "broadcast_agent_prompt", {
      prompt: "Please re-check your findings.",
      labels: { "paseo.agent-role": "reviewer" },
      wakeIdle: true,
    });
    expect(woken).toMatchObject({ woken: 1, turnsStarted: 1 });
    await waitUntil(() => timelineLengthOf(childId) > before, "the woken child's turn");
  });

  test("whoami is refused for a top-level session", async () => {
    const result = (await topLevel.callTool({ name: "whoami", args: {} })) as Record<string, Loose>;
    expect(result.isError).toBe(true);
  });
});
