import { describe, expect, it, vi } from "vitest";
import type { PluginBeforeRequests, PluginHookContext } from "@getpaseo/plugin/server";
import type { ResolvedPool } from "../shared/pool-config";
import { AGENT_ROLE_LABEL, AGENT_TYPE_LABEL, DEFAULT_POLICY, type RoleModelPolicy } from "../shared/role-policy-schema";
import { createHealthTracker } from "./health";
import type { ModelCatalog } from "./model-catalog";
import { createRouter } from "./router";
import { createRecentAgentTypes } from "./recent-agent-types";
import { createRoleRouter, type RoleRouterOptions } from "./role-router";

type CreateAgentRequest = PluginBeforeRequests["agent.create"];

function request(overrides: Record<string, unknown>): { request: CreateAgentRequest } {
  return {
    request: {
      config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp/work" },
      ...overrides,
    } as unknown as CreateAgentRequest,
  };
}

const fakeContext = {} as PluginHookContext;

function fakePolicyCache(policy: RoleModelPolicy) {
  return { get: () => policy, isMalformed: () => false, lastError: () => undefined, forceRefresh: vi.fn(), stop: vi.fn() };
}

function fakeCatalogCache(catalog: ModelCatalog) {
  return { get: () => catalog, forceRefresh: vi.fn(), stop: vi.fn() };
}

function fakePoolCache(pool: ResolvedPool, failOpen = false) {
  return { get: () => ({ pool, failOpen }), forceRefresh: vi.fn(), stop: vi.fn() };
}

function catalog(entries: Record<string, string[]>): ModelCatalog {
  return new Map(Object.entries(entries).map(([family, models]) => [family, new Set(models)]));
}

function policyWithWorkerModels(models: string[]): RoleModelPolicy {
  return {
    ...DEFAULT_POLICY,
    roles: DEFAULT_POLICY.roles.map((role) => (role.id === "worker" ? { ...role, models } : role)),
  };
}

function baseOptions(overrides: Partial<RoleRouterOptions> = {}): RoleRouterOptions {
  return {
    policyCache: fakePolicyCache(DEFAULT_POLICY),
    catalogCache: fakeCatalogCache(new Map()),
    poolCache: fakePoolCache({ workers: [], leader: null }),
    health: createHealthTracker(),
    recentAgentTypes: createRecentAgentTypes(),
    ...overrides,
  };
}

