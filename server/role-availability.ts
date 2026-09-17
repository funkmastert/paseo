import {
  DEFAULT_MODEL_BUDGET_THRESHOLD_PCT,
  POOL_FAMILY,
  modelRefFamily,
  splitModelRef,
  type RoleRecord,
} from "../shared/role-policy-schema";
import { detectModelFamily, weeklyModelWindow, type ModelFamily } from "./windows";

export type ModelCatalog = ReadonlyMap<string, ReadonlySet<string>>;

export interface AvailabilityPoolMember {
  providerId: string;
}

export interface AvailabilityPool {
  workers: readonly AvailabilityPoolMember[];
  leader: AvailabilityPoolMember | null;
}

export interface AvailabilityHealth {
  isHealthyFor(providerId: string, modelId: string): boolean;
  isLastResortEligible(providerId: string): boolean;
  windowUtilization(providerId: string, window: string): number | undefined;
}

/**
 * Model families whose weekly per-model window gates model SELECTION, not
 * just availability.
 *
 * Only Fable. It is the expensive escalation model, and a leader that keeps
 * reaching for it is exactly how a weekly window ends up at 94% with the rest
 * of the week still to run — by which point the cap lands mid-task rather than
 * at a model boundary. The everyday families (sonnet/haiku/opus) are the pool's
 * normal traffic; gating those at a soft threshold would churn the common path
 * for no benefit, since the hard cap already evacuates them.
 */
export const BUDGET_GATED_FAMILIES: readonly ModelFamily[] = ["fable"];

/**
 * `provider` is null for an account-agnostic (bare) ref: the role chose only
 * the model, and the account router still picks which pooled account runs it.
 * A non-null provider came from a pinned `provider/model` ref.
 */
export type SelectModelResult =
  | { outcome: "unconfigured" }
  | { outcome: "selected"; provider: string | null; model: string }
  | { outcome: "unavailable"; provider: string | null; model: string };

/**
 * Viable-anywhere check: looser than the account router's own selection
 * ladder (healthy -> last-resort -> leader). If any pool member — worker or
 * leader — is healthy or last-resort-eligible for the model, the role is
 * eligible; the router runs next and picks the actual account.
 */
function poolHasViableMember(pool: AvailabilityPool, health: AvailabilityHealth, modelId: string): boolean {
  const members: readonly AvailabilityPoolMember[] = pool.leader ? [...pool.workers, pool.leader] : pool.workers;
  return members.some(
    (member) => health.isHealthyFor(member.providerId, modelId) || health.isLastResortEligible(member.providerId),
  );
}

/**
 * Budget gate: is any pooled account still under `thresholdPct` on this
 * model's weekly per-model window?
 *
 * Only gated families are checked; everything else is always within budget.
 * An account with no reading yet is treated as within budget — a missing
 * usage poll must not silently downgrade every role's top model.
 */
function poolHasMemberWithinModelBudget(
  pool: AvailabilityPool,
  health: AvailabilityHealth,
  modelId: string,
  thresholdPct: number,
): boolean {
  const family = detectModelFamily(modelId);
  if (!family || !BUDGET_GATED_FAMILIES.includes(family)) {
    return true;
  }
  const window = weeklyModelWindow(family);
  const members: readonly AvailabilityPoolMember[] = pool.leader ? [...pool.workers, pool.leader] : pool.workers;
  return members.some((member) => {
    const usedPct = health.windowUtilization(member.providerId, window);
    return usedPct === undefined || usedPct < thresholdPct;
  });
}

export interface SelectModelOptions {
  /** Percent at/above which a budget-gated family stops being selectable. */
  modelBudgetThresholdPct?: number;
}

/**
 * Per-ref eligibility check: catalog presence, plus (for pool-family refs)
 * pool viability and the Fable budget gate. Shared by `selectModel`'s
 * ordered walk and `evaluateRequestedModel`'s single-ref check, so an
 * explicit request is held to the exact same bar as ordered selection.
 */
function isRefCurrentlySelectable(
  family: string,
  model: string,
  catalog: ModelCatalog,
  pool: AvailabilityPool,
  health: AvailabilityHealth,
  thresholdPct: number,
): boolean {
  if (!catalog.get(family)?.has(model)) {
    return false;
  }
  if (family === POOL_FAMILY) {
    if (!poolHasViableMember(pool, health, model)) {
      return false;
    }
    if (!poolHasMemberWithinModelBudget(pool, health, model, thresholdPct)) {
      return false;
    }
  }
  return true;
}

