import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TOOL_PROFILE } from "../shared/tool-profiles";
import { DEFAULT_MODEL_BUDGET_THRESHOLD_PCT, DEFAULT_THINKING_POLICY } from "../shared/role-policy-schema";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { DEFAULT_POLICY, type RoleModelPolicy } from "../shared/role-policy-schema";
import { createHealthTracker } from "./health";
import type { ModelCatalog, ThinkingCatalog } from "./model-catalog";
import { createRecentAgentTypes } from "./recent-agent-types";
import { createRoleModelPolicyRpcHandlers, type RoleModelPolicyRpcDeps } from "./role-policy-rpc-handlers";

const VALID_POLICY: RoleModelPolicy = {
  schemaVersion: 4,
  roles: [
    { id: "worker", name: "worker", standard: true, aliases: [], models: ["claude/opus"], mechanicalModels: [], hardModels: [], toolProfile: DEFAULT_TOOL_PROFILE },
    { id: "reviewer", name: "reviewer", standard: true, aliases: [], models: [], mechanicalModels: [], hardModels: [], toolProfile: DEFAULT_TOOL_PROFILE },
    { id: "advisor", name: "advisor", standard: true, aliases: [], models: [], mechanicalModels: [], hardModels: [], toolProfile: DEFAULT_TOOL_PROFILE },
    { id: "leader", name: "leader", standard: true, aliases: [], models: [], mechanicalModels: [], hardModels: [], toolProfile: DEFAULT_TOOL_PROFILE },
  ],
  modelBudgetThresholdPct: DEFAULT_MODEL_BUDGET_THRESHOLD_PCT,
  enforceToolsOnClassifiedRoles: false,
  exposeClassifierTool: false,
  allowUnlistedModels: [],
  thinking: DEFAULT_THINKING_POLICY,
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

function fakeCatalogCache(catalog: ModelCatalog = new Map(), thinking: ThinkingCatalog = new Map()) {
  return { get: () => catalog, getThinking: () => thinking, forceRefresh: vi.fn().mockResolvedValue(catalog), stop: vi.fn() };
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

    it("carries allowUnlistedModels through an unrelated save instead of resetting it to []", async () => {
      const stored: RoleModelPolicy = { ...VALID_POLICY, allowUnlistedModels: ["claude-opus-5-5"] };
      const handlers = createRoleModelPolicyRpcHandlers(baseDeps({ policyCache: fakePolicyCache(stored) }));
      const patch = vi.fn().mockResolvedValue({ requestId: "p1", config: {} });
      const paseo = fakePaseo({ config: { agentModelPolicy: stored }, patch });

      const result = await handlers.write(
        {
          revision: stored.revision,
          patch: { roles: stored.roles, agentTypeMappings: { worker: "worker", scout: "worker" }, modelBudgetThresholdPct: DEFAULT_MODEL_BUDGET_THRESHOLD_PCT },
        },
        context(paseo),
      );

      expect(result.status).toBe("saved");
      expect(patch).toHaveBeenCalledWith({
        agentModelPolicy: expect.objectContaining({ allowUnlistedModels: ["claude-opus-5-5"] }),
      });
    });

    it("carries thinking through an unrelated save when the patch omits it (an older app build)", async () => {
      const customThinking = { leader: "max", byTaskClass: { mechanical: "low", standard: "medium", hard: "xhigh" } };
      const stored: RoleModelPolicy = { ...VALID_POLICY, thinking: customThinking };
      const handlers = createRoleModelPolicyRpcHandlers(baseDeps({ policyCache: fakePolicyCache(stored) }));
      const patch = vi.fn().mockResolvedValue({ requestId: "p1", config: {} });
      const paseo = fakePaseo({ config: { agentModelPolicy: stored }, patch });

      const result = await handlers.write(
        {
          revision: stored.revision,
          // No `thinking` key at all — exactly what an app build that predates the field sends.
          patch: { roles: stored.roles, agentTypeMappings: { worker: "worker", scout: "worker" }, modelBudgetThresholdPct: DEFAULT_MODEL_BUDGET_THRESHOLD_PCT },
        },
        context(paseo),
      );

      expect(result.status).toBe("saved");
      expect(patch).toHaveBeenCalledWith({
        agentModelPolicy: expect.objectContaining({ thinking: customThinking }),
      });
    });

    it("saves the patch's own thinking field when the caller supplies one", async () => {
      const handlers = createRoleModelPolicyRpcHandlers(baseDeps());
      const patch = vi.fn().mockResolvedValue({ requestId: "p1", config: {} });
      const paseo = fakePaseo({ patch });
      const newThinking = { leader: null, byTaskClass: { mechanical: "low", standard: "max", hard: "max" } };

      const result = await handlers.write(
        {
          revision: VALID_POLICY.revision,
          patch: {
            roles: VALID_POLICY.roles,
            agentTypeMappings: VALID_POLICY.agentTypeMappings,
            modelBudgetThresholdPct: DEFAULT_MODEL_BUDGET_THRESHOLD_PCT,
            thinking: newThinking,
          },
        },
        context(paseo),
      );

      expect(result.status).toBe("saved");
      if (result.status !== "saved") throw new Error("expected saved");
      expect(result.policy.thinking).toEqual(newThinking);
      expect(patch).toHaveBeenCalledWith({ agentModelPolicy: expect.objectContaining({ thinking: newThinking }) });
    });

    it("a thinking-only change is not a semantic no-op", async () => {
      const handlers = createRoleModelPolicyRpcHandlers(baseDeps());
      const patch = vi.fn().mockResolvedValue({ requestId: "p1", config: {} });
      const paseo = fakePaseo({ patch });
      const newThinking = { leader: "ultracode", byTaskClass: { mechanical: "medium", standard: "high", hard: "xhigh" } };

      const result = await handlers.write(
        {
          revision: VALID_POLICY.revision,
          patch: {
            roles: VALID_POLICY.roles,
            agentTypeMappings: VALID_POLICY.agentTypeMappings,
            modelBudgetThresholdPct: DEFAULT_MODEL_BUDGET_THRESHOLD_PCT,
            thinking: newThinking,
          },
        },
        context(paseo),
      );

      expect(result.status).toBe("saved");
      if (result.status !== "saved") throw new Error("expected saved");
      expect(result.policy.revision).not.toBe(VALID_POLICY.revision); // bumped: this was not a no-op
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

      expect(result).toMatchObject({
        roleId: "worker",
        roleName: "worker",
        roleSource: "agent-type-mapping",
        tier: 1,
        outcome: "unconfigured",
        pool: [],
        poolSlot: "standard",
        deniedTools: [],
        taskClassSource: "default",
      });
      // Every part of the decision explains itself; the settings preview
      // prints these verbatim rather than re-deriving them.
      expect(result.reasons.model).toContain("no models configured");
      expect(result.reasons.role).toContain("agent-type mapping");
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

      expect(result).toMatchObject({
        roleId: "worker",
        roleName: "worker",
        tier: 1,
        outcome: "selected",
        provider: "codex",
        model: "gpt-5.1",
        pool: ["codex/gpt-5.1"],
        deniedTools: [],
        taskClassSource: "default",
      });
      // A non-pool-family request is not the account pool's business.
      expect(result.account.kind).toBe("no-pool");
    });

    it("falls through to tier-3 classification on an unmapped agentType, using title text", async () => {
      const handlers = createRoleModelPolicyRpcHandlers(baseDeps({ policyCache: fakePolicyCache(DEFAULT_POLICY) }));

      const result = await handlers.explain({ agentType: "totally-unmapped", title: "review the diff" }, context(fakePaseo({})));

      expect(result.roleId).toBe("reviewer");
      expect(result.tier).toBe(3);
    });

    describe("requestedModel — mirrors the role router's explicit-request precedence", () => {
      it("reports honored=true when the requested model is a member of the role's pool", async () => {
        const policy: RoleModelPolicy = {
          ...DEFAULT_POLICY,
          roles: DEFAULT_POLICY.roles.map((r) =>
            r.id === "worker" ? { ...r, models: ["claude-sonnet-5", "claude-opus-5"] } : r,
          ),
        };
        const catalog: ModelCatalog = new Map([["claude", new Set(["claude-sonnet-5", "claude-opus-5"])]]);
        const poolCache = {
          get: () => ({ pool: { workers: [{ providerId: "claude-backup", priority: 1 }], leader: null }, failOpen: false }),
          forceRefresh: vi.fn(),
          stop: vi.fn(),
        };
        const handlers = createRoleModelPolicyRpcHandlers(
          baseDeps({ policyCache: fakePolicyCache(policy), catalogCache: fakeCatalogCache(catalog), poolCache }),
        );

        const result = await handlers.explain(
          { agentType: "worker", requestedModel: "claude-opus-5", requestedProvider: "claude-backup" },
          context(fakePaseo({})),
        );

        expect(result.requestedModelOverride).toEqual({
          requestedRef: "claude-backup/claude-opus-5",
          honored: true,
        });
      });

      it("reports honored=false, reason not-approved, when the requested model is not in the role's pool at all", async () => {
        const policy: RoleModelPolicy = {
          ...DEFAULT_POLICY,
          roles: DEFAULT_POLICY.roles.map((r) => (r.id === "worker" ? { ...r, models: ["claude-sonnet-5"] } : r)),
        };
        const catalog: ModelCatalog = new Map([["claude", new Set(["claude-sonnet-5"])]]);
        const handlers = createRoleModelPolicyRpcHandlers(
          baseDeps({ policyCache: fakePolicyCache(policy), catalogCache: fakeCatalogCache(catalog) }),
        );

        const result = await handlers.explain(
          { agentType: "worker", requestedModel: "claude-opus-5", requestedProvider: "claude-backup" },
          context(fakePaseo({})),
        );

        expect(result.requestedModelOverride).toEqual({
          requestedRef: "claude-backup/claude-opus-5",
          honored: false,
          effectiveRef: "claude-sonnet-5",
          reason: "not-approved",
        });
      });

      it("reports honored=false, reason not-currently-selectable, when the requested model is approved but catalog-missing", async () => {
        const policy: RoleModelPolicy = {
          ...DEFAULT_POLICY,
          roles: DEFAULT_POLICY.roles.map((r) =>
            r.id === "worker" ? { ...r, models: ["claude-opus-5", "claude-sonnet-5"] } : r,
          ),
        };
        // "claude-opus-5" is approved for the role but absent from the live catalog.
        const catalog: ModelCatalog = new Map([["claude", new Set(["claude-sonnet-5"])]]);
        const poolCache = {
          get: () => ({ pool: { workers: [{ providerId: "claude-backup", priority: 1 }], leader: null }, failOpen: false }),
          forceRefresh: vi.fn(),
          stop: vi.fn(),
        };
        const handlers = createRoleModelPolicyRpcHandlers(
          baseDeps({ policyCache: fakePolicyCache(policy), catalogCache: fakeCatalogCache(catalog), poolCache }),
        );

        const result = await handlers.explain(
          { agentType: "worker", requestedModel: "claude-opus-5", requestedProvider: "claude-backup" },
          context(fakePaseo({})),
        );

        expect(result.requestedModelOverride).toEqual({
          requestedRef: "claude-backup/claude-opus-5",
          honored: false,
          effectiveRef: "claude-sonnet-5",
          reason: "not-currently-selectable",
          missingFromCatalog: true,
        });
      });

      it("real shape from today: reason not-currently-selectable when the requested Fable model is over the weekly budget threshold", async () => {
        const FABLE = "claude-fable-5-1";
        const policy: RoleModelPolicy = {
          ...DEFAULT_POLICY,
          roles: DEFAULT_POLICY.roles.map((r) => (r.id === "worker" ? { ...r, models: [FABLE, "claude-sonnet-5"] } : r)),
        };
        const catalog: ModelCatalog = new Map([["claude", new Set([FABLE, "claude-sonnet-5"])]]);
        const health = createHealthTracker();
        health.reportUsage("claude-backup", [{ window: "weekly_model_fable", usedPct: 100 }]);
        const poolCache = {
          get: () => ({ pool: { workers: [{ providerId: "claude-backup", priority: 1 }], leader: null }, failOpen: false }),
          forceRefresh: vi.fn(),
          stop: vi.fn(),
        };
        const handlers = createRoleModelPolicyRpcHandlers(
          baseDeps({ policyCache: fakePolicyCache(policy), catalogCache: fakeCatalogCache(catalog), poolCache, health }),
        );

        const result = await handlers.explain(
          { agentType: "worker", requestedModel: FABLE, requestedProvider: "claude-backup" },
          context(fakePaseo({})),
        );

        expect(result.requestedModelOverride).toEqual({
          requestedRef: `claude-backup/${FABLE}`,
          honored: false,
          effectiveRef: "claude-sonnet-5",
          reason: "not-currently-selectable",
        });
      });

      it("reports honored=true when the role has no configured pool at all — nothing to override", async () => {
        const handlers = createRoleModelPolicyRpcHandlers(baseDeps({ policyCache: fakePolicyCache(DEFAULT_POLICY) }));

        const result = await handlers.explain(
          { agentType: "worker", requestedModel: "claude-opus-5" },
          context(fakePaseo({})),
        );

        expect(result.requestedModelOverride).toEqual({
          requestedRef: "claude/claude-opus-5",
          honored: true,
        });
      });

      it("omits requestedModelOverride entirely when no requestedModel was asked about", async () => {
        const handlers = createRoleModelPolicyRpcHandlers(baseDeps({ policyCache: fakePolicyCache(DEFAULT_POLICY) }));

        const result = await handlers.explain({ agentType: "worker" }, context(fakePaseo({})));

        expect(result.requestedModelOverride).toBeUndefined();
      });
    });

    describe("taskClass — answers 'why did I get this model' in one call", () => {
      function policyWithWorkerClassPools(): RoleModelPolicy {
        return {
          ...DEFAULT_POLICY,
          roles: DEFAULT_POLICY.roles.map((r) =>
            r.id === "worker" ? { ...r, models: ["claude-sonnet-5"], hardModels: ["claude-opus-5"] } : r,
          ),
        };
      }

      it("a declared taskClass reports the class-specific pool's outcome, not the standard pool's", async () => {
        const catalog: ModelCatalog = new Map([["claude", new Set(["claude-sonnet-5", "claude-opus-5"])]]);
        const poolCache = {
          get: () => ({ pool: { workers: [{ providerId: "w1", priority: 1 }], leader: null }, failOpen: false }),
          forceRefresh: vi.fn(),
          stop: vi.fn(),
        };
        const handlers = createRoleModelPolicyRpcHandlers(
          baseDeps({
            policyCache: fakePolicyCache(policyWithWorkerClassPools()),
            catalogCache: fakeCatalogCache(catalog),
            poolCache,
          }),
        );

        const result = await handlers.explain(
          { agentType: "worker", taskClass: "hard" },
          context(fakePaseo({})),
        );

        expect(result).toMatchObject({ outcome: "selected", model: "claude-opus-5", taskClass: "hard", taskClassSource: "declared" });
      });

      it("omits taskClass and reports source 'default' when nothing is declared and no seed word matches", async () => {
        const catalog: ModelCatalog = new Map([["claude", new Set(["claude-sonnet-5"])]]);
        const poolCache = {
          get: () => ({ pool: { workers: [{ providerId: "w1", priority: 1 }], leader: null }, failOpen: false }),
          forceRefresh: vi.fn(),
          stop: vi.fn(),
        };
        const handlers = createRoleModelPolicyRpcHandlers(
          baseDeps({
            policyCache: fakePolicyCache(policyWithWorkerClassPools()),
            catalogCache: fakeCatalogCache(catalog),
            poolCache,
          }),
        );

        const result = await handlers.explain({ agentType: "worker" }, context(fakePaseo({})));

        expect(result.taskClass).toBeUndefined();
        expect(result.taskClassSource).toBe("default");
        expect(result).toMatchObject({ outcome: "selected", model: "claude-sonnet-5" });
      });

      it("an unknown declared taskClass never blocks: falls through and reports unknownDeclaredTaskClass", async () => {
        const catalog: ModelCatalog = new Map([["claude", new Set(["claude-sonnet-5"])]]);
        const poolCache = {
          get: () => ({ pool: { workers: [{ providerId: "w1", priority: 1 }], leader: null }, failOpen: false }),
          forceRefresh: vi.fn(),
          stop: vi.fn(),
        };
        const handlers = createRoleModelPolicyRpcHandlers(
          baseDeps({
            policyCache: fakePolicyCache(policyWithWorkerClassPools()),
            catalogCache: fakeCatalogCache(catalog),
            poolCache,
          }),
        );

        const result = await handlers.explain(
          { agentType: "worker", taskClass: "urgent" },
          context(fakePaseo({})),
        );

        expect(result.taskClass).toBeUndefined();
        expect(result.taskClassSource).toBe("default");
        expect(result.unknownDeclaredTaskClass).toBe("urgent");
        expect(result).toMatchObject({ outcome: "selected", model: "claude-sonnet-5" }); // fell through, not blocked
      });

      it("requestedModelOverride is evaluated against the RESOLVED class's pool — exactly the 'asked for Opus, got Sonnet' case, explained", async () => {
        const catalog: ModelCatalog = new Map([["claude", new Set(["claude-sonnet-5", "claude-opus-5"])]]);
        const poolCache = {
          get: () => ({ pool: { workers: [{ providerId: "w1", priority: 1 }], leader: null }, failOpen: false }),
          forceRefresh: vi.fn(),
          stop: vi.fn(),
        };
        const handlers = createRoleModelPolicyRpcHandlers(
          baseDeps({
            policyCache: fakePolicyCache(policyWithWorkerClassPools()),
            catalogCache: fakeCatalogCache(catalog),
            poolCache,
          }),
        );

        // No declared task class: default/standard pool doesn't have opus -> overridden.
        const undeclared = await handlers.explain(
          { agentType: "worker", requestedModel: "claude-opus-5" },
          context(fakePaseo({})),
        );
        expect(undeclared.requestedModelOverride).toEqual({
          requestedRef: "claude/claude-opus-5",
          honored: false,
          effectiveRef: "claude-sonnet-5",
          reason: "not-approved",
        });

        // Declared hard: the hard pool DOES have opus -> honored.
        const declaredHard = await handlers.explain(
          { agentType: "worker", requestedModel: "claude-opus-5", taskClass: "hard" },
          context(fakePaseo({})),
        );
        expect(declaredHard.requestedModelOverride).toEqual({ requestedRef: "claude/claude-opus-5", honored: true });
      });
    });
  });
});