describe("createRoleRouter", () => {
  it("returns the request untouched when there is no callerAgentId (human-created leaders)", () => {
    const router = createRoleRouter(baseOptions({ policyCache: fakePolicyCache(policyWithWorkerModels(["codex/gpt-5.1"])) }));

    const result = router(request({}), fakeContext);

    expect(result).toBeUndefined();
  });

  it("UNCONFIGURED: passes an empty-models role through byte-identical", () => {
    const router = createRoleRouter(baseOptions());

    const result = router(request({ callerAgentId: "c1" }), fakeContext);

    expect(result).toBeUndefined();
  });

  it("rewrites config.model when the resolved role's top model is catalog-eligible", () => {
    const router = createRoleRouter(
      baseOptions({
        policyCache: fakePolicyCache(policyWithWorkerModels(["codex/gpt-5.1"])),
        catalogCache: fakeCatalogCache(catalog({ codex: ["gpt-5.1"] })),
      }),
    );

    const result = router(request({ callerAgentId: "c1" }), fakeContext);

    expect(result?.config.model).toBe("gpt-5.1");
    expect(result?.config.provider).toBe("codex"); // crossed families: claude -> codex
  });

  it("leaves config.provider untouched when the selection stays in the claude family", () => {
    const pool: ResolvedPool = { workers: [{ providerId: "worker-a", priority: 1 }], leader: { providerId: "leader" } };
    const router = createRoleRouter(
      baseOptions({
        policyCache: fakePolicyCache(policyWithWorkerModels(["claude/claude-opus-4"])),
        catalogCache: fakeCatalogCache(catalog({ claude: ["claude-opus-4"] })),
        poolCache: fakePoolCache(pool),
      }),
    );

    const result = router(request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp" } }), fakeContext);

    expect(result?.config.model).toBe("claude-opus-4");
    expect(result?.config.provider).toBe("claude"); // still the family id; the account router decides the account next
  });

  it("leaves config.provider untouched when the request already pinned a pool worker id in the same family", () => {
    const pool: ResolvedPool = { workers: [{ providerId: "worker-a", priority: 1 }], leader: { providerId: "leader" } };
    const router = createRoleRouter(
      baseOptions({
        policyCache: fakePolicyCache(policyWithWorkerModels(["claude/claude-opus-4"])),
        catalogCache: fakeCatalogCache(catalog({ claude: ["claude-opus-4"] })),
        poolCache: fakePoolCache(pool),
      }),
    );

    const result = router(request({ callerAgentId: "c1", config: { provider: "worker-a", model: "claude-sonnet", cwd: "/tmp" } }), fakeContext);

    expect(result?.config.provider).toBe("worker-a");
    expect(result?.config.model).toBe("claude-opus-4");
  });

  describe("account-agnostic (bare) model refs", () => {
    const pool: ResolvedPool = { workers: [{ providerId: "worker-a", priority: 1 }], leader: { providerId: "claude" } };

    function bareRouter() {
      return createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(policyWithWorkerModels(["claude-opus-4"])),
          catalogCache: fakeCatalogCache(catalog({ claude: ["claude-opus-4"] })),
          poolCache: fakePoolCache(pool),
        }),
      );
    }

    it("rewrites only config.model, never config.provider", () => {
      const result = bareRouter()(
        request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp" } }),
        fakeContext,
      );

      expect(result?.config.model).toBe("claude-opus-4");
      expect(result?.config.provider).toBe("claude");
    });

    it("leaves a worker the account router already chose in place", () => {
      const result = bareRouter()(
        request({ callerAgentId: "c1", config: { provider: "worker-a", model: "claude-sonnet", cwd: "/tmp" } }),
        fakeContext,
      );

      expect(result?.config.provider).toBe("worker-a");
      expect(result?.config.model).toBe("claude-opus-4");
    });

    it("reports an unavailable bare ref without a bogus provider prefix", () => {
      const onRoleUnavailable = vi.fn();
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(policyWithWorkerModels(["claude-ghost"])),
          catalogCache: fakeCatalogCache(catalog({ claude: [] })),
          poolCache: fakePoolCache(pool),
          onRoleUnavailable,
        }),
      );

      router(request({ callerAgentId: "c1" }), fakeContext);

      expect(onRoleUnavailable).toHaveBeenCalledWith(
        expect.objectContaining({ requestedModel: "claude-ghost", reason: "no-eligible-model" }),
      );
    });
  });

  describe("tool profile enforcement", () => {
    function policyWithWorkerProfile(profile: RoleModelPolicy["roles"][number]["toolProfile"]): RoleModelPolicy {
      return {
        ...DEFAULT_POLICY,
        roles: DEFAULT_POLICY.roles.map((role) => (role.id === "worker" ? { ...role, toolProfile: profile } : role)),
      };
    }

    it("enforces the profile even when the role has NO configured models", () => {
      const router = createRoleRouter(
        baseOptions({ policyCache: fakePolicyCache(policyWithWorkerProfile({ kind: "orchestrator" })) }),
      );

      const result = router(request({ callerAgentId: "c1" }), fakeContext);

      const options = result?.config.providerOptions as { disallowedTools: string[] };
      expect(options.disallowedTools).toContain("Bash");
      expect(result?.config.model).toBe("claude-sonnet"); // untouched: no models configured
    });

    it("still passes through byte-identical for the default unrestricted profile", () => {
      const router = createRoleRouter(baseOptions());

      expect(router(request({ callerAgentId: "c1" }), fakeContext)).toBeUndefined();
    });

    it("applies both the model rewrite and the tool profile together", () => {
      const policy = {
        ...policyWithWorkerProfile({ kind: "read-only" }),
        roles: policyWithWorkerProfile({ kind: "read-only" }).roles.map((role) =>
          role.id === "worker" ? { ...role, models: ["codex/gpt-5.1"] } : role,
        ),
      };
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(policy),
          catalogCache: fakeCatalogCache(catalog({ codex: ["gpt-5.1"] })),
        }),
      );

      const result = router(request({ callerAgentId: "c1" }), fakeContext);

      expect(result?.config.model).toBe("gpt-5.1");
      const options = result?.config.providerOptions as { disallowedTools: string[] };
      expect(options.disallowedTools).toContain("Write");
      expect(options.disallowedTools).not.toContain("Read");
    });

    it("never weakens a restriction the caller already set", () => {
      const router = createRoleRouter(
        baseOptions({ policyCache: fakePolicyCache(policyWithWorkerProfile({ kind: "custom", deny: ["Write"] })) }),
      );

      const result = router(
        request({
          callerAgentId: "c1",
          config: { provider: "claude", cwd: "/tmp", providerOptions: { disallowedTools: ["Bash"] } },
        }),
        fakeContext,
      );

      const options = result?.config.providerOptions as { disallowedTools: string[] };
      expect(options.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Write"]));
    });

    it("keeps enforcing when a pinned provider vanished from the registry", () => {
      const policy = {
        ...policyWithWorkerProfile({ kind: "orchestrator" }),
        roles: policyWithWorkerProfile({ kind: "orchestrator" }).roles.map((role) =>
          role.id === "worker" ? { ...role, models: ["codex/gpt-5.1"] } : role,
        ),
      };
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(policy),
          catalogCache: fakeCatalogCache(catalog({ codex: ["gpt-5.1"] })),
          providerIds: { get: () => new Set(["claude"]), forceRefresh: vi.fn(), stop: vi.fn() },
        }),
      );

      const result = router(request({ callerAgentId: "c1" }), fakeContext);

      expect(result?.config.model).toBe("claude-sonnet"); // no model rewrite: target is gone
      const options = result?.config.providerOptions as { disallowedTools: string[] };
      expect(options.disallowedTools).toContain("Bash");
    });

    it("leaves root agents (no callerAgentId) alone", () => {
      const router = createRoleRouter(
        baseOptions({ policyCache: fakePolicyCache(policyWithWorkerProfile({ kind: "orchestrator" })) }),
      );

      expect(router(request({}), fakeContext)).toBeUndefined();
    });
  });

  it("preserves other config fields (modeId, providerOptions, cwd) across the rewrite", () => {
    const router = createRoleRouter(
      baseOptions({
        policyCache: fakePolicyCache(policyWithWorkerModels(["codex/gpt-5.1"])),
        catalogCache: fakeCatalogCache(catalog({ codex: ["gpt-5.1"] })),
      }),
    );

    const result = router(
      request({
        callerAgentId: "c1",
        config: { provider: "claude", model: "claude-sonnet", modeId: "default", providerOptions: { foo: "bar" }, cwd: "/tmp/work" },
      }),
      fakeContext,
    );

    expect(result?.config.modeId).toBe("default");
    expect(result?.config.providerOptions).toEqual({ foo: "bar" });
    expect(result?.config.cwd).toBe("/tmp/work");
  });

  it("resolves via tier 2 declared role label and routes to that role's model", () => {
    const router = createRoleRouter(
      baseOptions({
        policyCache: fakePolicyCache({
          ...DEFAULT_POLICY,
          roles: DEFAULT_POLICY.roles.map((role) => (role.id === "reviewer" ? { ...role, models: ["codex/gpt-5.1"] } : role)),
        }),
        catalogCache: fakeCatalogCache(catalog({ codex: ["gpt-5.1"] })),
      }),
    );

    const result = router(request({ callerAgentId: "c1", labels: { [AGENT_ROLE_LABEL]: "reviewer" } } as unknown as Record<string, unknown>), fakeContext);

    expect(result?.config.model).toBe("gpt-5.1");
  });

  it("records the agent-type label into recentAgentTypes on every gated create", () => {
    const recentAgentTypes = createRecentAgentTypes();
    const router = createRoleRouter(baseOptions({ recentAgentTypes }));

    router(request({ callerAgentId: "c1", labels: { [AGENT_TYPE_LABEL]: "ce-code-reviewer" } } as unknown as Record<string, unknown>), fakeContext);

    expect(recentAgentTypes.list()).toEqual(["ce-code-reviewer"]);
  });

  it("falls back to title for recentAgentTypes when no agent-type label is present", () => {
    const recentAgentTypes = createRecentAgentTypes();
    const router = createRoleRouter(baseOptions({ recentAgentTypes }));

    router(request({ callerAgentId: "c1", config: { provider: "claude", model: "x", cwd: "/tmp", title: "Untitled Scout" } }), fakeContext);

    expect(recentAgentTypes.list()).toEqual(["Untitled Scout"]);
  });

  it("calls onDeclaredRoleUnknown exactly once per (callerAgentId, value), not once per create", () => {
    const onDeclaredRoleUnknown = vi.fn();
    const router = createRoleRouter(baseOptions({ onDeclaredRoleUnknown }));

    router(request({ callerAgentId: "c1", labels: { [AGENT_ROLE_LABEL]: "not-a-role" } } as unknown as Record<string, unknown>), fakeContext);
    router(request({ callerAgentId: "c1", labels: { [AGENT_ROLE_LABEL]: "not-a-role" } } as unknown as Record<string, unknown>), fakeContext);

    expect(onDeclaredRoleUnknown).toHaveBeenCalledTimes(1);
    expect(onDeclaredRoleUnknown).toHaveBeenCalledWith({ callerAgentId: "c1", value: "not-a-role" });
  });

  it("still fires onDeclaredRoleUnknown again for a different caller declaring the same unknown value", () => {
    const onDeclaredRoleUnknown = vi.fn();
    const router = createRoleRouter(baseOptions({ onDeclaredRoleUnknown }));

    router(request({ callerAgentId: "c1", labels: { [AGENT_ROLE_LABEL]: "not-a-role" } } as unknown as Record<string, unknown>), fakeContext);
    router(request({ callerAgentId: "c2", labels: { [AGENT_ROLE_LABEL]: "not-a-role" } } as unknown as Record<string, unknown>), fakeContext);

    expect(onDeclaredRoleUnknown).toHaveBeenCalledTimes(2);
  });

  it("never blocks the create even when the declared role is unknown", () => {
    const router = createRoleRouter(
      baseOptions({
        policyCache: fakePolicyCache(policyWithWorkerModels(["codex/gpt-5.1"])),
        catalogCache: fakeCatalogCache(catalog({ codex: ["gpt-5.1"] })),
      }),
    );

    // Unknown role label falls through to classification -> worker (empty title/prompt) -> routed normally.
    const result = router(request({ callerAgentId: "c1", labels: { [AGENT_ROLE_LABEL]: "not-a-role" } } as unknown as Record<string, unknown>), fakeContext);

    expect(result?.config.model).toBe("gpt-5.1");
  });

  it("UNAVAILABLE: calls onRoleUnavailable exactly once, and re-arms on recovery", () => {
    const onRoleUnavailable = vi.fn();
    const pool: ResolvedPool = { workers: [{ providerId: "worker-a", priority: 1 }], leader: { providerId: "leader" } };
    const health = createHealthTracker();
    // No catalog entries at all: both refs are catalog-missing -> UNAVAILABLE every time.
    const unavailablePolicy = fakePolicyCache(policyWithWorkerModels(["claude/claude-opus-4"]));
    const router = createRoleRouter({
      ...baseOptions({ poolCache: fakePoolCache(pool), health, onRoleUnavailable }),
      policyCache: unavailablePolicy,
      catalogCache: fakeCatalogCache(new Map()), // empty catalog: always catalog-miss
    });

    const first = router(request({ callerAgentId: "c1" }), fakeContext);
    const second = router(request({ callerAgentId: "c2" }), fakeContext);

    expect(first?.config.model).toBe("claude-opus-4"); // still uses models[0]
    expect(second?.config.model).toBe("claude-opus-4");
    expect(onRoleUnavailable).toHaveBeenCalledTimes(1);
    expect(onRoleUnavailable).toHaveBeenCalledWith({
      callerAgentId: "c1",
      roleId: "worker",
      requestedModel: "claude/claude-opus-4",
      reason: "no-eligible-model",
    });

    // Recovery: catalog now has the model and the worker is healthy -> selected, not unavailable.
    const router2 = createRoleRouter({
      ...baseOptions({ poolCache: fakePoolCache(pool), health, onRoleUnavailable }),
      policyCache: unavailablePolicy,
      catalogCache: fakeCatalogCache(catalog({ claude: ["claude-opus-4"] })),
    });
    router2(request({ callerAgentId: "c3" }), fakeContext);
    // A fresh router instance re-arms naturally (its own dedup state); the
    // re-arm-on-recovery guarantee is that the SAME instance clears its
    // dedup set once selection succeeds again, verified below.
    expect(onRoleUnavailable).toHaveBeenCalledTimes(1);
  });

  it("re-arms within the same router instance: unavailable, then recovered, then unavailable again fires twice total", () => {
    const onRoleUnavailable = vi.fn();
    const pool: ResolvedPool = { workers: [{ providerId: "worker-a", priority: 1 }], leader: { providerId: "leader" } };
    const health = createHealthTracker();
    const policy = policyWithWorkerModels(["claude/claude-opus-4"]);
    let currentCatalog: ModelCatalog = new Map(); // starts catalog-missing -> unavailable
    const catalogCache = { get: () => currentCatalog, forceRefresh: vi.fn(), stop: vi.fn() };
    const router = createRoleRouter({
      ...baseOptions({ poolCache: fakePoolCache(pool), health, onRoleUnavailable }),
      policyCache: fakePolicyCache(policy),
      catalogCache,
    });

    router(request({ callerAgentId: "c1" }), fakeContext);
    expect(onRoleUnavailable).toHaveBeenCalledTimes(1);

    router(request({ callerAgentId: "c1" }), fakeContext); // still unavailable: no additional call
    expect(onRoleUnavailable).toHaveBeenCalledTimes(1);

    currentCatalog = catalog({ claude: ["claude-opus-4"] }); // recovers
    router(request({ callerAgentId: "c1" }), fakeContext);
    expect(onRoleUnavailable).toHaveBeenCalledTimes(1); // no call on recovery itself

    currentCatalog = new Map(); // goes unavailable again
    router(request({ callerAgentId: "c1" }), fakeContext);
    expect(onRoleUnavailable).toHaveBeenCalledTimes(2); // re-armed
  });

  it("F2: cross-family rewrite to an unregistered provider family passes through untouched and fires role-unavailable with a distinct reason", () => {
    const onRoleUnavailable = vi.fn();
    const pool: ResolvedPool = { workers: [{ providerId: "worker-a", priority: 1 }], leader: { providerId: "leader" } };
    // Registry the account router actually knows about: "deadfamily" was
    // removed from daemon config, so it's absent here even though the
    // role's models[0] still names it.
    const providerIds = { get: () => new Set(["claude", "worker-a", "leader"]), forceRefresh: vi.fn(), stop: vi.fn() };
    const router = createRoleRouter({
      ...baseOptions({ poolCache: fakePoolCache(pool), onRoleUnavailable }),
      policyCache: fakePolicyCache(policyWithWorkerModels(["deadfamily/some-model"])),
      catalogCache: fakeCatalogCache(new Map()), // "deadfamily" never resolves in the catalog either
      providerIds,
    });

    const initial = request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp" } });
    const result = router(initial, fakeContext);

    expect(result).toBeUndefined(); // pass-through = recovered, not blocked: request untouched
    const finalProvider = (result ?? initial.request).config.provider;
    expect(providerIds.get().has(finalProvider)).toBe(true); // still a provider the registry actually knows

    expect(onRoleUnavailable).toHaveBeenCalledTimes(1);
    expect(onRoleUnavailable).toHaveBeenCalledWith({
      callerAgentId: "c1",
      roleId: "worker",
      requestedModel: "deadfamily/some-model",
      reason: "provider-not-registered",
    });
  });

  it("F3: never propagates a throw from the policy cache — logs and returns undefined (pass-through)", () => {
    const throwingPolicyCache = {
      get: () => {
        throw new Error("policy cache exploded");
      },
      isMalformed: () => false,
      lastError: () => undefined,
      forceRefresh: vi.fn(),
      stop: vi.fn(),
    };
    const router = createRoleRouter(baseOptions({ policyCache: throwingPolicyCache }));

    let result: ReturnType<typeof router> = undefined;
    expect(() => {
      result = router(request({ callerAgentId: "c1" }), fakeContext);
    }).not.toThrow();
    expect(result).toBeUndefined();
  });

  it("F3: throttles the unexpected-error fail-open log to once per window across a burst of identical failures", () => {
    const throwingPolicyCache = {
      get: () => {
        throw new Error("policy cache exploded");
      },
      isMalformed: () => false,
      lastError: () => undefined,
      forceRefresh: vi.fn(),
      stop: vi.fn(),
    };
    let nowMs = 0;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const router = createRoleRouter(
      baseOptions({ policyCache: throwingPolicyCache, now: () => nowMs }),
    );

    for (let i = 0; i < 5; i++) {
      router(request({ callerAgentId: "c1" }), fakeContext);
    }
    expect(errorSpy).toHaveBeenCalledTimes(1);

    nowMs += 60_000;
    router(request({ callerAgentId: "c1" }), fakeContext);
    expect(errorSpy).toHaveBeenCalledTimes(2);

    errorSpy.mockRestore();
  });

  it("F3: never propagates a throw from deep in role resolution (missing standard role) — logs and returns undefined", () => {
    // A policy missing every standard role forces requireStandardRole (via
    // resolveRole's classify()) to throw when there's no title/prompt text
    // to classify against.
    const corruptPolicy = { ...DEFAULT_POLICY, roles: [] };
    const router = createRoleRouter(baseOptions({ policyCache: fakePolicyCache(corruptPolicy) }));

    let result: ReturnType<typeof router> = undefined;
    expect(() => {
      result = router(request({ callerAgentId: "c1" }), fakeContext);
    }).not.toThrow();
    expect(result).toBeUndefined();
  });

  it("never skips or blocks a requested subagent create in any outcome", () => {
    // Exhaustive-ish: unconfigured, selected, and unavailable all return a
    // usable request shape from the caller's perspective (either the
    // original request, unmodified, or a rewritten one) — never null/throw.
    const outcomes = [
      baseOptions(), // unconfigured
      baseOptions({
        policyCache: fakePolicyCache(policyWithWorkerModels(["codex/gpt-5.1"])),
        catalogCache: fakeCatalogCache(catalog({ codex: ["gpt-5.1"] })),
      }), // selected
      baseOptions({ policyCache: fakePolicyCache(policyWithWorkerModels(["codex/gpt-ghost"])) }), // unavailable
    ];
    for (const options of outcomes) {
      const router = createRoleRouter(options);
      expect(() => router(request({ callerAgentId: "c1" }), fakeContext)).not.toThrow();
    }
  });
});

