import { randomUUID } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { CURRENT_SCHEMA_VERSION, RoleModelPolicySchema, type RoleModelPolicy } from "../shared/role-policy-schema";
import { roleModelPolicyRpc, type RoleModelPolicyExplainResult } from "../shared/role-policy-rpc";
import type { HealthTracker } from "./health";
import type { ModelCatalogCache } from "./model-catalog";
import type { PoolCache } from "./pool";
import type { RecentAgentTypes } from "./recent-agent-types";
import { loadRolePolicy, type PolicyCache } from "./role-policy";
import { classifyAgent } from "./classifier";
import { AGENT_ROLE_LABEL, AGENT_TYPE_LABEL, TASK_CLASS_LABEL } from "../shared/role-policy-schema";
import { profileDeniedTools } from "../shared/tool-profiles";

export interface RoleModelPolicyRpcDeps {
  policyCache: PolicyCache;
  catalogCache: ModelCatalogCache;
  poolCache: PoolCache;
  /**
   * Wider than the create hook's: `explain` reports which pooled ACCOUNT
   * would serve the agent, and the account ladder scores headroom across
   * every window (server/account-select.ts).
   */
  health: Pick<
    HealthTracker,
    | "isHealthyFor"
    | "isLastResortEligible"
    | "windowUtilization"
    | "isHealthyForAllWindows"
    | "describeWindow"
    | "windowIds"
  >;
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

type EditableDocument = Pick<RoleModelPolicy, "roles" | "agentTypeMappings" | "modelBudgetThresholdPct" | "thinking">;

/** Two documents are semantically equal when their editable fields serialize identically (order-sensitive: array order is meaningful). */
function sameDocument(a: EditableDocument, b: EditableDocument): boolean {
  return (
    JSON.stringify(a.roles) === JSON.stringify(b.roles) &&
    JSON.stringify(a.agentTypeMappings) === JSON.stringify(b.agentTypeMappings) &&
    a.modelBudgetThresholdPct === b.modelBudgetThresholdPct &&
    JSON.stringify(a.thinking) === JSON.stringify(b.thinking)
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
    // OPTIONAL on the patch, unlike the fields above: an app build that
    // predates this field never sends it, and the stored value carries
    // through untouched rather than resetting to the schema's default —
    // mirroring how allowUnlistedModels survives an unrelated save below.
    thinking: input.patch.thinking ?? current.policy.thinking,
  };
  if (sameDocument(candidateDoc, current.policy)) {
    // Semantic no-op: nothing to persist, revision stays put.
    return { status: "saved", policy: current.policy };
  }

  const candidate: RoleModelPolicy = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ...candidateDoc,
    // Not part of the settings screen's editable surface yet — carry the
    // stored values through untouched so saving any other field can't
    // silently reset one of these escape hatches back to its default.
    enforceToolsOnClassifiedRoles: current.policy.enforceToolsOnClassifiedRoles,
    exposeClassifierTool: current.policy.exposeClassifierTool,
    // Same reason: `allowUnlistedModels` is operator-only config, and dropping it
    // on an unrelated save would silently re-arm the catalog check for a model
    // the operator had opted in.
    allowUnlistedModels: current.policy.allowUnlistedModels,
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

    /**
     * The settings preview, answered by the SAME function the
     * `before("agent.create")` hook calls — see server/classifier.ts. Nothing
     * here re-derives a rule; it maps one `AgentDecision` onto the wire.
     *
     * `Date.now()` is read HERE, not in the classifier: the account ladder
     * scores headroom against an instant, and keeping the clock on the
     * consumer's side is what keeps the classifier replayable.
     */
    async explain(input) {
      // Re-read first: `explain` is what an operator runs right after editing
      // the config, and answering from a cache up to 60s old made a correct
      // edit look ignored (read() bypasses the cache; explain() did not).
      // forceRefresh keeps the last good policy on any failure, so this cannot
      // throw.
      await deps.policyCache.forceRefresh();
      const policy = deps.policyCache.get();
      // Re-read first: `explain` is what an operator runs right after editing
      // the config, and answering from a cache up to 60s old made a correct
      // edit look ignored (read() bypasses the cache; explain() did not).
      // forceRefresh keeps the last good policy on any failure, so this cannot
      // throw. Done here rather than inside the classifier, which takes the
      // policy as data and never fetches anything.
      await deps.policyCache.forceRefresh();
      const freshPolicy = deps.policyCache.get();
      const { pool } = deps.poolCache.get();
      const labels: Record<string, string> = {};
      if (input.agentType !== undefined) labels[AGENT_TYPE_LABEL] = input.agentType;
      if (input.role !== undefined) labels[AGENT_ROLE_LABEL] = input.role;
      if (input.taskClass !== undefined) labels[TASK_CLASS_LABEL] = input.taskClass;

      const decision = classifyAgent(
        {
          labels: Object.keys(labels).length > 0 ? labels : undefined,
          title: input.title,
          initialPrompt: input.prompt,
          // A root agent has no caller; anything else is simulated as a child
          // of a synthetic caller, which is what makes the leader tier
          // reachable from this screen at all.
          callerAgentId: input.root === true ? undefined : "(preview)",
          requestedProvider: input.requestedProvider,
          requestedModel: input.requestedModel,
          requestedThinkingOptionId: input.requestedThinkingOptionId,
        },
        {
          policy: freshPolicy,
          catalog: deps.catalogCache.get(),
          thinkingCatalog: deps.catalogCache.getThinking(),
          pool,
          health: deps.health,
          nowMs: Date.now(),
        },
      );

      const { role, taskClass, model, tools, account, thinking } = decision;
      const requestedModelOverride: RoleModelPolicyExplainResult["requestedModelOverride"] = model.override
        ? {
            requestedRef: model.override.requestedRef,
            honored: false,
            effectiveRef: model.override.effectiveRef,
            reason: model.override.reason,
            ...(model.override.missingFromCatalog ? { missingFromCatalog: true } : {}),
          }
        : model.requestedRef !== undefined
          ? {
              requestedRef: model.requestedRef,
              honored: true,
              // Honored, but only because the catalog check was waived: the
              // model is unverified, and a real agent would carry
              // paseo.model-unadvertised.
              ...(model.unadvertised?.source === "explicit" ? { unadvertised: true } : {}),
            }
          : undefined;

      return {
        roleId: role.role.id,
        roleName: role.role.name,
        roleSource: role.source,
        ...(role.tier !== undefined ? { tier: role.tier } : {}),
        ...(role.unknownDeclaredValue !== undefined ? { unknownDeclaredRole: role.unknownDeclaredValue } : {}),
        outcome: model.outcome,
        ...(model.model !== undefined ? { model: model.model } : {}),
        // Selected as the pool default even though the catalog doesn't list it:
        // running on the operator's say-so, so the panel can say "unverified".
        ...(model.unadvertised?.source === "pool" ? { modelUnadvertised: true } : {}),
        // Omitted for a bare ref: no provider was chosen, so the account
        // router is still free to pick any healthy pooled account.
        ...(model.provider !== null ? { provider: model.provider } : {}),
        pool: [...model.pool],
        poolSlot: model.poolSlot,
        fellBackToStandardPool: model.fellBackToStandardPool,
        deniedTools: tools.deniedTools,
        ...(tools.withheld
          ? {
              toolsWithheld: {
                profileKind: tools.withheld.profile.kind,
                deniedTools: tools.withheld.deniedTools,
              },
            }
          : {}),
        ...(taskClass.taskClass !== undefined ? { taskClass: taskClass.taskClass } : {}),
        taskClassSource: taskClass.source,
        ...(taskClass.unknownDeclaredValue !== undefined
          ? { unknownDeclaredTaskClass: taskClass.unknownDeclaredValue }
          : {}),
        account: {
          kind: account.kind,
          ...(account.providerId !== undefined ? { providerId: account.providerId } : {}),
          ...(account.usableProviderIds !== undefined ? { usableProviderIds: account.usableProviderIds } : {}),
        },
        reasons: {
          role: role.reason,
          taskClass: taskClass.reason,
          model: model.reason,
          tools: tools.reason,
          account: account.reason,
          thinking: thinking.reason,
        },
        thinking: {
          outcome: thinking.outcome,
          ...(thinking.optionId !== null ? { optionId: thinking.optionId } : {}),
          ...(thinking.modelRef !== undefined ? { modelRef: thinking.modelRef } : {}),
          ...(thinking.wanted !== undefined ? { wanted: thinking.wanted } : {}),
          ...(thinking.subagentCapped ? { subagentCapped: true } : {}),
          ...(thinking.clamped ? { clamped: thinking.clamped } : {}),
          ...(thinking.requested !== undefined ? { requested: thinking.requested } : {}),
          ...(thinking.override
            ? {
                override: {
                  requested: thinking.override.requested,
                  ...(thinking.override.applied !== null ? { applied: thinking.override.applied } : {}),
                  reason: thinking.override.reason,
                },
              }
            : {}),
        },
        ...(requestedModelOverride ? { requestedModelOverride } : {}),
        ...(model.unadvertisedPoolEntries.length > 0
          ? { unadvertisedPoolEntries: model.unadvertisedPoolEntries }
          : {}),
      };
    },
  };
}
