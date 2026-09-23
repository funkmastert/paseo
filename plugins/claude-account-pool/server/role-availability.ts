import {
  DEFAULT_MODEL_BUDGET_THRESHOLD_PCT,
  POOL_FAMILY,
  classModels,
  modelRefFamily,
  splitModelRef,
  type RoleRecord,
  type TaskClassId,
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
  | {
      outcome: "selected";
      provider: string | null;
      model: string;
      /**
       * Set only when the catalog doesn't list the model and it was selected
       * because the operator named it in `allowUnlistedModels`. Unverified by
       * the provider, verified by the operator; callers surface it.
       */
      unadvertised?: true;
    }
  | {
      outcome: "unavailable";
      provider: string | null;
      model: string;
      /** Same meaning as on "selected", for the fallback entry: unlisted by the catalog, vouched for by the operator. */
      unadvertised?: true;
    };

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
  /**
   * `RoleModelPolicy.allowUnlistedModels`: refs the operator has verified
   * even though the provider's catalog doesn't list them. An allowlisted
   * entry counts as present for the catalog check — both for a pool entry in
   * ordered selection and for an explicit request. Every other gate (pool
   * viability, the budget gate, role approval) still applies to it.
   */
  allowUnlistedModels?: readonly string[];
  /**
   * Which of the role's model pools to use — see `classModels` in
   * shared/role-policy-schema.ts. Omitted (or "standard") means
   * `role.models`, the same pool every role has always used; this makes the
   * task-class dimension purely additive for every existing caller.
   */
  taskClass?: TaskClassId;
}

/** Whether the provider's advertised catalog lists this model. */
function isListedInCatalog(family: string, model: string, catalog: ModelCatalog): boolean {
  return catalog.get(family)?.has(model) === true;
}

/**
 * The half of eligibility that is about capacity, not existence: for
 * pool-family refs, a viable pool member and the Fable budget gate. Kept
 * apart from the catalog check so an explicit request can waive the catalog
 * half alone (see `evaluateRequestedModel`) without ever waiving this one —
 * a capped or drained model must stay refused whether or not it is listed.
 */
function isRefUsable(
  family: string,
  model: string,
  pool: AvailabilityPool,
  health: AvailabilityHealth,
  thresholdPct: number,
): boolean {
  if (family !== POOL_FAMILY) {
    return true;
  }
  return poolHasViableMember(pool, health, model) && poolHasMemberWithinModelBudget(pool, health, model, thresholdPct);
}

/**
 * Per-ref eligibility check: catalog presence (or an operator allowlist
 * entry standing in for it), plus (for pool-family refs) pool viability and
 * the Fable budget gate. Shared by `selectModel`'s ordered walk and
 * `evaluateRequestedModel`'s single-ref check, so an explicit request is held
 * to the exact same bar as ordered selection.
 */