/** Renders a selection back into the ref spelling the operator configured, for logs/notifications. */
export function formatModelRef(outcome: { provider: string | null; model: string }): string {
  return outcome.provider === null ? outcome.model : `${outcome.provider}/${outcome.model}`;
}

/** Same shape as `AvailabilityPool`, kept separate so callers that only need family resolution don't have to construct a full pool. */
export interface FamilyResolvablePool {
  workers: ReadonlyArray<{ providerId: string }>;
  leader: { providerId: string } | null;
}

/** Model refs use provider-family ids; a request's current provider may instead be a literal pool-worker/leader entry id. */
export function familyOfProvider(pool: FamilyResolvablePool, providerId: string): string {
  if (providerId === POOL_FAMILY) {
    return POOL_FAMILY;
  }
  if (pool.workers.some((worker) => worker.providerId === providerId) || pool.leader?.providerId === providerId) {
    return POOL_FAMILY;
  }
  return providerId;
}

/**
 * Whether an explicitly requested (family, model) pair is literally one of
 * the role's own configured entries — the caller choosing among models the
 * operator already approved for this role, as opposed to asking for
 * something the role was never configured to run.
 */
export function isRequestedModelApproved(role: RoleRecord, requestedFamily: string, requestedModel: string): boolean {
  return role.models.some((ref) => {
    const parsed = splitModelRef(ref);
    return parsed !== null && parsed.model === requestedModel && modelRefFamily(parsed) === requestedFamily;
  });
}

export interface RequestedModelEvaluation {
  /** Whether the (family, model) pair is literally one of the role's configured entries. */
  configured: boolean;
  /** Whether it's configured AND currently selectable — catalog present, pool viable, budget gate open. */
  eligible: boolean;
}

/**
 * Evaluates an explicitly requested (family, model) pair against the
 * resolved role's own pool using the exact same eligibility bar ordered
 * selection applies — not just "is it in the configured list". A model that
 * is approved but currently capped everywhere or missing from the catalog
 * must not be honored as-is: that's the failure this exists to prevent (an
 * agent spawned onto an account/model with no budget left, dying on its
 * first turn). `configured` is still reported separately so the caller can
 * distinguish "not approved for this role at all" from "approved, but not
 * selectable right now" — two different situations that deserve different
 * messages.
 */
export function evaluateRequestedModel(
  role: RoleRecord,
  requestedFamily: string,
  requestedModel: string,
  catalog: ModelCatalog,
  pool: AvailabilityPool,
  health: AvailabilityHealth,
  options: SelectModelOptions = {},
): RequestedModelEvaluation {
  const configured = isRequestedModelApproved(role, requestedFamily, requestedModel);
  if (!configured) {
    return { configured: false, eligible: false };
  }
  const thresholdPct = options.modelBudgetThresholdPct ?? DEFAULT_MODEL_BUDGET_THRESHOLD_PCT;
  const eligible = isRefCurrentlySelectable(requestedFamily, requestedModel, catalog, pool, health, thresholdPct);
  return { configured: true, eligible };
}

/**
 * Pure model selection: ordered intersection of role.models with the live
 * catalog. `role.models` empty -> UNCONFIGURED (byte-identical pass-through,
 * caller must not touch the request at all). Nothing eligible -> UNAVAILABLE
 * using role.models[0] anyway — routing problems get recovered, never used
 * to skip a requested subagent.
 *
 * Exhaustion stays inside the role: a role whose every entry is gated out
 * falls back to its own models[0], never to another role's pool or to
 * whatever model the parent happened to be running.
 */
export function selectModel(
  role: RoleRecord,
  catalog: ModelCatalog,
  pool: AvailabilityPool,
  health: AvailabilityHealth,
  options: SelectModelOptions = {},
): SelectModelResult {
  if (role.models.length === 0) {
    return { outcome: "unconfigured" };
  }
  const thresholdPct = options.modelBudgetThresholdPct ?? DEFAULT_MODEL_BUDGET_THRESHOLD_PCT;

  for (const ref of role.models) {
    const parsed = splitModelRef(ref);
    if (!parsed) {
      continue; // Defensive: schema validation already prevents malformed refs from being stored.
    }
    const family = modelRefFamily(parsed);
    const { model } = parsed;
    if (!isRefCurrentlySelectable(family, model, catalog, pool, health, thresholdPct)) {
      continue;
    }
    return { outcome: "selected", provider: parsed.provider, model };
  }

  const fallback = splitModelRef(role.models[0]);
  if (!fallback) {
    return { outcome: "unconfigured" }; // Defensive: same guarantee as above.
  }
  return { outcome: "unavailable", provider: fallback.provider, model: fallback.model };
}
