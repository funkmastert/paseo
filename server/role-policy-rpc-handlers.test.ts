import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TOOL_PROFILE } from "../shared/tool-profiles";
import { DEFAULT_MODEL_BUDGET_THRESHOLD_PCT } from "../shared/role-policy-schema";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { DEFAULT_POLICY, type RoleModelPolicy } from "../shared/role-policy-schema";
import { createHealthTracker } from "./health";
import type { ModelCatalog } from "./model-catalog";
import { createRecentAgentTypes } from "./recent-agent-types";
import { createRoleModelPolicyRpcHandlers, type RoleModelPolicyRpcDeps } from "./role-policy-rpc-handlers";

const VALID_POLICY: RoleModelPolicy = {
  schemaVersion: 3,
  roles: [
    { id: "worker", name: "worker", standard: true, aliases: [], models: ["claude/opus"], toolProfile: DEFAULT_TOOL_PROFILE },
    { id: "reviewer", name: "reviewer", standard: true, aliases: [], models: [], toolProfile: DEFAULT_TOOL_PROFILE },
    { id: "advisor", name: "advisor", standard: true, aliases: [], models: [], toolProfile: DEFAULT_TOOL_PROFILE },
    { id: "leader", name: "leader", standard: true, aliases: [], models: [], toolProfile: DEFAULT_TOOL_PROFILE },
  ],
  modelBudgetThresholdPct: DEFAULT_MODEL_BUDGET_THRESHOLD_PCT,
  agentTypeMappings: { worker: "worker" },
  revision: "rev-1",
};

function fakePaseo(overrides: {
  config?: Record<string, unknown>;
  patch?: ReturnType<typeof vi.fn>;
  listModels?: ReturnType<typeof vi.fn>;
  refresh?: ReturnType<typeof vi.fn>;
}): PluginHandlerContext["paseo"] {
  return {
    config: {
      get: vi.fn().mockResolvedValue({ requestId: "r1", config: overrides.config ?? { agentModelPolicy: VALID_POLICY } }),
      patch: overrides.patch ?? vi.fn().mockResolvedValue({ requestId: "p1", config: {} }),
    },
    providers: {
      listModels: overrides.listModels ?? vi.fn().mockResolvedValue({ models: [] }),
      refresh: overrides.refresh ?? vi.fn().mockResolvedValue({}),
    },
  } as unknown as PluginHandlerContext["paseo"];
}

function fakePolicyCache(policy: RoleModelPolicy, options: { malformed?: boolean; error?: string } = {}) {
  return {
    get: () => policy,
    isMalformed: () => options.malformed ?? false,
    lastError: () => options.error,
    forceRefresh: vi.fn().mockResolvedValue(policy),
    stop: vi.fn(),
  };
}

function fakeCatalogCache(catalog: ModelCatalog = new Map()) {
  return { get: () => catalog, forceRefresh: vi.fn().mockResolvedValue(catalog), stop: vi.fn() };
}

function fakePoolCache() {
  return { get: () => ({ pool: { workers: [], leader: null }, failOpen: false }), forceRefresh: vi.fn(), stop: vi.fn() };
}

function baseDeps(overrides: Partial<RoleModelPolicyRpcDeps> = {}): RoleModelPolicyRpcDeps {
  return {
    policyCache: fakePolicyCache(VALID_POLICY),
    catalogCache: fakeCatalogCache(),
    poolCache: fakePoolCache(),
    health: createHealthTracker(),
    recentAgentTypes: createRecentAgentTypes(),
    ...overrides,
  };
}

function context(paseo: PluginHandlerContext["paseo"]): PluginHandlerContext {
  return { paseo };
}

/**
 * Simulates the real daemon config store: `patch` mutates a shared,
 * in-memory document that subsequent `get` calls observe, with a small
 * delay on both so two in-flight write() calls actually interleave instead
 * of resolving synchronously in call order.
 */
