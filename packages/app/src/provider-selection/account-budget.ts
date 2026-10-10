import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { AccountPoolMember } from "@/orchestration/account-budget-strip-model";
import { resolveUsedPct } from "@/provider-usage/format";
import type { ProviderUsage, ProviderUsageWindow } from "@/provider-usage/types";

/**
 * Which pooled Claude accounts can still run a new chat, from the same usage payload and pool
 * config the orchestration budget strip reads.
 *
 * The app remembers one provider for every new chat, so an account that ran out since it was
 * last used would keep being offered as the default — and a chat started there fails on its
 * first turn. The daemon's account pool moves such a chat at create time too; this keeps the
 * composer from showing a choice that is about to be overruled.
 */
export interface AccountBudget {
  /** Leader first, then workers by priority: `resolveAccountPool`'s order. */
  pool: readonly AccountPoolMember[];
  usage: readonly ProviderUsage[];
}

/** A pooled account at a usage cap: the window that stopped it, and when it comes back. */
export interface AccountOutOfBudget {
  providerId: string;
  windowId: string;
  resetsAt: string | null;
}

const GENERAL_WINDOW_IDS = new Set(["five_hour", "weekly"]);
const MODEL_WINDOW_PREFIX = "weekly_model_";

/** A per-model weekly window binds only a model of that family, e.g. `weekly_model_opus`. */
function windowBinds(windowId: string, modelId: string | null | undefined): boolean {
  if (GENERAL_WINDOW_IDS.has(windowId)) return true;
  if (!modelId || !windowId.startsWith(MODEL_WINDOW_PREFIX)) return false;
  const family = windowId.slice(MODEL_WINDOW_PREFIX.length).toLowerCase();
  return family.length > 0 && modelId.toLowerCase().includes(family);
}

function findUsage(budget: AccountBudget, providerId: string): ProviderUsage | undefined {
  const key = providerId.toLowerCase();
  return budget.usage.find((candidate) => candidate.providerId.toLowerCase() === key);
}

function isPoolMember(budget: AccountBudget, providerId: string): boolean {
  const key = providerId.toLowerCase();
  return budget.pool.some((member) => member.providerId.toLowerCase() === key);
}

function bindingWindows(
  usage: ProviderUsage,
  modelId: string | null | undefined,
): ProviderUsageWindow[] {
  return usage.windows.filter((window) => windowBinds(window.id, modelId));
}

/**
 * The window that stops a pooled account from running `modelId`, or null. Only a window at its
 * cap counts: a drained account is still a working choice. Without a model, only the session and
 * weekly windows count.
 */
export function findAccountOutOfBudget(
  budget: AccountBudget,
  providerId: string,
  modelId?: string | null,
): AccountOutOfBudget | null {
  if (!isPoolMember(budget, providerId)) return null;
  const usage = findUsage(budget, providerId);
  if (!usage || usage.status !== "available") return null;
  for (const window of bindingWindows(usage, modelId)) {
    const usedPct = resolveUsedPct(window);
    if (usedPct !== null && usedPct >= 100) {
      return { providerId, windowId: window.id, resetsAt: window.resetsAt ?? null };
    }
  }
  return null;
}

/** The fullest binding window, as a ranking key: lower means more room. Unknown counts as empty. */
function fullestUsedPct(budget: AccountBudget, providerId: string, modelId: string | null): number {
  const usage = findUsage(budget, providerId);
  if (!usage || usage.status !== "available") return 0;
  let fullest = 0;
  for (const window of bindingWindows(usage, modelId)) {
    fullest = Math.max(fullest, resolveUsedPct(window) ?? 0);
  }
  return fullest;
}

/**
 * The provider a new chat should default to: `provider` itself unless it is a pooled account
 * that is out of budget. Then the leader account, then the worker with the most room left. When
 * nothing else can serve, `provider` stands — the daemon has the final word at create time.
 */
export function avoidOutOfBudgetAccount(input: {
  provider: AgentProvider;
  budget: AccountBudget | null;
  isSelectable: (provider: AgentProvider) => boolean;
  /** The model the form would open with on each account, if one is remembered. */
  modelFor: (provider: AgentProvider) => string | null;
}): AgentProvider {
  const { provider, budget, isSelectable, modelFor } = input;
  if (!budget || !findAccountOutOfBudget(budget, provider, modelFor(provider))) return provider;

  const usable = budget.pool.filter(
    (member) =>
      member.providerId !== provider &&
      isSelectable(member.providerId) &&
      !findAccountOutOfBudget(budget, member.providerId, modelFor(member.providerId)),
  );
  const leader = usable.find((member) => member.role === "leader");
  if (leader) return leader.providerId;
  const [best] = usable
    .map((member, order) => ({
      member,
      order,
      fullest: fullestUsedPct(budget, member.providerId, modelFor(member.providerId)),
    }))
    .sort((a, b) => a.fullest - b.fullest || a.order - b.order);
  return best?.member.providerId ?? provider;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function formatClock(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${WEEKDAYS[date.getDay()]} ${hours}:${minutes}`;
}

/** "out until Sat 06:00" in local time, or "out of budget" when no reset is known. */
export function formatOutOfBudget(out: AccountOutOfBudget): string {
  const resetsAt = out.resetsAt ? new Date(out.resetsAt) : null;
  if (!resetsAt || Number.isNaN(resetsAt.getTime())) return "out of budget";
  return `out until ${formatClock(resetsAt)}`;
}

/** Provider id → compact budget note, for the pooled accounts that are out right now. */
export function buildAccountBudgetNotes(budget: AccountBudget | null): Map<AgentProvider, string> {
  const notes = new Map<AgentProvider, string>();
  if (!budget) return notes;
  for (const member of budget.pool) {
    const out = findAccountOutOfBudget(budget, member.providerId);
    if (out) notes.set(member.providerId, formatOutOfBudget(out));
  }
  return notes;
}
