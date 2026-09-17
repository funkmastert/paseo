import { randomUUID } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { CURRENT_SCHEMA_VERSION, RoleModelPolicySchema, type RoleModelPolicy } from "../shared/role-policy-schema";
import { roleModelPolicyRpc } from "../shared/role-policy-rpc";
import type { HealthTracker } from "./health";
import type { ModelCatalogCache } from "./model-catalog";
import type { PoolCache } from "./pool";
import type { RecentAgentTypes } from "./recent-agent-types";
import { loadRolePolicy, type PolicyCache } from "./role-policy";
import { selectModel } from "./role-availability";
import { resolveRole } from "./role-resolve";
import { AGENT_TYPE_LABEL } from "../shared/role-policy-schema";

export interface RoleModelPolicyRpcDeps {
  policyCache: PolicyCache;
  catalogCache: ModelCatalogCache;
  poolCache: PoolCache;
  health: Pick<HealthTracker, "isHealthyFor" | "isLastResortEligible" | "windowUtilization">;
  recentAgentTypes: RecentAgentTypes;
}

export interface RoleModelPolicyRpcHandlers {
  read(
    input: RpcInput<typeof roleModelPolicyRpc.read>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof roleModelPolicyRpc.read>>;
  write(
    input: RpcInput<typeof roleModelPolicyRpc.write>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof roleModelPolicyRpc.write>>;
  listModels(
    input: RpcInput<typeof roleModelPolicyRpc.listModels>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof roleModelPolicyRpc.listModels>>;
  recentAgentTypes(
    input: RpcInput<typeof roleModelPolicyRpc.recentAgentTypes>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof roleModelPolicyRpc.recentAgentTypes>>;
  explain(
    input: RpcInput<typeof roleModelPolicyRpc.explain>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof roleModelPolicyRpc.explain>>;
}

type EditableDocument = Pick<RoleModelPolicy, "roles" | "agentTypeMappings" | "modelBudgetThresholdPct">;

/** Two documents are semantically equal when their editable fields serialize identically (order-sensitive: array order is meaningful). */
function sameDocument(a: EditableDocument, b: EditableDocument): boolean {
  return (
    JSON.stringify(a.roles) === JSON.stringify(b.roles) &&
    JSON.stringify(a.agentTypeMappings) === JSON.stringify(b.agentTypeMappings) &&
    a.modelBudgetThresholdPct === b.modelBudgetThresholdPct
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Serializes async work through a promise chain: each queued task starts
 * only after the previous one has settled (fulfilled or rejected), so a
 * caller's read-check-write span never interleaves with another caller's.
 * Scoped to one `createRoleModelPolicyRpcHandlers` instance, matching the
 * lifetime of the plugin process that owns the handler.
 */
function createMutex(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task, task);
    // Swallow rejection here so a failed task doesn't wedge the chain for
    // the next caller; the caller's own promise (`result`) still rejects.
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

/**
 * The `write` critical section: read-current -> check-revision -> patch.
 * Always invoked through `createRoleModelPolicyRpcHandlers`'s write mutex —
 * never call this directly from a handler.
 */
async function performWrite(
  input: RpcInput<typeof roleModelPolicyRpc.write>,
  paseo: PluginHandlerContext["paseo"],
  deps: RoleModelPolicyRpcDeps,
): Promise<RpcOutput<typeof roleModelPolicyRpc.write>> {
  const current = await loadRolePolicy(paseo, deps.policyCache.get());
  if (current.malformed) {
    return {
      status: "invalid",
      error: `the stored policy is malformed and cannot be edited until it's fixed: ${current.error ?? "unknown error"}`,
    };
  }
  if (input.revision !== current.policy.revision) {
    return { status: "conflict", error: "the policy changed since you loaded it", policy: current.policy };
  }

  const candidateDoc: EditableDocument = {
    roles: input.patch.roles,
    agentTypeMappings: input.patch.agentTypeMappings,
    modelBudgetThresholdPct: input.patch.modelBudgetThresholdPct,
  };
  if (sameDocument(candidateDoc, current.policy)) {
    // Semantic no-op: nothing to persist, revision stays put.
    return { status: "saved", policy: current.policy };
  }

  const candidate: RoleModelPolicy = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ...candidateDoc,
    revision: randomUUID(),
  };
  const parsed = RoleModelPolicySchema.safeParse(candidate);
  if (!parsed.success) {
    return { status: "invalid", error: parsed.error.message };
  }

  try {
    await paseo.config.patch({ agentModelPolicy: parsed.data });
  } catch (error) {
    return { status: "invalid", error: `failed to save: ${errorMessage(error)}` };
  }

  let warning: string | undefined;
  try {
    await deps.policyCache.forceRefresh();
    if (deps.policyCache.isMalformed()) {
      warning = `saved, but the routing cache failed to reload it: ${deps.policyCache.lastError() ?? "unknown error"}`;
    }
  } catch (error) {
    warning = `saved, but the routing cache failed to reload it: ${errorMessage(error)}`;
  }

  return { status: "saved", policy: parsed.data, warning };
}

/**
 * Handler factory for the settings screen's RPC surface. Takes the same
 * long-lived caches `index.server.ts` builds for the routing hook — `read`
 * and `write` bypass `policyCache` for a fresh `paseo.config.get()` (the
 * settings screen must see the true current revision, not a up-to-60s-stale
 * cache entry), while `listModels`/`recentAgentTypes`/`explain` reuse the
 * cache instances so "test this name" mirrors what the router would
 * actually do right now.
 */
export function createRoleModelPolicyRpcHandlers(deps: RoleModelPolicyRpcDeps): RoleModelPolicyRpcHandlers {
  // `write`'s read-current -> check-revision -> patch span crosses microtask
  // boundaries (multiple awaits), and the plugin RPC dispatcher does not
  // serialize inbound calls — without this, two concurrent writes can both
  // read the same current revision, both pass the check, and both patch,
  // silently losing whichever one wrote first. Routed through this mutex,
  // the second writer's read happens after the first's patch, so it
  // correctly observes the new revision and reports `conflict`.
  const withWriteLock = createMutex();

  return {
    async read(_input, { paseo }) {
      const result = await loadRolePolicy(paseo, deps.policyCache.get());
      return { policy: result.policy, malformed: result.malformed, error: result.error };
    },

    write(input, { paseo }) {
      return withWriteLock(() => performWrite(input, paseo, deps));
    },

    async listModels(input, { paseo }) {
      const catalog: Record<string, string[]> = {};
      if (input.force) {
        try {
          // TYPE NOTE: same structural-read rationale as model-catalog.ts —
          // family ids come from free-form policy config, not necessarily a
          // known AgentProvider literal.
          type RefreshOptions = Parameters<typeof paseo.providers.refresh>[0];
          await paseo.providers.refresh({ providers: input.families } as RefreshOptions);
        } catch {
          // Best-effort: fall through to per-family listModels below, which
          // still returns whatever the daemon currently has.
        }
      }
      for (const family of input.families) {
        try {
          const result = await paseo.providers.listModels(
            family as Parameters<typeof paseo.providers.listModels>[0],
          );
          catalog[family] = (result.models ?? []).map((model) => model.id);
        } catch {
          catalog[family] = [];
        }
      }
      if (input.force) {
        // Best-effort warm of the routing hook's own cache; never blocks the response.
        void deps.catalogCache.forceRefresh().catch(() => {});
      }
      return { catalog };
    },

    async recentAgentTypes() {
      return { values: deps.recentAgentTypes.list() };
    },

    async explain(input) {
      const policy = deps.policyCache.get();
      const resolution = resolveRole(policy, {
        labels: input.agentType !== undefined ? { [AGENT_TYPE_LABEL]: input.agentType } : undefined,
        title: input.title,
      });
      const catalog = deps.catalogCache.get();
      const { pool } = deps.poolCache.get();
      const outcome = selectModel(resolution.role, catalog, pool, deps.health, {
        modelBudgetThresholdPct: policy.modelBudgetThresholdPct,
      });

      return {
        roleId: resolution.role.id,
        roleName: resolution.role.name,
        tier: resolution.tier,
        outcome: outcome.outcome,
        ...(outcome.outcome !== "unconfigured" ? { model: outcome.model } : {}),
        // Omitted for a bare ref: no provider was chosen, so the account
        // router is still free to pick any healthy pooled account.
        ...(outcome.outcome !== "unconfigured" && outcome.provider !== null
          ? { provider: outcome.provider }
          : {}),
      };
    },
  };
}