function fakeConcurrentPaseo(initialConfig: Record<string, unknown>): PluginHandlerContext["paseo"] {
  let stored = { ...initialConfig };
  const get = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { requestId: "r", config: { ...stored } };
  });
  const patch = vi.fn(async (p: Record<string, unknown>) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    stored = { ...stored, ...p };
    return { requestId: "p", config: {} };
  });
  return {
    config: { get, patch },
    providers: {
      listModels: vi.fn().mockResolvedValue({ models: [] }),
      refresh: vi.fn().mockResolvedValue({}),
    },
  } as unknown as PluginHandlerContext["paseo"];
}

describe("role-model-policy RPC handlers", () => {
  describe("read", () => {
    it("returns the fresh-read policy, not the (possibly stale) cache", async () => {
      const handlers = createRoleModelPolicyRpcHandlers(baseDeps());
      const paseo = fakePaseo({ config: { agentModelPolicy: VALID_POLICY } });

      const result = await handlers.read({}, context(paseo));

      expect(result).toEqual({ policy: VALID_POLICY, malformed: false, error: undefined });
    });

    it("reports malformed and falls back to the cache's last-good policy", async () => {
      const handlers = createRoleModelPolicyRpcHandlers(baseDeps({ policyCache: fakePolicyCache(VALID_POLICY) }));
      const paseo = fakePaseo({ config: { agentModelPolicy: { schemaVersion: 3, roles: "not-an-array" } } });

      const result = await handlers.read({}, context(paseo));

      expect(result.malformed).toBe(true);
      expect(result.policy).toEqual(VALID_POLICY);
      expect(result.error).toBeDefined();
    });
  });

  describe("write", () => {
    it("saves a valid patch, bumps the revision, and calls config.patch exactly once", async () => {
      const handlers = createRoleModelPolicyRpcHandlers(baseDeps());
      const patch = vi.fn().mockResolvedValue({ requestId: "p1", config: {} });
      const paseo = fakePaseo({ patch });

      const result = await handlers.write(
        {
          revision: VALID_POLICY.revision,
          patch: { roles: VALID_POLICY.roles.map((r) => (r.id === "worker" ? { ...r, name: "worker" } : r)), agentTypeMappings: { worker: "worker", scout: "worker" }, modelBudgetThresholdPct: DEFAULT_MODEL_BUDGET_THRESHOLD_PCT },
        },
        context(paseo),
      );

      expect(result.status).toBe("saved");
      if (result.status !== "saved") throw new Error("expected saved");
      expect(result.policy.revision).not.toBe(VALID_POLICY.revision);
      expect(result.policy.agentTypeMappings).toEqual({ worker: "worker", scout: "worker" });
      expect(patch).toHaveBeenCalledTimes(1);
    });

    it("stale-revision conflict leaves storage untouched", async () => {
      const handlers = createRoleModelPolicyRpcHandlers(baseDeps());
      const patch = vi.fn().mockResolvedValue({ requestId: "p1", config: {} });
      const paseo = fakePaseo({ patch });

      const result = await handlers.write(
        { revision: "stale-revision", patch: { roles: VALID_POLICY.roles, agentTypeMappings: VALID_POLICY.agentTypeMappings, modelBudgetThresholdPct: DEFAULT_MODEL_BUDGET_THRESHOLD_PCT } },
        context(paseo),
      );

      expect(result).toEqual({ status: "conflict", error: expect.any(String), policy: VALID_POLICY });
      expect(patch).not.toHaveBeenCalled();
    });

    it("invalid patch (duplicate name/alias namespace) is rejected and storage stays untouched", async () => {
      const handlers = createRoleModelPolicyRpcHandlers(baseDeps());
      const patch = vi.fn().mockResolvedValue({ requestId: "p1", config: {} });
      const paseo = fakePaseo({ patch });

      const badRoles = VALID_POLICY.roles.map((r) => (r.id === "reviewer" ? { ...r, aliases: ["worker"] } : r)); // "worker" collides with the worker role's own name

      const result = await handlers.write(
        { revision: VALID_POLICY.revision, patch: { roles: badRoles, agentTypeMappings: VALID_POLICY.agentTypeMappings, modelBudgetThresholdPct: DEFAULT_MODEL_BUDGET_THRESHOLD_PCT } },
        context(paseo),
      );

      expect(result.status).toBe("invalid");
      expect(patch).not.toHaveBeenCalled();
    });

    it("a semantic no-op does not bump the revision or call config.patch", async () => {
      const handlers = createRoleModelPolicyRpcHandlers(baseDeps());
      const patch = vi.fn().mockResolvedValue({ requestId: "p1", config: {} });
      const paseo = fakePaseo({ patch });

      const result = await handlers.write(
        { revision: VALID_POLICY.revision, patch: { roles: VALID_POLICY.roles, agentTypeMappings: VALID_POLICY.agentTypeMappings, modelBudgetThresholdPct: DEFAULT_MODEL_BUDGET_THRESHOLD_PCT } },
        context(paseo),
      );

      expect(result).toEqual({ status: "saved", policy: VALID_POLICY });
      expect(patch).not.toHaveBeenCalled();
    });

    it("returns a saved-with-warning outcome, distinct from a clean save, when the cache fails to reload", async () => {
      const policyCache = fakePolicyCache(VALID_POLICY, { malformed: true, error: "cache reload exploded" });
      const handlers = createRoleModelPolicyRpcHandlers(baseDeps({ policyCache }));
      const paseo = fakePaseo({});

      const result = await handlers.write(
        { revision: VALID_POLICY.revision, patch: { roles: VALID_POLICY.roles, agentTypeMappings: { worker: "worker", scout: "worker" }, modelBudgetThresholdPct: DEFAULT_MODEL_BUDGET_THRESHOLD_PCT } },
        context(paseo),
      );

      expect(result.status).toBe("saved");
      if (result.status !== "saved") throw new Error("expected saved");
      expect(result.warning).toMatch(/cache reload exploded/);
      expect(policyCache.forceRefresh).toHaveBeenCalledTimes(1);
    });

    it("F1: concurrent writes against the same revision — exactly one saved, one conflict, final doc is the saved one", async () => {
      const handlers = createRoleModelPolicyRpcHandlers(baseDeps());
      const paseo = fakeConcurrentPaseo({ agentModelPolicy: VALID_POLICY });

      const patchA = {
        roles: VALID_POLICY.roles.map((r) => (r.id === "worker" ? { ...r, name: "workerA" } : r)),
        agentTypeMappings: VALID_POLICY.agentTypeMappings,
        modelBudgetThresholdPct: DEFAULT_MODEL_BUDGET_THRESHOLD_PCT,
      };
      const patchB = {
        roles: VALID_POLICY.roles.map((r) => (r.id === "worker" ? { ...r, name: "workerB" } : r)),
        agentTypeMappings: VALID_POLICY.agentTypeMappings,
        modelBudgetThresholdPct: DEFAULT_MODEL_BUDGET_THRESHOLD_PCT,
      };

      const [resultA, resultB] = await Promise.all([
        handlers.write({ revision: VALID_POLICY.revision, patch: patchA }, context(paseo)),
        handlers.write({ revision: VALID_POLICY.revision, patch: patchB }, context(paseo)),
      ]);

      expect([resultA.status, resultB.status].sort()).toEqual(["conflict", "saved"]);

      const saved = resultA.status === "saved" ? resultA : resultB;
      if (saved.status !== "saved") throw new Error("expected exactly one saved result");

      const final = await handlers.read({}, context(paseo));
      expect(final.policy).toEqual(saved.policy);
    });

    it("rejects writes while the stored policy is malformed, without touching storage", async () => {
      const handlers = createRoleModelPolicyRpcHandlers(baseDeps());
      const patch = vi.fn().mockResolvedValue({ requestId: "p1", config: {} });
      const paseo = fakePaseo({ config: { agentModelPolicy: { schemaVersion: 3, roles: "not-an-array" } }, patch });

      const result = await handlers.write(
        { revision: VALID_POLICY.revision, patch: { roles: VALID_POLICY.roles, agentTypeMappings: VALID_POLICY.agentTypeMappings, modelBudgetThresholdPct: DEFAULT_MODEL_BUDGET_THRESHOLD_PCT } },
        context(paseo),
      );

      expect(result.status).toBe("invalid");
      expect(patch).not.toHaveBeenCalled();
    });
  });

  describe("listModels", () => {
    it("returns a per-family catalog and fails soft on a per-family error", async () => {
      const listModels = vi
        .fn()
        .mockResolvedValueOnce({ models: [{ id: "opus" }, { id: "sonnet" }] })
        .mockRejectedValueOnce(new Error("provider unreachable"));
      const handlers = createRoleModelPolicyRpcHandlers(baseDeps());
      const paseo = fakePaseo({ listModels });

      const result = await handlers.listModels({ families: ["claude", "codex"] }, context(paseo));

      expect(result).toEqual({ catalog: { claude: ["opus", "sonnet"], codex: [] } });
    });

    it("force-refreshes the provider snapshot first and warms the routing cache afterward", async () => {
      const refresh = vi.fn().mockResolvedValue({});
      const catalogCache = fakeCatalogCache();
      const handlers = createRoleModelPolicyRpcHandlers(baseDeps({ catalogCache }));
      const paseo = fakePaseo({ refresh });

      await handlers.listModels({ families: ["claude"], force: true }, context(paseo));

      expect(refresh).toHaveBeenCalledWith({ providers: ["claude"] });
      expect(catalogCache.forceRefresh).toHaveBeenCalledTimes(1);
    });
  });

  describe("recentAgentTypes", () => {
    it("returns the tracker's most-recently-seen list", async () => {
      const recentAgentTypes = createRecentAgentTypes();
      recentAgentTypes.record("ce-code-reviewer");
      const handlers = createRoleModelPolicyRpcHandlers(baseDeps({ recentAgentTypes }));

      const result = await handlers.recentAgentTypes({}, context(fakePaseo({})));

      expect(result).toEqual({ values: ["ce-code-reviewer"] });
    });
  });

  describe("explain", () => {
    it("resolves a tier-1 exact mapping and reports UNCONFIGURED when the role has no models", async () => {
      const handlers = createRoleModelPolicyRpcHandlers(baseDeps({ policyCache: fakePolicyCache(DEFAULT_POLICY) }));

      const result = await handlers.explain({ agentType: "scout" }, context(fakePaseo({})));

      expect(result).toEqual({ roleId: "worker", roleName: "worker", tier: 1, outcome: "unconfigured" });
    });

    it("reports SELECTED with the chosen provider/model when the role is configured and catalog-eligible", async () => {
      const policy: RoleModelPolicy = {
        ...DEFAULT_POLICY,
        roles: DEFAULT_POLICY.roles.map((r) => (r.id === "worker" ? { ...r, models: ["codex/gpt-5.1"] } : r)),
      };
      const catalog: ModelCatalog = new Map([["codex", new Set(["gpt-5.1"])]]);
      const handlers = createRoleModelPolicyRpcHandlers(
        baseDeps({ policyCache: fakePolicyCache(policy), catalogCache: fakeCatalogCache(catalog) }),
      );

      const result = await handlers.explain({ agentType: "worker" }, context(fakePaseo({})));

      expect(result).toEqual({ roleId: "worker", roleName: "worker", tier: 1, outcome: "selected", provider: "codex", model: "gpt-5.1" });
    });

    it("falls through to tier-3 classification on an unmapped agentType, using title text", async () => {
      const handlers = createRoleModelPolicyRpcHandlers(baseDeps({ policyCache: fakePolicyCache(DEFAULT_POLICY) }));

      const result = await handlers.explain({ agentType: "totally-unmapped", title: "review the diff" }, context(fakePaseo({})));

      expect(result.roleId).toBe("reviewer");
      expect(result.tier).toBe(3);
    });
  });
});
