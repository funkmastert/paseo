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
/** The rolling 7-day weekly window. */
export const WINDOW_SEVEN_DAY = "seven_day";
/**
 * Whole-account fallback window. Used when a reactive failure message
 * can't be attributed to a specific window/model — caps everything
 * conservatively rather than guessing.
 */
export const WINDOW_ACCOUNT = "account";

/** Model families recognized in reactive failure text and usage window ids. */
const MODEL_FAMILIES = ["opus", "sonnet", "haiku"] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

/** Builds the weekly per-model-family window key, e.g. "weekly-opus". */
export function weeklyModelWindow(family: ModelFamily): string {
  return `weekly-${family}`;
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
