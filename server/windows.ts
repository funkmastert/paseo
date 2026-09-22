/**
 * Shared window-key vocabulary for the health tracker. A "window" is a
 * usage/limit scope: the two general windows every account has (the
 * rolling 5-hour session window and the weekly 7-day window), a whole-
 * account fallback used when a reactive failure can't be attributed to a
 * specific window, and per-model-family weekly windows (e.g. a weekly Opus
 * cap must not evacuate Sonnet work).
 */

/** The rolling 5-hour session window. */
export const WINDOW_FIVE_HOUR = "five_hour";
/**
 * The rolling 7-day weekly window. Matches the daemon's wire id (see
 * `UNSCOPED_WINDOWS` in
 * `/Users/tylerthackray/paseo/packages/server/src/services/quota-fetcher/providers/claude.ts`,
 * which maps `seven_day` usage to wire id `"weekly"`).
 */
export const WINDOW_SEVEN_DAY = "weekly";
/**
 * Whole-account fallback window. Used when a reactive failure message
 * can't be attributed to a specific window/model — caps everything
 * conservatively rather than guessing.
 */
export const WINDOW_ACCOUNT = "account";

/**
 * Model families recognized in reactive failure text and usage window ids.
 * `fable` is here because the daemon really does report a `weekly_model_fable`
 * window; without it a Fable-scoped cap was invisible to every window lookup.
 */
const MODEL_FAMILIES = ["opus", "sonnet", "haiku", "fable"] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

/**
 * Builds the weekly per-model-family window key, e.g. "weekly_model_opus".
 * Matches the shape produced by `scopedWindowId()` in
 * `/Users/tylerthackray/paseo/packages/server/src/services/quota-fetcher/providers/claude.ts`
 * for model-scoped weekly limits (`` `weekly_${dimension}_${name}` `` with
 * `dimension === "model"`), which is the daemon's source of truth for wire ids.
 */
export function weeklyModelWindow(family: ModelFamily): string {
  return `weekly_model_${family}`;
}

/** Extracts a known model family from free text (a message or a model id), if any. */
export function detectModelFamily(text: string): ModelFamily | undefined {
  const lower = text.toLowerCase();
  return MODEL_FAMILIES.find((family) => lower.includes(family));
}

/** The weekly per-model-family window key that applies to a given model id, if any. */
export function modelWindowFor(modelId: string): string | undefined {
  const family = detectModelFamily(modelId);
  return family ? weeklyModelWindow(family) : undefined;
}

/**
 * Whether a window id is a weekly one — the general 7-day window or a
 * per-model weekly one. Weekly windows are the reason cap expiry can't be
 * one constant: a 5-hour window is back within the working day, while a
 * weekly window can be dead until Friday. See health.ts's cap TTL split.
 */
export function isWeeklyWindow(window: string): boolean {
  return window === WINDOW_SEVEN_DAY || window.startsWith("weekly_");
}