describe("explain — account-agnostic refs and tool profiles", () => {
  it("omits `provider` for a bare ref, so the UI can say the pool picks the account", async () => {
    const policy: RoleModelPolicy = {
      ...DEFAULT_POLICY,
      roles: DEFAULT_POLICY.roles.map((r) => (r.id === "worker" ? { ...r, models: ["claude-sonnet-5"] } : r)),
    };
    const handlers = createRoleModelPolicyRpcHandlers(
      baseDeps({
        policyCache: fakePolicyCache(policy),
        catalogCache: {
          get: () => new Map([["claude", new Set(["claude-sonnet-5"])]]),
          getThinking: () => new Map(),
          forceRefresh: vi.fn(),
          stop: vi.fn(),
        },
        poolCache: { get: () => ({ pool: { workers: [{ providerId: "w1", priority: 1 }], leader: null }, failOpen: false }), forceRefresh: vi.fn(), stop: vi.fn() },
      }),
    );

    const result = await handlers.explain({ agentType: "worker" }, context(fakePaseo({})));

    expect(result).toMatchObject({ outcome: "selected", model: "claude-sonnet-5" });
    expect(result.provider).toBeUndefined();
  });

  it("reports the role's denied tools even when no model is configured", async () => {
    const policy: RoleModelPolicy = {
      ...DEFAULT_POLICY,
      roles: DEFAULT_POLICY.roles.map((r) => (r.id === "worker" ? { ...r, toolProfile: { kind: "read-only" as const } } : r)),
    };
    const handlers = createRoleModelPolicyRpcHandlers(baseDeps({ policyCache: fakePolicyCache(policy) }));

    const result = await handlers.explain({ agentType: "worker" }, context(fakePaseo({})));

    expect(result.outcome).toBe("unconfigured");
    expect(result.deniedTools).toEqual(expect.arrayContaining(["Bash", "Write", "Edit", "NotebookEdit"]));
  });
});

