import { z } from "zod";
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

/**
 * Highest-priority (lowest `priority` number, then provider id) enabled worker that is not dead
 * this sweep and is not the account the agent is leaving.
 *
 * Leader-role entries are never a target, whatever their health: the leader account can be the
 * one that ran dry, and when it isn't, it holds the budget the pool exists to protect. So there
 * is no "leader as last resort" here — with no eligible worker this returns null, and the caller
 * skips the agent and retries next sweep (no pending state; each sweep re-derives from scratch).
 */
export function pickFailoverTarget(
  entries: readonly AccountPoolProviderEntry[],
  exclusions: { deadProviderIds: ReadonlySet<string>; sourceProviderId: string },
): string | null {
  const eligible = entries
    .filter(
      (entry) =>
        entry.role === "worker" &&
        entry.enabled &&
        entry.providerId !== exclusions.sourceProviderId &&
        !exclusions.deadProviderIds.has(entry.providerId),
    )
    .sort((a, b) => a.priority - b.priority || a.providerId.localeCompare(b.providerId));
  return eligible[0]?.providerId ?? null;
}