function isRefCurrentlySelectable(
  family: string,
  model: string,
  catalog: ModelCatalog,
  pool: AvailabilityPool,
  health: AvailabilityHealth,
  thresholdPct: number,
  allowUnlisted: readonly string[],
): boolean {
  const present = isListedInCatalog(family, model, catalog) || isAllowlisted(allowUnlisted, family, model);
  return present && isRefUsable(family, model, pool, health, thresholdPct);
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
 * the role's own configured entries for the given task class — the caller
 * choosing among models the operator already approved for this (role, task
 * class), as opposed to asking for something never configured to run.
 */
export function isRequestedModelApproved(
  role: RoleRecord,
  requestedFamily: string,
  requestedModel: string,
  taskClass?: TaskClassId,
): boolean {
  return classModels(role, taskClass).some((ref) => {
    const parsed = splitModelRef(ref);
    return parsed !== null && parsed.model === requestedModel && modelRefFamily(parsed) === requestedFamily;
  });
}

export interface RequestedModelEvaluation {
  /** Whether the (family, model) pair is literally one of the role's configured entries. */
  configured: boolean;
  /** Whether it's configured AND currently selectable — catalog present (or waived, see `unadvertised`), pool viable, budget gate open. */
  eligible: boolean;
  /**
   * Set only when `eligible` is true BECAUSE the catalog check was waived: the
   * model is absent from the advertised catalog and the operator listed it in
   * `allowUnlistedModels`. The caller must surface this — an unverified model
   * running is exactly the case that must never be silent.
   */
  unadvertised?: true;
  /**
   * Set only when the request is configured and usable but was refused for
   * being absent from the catalog and not in `allowUnlistedModels`. Lets the
   * override message say "add it to allowUnlistedModels if it's real" instead
   * of the generic not-currently-selectable text, which also covers capped.
   */
  missingFromCatalog?: true;
}

/** Whether `(family, model)` matches an entry of an allowlist of model refs, by family the same way pool membership does. */
function isAllowlisted(allowlist: readonly string[], family: string, model: string): boolean {
  return allowlist.some((ref) => {
    const parsed = splitModelRef(ref);
    return parsed !== null && parsed.model === model && modelRefFamily(parsed) === family;
  });
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
 *
 * The one exception to "same bar": an approved model absent from the
 * advertised catalog passes when the operator listed it in
 * `allowUnlistedModels`, because a provider can accept an id it doesn't
 * advertise. Only the catalog check is waived — pool viability and the budget
 * gate still apply, so a capped model stays refused — and the result says so
 * via `unadvertised`.
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
  const configured = isRequestedModelApproved(role, requestedFamily, requestedModel, options.taskClass);
  if (!configured) {
    return { configured: false, eligible: false };
  }
  const thresholdPct = options.modelBudgetThresholdPct ?? DEFAULT_MODEL_BUDGET_THRESHOLD_PCT;
  if (isListedInCatalog(requestedFamily, requestedModel, catalog)) {
    return { configured: true, eligible: isRefUsable(requestedFamily, requestedModel, pool, health, thresholdPct) };
  }
  if (!isAllowlisted(options.allowUnlistedModels ?? [], requestedFamily, requestedModel)) {
    // Not usable-checked: it is refused either way, and `missingFromCatalog`
    // is only a hint that the catalog is the reason.
    return { configured: true, eligible: false, missingFromCatalog: true };
  }
  if (!isRefUsable(requestedFamily, requestedModel, pool, health, thresholdPct)) {
    return { configured: true, eligible: false };
  }
  return { configured: true, eligible: true, unadvertised: true };
}

/**
 * The refs in the (role, task class) pool that ordered selection SKIPS: the
 * catalog doesn't list them and the operator hasn't allowlisted them. Reported
 * by `explain` so a pool entry that is never chosen is visible rather than a
 * silent no-op. An allowlisted entry is not skipped, so it isn't listed here.
 */
export function unadvertisedPoolEntries(
  role: RoleRecord,
  catalog: ModelCatalog,
  taskClass?: TaskClassId,
  allowUnlisted: readonly string[] = [],
): string[] {
  return classModels(role, taskClass).filter((ref) => {
    const parsed = splitModelRef(ref);
    if (parsed === null) {
      return false;
    }
    const family = modelRefFamily(parsed);
    return !isListedInCatalog(family, parsed.model, catalog) && !isAllowlisted(allowUnlisted, family, parsed.model);
  });
}

/**
 * Pure model selection: ordered intersection of the resolved (role, task
 * class) pool — see `classModels` — with the live catalog. That pool empty
 * -> UNCONFIGURED (byte-identical pass-through, caller must not touch the
 * request at all). Nothing eligible -> UNAVAILABLE using its first entry
 * anyway — routing problems get recovered, never used to skip a requested
 * subagent.
 *
 * Exhaustion stays inside the (role, task class) pool: one whose every entry
 * is gated out falls back to its own first entry, never to another
 * role/class's pool or to whatever model the parent happened to be running.
 */
export function selectModel(
  role: RoleRecord,
  catalog: ModelCatalog,
  pool: AvailabilityPool,
  health: AvailabilityHealth,
  options: SelectModelOptions = {},
): SelectModelResult {
  const models = classModels(role, options.taskClass);
  if (models.length === 0) {
    return { outcome: "unconfigured" };
  }
  const thresholdPct = options.modelBudgetThresholdPct ?? DEFAULT_MODEL_BUDGET_THRESHOLD_PCT;
  const allowUnlisted = options.allowUnlistedModels ?? [];

  for (const ref of models) {
    const parsed = splitModelRef(ref);
    if (!parsed) {
      continue; // Defensive: schema validation already prevents malformed refs from being stored.
    }
    const family = modelRefFamily(parsed);
    const { model } = parsed;
    if (!isRefCurrentlySelectable(family, model, catalog, pool, health, thresholdPct, allowUnlisted)) {
      continue;
    }
    return {
      outcome: "selected",
      provider: parsed.provider,
      model,
      ...(isListedInCatalog(family, model, catalog) ? {} : { unadvertised: true as const }),
    };
  }

  const fallback = splitModelRef(models[0]);
  if (!fallback) {
    return { outcome: "unconfigured" }; // Defensive: same guarantee as above.
  }
  const fallbackFamily = modelRefFamily(fallback);
  const fallbackUnadvertised =
    !isListedInCatalog(fallbackFamily, fallback.model, catalog) &&
    isAllowlisted(allowUnlisted, fallbackFamily, fallback.model);
  return {
    outcome: "unavailable",
    provider: fallback.provider,
    model: fallback.model,
    ...(fallbackUnadvertised ? { unadvertised: true as const } : {}),
  };
}
