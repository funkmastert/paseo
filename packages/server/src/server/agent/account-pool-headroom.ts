/**
 * How much budget a pool account has left, as one comparable number, computed from the same
 * `ProviderUsage` rows the failover sweep already reads. Pure — the caller passes the rows and
 * `nowMs`. See docs/account-failover.md.
 *
 * Failover used to take the lowest-priority-number worker that wasn't dead. Priority never
 * changes, so a rescue landed on whichever account the operator numbered first regardless of
 * what was left in it, and the quiet account stayed quiet until everything ahead of it capped.
 * Ranking by headroom sends the agent where the budget actually is.
 */
import type { ProviderUsage } from "@getpaseo/protocol/messages";

/**
 * How long a cached usage row may be trusted before the proactive dead-account check
 * (`account-failover-detector.ts`) and target ranking both have to treat it as unreadable rather
 * than live (OR-D8). Configurable via `agents.accountFailover.usageStaleAfterMs`. Without a
 * bound, a usage row that stopped refreshing would either wedge an account dead forever at a
 * stale 100%, or dangle a stale 0% in front of the headroom ranking as if it were free.
 */
export const DEFAULT_USAGE_STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * Every pool provider whose usage row is older than `staleAfterMs`, keyed to how old it is. A
 * row's own `fetchedAt` wins when a fetcher sets one (the OpenAI usage fetcher does); the Claude
 * fetcher never does, so those rows fall back to `batchFetchedAtMs` — when
 * `ProviderUsageService.listUsage()` last actually fetched, the same timestamp every row in that
 * response shares. A provider with neither is never stale — there is no evidence it is old, and
 * a response from before provenance tracking existed must keep working. The caller filters these
 * rows out of both legs: the dead-account check (so a stale 100% does not condemn an account
 * forever) and headroom/saturation ranking (so a stale reading does not make a target look like
 * it has room it may no longer have).
 */
export function staleUsageAges(
  usage: readonly ProviderUsage[] | null,
  nowMs: number,
  staleAfterMs: number,
  batchFetchedAtMs: number | null,
): Map<string, number> {
  const ages = new Map<string, number>();
  for (const provider of usage ?? []) {
    const ownFetchedAtMs = provider.fetchedAt ? Date.parse(provider.fetchedAt) : Number.NaN;
    const fetchedAtMs = Number.isFinite(ownFetchedAtMs) ? ownFetchedAtMs : batchFetchedAtMs;
    if (fetchedAtMs === null || !Number.isFinite(fetchedAtMs)) continue;
    const age = nowMs - fetchedAtMs;
    if (age > staleAfterMs) ages.set(provider.providerId, age);
  }
  return ages;
}

/**
 * How far ahead a reset is worth anything. A day: the span a rescue actually has to cover, so a
 * window resetting on Friday does not pull an agent onto an account that cannot run it today.
 */
const HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * An account with no usable reading scores as empty. Optimistic on purpose, and it is what
 * keeps this inert where usage is unreadable: every candidate ties and the tie-break is the
 * configured priority order, which is what ran before.
 */
export const NEUTRAL_HEADROOM = 100;

/**
 * What one window is worth: what is free now, plus what the reset gives back, discounted by the
 * wait. The discount is why "20% left, resets in an hour" beats "30% left, resets on Friday" —
 * the first is about to be a whole fresh window, the second is all there is until the weekend.
 */
function windowScore(freePct: number, resetsAtMs: number | null, nowMs: number): number {
  const free = Math.max(0, Math.min(100, freePct));
  if (resetsAtMs === null) return free;
  const waitMs = resetsAtMs - nowMs;
  if (waitMs >= HORIZON_MS) return free;
  const nearness = waitMs <= 0 ? 1 : 1 - waitMs / HORIZON_MS;
  return free + (100 - free) * nearness;
}

function parseResetMs(resetsAt: string | null | undefined): number | null {
  if (!resetsAt) return null;
  const parsed = Date.parse(resetsAt);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The model families a Claude usage window can be scoped to. The account-pool plugin keeps the
 * same list (`plugins/claude-account-pool/server/windows.ts`); failover and placement have to
 * agree on which windows stop which agents.
 */
const MODEL_FAMILIES = ["opus", "sonnet", "haiku", "fable"] as const;

// The Claude fetcher's id for a model-scoped weekly window (`scopedWindowId` in
// services/quota-fetcher/providers/claude.ts). The suffix is the API's model id or a normalized
// display name, so it is matched by family, not compared.
const MODEL_WINDOW_ID = /^weekly_model_(.+)$/;

/** Whether a usage window is one model's weekly window rather than the whole account's. */
export function isModelWindow(windowId: string): boolean {
  return MODEL_WINDOW_ID.test(windowId);
}

function modelFamilyOf(text: string): string | undefined {
  const lower = text.toLowerCase();
  return MODEL_FAMILIES.find((family) => lower.includes(family));
}

/**
 * Whether a usage window stops an agent running `model`. A model's weekly window stops only that
 * model: an Opus cap leaves Sonnet workers on the same account running. Every other window
 * (session, weekly, a surface's) stops every agent on the account. An agent whose model is unset,
 * or not in a family this knows, is held to every window, since it may be the capped model.
 */
export function windowLimitsModel(windowId: string, model: string | undefined): boolean {
  const scope = MODEL_WINDOW_ID.exec(windowId)?.[1];
  if (scope === undefined) return true;
  const agentFamily = model ? modelFamilyOf(model) : undefined;
  if (agentFamily === undefined) return true;
  return modelFamilyOf(scope) === agentFamily;
}

/**
 * Per-provider headroom, best-first comparable. The tightest window wins, because a window is a
 * wall: 95% free on the session window buys nothing when the weekly window has 2% left. Given a
 * model, only the windows that stop that model count (`windowLimitsModel`).
 *
 * Quantized to whole points so ranking is a total order and two accounts a fraction apart keep
 * a stable order rather than swapping every time the usage cache refreshes.
 */
export function headroomByProvider(
  usage: readonly ProviderUsage[] | null,
  nowMs: number,
  model?: string,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const provider of usage ?? []) {
    let lowest: number | null = null;
    for (const window of provider.windows) {
      if (typeof window.usedPct !== "number") continue;
      if (!windowLimitsModel(window.id, model)) continue;
      const score = windowScore(100 - window.usedPct, parseResetMs(window.resetsAt), nowMs);
      if (lowest === null || score < lowest) lowest = score;
    }
    if (lowest !== null) scores.set(provider.providerId, Math.round(lowest));
  }
  return scores;
}

/**
 * A window at or above this is too close to its cap to move an agent onto: the agent would cap
 * again within a turn or two. The same line `~/bozeo-ops/failover-watch.mjs` drew.
 */
export const USABLE_BELOW_PCT = 90;

/**
 * Every account with a window at or above USABLE_BELOW_PCT that stops `model`
 * (`windowLimitsModel`). Never a move target for an agent on that model.
 */
export function saturatedProviderIds(
  usage: readonly ProviderUsage[] | null,
  model?: string,
): Set<string> {
  const saturated = new Set<string>();
  for (const provider of usage ?? []) {
    if (
      provider.windows.some(
        (window) =>
          typeof window.usedPct === "number" &&
          window.usedPct >= USABLE_BELOW_PCT &&
          windowLimitsModel(window.id, model),
      )
    ) {
      saturated.add(provider.providerId);
    }
  }
  return saturated;
}
