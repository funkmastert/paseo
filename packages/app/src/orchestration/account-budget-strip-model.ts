import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { getProviderIcon, type ProviderIconComponent } from "@/components/provider-icons";
import { resolveUsedPct } from "@/provider-usage/format";
import type { ProviderUsage, ProviderUsageWindow } from "@/provider-usage/types";
import type { OrchestrationFlatRow } from "./orchestration-panel-model";

// The budget strip only ever composes these two windows (session + weekly). Any other
// windows a provider reports (balances, per-model detail rows, etc.) stay out of the
// compact strip and remain visible in the full ProviderUsageCard elsewhere.
const BUDGET_WINDOW_IDS = ["five_hour", "weekly"] as const;

/** What an account is for in the daemon's account pool, not what its label says. */
export type AccountPoolRole = "leader" | "primary" | "backup";

export interface AccountPoolMember {
  providerId: string;
  role: AccountPoolRole;
}

/** Live agents on one account: leaders are tree roots, workers are everything below one. */
export interface AccountUsageCount {
  leaders: number;
  workers: number;
}

interface AccountBudgetRowBase {
  providerId: string;
  label: string;
  /** Null for an account outside the pool, or when the host reports no pool at all. */
  role: AccountPoolRole | null;
  /** Null when the caller did not measure usage. */
  usage: AccountUsageCount | null;
}

export type AccountBudgetRowViewModel =
  | (AccountBudgetRowBase & {
      kind: "available";
      windows: ProviderUsageWindow[];
    })
  | (AccountBudgetRowBase & {
      kind: "unavailable";
    });

export interface AccountBudgetContext {
  pool: readonly AccountPoolMember[];
  usage: ReadonlyMap<string, AccountUsageCount>;
}

interface RawAccountPool {
  role: "leader" | "worker";
  priority: number;
}

function readAccountPool(entry: unknown): RawAccountPool | null {
  if (typeof entry !== "object" || entry === null) return null;
  const params: unknown = Reflect.get(entry, "params");
  if (typeof params !== "object" || params === null) return null;
  const pool: unknown = Reflect.get(params, "accountPool");
  if (typeof pool !== "object" || pool === null) return null;
  const role: unknown = Reflect.get(pool, "role");
  const priority: unknown = Reflect.get(pool, "priority");
  if (role !== "leader" && role !== "worker") return null;
  return { role, priority: typeof priority === "number" ? priority : Number.MAX_SAFE_INTEGER };
}

/**
 * The account pool as the daemon config declares it, at
 * `providers.<id>.params.accountPool`: the leader first, then workers by priority. The most
 * preferred worker is the primary and every worker after it is a backup — the role is the pool's
 * word for it, never inferred from the account's label. A host that declares no pool yields none.
 */
export function resolveAccountPool(
  providers: Readonly<Record<string, unknown>> | null | undefined,
): AccountPoolMember[] {
  if (!providers) return [];
  const leaders: AccountPoolMember[] = [];
  const workers: Array<{ providerId: string; priority: number }> = [];
  for (const [providerId, entry] of Object.entries(providers)) {
    const pool = readAccountPool(entry);
    if (!pool) continue;
    if (pool.role === "leader") leaders.push({ providerId, role: "leader" });
    else workers.push({ providerId, priority: pool.priority });
  }
  workers.sort((a, b) => a.priority - b.priority);
  return [
    ...leaders,
    ...workers.map(
      ({ providerId }, index): AccountPoolMember => ({
        providerId,
        role: index === 0 ? "primary" : "backup",
      }),
    ),
  ];
}

/** `claude` and every `claude-*` account a host configures; the accounts a pool is made of. */
export function isClaudeFamilyProviderId(providerId: string): boolean {
  const id = providerId.toLowerCase();
  return id === "claude" || id.startsWith("claude-");
}

/**
 * Every account the host reports when the daemon config is not available to this client (still
 * loading, not permitted over the relay, an older host): the Claude-family ids in the usage
 * payload and the providers snapshot, `claude` first. A host with no Claude account at all lists
 * whatever its usage payload reports, so the strip is not blank there. This never reads the tab's
 * tree: which accounts exist is a fact about the host, not about which of them this tab is using.
 */
export function resolveHostClaudeAccountIds(
  usageProviders: readonly Pick<ProviderUsage, "providerId">[],
  entries: readonly Pick<ProviderSnapshotEntry, "provider" | "enabled">[] | undefined,
): string[] {
  const claude = new Map<string, string>();
  const add = (providerId: string) => {
    if (isClaudeFamilyProviderId(providerId) && !claude.has(providerId.toLowerCase())) {
      claude.set(providerId.toLowerCase(), providerId);
    }
  };
  for (const provider of usageProviders) add(provider.providerId);
  for (const entry of entries ?? []) {
    if (entry.enabled !== false) add(entry.provider);
  }
  if (claude.size === 0) return usageProviders.map((provider) => provider.providerId);
  return [...claude.values()].sort((a, b) => {
    if (a.toLowerCase() === "claude") return -1;
    if (b.toLowerCase() === "claude") return 1;
    return a.localeCompare(b);
  });
}

