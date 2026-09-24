import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type RoleModelPolicy } from "../shared/role-policy-schema";
import { queryToInput, startClassifierToolServer, type ClassifierToolServer } from "./classifier-tool";
import type { ClassifierWorld } from "./classifier";

/**
 * End-to-end over the real transport: the bridge is spawned exactly as the
 * daemon spawns it — `process.execPath` against the path the server itself
 * materialized — it speaks JSON-RPC on stdio, and its answers come back from
 * a live classifier over the socket. Asserting that output is the only way to
 * know the MCP surface works; nothing else in this repo speaks the protocol.
 *
 * Spawning the server's OWN `bridgePath` rather than a file checked into the
 * plugin is the point: the plugin ships no such file, because a plugin
 * evaluated from a bundle cannot locate one (see classifier-tool.ts).
 */

const POLICY: RoleModelPolicy = {
  ...DEFAULT_POLICY,
  roles: DEFAULT_POLICY.roles.map((role) =>
    role.id === "worker"
      ? { ...role, models: ["claude-sonnet-5"], mechanicalModels: ["claude-haiku-4-5-20251001"] }
      : role,
  ),
};

function world(): ClassifierWorld {
  return {
    policy: POLICY,
    catalog: new Map([["claude", new Set(["claude-sonnet-5", "claude-haiku-4-5-20251001"])]]),
    thinkingCatalog: new Map([
      [
        "claude",
        new Map([
          ["claude-sonnet-5", { optionIds: ["off", "low", "medium", "high", "xhigh", "max", "ultracode"], defaultOptionId: "high" }],
          ["claude-haiku-4-5-20251001", { optionIds: [] }],
        ]),
      ],
    ]),
    pool: { workers: [{ providerId: "claude-work", priority: 1 }], leader: { providerId: "claude-personal" } },
    health: {
      isHealthyFor: () => true,
      isHealthyForAllWindows: () => true,
      isLastResortEligible: () => true,
      windowUtilization: () => undefined,
      describeWindow: () => undefined,
      windowIds: () => [],
    },
    nowMs: 1_700_000_000_000,
  } as ClassifierWorld;
}

let server: ClassifierToolServer | null = null;
let shim: ChildProcessWithoutNullStreams | null = null;
let directory: string | null = null;

afterEach(() => {
  shim?.kill();
  shim = null;
  server?.close();
  server = null;
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
    directory = null;
  }
});

/** Starts the socket + shim pair and returns a `send` that resolves the matching JSON-RPC reply. */
function startShim(): (message: Record<string, unknown>) => Promise<Record<string, unknown>> {
  directory = mkdtempSync(join(tmpdir(), "classifier-tool-test-"));
  server = startClassifierToolServer({ world, socketPath: join(directory, "s.sock") });
  shim = spawn(process.execPath, [server.bridgePath], {
    env: { ...process.env, PASEO_CLASSIFIER_SOCKET: server.socketPath },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  let buffer = "";
  shim.stdout.setEncoding("utf8");
  shim.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.trim().length === 0) continue;
      const message = JSON.parse(line) as { id?: number };
      if (typeof message.id === "number") {
        pending.get(message.id)?.(message as Record<string, unknown>);
        pending.delete(message.id);
      }
    }
  });

  return (message) =>
    new Promise((resolve) => {
      pending.set(message.id as number, resolve);
      shim?.stdin.write(`${JSON.stringify(message)}\n`);
    });
}

describe("the agent_model_policy MCP tool", () => {
  it("writes its own bridge, so nothing has to resolve a path inside the bundle", () => {
    startShim();
    expect(existsSync(server?.bridgePath as string)).toBe(true);
  });

  it("completes an MCP handshake and advertises exactly one tool", async () => {
    const send = startShim();
    const initialized = (await send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    })) as { result: { capabilities: { tools: unknown }; serverInfo: { name: string } } };
    expect(initialized.result.capabilities.tools).toBeDefined();
    expect(initialized.result.serverInfo.name).toBe("paseo-agent-model-policy");

    const listed = (await send({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(["agent_model_policy"]);
  });

  it("answers from the live classifier, not a copy of the rules", async () => {
    const send = startShim();
    const called = (await send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "agent_model_policy", arguments: { agentType: "worker", taskClass: "mechanical" } },
    })) as { result: { content: Array<{ text: string }>; isError?: boolean } };

    const text = called.result.content[0].text;
    expect(called.result.isError).toBeUndefined();
    expect(text).toContain("Role: worker");
    expect(text).toContain("Task class: mechanical (declared)");
    expect(text).toContain("claude-haiku-4-5-20251001");
    // The account comes from the same ladder the account router walks.
    expect(text).toContain("claude-work");
  });

  /**
   * The point of the tool: a caller learns its labels are being guessed, and
   * which label to set instead — before it spawns, not by hitting a wall.
   */
  it("tells a caller which labels would make the decision explicit", async () => {
    const send = startShim();
    const called = (await send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "agent_model_policy", arguments: { title: "audit the migration" } },
    })) as { result: { content: Array<{ text: string }> } };

    const text = called.result.content[0].text;
    expect(text).toContain("classified-seed");
    expect(text).toContain("paseo.agent-role=reviewer");
    expect(text).toContain("paseo.task-class=hard");
  });

  it("reports the thinking level, and that a subagent asking for Ultra Code is overridden", async () => {
    const send = startShim();
    const called = (await send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "agent_model_policy", arguments: { agentType: "worker", requestedThinkingOptionId: "ultracode" } },
    })) as { result: { content: Array<{ text: string }> } };

    const text = called.result.content[0].text;
    expect(text).toContain("Thinking: Extra High");
    expect(text).toContain("paseo.thinking-overridden-by-policy=ultracode");
  });

  it("carries a requested thinking level into the classifier input", () => {
    expect(queryToInput({ requestedThinkingOptionId: "max" }).requestedThinkingOptionId).toBe("max");
    expect(queryToInput({})).not.toHaveProperty("requestedThinkingOptionId");
  });

  it("reports an unknown tool as a protocol error", async () => {
    const send = startShim();
    const called = (await send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "something_else", arguments: {} },
    })) as { error?: { code: number } };
    expect(called.error?.code).toBe(-32602);
  });
});
