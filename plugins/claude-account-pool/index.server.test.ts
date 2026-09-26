import { existsSync } from "node:fs";
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
        exposeClassifierTool: false,
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

  it("END TO END: the leader's hard class holds claude-opus-5-5 and an explicit request runs it, loudly, though Claude Code doesn't advertise it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { server, dispatchBefore } = fakeServer();
    const cleanup = contribute(server);
    const policy = (allowUnlistedModels: string[]) => ({
      schemaVersion: 4,
      roles: [
        { id: "worker", name: "worker", standard: true, aliases: [], models: [] },
        { id: "reviewer", name: "reviewer", standard: true, aliases: [], models: [] },
        { id: "advisor", name: "advisor", standard: true, aliases: [], models: [] },
        {
          id: "leader",
          name: "leader",
          standard: true,
          aliases: [],
          models: ["claude-opus-5", "claude-sonnet-5"],
          // Mirrors Tyler's live leader pools, plus the model his CLI accepts but doesn't advertise.
          hardModels: ["claude-opus-5-5", "claude-fable-5-1", "claude-opus-5"],
        },
      ],
      agentTypeMappings: {},
      modelBudgetThresholdPct: 80,
      enforceToolsOnClassifiedRoles: false,
      allowUnlistedModels,
      revision: "test",
    });
    const providers = {
      claude: { params: { accountPool: { role: "leader", priority: 1 } } },
      "claude-personal": { params: { accountPool: { role: "worker", priority: 1 } } },
    };
    const request = (): PluginBeforeRequests["agent.create"] =>
      ({
        config: { provider: "claude-personal", model: "claude-opus-5-5", cwd: "/tmp" },
        labels: { "paseo.task-class": "hard" },
      }) as unknown as PluginBeforeRequests["agent.create"];
    // What `list_models` really returned: no opus-5-5.
    const advertise = (paseo: PluginHookContext["paseo"]) => {
      (paseo.providers as unknown as { listModels: unknown }).listModels = vi.fn().mockResolvedValue({
        models: ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"].map((id) => ({ id })),
      });
    };

    const allowed = fakePaseo({ providers, agentModelPolicy: policy(["claude-opus-5-5"]) });
    advertise(allowed.paseo);
    const honored = await dispatchBefore("agent.create", request(), fakeContext(allowed.paseo));

    expect(honored.config.model).toBe("claude-opus-5-5");
    expect((honored as { labels?: Record<string, string> }).labels).toMatchObject({
      "paseo.model-unadvertised": "claude-personal/claude-opus-5-5",
    });
    const logged = errors.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("UNVERIFIED MODEL");
    expect(logged).toContain("claude-personal/claude-opus-5-5");
    cleanup();

    // Same request, no allowlist: the catalog check holds, as it did before this feature.
    const second = fakeServer();
    const cleanupSecond = contribute(second.server);
    const refused = fakePaseo({ providers, agentModelPolicy: policy([]) });
    advertise(refused.paseo);
    const overridden = await second.dispatchBefore("agent.create", request(), fakeContext(refused.paseo));

    expect(overridden.config.model).toBe("claude-fable-5-1");
    expect(errors.mock.calls.map((call) => String(call[0])).join("\n")).toContain("allowUnlistedModels");
    cleanupSecond();
    errors.mockRestore();
  });

  describe("against the live config shape (agentModelPolicy exactly as `~/.paseo/config.json` stores it)", () => {
    // Copied from Tyler's live config on 2026-09-23: the shape the daemon's
    // config.get really returns, including field order and `revision`. Nothing
    // here is built through the plugin's own types.
    const LIVE_POLICY = {
      schemaVersion: 4,
      roles: [
        {
          id: "worker",
          name: "Worker",
          standard: true,
          aliases: [],
          models: ["claude-sonnet-5", "claude-haiku-4-5-20251001"],
          mechanicalModels: ["claude-haiku-4-5-20251001"],
          hardModels: ["claude-opus-5-5", "claude-opus-5"],
          toolProfile: { kind: "unrestricted" },
        },
        { id: "reviewer", name: "Reviewer", standard: true, aliases: ["check"], models: ["claude-sonnet-5"], mechanicalModels: [], hardModels: ["claude-opus-5-5", "claude-opus-5"], toolProfile: { kind: "read-only" } },
        { id: "advisor", name: "Advisor", standard: true, aliases: ["oracle"], models: ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5"], mechanicalModels: [], hardModels: [], toolProfile: { kind: "unrestricted" } },
        {
          id: "leader",
          name: "leader",
          standard: true,
          aliases: [],
          models: ["claude-opus-5-5", "claude-opus-5"],
          mechanicalModels: [],
          hardModels: ["claude-opus-5-5", "claude-opus-5"],
          toolProfile: { kind: "unrestricted" },
        },
      ],
      agentTypeMappings: { worker: "worker", scout: "worker", researcher: "worker", delegate: "worker", reviewer: "reviewer", oracle: "advisor", advisor: "advisor" },
      modelBudgetThresholdPct: 80,
      enforceToolsOnClassifiedRoles: false,
      revision: "fe14369d-b38d-4d23-9208-217782f447ff",
    };
    const PROVIDERS = {
      claude: { params: { accountPool: { role: "leader", priority: 1 } } },
      "claude-personal": { params: { accountPool: { role: "worker", priority: 1 } } },
    };
    // What list_models returned live: no claude-opus-5-5.
    const ADVERTISED = ["claude-opus-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5"];

    function harness(config: Record<string, unknown>) {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const { server, dispatchBefore } = fakeServer();
      const cleanup = contribute(server);
      const live = fakePaseo(config);
      (live.paseo.providers as unknown as { listModels: unknown }).listModels = vi
        .fn()
        .mockResolvedValue({ models: ADVERTISED.map((id) => ({ id })) });
      const logged = () => errors.mock.calls.map((call) => String(call[0])).join("\n");
      return {
        live,
        logged,
        create: (model: string | undefined, extra: Record<string, unknown> = {}) =>
          dispatchBefore(
            "agent.create",
            { config: { provider: "claude-personal", ...(model ? { model } : {}), cwd: "/tmp" }, ...extra } as unknown as PluginBeforeRequests["agent.create"],
            fakeContext(live.paseo),
          ),
        done: () => {
          cleanup();
          errors.mockRestore();
        },
      };
    }

    /**
     * `exposeClassifierTool` defaults OFF, and while it is off the feature
     * must run NO code at all — no socket, no temp directory, no bridge
     * written to disk.
     *
     * This is the shape of the outage, not a tidiness preference: the first
     * version resolved the bridge's path at module scope, so it ran while the
     * flag was false, threw `TypeError: Invalid URL` inside the daemon's
     * eval'd bundle, and took account routing, model policy and tool
     * enforcement down with it. A disabled feature that can do that is a
     * disabled feature with a live blast radius.
     */
    it("adds no MCP server while the classifier tool is switched off (the default)", async () => {
      const h = harness({ providers: PROVIDERS, agentModelPolicy: LIVE_POLICY });

      const created = await h.create(undefined);

      expect(created.config).not.toHaveProperty("mcpServers");
      h.done();
    });

    it("adds it, pointed at a bridge it wrote itself, once the operator switches it on", async () => {
      const h = harness({
        providers: PROVIDERS,
        agentModelPolicy: { ...LIVE_POLICY, exposeClassifierTool: true },
      });

      const created = await h.create(undefined);

      const servers = (created.config as { mcpServers?: Record<string, { command: string; args: string[]; env: Record<string, string> }> }).mcpServers;
      const entry = servers?.["paseo-agent-policy"];
      expect(entry).toBeDefined();
      // The path is one the plugin created at runtime, never one resolved
      // relative to the bundle — which it cannot do.
      expect(existsSync(entry?.args[0] as string)).toBe(true);
      expect(entry?.command).toBe(process.execPath);
      expect(entry?.env.PASEO_CLASSIFIER_SOCKET).toBeTruthy();
      h.done();
    });

    it("REGRESSION: an allowlist written AFTER the plugin started applies to the very next create, with no reload and no 60s wait", async () => {
      // This is the live failure: the config was patched at 19:25:10 and the
      // create at 19:25:14 was still routed by the policy cached at startup.
      // `role-model-policy.read` bypasses the cache, so it showed the
      // allowlist while the router and `explain` did not. Every earlier test
      // built its policy BEFORE activation, so none could see a stale cache.
      const h = harness({ providers: PROVIDERS, agentModelPolicy: LIVE_POLICY });
      const hard = { labels: { "paseo.task-class": "hard" } };

      const before = await h.create("claude-opus-5-5", hard); // plugin warmed with NO allowlist
      expect(before.config.model).toBe("claude-opus-5"); // refused: the state the operator saw

      h.live.configGet.mockResolvedValue({
        requestId: "r2",
        config: { providers: PROVIDERS, agentModelPolicy: { ...LIVE_POLICY, allowUnlistedModels: ["claude-opus-5-5"] } },
      });
      const after = await h.create("claude-opus-5-5", hard); // dispatched immediately, no timers advanced

      expect(after.config.model).toBe("claude-opus-5-5");
      expect((after as { labels?: Record<string, string> }).labels).toMatchObject({
        "paseo.model-unadvertised": "claude-personal/claude-opus-5-5",
      });
      expect(h.logged()).toContain("UNVERIFIED MODEL");
      h.done();
    });

    it("makes claude-opus-5-5 the leader's DEFAULT: a root create with no model, or with the UI's own pick, lands on it", async () => {
      const h = harness({
        providers: PROVIDERS,
        agentModelPolicy: { ...LIVE_POLICY, allowUnlistedModels: ["claude-opus-5-5"] },
      });

      const noModel = await h.create(undefined); // no explicit signal: ordered selection decides
      expect(noModel.config.model).toBe("claude-opus-5-5");

      const uiPick = await h.create("claude-sonnet-5"); // not in the leader pool: policy default wins
      expect(uiPick.config.model).toBe("claude-opus-5-5");

      expect(h.logged()).toContain("selected \"claude-opus-5-5\" as its default");
      h.done();
    });

    it("without the allowlist the leader default falls to the advertised opus-5, unchanged from before", async () => {
      const h = harness({ providers: PROVIDERS, agentModelPolicy: LIVE_POLICY });

      const result = await h.create(undefined);

      expect(result.config.model).toBe("claude-opus-5");
      expect(h.logged()).not.toContain("UNVERIFIED MODEL");
      h.done();
    });
  });
});