describe("role-router + account router composition", () => {
  it("role hook sets the model; the unmodified account router runs second and picks the account", () => {
    const pool: ResolvedPool = {
      workers: [
        { providerId: "worker-a", priority: 1 },
        { providerId: "worker-b", priority: 2 },
      ],
      leader: { providerId: "leader" },
    };
    const health = createHealthTracker();
    // Cap worker-a specifically for the role's chosen model so the account
    // router's own ladder (not the role hook) is what advances to worker-b.
    health.reportTurnFailure("worker-a", "hit your limit — weekly opus cap reached");

    const poolCache = fakePoolCache(pool);
    const roleRouter = createRoleRouter({
      policyCache: fakePolicyCache(policyWithWorkerModels(["claude/claude-opus-4"])),
      catalogCache: fakeCatalogCache(catalog({ claude: ["claude-opus-4"] })),
      poolCache,
      health,
      recentAgentTypes: createRecentAgentTypes(),
    });
    // Provider-id cache populated (not the null cold-start state) so the
    // assertion below reflects real target selection, not a fail-open guard.
    const providerIds = { get: () => new Set(["worker-a", "worker-b", "leader"]), forceRefresh: vi.fn(), stop: vi.fn() };
    const accountRouter = createRouter({ poolCache, health, providerIds });

    const initial = request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp" } });

    // Registration-order composition, exactly as index.server.ts wires it:
    // role hook's output feeds the account router's input.
    const afterRole = roleRouter(initial, fakeContext);
    expect(afterRole?.config.model).toBe("claude-opus-4");
    expect(afterRole?.config.provider).toBe("claude"); // role hook never touches the account

    const afterAccount = accountRouter({ request: afterRole ?? initial.request }, fakeContext);
    expect(afterAccount?.config.provider).toBe("worker-b"); // worker-a is capped for opus specifically
    expect(afterAccount?.config.model).toBe("claude-opus-4"); // model choice survives untouched
  });

  it("UNCONFIGURED role composes as a true no-op: the account router still runs on the original request", () => {
    const pool: ResolvedPool = { workers: [{ providerId: "worker-a", priority: 1 }], leader: { providerId: "leader" } };
    const health = createHealthTracker();
    const poolCache = fakePoolCache(pool);
    const roleRouter = createRoleRouter({
      policyCache: fakePolicyCache(DEFAULT_POLICY), // every role unconfigured
      catalogCache: fakeCatalogCache(new Map()),
      poolCache,
      health,
      recentAgentTypes: createRecentAgentTypes(),
    });
    const providerIds = { get: () => new Set(["worker-a", "leader"]), forceRefresh: vi.fn(), stop: vi.fn() };
    const accountRouter = createRouter({ poolCache, health, providerIds });

    const initial = request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp" } });

    const afterRole = roleRouter(initial, fakeContext);
    expect(afterRole).toBeUndefined(); // byte-identical pass-through

    const afterAccount = accountRouter({ request: initial.request }, fakeContext);
    expect(afterAccount?.config.provider).toBe("worker-a");
    expect(afterAccount?.config.model).toBe("claude-sonnet"); // the caller's original model choice, untouched by the role hook
  });
});
