import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { openCoordination, type Coordination } from "../../coordination/coordination.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import { registerCoordinationTools } from "./coordination-tools.js";
import type { PaseoToolExecutionContext, PaseoToolResult } from "./types.js";

// Tool payloads are asserted field by field; each test states the shape it expects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Structured tool output is untyped JSON.
type Loose = any;
type Handler = (input: Loose, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>;

let paseoHome: string;
let coordination: Coordination;

beforeEach(async () => {
  paseoHome = await fs.mkdtemp(path.join(os.tmpdir(), "coordination-queue-tools-"));
  coordination = await openCoordination({
    paseoHome,
    config: { enabled: true },
    logger: createTestLogger(),
  });
});

afterEach(async () => {
  await fs.rm(paseoHome, { recursive: true, force: true });
});

function register(options: { callerAgentId?: string; enabled: boolean }): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  registerCoordinationTools({
    registerTool: (name, _config, handler) => tools.set(name, handler),
    // The queue tools never touch the agent manager or storage.
    agentManager: {} as AgentManager,
    agentStorage: {} as AgentStorage,
    ...(options.callerAgentId ? { callerAgentId: options.callerAgentId } : {}),
    logger: createTestLogger(),
    ...(options.enabled ? { coordination: { require: async () => coordination } } : {}),
  });
  return tools;
}

async function call(tools: Map<string, Handler>, name: string, input: Loose): Promise<Loose> {
  const handler = tools.get(name);
  if (!handler) throw new Error(`tool ${name} not registered`);
  const result = await handler(input, {} as PaseoToolExecutionContext);
  return result.structuredContent;
}

describe("queue tools", () => {
  test("register only when coordination is enabled", () => {
    expect([...register({ enabled: false }).keys()].some((name) => name.startsWith("queue_"))).toBe(
      false,
    );
    expect([...register({ enabled: true, callerAgentId: "agent-a" }).keys()]).toEqual(
      expect.arrayContaining([
        "queue_create",
        "queue_claim",
        "queue_update",
        "queue_handoff",
        "queue_list",
        "queue_show",
      ]),
    );
  });

  test("the caller is the actor, and output is a compact row plus the next action", async () => {
    const tools = register({ enabled: true, callerAgentId: "agent-a" });
    const created = await call(tools, "queue_create", {
      id: "wi-1",
      title: "Review the plan",
      owner: "agent-a",
      body: "x".repeat(2000),
    });
    expect(created).toEqual({
      result: "created",
      item: {
        id: "wi-1",
        title: "Review the plan",
        owner: "agent-a",
        state: "pending",
        closure: null,
        delivery: "not_attempted",
      },
      next: "Claim it with queue_claim when you start.",
    });
    expect((await coordination.queue.get("wi-1"))?.item.createdBy).toBe("agent-a");

    const again = await call(tools, "queue_create", {
      id: "wi-1",
      title: "Review the plan",
      owner: "agent-a",
      body: "x".repeat(2000),
    });
    expect(again.result).toBe("unchanged (already exists)");

    const claimed = await call(tools, "queue_claim", { id: "wi-1" });
    expect(claimed).toMatchObject({ result: "claimed", item: { state: "in-progress" } });
    expect(claimed.next).toMatch(/queue_update/);

    const done = await call(tools, "queue_update", {
      id: "wi-1",
      state: "done",
      closure: { reason: "no-follow-on" },
    });
    expect(done).toMatchObject({
      result: "moved to done",
      item: { state: "done", closure: "no-follow-on" },
    });
  });

  test("full: true returns the whole item; show returns recent transitions", async () => {
    const tools = register({ enabled: true, callerAgentId: "agent-a" });
    const created = await call(tools, "queue_create", {
      title: "Review",
      owner: "human",
      full: true,
    });
    expect(created.item).toMatchObject({ revision: 1, createdAt: expect.any(String) });
    const shown = await call(tools, "queue_show", { id: created.item.id });
    expect(shown.transitions).toEqual([
      { at: expect.any(String), from: null, to: "pending", actor: "agent-a" },
    ]);
  });

  test("queue_update refuses a done without a closure, with what to send instead", async () => {
    const tools = register({ enabled: true, callerAgentId: "agent-a" });
    await call(tools, "queue_create", { id: "wi-2", title: "Review", owner: "agent-a" });
    await expect(call(tools, "queue_update", { id: "wi-2", state: "done" })).rejects.toThrow(
      /closure/,
    );
  });

  test("handoff returns both halves; list filters to mine and open by default", async () => {
    const tools = register({ enabled: true, callerAgentId: "agent-a" });
    await call(tools, "queue_create", { id: "wi-3", title: "Review", owner: "agent-a" });
    await call(tools, "queue_create", { id: "wi-4", title: "Other", owner: "agent-c" });
    const handed = await call(tools, "queue_handoff", { id: "wi-3", to: "agent-b" });
    expect(handed).toMatchObject({
      result: "handed off",
      source: { id: "wi-3", state: "handed-off" },
      successor: { owner: "agent-b", state: "pending", handedOffFrom: "wi-3" },
      next: "Waiting for agent-b to claim it.",
    });
    const mine = await call(tools, "queue_list", { owner: "me" });
    expect(mine).toEqual({ count: 0, items: [] });
    const all = await call(tools, "queue_list", {});
    expect(all.items.map((item: Loose) => item.id).sort()).toEqual(
      [handed.successor.id, "wi-4"].sort(),
    );
  });
});
