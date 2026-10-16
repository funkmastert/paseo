import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PluginBeforeRequests, PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "./index.server";
import { CE_PLUGIN_ID, COMPOUND_POLICY_LABEL, COMPOUND_POLICY_NOTICE } from "./server/compound-policy";
import { DECISION_TOKEN_LABEL } from "./server/decision-log";

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

/** One create of a templated fan-out: the same caller, cwd, title and prompt; only the task class differs. */
function fanOutCreate(taskClass: string): PluginBeforeRequests["agent.create"] {
  return {
    config: { provider: "claude-personal", cwd: "/tmp", title: "fan-out" },
    callerAgentId: "caller-1",
    initialPrompt: "do the thing",
    labels: { "paseo.agent-type": "worker", "paseo.task-class": taskClass },
  } as unknown as PluginBeforeRequests["agent.create"];
}

/** Runs one before hook the way the daemon does: on a structured clone, so no object survives from one hook to the next. */
async function runHook(
  hook: BeforeHandler,
  request: PluginBeforeRequests["agent.create"],
  context: PluginHookContext,
): Promise<PluginBeforeRequests["agent.create"]> {
  return (await hook({ request: structuredClone(request) }, context)) ?? request;
}

/** The parsed `classifier-decision` lines among console.log calls. */
function decisionLines(calls: unknown[][]): Record<string, unknown>[] {
  return calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith("classifier-decision "))
    .map((line) => JSON.parse(line.slice("classifier-decision ".length)));
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

    // Three times: the pool cache, the role-policy cache and the MCP gateway
    // cache each read daemon config independently (mirrors pool.ts's own
    // config.get() call).
    expect(configGet).toHaveBeenCalledTimes(3);
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
      const { server, dispatchBefore, beforeHandlers } = fakeServer();
      const cleanup = contribute(server);
      const live = fakePaseo(config);
      (live.paseo.providers as unknown as { listModels: unknown }).listModels = vi
        .fn()
        .mockResolvedValue({ models: ADVERTISED.map((id) => ({ id })) });
      const logged = () => errors.mock.calls.map((call) => String(call[0])).join("\n");
      return {
        live,
        logged,
        hooks: beforeHandlers.get("agent.create") ?? [],
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

    it("REGRESSION: a mechanical worker runs the catalog's Haiku though the policy spells the dated snapshot, and the create logs ONE decision line naming the account that runs", async () => {
      const lines = vi.spyOn(console, "log").mockImplementation(() => {});
      const h = harness({ providers: PROVIDERS, agentModelPolicy: LIVE_POLICY });

      const created = await h.create("claude-sonnet-5", {
        callerAgentId: "caller-1",
        labels: { "paseo.agent-type": "worker", "paseo.task-class": "mechanical" },
      });

      expect(created.config.model).toBe("claude-haiku-4-5");
      const decisions = lines.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("classifier-decision "));
      expect(decisions).toHaveLength(1);
      expect(JSON.parse(decisions[0].slice("classifier-decision ".length))).toMatchObject({
        caller: "child",
        taskClass: { value: "mechanical", source: "declared" },
        model: { ref: "claude-haiku-4-5", resolvedFrom: "claude-haiku-4-5-20251001", poolSlot: "mechanical", final: "claude-haiku-4-5" },
        account: { providerId: created.config.provider },
      });
      lines.mockRestore();
      h.done();
    });

    // The remediation ladder starts its agents with no calling agent and labels them workers.
    // They used to run as leaders anyway: Opus 5.5 at Extra High, on the leader account.
    it("REGRESSION: a caller-less create labelled a mechanical worker runs Haiku on a worker account", async () => {
      const h = harness({ providers: PROVIDERS, agentModelPolicy: LIVE_POLICY });

      const created = await h.create(undefined, {
        config: { provider: "claude", cwd: "/tmp" },
        labels: { "paseo.agent-type": "worker", "paseo.task-class": "mechanical" },
      });

      expect(created.config.model).toBe("claude-haiku-4-5");
      expect(created.config.provider).toBe("claude-personal");
      h.done();
    });

    it("an unlabelled caller-less create is still the leader, on the account it asked for", async () => {
      const h = harness({
        providers: PROVIDERS,
        agentModelPolicy: { ...LIVE_POLICY, allowUnlistedModels: ["claude-opus-5-5"] },
      });

      const created = await h.create(undefined, { config: { provider: "claude", cwd: "/tmp" } });

      expect(created.config.model).toBe("claude-opus-5-5");
      expect(created.config.provider).toBe("claude");
      h.done();
    });

    it("REGRESSION: two concurrent creates that differ only in task class each log their own decision when they finish in reverse order", async () => {
      const lines = vi.spyOn(console, "log").mockImplementation(() => {});
      const h = harness({ providers: PROVIDERS, agentModelPolicy: LIVE_POLICY });
      const [roleHook, accountHook] = h.hooks;
      const context = fakeContext(h.live.paseo);

      const mechanical = await runHook(roleHook, fanOutCreate("mechanical"), context);
      const hard = await runHook(roleHook, fanOutCreate("hard"), context);
      const hardOut = await runHook(accountHook, hard, context);
      const mechanicalOut = await runHook(accountHook, mechanical, context);

      const decisions = decisionLines(lines.mock.calls);
      expect(decisions).toHaveLength(2);
      expect(decisions[0]).toMatchObject({
        taskClass: { value: "hard" },
        model: { ref: "claude-opus-5", poolSlot: "hard", final: hardOut.config.model },
      });
      expect(decisions[1]).toMatchObject({
        taskClass: { value: "mechanical" },
        model: { ref: "claude-haiku-4-5", poolSlot: "mechanical", final: mechanicalOut.config.model },
      });
      // The pairing token is the plugin's own bookkeeping and never reaches the daemon.
      for (const out of [hardOut, mechanicalOut]) {
        expect(Object.keys((out as { labels?: Record<string, string> }).labels ?? {})).not.toContain(DECISION_TOKEN_LABEL);
      }
      lines.mockRestore();
      h.done();
    });

    it("REGRESSION: no line a create logs grows with a caller-supplied string, whichever label, model, level or provider carries it", async () => {
      const lines = vi.spyOn(console, "log").mockImplementation(() => {});
      const h = harness({ providers: PROVIDERS, agentModelPolicy: LIVE_POLICY });
      const [roleHook, accountHook] = h.hooks;
      const context = fakeContext(h.live.paseo);
      const huge = (char: string) => char.repeat(2_000_000);
      const create = (provider: string) =>
        ({
          config: { provider, model: huge("m"), thinkingOptionId: huge("t"), cwd: "/tmp" },
          callerAgentId: "caller-1",
          labels: {
            "paseo.agent-role": huge("r"),
            "paseo.task-class": huge("c"),
            "paseo.mcp": [huge("s"), ...Array.from({ length: 10_000 }, (_, index) => `server-${index}`)].join(","),
          },
        }) as unknown as PluginBeforeRequests["agent.create"];

      // A pooled account, then a provider outside the pool, which the account router passes through as asked.
      for (const provider of ["claude-personal", huge("p")]) {
        await runHook(accountHook, await runHook(roleHook, create(provider), context), context);
      }

      // Every episode the create raises actually ran, so each of their lines is measured below.
      const logged = h.logged();
      for (const episode of ["declared unknown role", "declared unknown task class", "in paseo.mcp", "explicitly requested \"claude-personal/", "explicitly requested thinking level"]) {
        expect(logged).toContain(episode);
      }
      const decisions = lines.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("classifier-decision "));
      expect(decisions).toHaveLength(2);
      for (const line of [...logged.split("\n"), ...decisions]) {
        expect(line.length).toBeLessThan(10_000);
      }
      lines.mockRestore();
      h.done();
    });

    it("without the allowlist the leader default falls to the advertised opus-5, unchanged from before", async () => {
      const h = harness({ providers: PROVIDERS, agentModelPolicy: LIVE_POLICY });

      const result = await h.create(undefined);

      expect(result.config.model).toBe("claude-opus-5");
      expect(h.logged()).not.toContain("UNVERIFIED MODEL");
      h.done();
    });

    describe("JEV's spawn hint (docs/jev.md, Feature 2)", () => {
      const LANE = {
        today: { calls: 0, answered: 0, failed: 0, unavailable: 0, inputTokens: 0, usd: 0, usdSource: "none" },
        maxUsdPerDay: 1,
        exhausted: false,
        circuit: "closed",
        resetsAt: "2026-09-30T00:00:00.000Z",
      };
      /** `served`: the daemon carries the JEV agent tools (the tools track sets `agentTools.served`). */
      function jevStatus(shadow: boolean, served = false) {
        return {
          available: true,
          reason: null,
          keyPresent: true,
          provider: "fake",
          model: "jev-fake",
          features: { spawnHint: { enabled: true, shadow }, agentTools: { enabled: true, shadow: false } },
          lanes: { control: LANE, agentTools: LANE, interactive: LANE },
          spawnHint: { applyHard: false, applyRole: false },
          agentTools: { assignShare: 0.5, ...(served ? { served: true } : {}) },
          todayByFeature: {},
          last7Days: [],
        };
      }
      /** A mechanical answer both floors accept, for a child whose role is a guess. */
      const MECHANICAL = {
        task_class: { type: "choice", choice: "mechanical", probabilities: {}, confidence: 0.9 },
        reasoning: { type: "score", score: 0.2, legend: {}, probabilities: {}, confidence: 0.9 },
        role: { type: "choice", choice: "worker", probabilities: {}, confidence: 0.9 },
      };
      const UNLABELLED_CHILD = {
        callerAgentId: "caller-1",
        initialPrompt: "Implement the retry helper in src/net.ts and add a unit test.",
      };

      function withJev(
        h: ReturnType<typeof harness>,
        options: {
          shadow: boolean;
          served?: boolean;
          decide: (...args: unknown[]) => Promise<unknown>;
          status?: (...args: unknown[]) => Promise<unknown>;
        },
      ) {
        const decide = vi.fn(options.decide);
        const checkScope = vi.fn().mockResolvedValue("ok");
        const status = vi.fn(options.status ?? (async () => jevStatus(options.shadow, options.served)));
        (h.live.paseo as unknown as { jev: unknown }).jev = { decide, status, checkScope };
        return { decide, checkScope, status };
      }

      /** Runs `creates` on a fresh plugin and returns every create and every decision line, verbatim. */
      async function run(
        creates: Record<string, unknown>[],
        jev?: Omit<Parameters<typeof withJev>[1], "shadow"> & { shadow?: boolean },
      ) {
        const lines = vi.spyOn(console, "log").mockImplementation(() => {});
        const h = harness({ providers: PROVIDERS, agentModelPolicy: LIVE_POLICY });
        const spies = jev ? withJev(h, { shadow: true, ...jev }) : undefined;
        const created: unknown[] = [];
        const elapsedMs: number[] = [];
        for (const extra of creates) {
          const started = Date.now();
          created.push(await h.create("claude-sonnet-5", extra));
          elapsedMs.push(Date.now() - started);
        }
        const logged = lines.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("classifier-decision "));
        lines.mockRestore();
        h.done();
        return { created, logged, elapsedMs, spies };
      }

      const unknownSchema = async () => {
        throw Object.assign(new Error("Unknown request, try upgrading the daemon"), { code: "unknown_schema" });
      };

      function answered(outcome: "answered" | "shadow") {
        return async () => ({
          requestId: "r",
          callId: "jev-call-1",
          outcome,
          reason: null,
          answers: MECHANICAL,
          model: "jev-fake",
          elapsedMs: 5,
        });
      }

      it("live: a mechanical answer moves an unlabelled child to Haiku, labels it, and logs wouldBe", async () => {
        const lines = vi.spyOn(console, "log").mockImplementation(() => {});
        const random = vi.spyOn(Math, "random").mockReturnValue(0.1);
        const h = harness({ providers: PROVIDERS, agentModelPolicy: LIVE_POLICY });
        const { decide, checkScope } = withJev(h, { shadow: false, served: true, decide: answered("answered") });

        const created = await h.create("claude-sonnet-5", UNLABELLED_CHILD);

        expect(created.config.model).toBe("claude-haiku-4-5");
        expect(decide).toHaveBeenCalledTimes(1);
        expect((decide.mock.calls[0] as unknown[])[0]).toMatchObject({
          feature: "spawnHint",
          scope: { cwd: "/tmp", parentAgentId: "caller-1" },
        });
        expect(checkScope).toHaveBeenCalledWith({ cwd: "/tmp", parentAgentId: "caller-1" }, { timeout: 2_000 });
        expect(created.labels).toMatchObject({
          "paseo.task-class-source": "jev",
          "paseo.jev-call": "jev-call-1",
          "paseo.jev-tools": "on",
        });
        const [line] = decisionLines(lines.mock.calls);
        expect(line).toMatchObject({
          taskClass: { value: "mechanical", source: "jev" },
          jev: {
            status: "answered",
            callId: "jev-call-1",
            taskClass: { choice: "mechanical", confidence: 0.9 },
            reasoning: { score: 0.2, confidence: 0.9 },
            applied: true,
            wouldBe: { taskClass: "mechanical", role: "worker", model: "claude-haiku-4-5", move: "down" },
          },
          jevTools: "on",
        });
        random.mockRestore();
        lines.mockRestore();
        h.done();
      });

      it("shadow, the default: the answer is logged as wouldBe and the create runs as today", async () => {
        const lines = vi.spyOn(console, "log").mockImplementation(() => {});
        const h = harness({ providers: PROVIDERS, agentModelPolicy: LIVE_POLICY });
        withJev(h, { shadow: true, decide: answered("shadow") });

        const created = await h.create("claude-sonnet-5", UNLABELLED_CHILD);

        expect(created.config.model).toBe("claude-sonnet-5");
        expect(created.labels).toMatchObject({ "paseo.task-class-source": "default", "paseo.jev-call": "jev-call-1" });
        expect(decisionLines(lines.mock.calls)[0]).toMatchObject({
          taskClass: { value: null, source: "default" },
          jev: { status: "shadow", applied: false, wouldBe: { taskClass: "mechanical", move: "down" } },
        });
        lines.mockRestore();
        h.done();
      });

      it("a daemon without JEV: nothing is asked and the line and labels are today's", async () => {
        const lines = vi.spyOn(console, "log").mockImplementation(() => {});
        const h = harness({ providers: PROVIDERS, agentModelPolicy: LIVE_POLICY });

        const created = await h.create("claude-sonnet-5", UNLABELLED_CHILD);

        expect(created.config.model).toBe("claude-sonnet-5");
        expect(created.labels?.["paseo.jev-call"]).toBeUndefined();
        expect(created.labels?.["paseo.jev-tools"]).toBeUndefined();
        const [line] = decisionLines(lines.mock.calls);
        expect(line).not.toHaveProperty("jev");
        expect(line).not.toHaveProperty("jevTools");
        lines.mockRestore();
        h.done();
      });

      it("a rejected call fails no create and applies nothing", async () => {
        const lines = vi.spyOn(console, "log").mockImplementation(() => {});
        const h = harness({ providers: PROVIDERS, agentModelPolicy: LIVE_POLICY });
        withJev(h, {
          shadow: false,
          decide: async () => {
            throw new Error("socket closed");
          },
        });

        const created = await h.create("claude-sonnet-5", UNLABELLED_CHILD);

        expect(created.config.model).toBe("claude-sonnet-5");
        expect(decisionLines(lines.mock.calls)[0]).toMatchObject({ jev: { status: "unavailable", reason: "error", applied: false } });
        lines.mockRestore();
        h.done();
      });

      it("a daemon that rejects jev.status (a plugin child newer than its daemon) is JEV absent: nothing asked, lines byte-identical", async () => {
        const creates = [UNLABELLED_CHILD, { ...UNLABELLED_CHILD, labels: { "paseo.jev-tools": "on" } }, { initialPrompt: "Rename it." }];

        const absent = await run(creates);
        const mixed = await run(creates, { decide: answered("answered"), status: unknownSchema, served: true });

        expect(mixed.spies?.decide).not.toHaveBeenCalled();
        expect(mixed.spies?.checkScope).not.toHaveBeenCalled();
        expect(mixed.logged).toEqual(absent.logged);
        expect(JSON.stringify(mixed.created)).toBe(JSON.stringify(absent.created));
        expect(mixed.logged.join("\n")).not.toContain('"jev');
      });

      it("a status poll that has not answered yet is JEV unavailable, and a slow one delays no create", async () => {
        const creates = [UNLABELLED_CHILD, UNLABELLED_CHILD];

        const absent = await run(creates);
        const hanging = await run(creates, { decide: answered("answered"), status: () => new Promise(() => {}) });

        expect(hanging.spies?.decide).not.toHaveBeenCalled();
        expect(hanging.logged).toEqual(absent.logged);
        // The warm-up's bound is 5 s and the hint's 2 s; a create that waited on either would show it.
        expect(Math.max(...hanging.elapsedMs)).toBeLessThan(1_000);
      });

      describe("paseo.jev-tools", () => {
        it("is not written while the daemon does not serve the JEV tools, though the feature is on", async () => {
          const { created, logged, spies } = await run([UNLABELLED_CHILD], { decide: answered("shadow"), served: false });

          expect((created[0] as { labels?: Record<string, string> }).labels?.["paseo.jev-tools"]).toBeUndefined();
          expect(spies?.checkScope).not.toHaveBeenCalled();
          expect(JSON.parse(logged[0].slice("classifier-decision ".length))).not.toHaveProperty("jevTools");
        });

        it("once served: the drawn arm replaces a caller's own, and the line records the label the agent keeps", async () => {
          const random = vi.spyOn(Math, "random").mockReturnValue(0.9);
          const { created, logged } = await run([{ ...UNLABELLED_CHILD, labels: { "paseo.jev-tools": "on" } }], {
            decide: answered("shadow"),
            served: true,
          });
          random.mockRestore();

          expect((created[0] as { labels?: Record<string, string> }).labels?.["paseo.jev-tools"]).toBe("control");
          expect(JSON.parse(logged[0].slice("classifier-decision ".length))).toMatchObject({ jevTools: "control" });
        });
      });

      it("a root create never asks", async () => {
        const h = harness({ providers: PROVIDERS, agentModelPolicy: LIVE_POLICY });
        const { decide } = withJev(h, { shadow: false, decide: answered("answered") });

        await h.create(undefined, { initialPrompt: "Rename the helper everywhere." });

        expect(decide).not.toHaveBeenCalled();
        h.done();
      });
    });
  });
});