describe("explain — an explicit request for a model the catalog doesn't list", () => {
  const OPUS_5_5 = "claude-opus-5-5";
  const FABLE = "claude-fable-5-1";
  // The live shape: the leader's `hard` pool holds opus-5-5, which Claude Code doesn't advertise.
  const policyWith = (allowUnlistedModels: string[]): RoleModelPolicy => ({
    ...DEFAULT_POLICY,
    allowUnlistedModels,
    roles: DEFAULT_POLICY.roles.map((r) =>
      r.id === "leader" ? { ...r, models: ["claude-opus-5"], hardModels: [OPUS_5_5, FABLE, "claude-opus-5"] } : r,
    ),
  });
  const catalog: ModelCatalog = new Map([["claude", new Set([FABLE, "claude-opus-5", "claude-sonnet-5"])]]);
  const poolCache = {
    get: () => ({ pool: { workers: [], leader: { providerId: "claude-personal" } }, failOpen: false }),
    forceRefresh: vi.fn(),
    stop: vi.fn(),
  };
  const explainLeader = (policy: RoleModelPolicy, extra: Record<string, unknown> = {}) =>
    createRoleModelPolicyRpcHandlers(
      baseDeps({ policyCache: fakePolicyCache(policy), catalogCache: fakeCatalogCache(catalog), poolCache }),
    ).explain({ role: "leader", taskClass: "hard", ...extra }, context(fakePaseo({})));
  /** With an explicit request for the unadvertised id — the caller-asked-for-it route. */
  const explainLeaderHard = (policy: RoleModelPolicy) =>
    explainLeader(policy, { requestedModel: OPUS_5_5, requestedProvider: "claude-personal" });

  it("reports honored + unadvertised when the operator allowlisted the id", async () => {
    const result = await explainLeaderHard(policyWith([OPUS_5_5]));

    expect(result.roleId).toBe("leader");
    expect(result.taskClass).toBe("hard");
    expect(result.requestedModelOverride).toEqual({
      requestedRef: `claude-personal/${OPUS_5_5}`,
      honored: true,
      unadvertised: true,
    });
  });

  it("reports the refusal as liftable (missingFromCatalog) when the id is not allowlisted", async () => {
    const result = await explainLeaderHard(policyWith([]));

    expect(result.requestedModelOverride).toEqual({
      requestedRef: `claude-personal/${OPUS_5_5}`,
      honored: false,
      effectiveRef: FABLE, // ordered selection skips the unadvertised entry
      reason: "not-currently-selectable",
      missingFromCatalog: true,
    });
  });

  it("names the pool entries ordered selection skips, so a never-chosen entry isn't a mystery", async () => {
    const result = await explainLeaderHard(policyWith([]));

    expect(result.unadvertisedPoolEntries).toEqual([OPUS_5_5]);
    expect(result).toMatchObject({ outcome: "selected", model: FABLE }); // not allowlisted: skipped
    expect(result).not.toHaveProperty("modelUnadvertised");
  });

  it("selects an allowlisted unadvertised entry as the pool default and flags the selection unverified", async () => {
    // Asked WITHOUT an explicit request: this is the pool-default route, and
    // it has to be asked as such. An honored explicit request short-circuits
    // selection in the create hook — no pool default is ever computed — so
    // the classifier reports that as its own outcome (below) rather than
    // pretending ordered selection ran.
    const result = await explainLeader(policyWith([OPUS_5_5]));

    expect(result).toMatchObject({ outcome: "selected", model: OPUS_5_5, modelUnadvertised: true });
    expect(result).not.toHaveProperty("unadvertisedPoolEntries"); // nothing is being skipped any more
  });

  it("reports an honored explicit request as honored-request, not as a pool selection", async () => {
    const result = await explainLeaderHard(policyWith([OPUS_5_5]));

    expect(result).toMatchObject({ outcome: "honored-request", model: OPUS_5_5 });
    // The unverified fact still lands, on the field that describes the request.
    expect(result.requestedModelOverride).toMatchObject({ honored: true, unadvertised: true });
  });

  it("omits unadvertisedPoolEntries when every pool entry is advertised", async () => {
    const handlers = createRoleModelPolicyRpcHandlers(
      baseDeps({
        policyCache: fakePolicyCache(DEFAULT_POLICY),
        catalogCache: fakeCatalogCache(catalog),
        poolCache,
      }),
    );

    const result = await handlers.explain({ role: "leader" }, context(fakePaseo({})));

    expect(result).not.toHaveProperty("unadvertisedPoolEntries");
  });
});

