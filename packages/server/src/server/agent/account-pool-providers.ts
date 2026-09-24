import { z } from "zod";
import { NEUTRAL_HEADROOM } from "./account-pool-headroom.js";
import { ProviderOverrideSchema } from "./provider-launch-config.js";

/**
 * `agents.providers.<id>.params.accountPool` is schema-passthrough today (KTD3,
 * docs/plans/2026-09-10-001-feat-claude-account-pool-routing-plan.md) — no formally-typed
 * field on ProviderOverrideSchema. This is the one place that gives it a shape for the
 * account-failover monitor; a missing or malformed `accountPool` just drops that entry from
 * consideration rather than throwing.
 */
const AccountPoolSchema = z
  .object({
    role: z.enum(["leader", "worker"]).optional(),
    priority: z.number().optional(),
  })
  .passthrough();

const AccountPoolParamsSchema = z
  .object({
    accountPool: AccountPoolSchema.optional(),
  })
  .passthrough();

export interface AccountPoolProviderEntry {
  providerId: string;
  role: "leader" | "worker";
  priority: number;
  /** `enabled: false` hides a provider from the app/CLI (docs/custom-providers.md); it is
   * never a valid migration target even if otherwise healthy. */
  enabled: boolean;
}

/**
 * Claude-family: the bare `"claude"` id (the base built-in, which can itself carry `env`/
 * `params` overrides directly — Tyler's leader slot is exactly this shape) or any entry with
 * `extends: "claude"`. Mirrors the `pid != "claude" and extends != "claude"` filter in
 * claude-account-handoff's recent-leaders.py — same fact, read the same way.
 */
function isClaudeFamily(providerId: string, extendsValue: string | undefined): boolean {
  return providerId === "claude" || extendsValue === "claude";
}

/**
 * Resolve every claude-family provider entry that opted into the account pool via
 * `params.accountPool.{role,priority}`. Reads the same resolved `agents.providers` config the
 * daemon itself validates entries with (`ProviderOverrideSchema`) — not anything the separate,
 * out-of-repo routing plugin computes. Entries without a recognizable `accountPool` are
 * omitted; malformed `accountPool` values (unknown role, non-numeric priority) fail their own
 * parse and are treated the same as absent.
 */
export function resolveAccountPoolEntries(
  providers: Record<string, unknown> | undefined,
): AccountPoolProviderEntry[] {
  if (!providers) return [];

  const entries: AccountPoolProviderEntry[] = [];
  for (const [providerId, rawConfig] of Object.entries(providers)) {
    const result = ProviderOverrideSchema.safeParse(rawConfig);
    if (!result.success || !isClaudeFamily(providerId, result.data.extends)) continue;

    const params = AccountPoolParamsSchema.safeParse(result.data.params ?? {});
    const pool = params.success ? params.data.accountPool : undefined;
    if (!pool?.role || typeof pool.priority !== "number") continue;

    entries.push({
      providerId,
      role: pool.role,
      priority: pool.priority,
      enabled: result.data.enabled !== false,
    });
  }
  return entries;
}

export interface PickFailoverTargetOptions {
  deadProviderIds: ReadonlySet<string>;
  sourceProviderId: string;
  /**
   * Per-provider headroom from `headroomByProvider`, best-first. Absent providers score
   * NEUTRAL_HEADROOM, so an empty map ranks everything equal and the configured priority order
   * decides — the behaviour before headroom existed, and the behaviour when usage is unreadable.
   */
  headroom?: ReadonlyMap<string, number>;
  /**
   * Whether the leader account may be a target once no worker can take the agent. Defaults to
   * true. `false` restores the strict isolation this used to enforce.
   */
  allowLeader?: boolean;
}

/**
 * Where a stuck agent goes: an enabled account that is not dead this sweep and is not the one it
 * is leaving, preferring a worker, and among equals preferring the one with the most budget left.
 *
 * **Isolation is a preference, not a rule.** Workers are still tried first — keeping rescued
 * agents off the leader's account is the budget separation the pool exists for. But when no
 * worker can take the agent, the leader account is better than leaving it stranded, which is
 * what "the leader is never a target" produced on 2026-09-15: the leader account and the primary
 * worker were both out for the week, the backup was reachable for children, and the rule kept it
 * from being the general-purpose home. Placement at spawn time makes the same choice (the
 * account-pool plugin's router), and the two have to agree or a migration will strand a leader on
 * an account placement is happily using for children.
 *
 * With nothing eligible at all this returns null; the caller skips the agent and retries next
 * sweep (no pending state — each sweep re-derives from scratch).
 */
export function pickFailoverTarget(
  entries: readonly AccountPoolProviderEntry[],
  options: PickFailoverTargetOptions,
): string | null {
  const headroomOf = (providerId: string): number =>
    options.headroom?.get(providerId) ?? NEUTRAL_HEADROOM;
  const eligible = entries.filter(
    (entry) =>
      entry.enabled &&
      entry.providerId !== options.sourceProviderId &&
      !options.deadProviderIds.has(entry.providerId) &&
      (entry.role === "worker" || (options.allowLeader ?? true)),
  );
  // Role first so a worker always outranks the leader however the budget compares: a leader
  // account with more headroom is still the account whose budget the pool is protecting.
  const ranked = [...eligible].sort(
    (a, b) =>
      Number(a.role === "leader") - Number(b.role === "leader") ||
      headroomOf(b.providerId) - headroomOf(a.providerId) ||
      a.priority - b.priority ||
      a.providerId.localeCompare(b.providerId),
  );
  return ranked[0]?.providerId ?? null;
}