/**
 * The compound-engineering policy through the whole create chain, the way the daemon runs it:
 * role hook, account hook, then the policy hook, against Claude profiles on disk.
 */
describe("contribute (index.server) — compound-engineering policy for leaders", () => {
  function profileDir(withCe: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), "ce-profile-"));
    mkdirSync(join(dir, "plugins"));
    writeFileSync(join(dir, "settings.json"), JSON.stringify(withCe ? { enabledPlugins: { [CE_PLUGIN_ID]: true } } : {}));
    writeFileSync(
      join(dir, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: withCe ? { [CE_PLUGIN_ID]: [{ scope: "user", version: "3.19.0" }] } : {} }),
    );
    return dir;
  }

  async function run(withCeOnLeader: boolean, request: Record<string, unknown>) {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const leaderDir = profileDir(withCeOnLeader);
    const workerDir = profileDir(true);
    const { server, dispatchBefore } = fakeServer();
    const cleanup = contribute(server);
    const { paseo } = fakePaseo({
      providers: {
        claude: { env: { CLAUDE_CONFIG_DIR: leaderDir }, params: { accountPool: { role: "leader", priority: 1 } } },
        "claude-personal": {
          extends: "claude",
          env: { CLAUDE_CONFIG_DIR: workerDir },
          params: { accountPool: { role: "worker", priority: 1 } },
        },
      },
    });
    try {
      const result = await dispatchBefore(
        "agent.create",
        request as unknown as PluginBeforeRequests["agent.create"],
        fakeContext(paseo),
      );
      return { result, logged: errors.mock.calls.map((call) => String(call[0])).join("\n") };
    } finally {
      cleanup();
      errors.mockRestore();
      logs.mockRestore();
      rmSync(leaderDir, { recursive: true, force: true });
      rmSync(workerDir, { recursive: true, force: true });
    }
  }

  const appendOf = (result: PluginBeforeRequests["agent.create"]) =>
    (result.config.providerOptions as { appendSystemPrompt?: string } | undefined)?.appendSystemPrompt;

  it("injects the policy into a root leader whose profile has the CE plugin", async () => {
    const { result } = await run(true, { config: { provider: "claude", cwd: "/tmp" }, labels: {} });
    expect(result.labels?.[COMPOUND_POLICY_LABEL]).toBe("injected");
    expect(appendOf(result)).toContain(COMPOUND_POLICY_NOTICE);
  });

  it("flags and logs a root leader whose profile lacks the CE plugin, without refusing it", async () => {
    const { result, logged } = await run(false, { config: { provider: "claude", cwd: "/tmp" }, labels: {} });
    expect(result.labels?.[COMPOUND_POLICY_LABEL]).toBe("ce-plugin-missing");
    expect(appendOf(result)).toContain("NOT enabled in this agent's Claude profile");
    expect(logged).toContain("compound-policy: leader on \"claude\"");
  });

  it("leaves a spawned worker child without the policy", async () => {
    const { result } = await run(true, {
      config: { provider: "claude-personal", cwd: "/tmp" },
      callerAgentId: "leader-1",
      labels: { "paseo.agent-type": "worker" },
    });
    expect(result.labels?.[COMPOUND_POLICY_LABEL]).toBeUndefined();
    expect(appendOf(result) ?? "").not.toContain("COMPOUND-ENGINEERING");
  });
});
