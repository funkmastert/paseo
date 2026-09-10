import { describe, expect, it, vi } from "vitest";
import type { PluginBeforeRequests, PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "./index.server";

type BeforeHandler = (
  input: { request: PluginBeforeRequests["agent.create"] },
  context: PluginHookContext,
) => PluginBeforeRequests["agent.create"] | void | Promise<PluginBeforeRequests["agent.create"] | void>;
type OnHandler = (event: unknown, context: PluginHookContext) => void;

/**
 * Minimal fake of the plugin server harness: captures registered hooks so
 * the test can dispatch them directly, the way the daemon would.
 */
function fakeServer() {
  const beforeHandlers = new Map<string, BeforeHandler>();
  const onHandlers = new Map<string, OnHandler>();
  const server = {
    before: ((name: string, handler: BeforeHandler) => {
      beforeHandlers.set(name, handler);
      return () => beforeHandlers.delete(name);
    }) as PluginServerContext["before"],
    on: ((name: string, handler: OnHandler) => {
      onHandlers.set(name, handler);
      return () => onHandlers.delete(name);
    }) as PluginServerContext["on"],
  } as unknown as PluginServerContext;
  return { server, beforeHandlers, onHandlers };
}

function fakePaseo() {
  const configGet = vi.fn().mockResolvedValue({ requestId: "r1", config: { providers: {} } });
  const providersSnapshot = vi.fn().mockResolvedValue({ entries: [], generatedAt: "now", requestId: "r1" });
  const listUsage = vi.fn().mockResolvedValue({ providers: [] });
  const agentsList = vi.fn().mockResolvedValue({ entries: [] });
  const paseo = {
    config: { get: configGet },
    providers: { snapshot: providersSnapshot, listUsage },
    agents: { list: agentsList, ref: vi.fn() },
  } as unknown as PluginHookContext["paseo"];
  return { paseo, configGet, providersSnapshot, listUsage, agentsList };
}

const fakeContext = (paseo: PluginHookContext["paseo"]) => ({ paseo, signal: new AbortController().signal }) as PluginHookContext;

describe("contribute (index.server)", () => {
  it("immediately refreshes both the pool cache and provider-id cache on the first paseo capture, without waiting for the 60s interval", async () => {
    const { server, onHandlers } = fakeServer();
    const cleanup = contribute(server);
    const { paseo, configGet, providersSnapshot } = fakePaseo();

    // agent.turn_ended captures paseo without going through the router (which has
    // its own, separately-tested, failOpen-triggered refresh) — isolating this
    // assertion to the first-capture refresh alone.
    const onTurnEnded = onHandlers.get("agent.turn_ended");
    expect(onTurnEnded).toBeDefined();

    const agent = { id: "a1", workspaceId: null, parentAgentId: null, provider: "human-claude", cwd: "/tmp", title: null };
    onTurnEnded?.({ agent, turnId: null, outcome: { kind: "completed" }, timeline: [] }, fakeContext(paseo));

    // Dispatching the hook is synchronous from the daemon's perspective;
    // the refresh must be fired without being awaited here.
    expect(configGet).not.toHaveBeenCalled();
    expect(providersSnapshot).not.toHaveBeenCalled();

    // Flush the microtask queue.
    await Promise.resolve();
    await Promise.resolve();

    expect(configGet).toHaveBeenCalledTimes(1);
    expect(providersSnapshot).toHaveBeenCalledTimes(1);

    cleanup();
  });
});
