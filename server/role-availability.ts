import { POOL_FAMILY, modelRefFamily, splitModelRef, type RoleRecord } from "../shared/role-policy-schema";

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
}

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
 * Pure model selection: ordered intersection of role.models with the live
 * catalog. `role.models` empty -> UNCONFIGURED (byte-identical pass-through,
 * caller must not touch the request at all). Nothing eligible -> UNAVAILABLE
 * using role.models[0] anyway — routing problems get recovered, never used
 * to skip a requested subagent.
 */
export function selectModel(
  role: RoleRecord,
  catalog: ModelCatalog,
  pool: AvailabilityPool,
  health: AvailabilityHealth,
): SelectModelResult {
  if (role.models.length === 0) {
    return { outcome: "unconfigured" };
  }

  for (const ref of role.models) {
    const parsed = splitModelRef(ref);
    if (!parsed) {
      continue; // Defensive: schema validation already prevents malformed refs from being stored.
    }
    const family = modelRefFamily(parsed);
    const { model } = parsed;
    if (!catalog.get(family)?.has(model)) {
      continue;
    }
    if (family === POOL_FAMILY && !poolHasViableMember(pool, health, model)) {
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
