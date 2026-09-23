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
 *
 * `before` supports multiple registrations per event name (the real daemon
 * does — index.server.ts registers TWO separate "agent.create" handlers, the
 * role hook and the account hook, run in registration order with each
 * output feeding the next input; see PluginHookHandlers.invoke in
 * packages/server/.../plugins/lifecycle/index.ts).
 */
function fakeServer() {
  const beforeHandlers = new Map<string, BeforeHandler[]>();
  const onHandlers = new Map<string, OnHandler>();
  const server = {
    before: ((name: string, handler: BeforeHandler) => {
      const list = beforeHandlers.get(name) ?? [];
      list.push(handler);
      beforeHandlers.set(name, list);
      return () => {
        const remaining = (beforeHandlers.get(name) ?? []).filter((h) => h !== handler);
        beforeHandlers.set(name, remaining);
      };
    }) as PluginServerContext["before"],
    on: ((name: string, handler: OnHandler) => {
      onHandlers.set(name, handler);
      return () => onHandlers.delete(name);
    }) as PluginServerContext["on"],
    // Settings-screen RPC registrations aren't exercised by this test; a
    // no-op is enough to let contribute() finish wiring without throwing.
    handle: vi.fn(),
  } as unknown as PluginServerContext;

  /**
   * Runs every registered "before" handler for `name` in order, each
   * output feeding the next input — mirroring the real dispatcher's
   * `if (result !== undefined) { request = validateBeforeResult(...) }`
   * accumulation (minus the schema validation, irrelevant here).
   */
  async function dispatchBefore(
    name: string,
    request: PluginBeforeRequests["agent.create"],
    context: PluginHookContext,
  ): Promise<PluginBeforeRequests["agent.create"]> {
    let current = request;
    for (const handler of beforeHandlers.get(name) ?? []) {
      const result = await handler({ request: current }, context);
      if (result !== undefined) {
        current = result;
      }
    }
    return current;
  }

  return { server, beforeHandlers, onHandlers, dispatchBefore };
}

function fakePaseo(config: Record<string, unknown> = { providers: {} }) {
  const configGet = vi.fn().mockResolvedValue({ requestId: "r1", config });
  const providerEntries = Object.keys((config.providers as Record<string, unknown>) ?? {}).map((provider) => ({
    provider,
  }));
  const providersSnapshot = vi.fn().mockResolvedValue({ entries: providerEntries, generatedAt: "now", requestId: "r1" });
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
    const { paseo, configGet, providersSnapshot, listUsage } = fakePaseo();

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

    // Flush the microtask queue, including the chained policy -> catalog
    // refresh (policyCache.forceRefresh().then(() => catalogCache.forceRefresh())).
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }

    // Twice: the pool cache and the role-policy cache each read daemon
    // config independently (mirrors pool.ts's own config.get() call).
    expect(configGet).toHaveBeenCalledTimes(2);
    expect(providersSnapshot).toHaveBeenCalledTimes(1);

    // The usage poller must not wait for its own 5-minute interval either —
    // otherwise every account looks healthy (no usage reading at all) for up
    // to 5 minutes after every plugin start or reload.
    expect(listUsage).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("REGRESSION: the FIRST agent.create dispatched right after activation still enforces a restrictive role's tool profile", async () => {
    // Reproduces the production incident exactly: a fully-configured policy
    // (reviewer -> read-only, one model) sitting in daemon config, and an
    // agent.create landing before ensureStarted()'s warm-up has resolved —
    // which, for the FIRST dispatch after every plugin reload/daemon
    // restart, isn't a race that can go either way: forceRefresh() is only
    // even SCHEDULED (onto a microtask) by this same dispatch's call to
    // ensureStarted(), so without an await, `policyCache.get()` is
    // GUARANTEED to still return DEFAULT_POLICY (every role unconfigured,
    // unrestricted) at the moment the role hook reads it.
    const { server, dispatchBefore } = fakeServer();
    const cleanup = contribute(server);
    const { paseo } = fakePaseo({
      providers: {
        claude: { params: { accountPool: { role: "leader", priority: 1 } } },
        "claude-personal": { params: { accountPool: { role: "worker", priority: 1 } } },
      },
      agentModelPolicy: {
        schemaVersion: 3,
        roles: [
          { id: "worker", name: "Worker", standard: true, aliases: [], models: [], toolProfile: { kind: "unrestricted" } },
          {
            id: "reviewer",
            name: "Reviewer",
            standard: true,
            aliases: [],
            models: ["claude-sonnet-5"],
            toolProfile: { kind: "read-only" },
          },
          { id: "advisor", name: "Advisor", standard: true, aliases: [], models: [], toolProfile: { kind: "unrestricted" } },
          { id: "leader", name: "leader", standard: true, aliases: [], models: [], toolProfile: { kind: "unrestricted" } },
        ],
        agentTypeMappings: { reviewer: "reviewer" },
        modelBudgetThresholdPct: 80,
        enforceToolsOnClassifiedRoles: false,
        revision: "test",
      },
    });

    const request: PluginBeforeRequests["agent.create"] = {
      config: { provider: "claude-personal", model: "claude-sonnet-5", cwd: "/tmp" },
      callerAgentId: "c1",
      labels: { "paseo.agent-type": "reviewer" },
    } as unknown as PluginBeforeRequests["agent.create"];

    // No prior hook/RPC dispatch of any kind — this IS the first one, exactly
    // like the very first agent.create after a fresh plugin reload.
    const result = await dispatchBefore("agent.create", request, fakeContext(paseo));

    const options = result.config.providerOptions as { disallowedTools?: string[] } | undefined;
    expect(options?.disallowedTools?.length).toBeGreaterThan(0);
    expect(options?.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Write", "Edit"]));

    cleanup();
  });
});