/**
 * The strip's accounts: every pool member when the config declares a pool — an account nobody is
 * using right now is exactly the one whose headroom matters — otherwise every account the host
 * reports. Never the tab's tree, which would show one or two accounts in a tab that happens to use
 * one or two.
 */
export function resolveBudgetProviderIds(
  pool: readonly AccountPoolMember[],
  hostAccountIds: readonly string[],
): string[] {
  return pool.length > 0 ? pool.map((member) => member.providerId) : [...hostAccountIds];
}

/**
 * Leaders and workers currently on each account. Workers count while running or initializing —
 * the panel's own notion of alive: a finished agent no longer draws on the account, and counting
 * the idle majority of a real fleet would make every account look busy. A leader is idle between
 * turns while its workers run, and it is still the session those workers report to, so it counts
 * when it is alive itself or has any live agent below it. `rows` is the depth-first flatten, so a
 * root's subtree is the rows that follow it until the next root. A tab that is one leader's tree
 * passes `includeIdleLeaders`: that leader is the tab's own, so it is on its account whether or
 * not anything is running.
 */
export function countAccountUsage(
  rows: readonly Pick<OrchestrationFlatRow, "agent" | "depth">[],
  { includeIdleLeaders = false }: { includeIdleLeaders?: boolean } = {},
): Map<string, AccountUsageCount> {
  const counts = new Map<string, AccountUsageCount>();
  const bump = (provider: string, field: keyof AccountUsageCount) => {
    const current = counts.get(provider) ?? { leaders: 0, workers: 0 };
    current[field] += 1;
    counts.set(provider, current);
  };
  let leader: { provider: string; engaged: boolean } | null = null;
  const closeLeader = () => {
    if (leader && (leader.engaged || includeIdleLeaders)) bump(leader.provider, "leaders");
  };
  for (const { agent, depth } of rows) {
    const alive = agent.status === "running" || agent.status === "initializing";
    if (depth === 0) {
      closeLeader();
      leader = { provider: agent.provider, engaged: alive };
      continue;
    }
    if (!alive) continue;
    bump(agent.provider, "workers");
    if (leader) leader.engaged = true;
  }
  closeLeader();
  return counts;
}

// Snapshot label wins (it reflects custom-provider configuration); usage.displayName is
// the fallback for accounts the providers snapshot hasn't reported yet.
export function resolveAccountLabel(
  entries: ProviderSnapshotEntry[] | undefined,
  usage: ProviderUsage,
): string {
  const entry = entries?.find((candidate) => candidate.provider === usage.providerId);
  return entry?.label ?? usage.displayName;
}

export function selectBudgetWindows(usage: ProviderUsage): ProviderUsageWindow[] {
  return BUDGET_WINDOW_IDS.flatMap((id) => {
    const window = usage.windows.find((candidate) => candidate.id === id);
    return window ? [window] : [];
  });
}

// serverId-aware icon lookup so custom provider entries (e.g. claude-personal) resolve
// their snapshot icon instead of falling back to the generic Bot glyph. card.tsx's
// ProviderUsageIcon omits serverId; this call path intentionally does not repeat that.
export function resolveAccountIcon(providerId: string, serverId: string): ProviderIconComponent {
  return getProviderIcon(providerId, serverId);
}

export function buildAccountBudgetRows(
  providers: ProviderUsage[],
  providerIds: string[],
  entries: ProviderSnapshotEntry[] | undefined,
  context?: AccountBudgetContext,
): AccountBudgetRowViewModel[] {
  const poolRoles = new Map(
    (context?.pool ?? []).map((member) => [member.providerId.toLowerCase(), member.role]),
  );
  const rows: AccountBudgetRowViewModel[] = [];
  for (const providerId of providerIds) {
    const key = providerId.toLowerCase();
    const usage = providers.find((candidate) => candidate.providerId.toLowerCase() === key);
    const role = poolRoles.get(key) ?? null;
    // An account the usage endpoint has no entry for still gets a row: dropping it would make
    // the account vanish from the strip in exactly the case a reader is counting on it.
    const resolvedId = usage?.providerId ?? providerId;
    const base = {
      providerId: resolvedId,
      label: usage
        ? resolveAccountLabel(entries, usage)
        : (entries?.find((candidate) => candidate.provider === providerId)?.label ?? providerId),
      role,
      usage: context ? (context.usage.get(resolvedId) ?? { leaders: 0, workers: 0 }) : null,
    };
    if (!usage || usage.status !== "available") {
      rows.push({ ...base, kind: "unavailable" });
      continue;
    }
    rows.push({ ...base, kind: "available", windows: selectBudgetWindows(usage) });
  }
  return rows;
}

export interface WorstBudgetWindow {
  window: ProviderUsageWindow;
  usedPct: number;
}

/**
 * The one window a one-line account has room for: its fullest. It is the number that decides
 * whether to hand more work to that account. Ties keep window order; a window with no reading
 * cannot be the worst.
 */
export function selectAccountWorstWindow(row: AccountBudgetRowViewModel): WorstBudgetWindow | null {
  if (row.kind !== "available") return null;
  let worst: WorstBudgetWindow | null = null;
  for (const window of row.windows) {
    const usedPct = resolveUsedPct(window);
    if (usedPct == null) continue;
    if (worst === null || usedPct > worst.usedPct) worst = { window, usedPct };
  }
  return worst;
}