describe("explain — the thinking decision", () => {
  const OPUS_5_5 = "claude-opus-5-5";
  const policy: RoleModelPolicy = {
    ...DEFAULT_POLICY,
    roles: DEFAULT_POLICY.roles.map((r) =>
      r.id === "leader" || r.id === "worker" ? { ...r, models: [OPUS_5_5], mechanicalModels: ["claude-haiku-4-5"] } : r,
    ),
  };
  const catalog: ModelCatalog = new Map([["claude", new Set([OPUS_5_5, "claude-haiku-4-5"])]]);
  const thinking: ThinkingCatalog = new Map([
    [
      "claude",
      new Map([
        [OPUS_5_5, { optionIds: ["low", "medium", "high", "xhigh", "max", "ultracode"], defaultOptionId: "ultracode" }],
        ["claude-haiku-4-5", { optionIds: [] }],
      ]),
    ],
  ]);
  const poolCache = {
    get: () => ({ pool: { workers: [], leader: { providerId: "claude-personal" } }, failOpen: false }),
    forceRefresh: vi.fn(),
    stop: vi.fn(),
  };
  const explain = (input: Parameters<ReturnType<typeof createRoleModelPolicyRpcHandlers>["explain"]>[0]) =>
    createRoleModelPolicyRpcHandlers(
      baseDeps({ policyCache: fakePolicyCache(policy), catalogCache: fakeCatalogCache(catalog, thinking), poolCache }),
    ).explain(input, context(fakePaseo({})));

  it("reports Ultra Code for a root agent, with the classifier's reason", async () => {
    const result = await explain({ root: true });
    expect(result.thinking).toMatchObject({ outcome: "leader-rule", optionId: "ultracode", modelRef: OPUS_5_5 });
    expect(result.reasons.thinking).toContain("Ultra Code");
  });

  it("reports a subagent's requested Ultra Code as overridden to Extra High", async () => {
    const result = await explain({ agentType: "worker", requestedThinkingOptionId: "ultracode" });
    expect(result.thinking).toMatchObject({
      outcome: "requested",
      optionId: "xhigh",
      subagentCapped: true,
      requested: "ultracode",
      override: { requested: "ultracode", applied: "xhigh", reason: "subagent-no-ultracode" },
    });
  });

  it("omits optionId, and reports the removal, when the model offers no thinking options", async () => {
    const result = await explain({ agentType: "worker", taskClass: "mechanical", requestedThinkingOptionId: "max" });
    expect(result.model).toBe("claude-haiku-4-5");
    expect(result.thinking).toMatchObject({ outcome: "no-thinking-options", override: { requested: "max", reason: "no-thinking-options" } });
    expect(result.thinking).not.toHaveProperty("optionId");
    expect(result.thinking?.override).not.toHaveProperty("applied");
  });

  it("still parses a response from a plugin that predates the thinking decision", async () => {
    const { RoleModelPolicyExplainResultSchema } = await import("../shared/role-policy-rpc");
    const result = await explain({ root: true });
    const { thinking: _thinking, ...older } = result;
    const { thinking: _reason, ...olderReasons } = result.reasons;
    expect(RoleModelPolicyExplainResultSchema.safeParse({ ...older, reasons: olderReasons }).success).toBe(true);
  });
});
