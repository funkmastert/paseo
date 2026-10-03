import type { ResolvedJevFeatureConfig } from "./jev/config.js";

/**
 * `agents.jev.titleRefresh` (docs/jev.md, "Feature 17: session title refresh"). Lenient like the
 * rest of `agents.jev`: a malformed value falls back to its default. No shadow mode (like
 * `agentTools` and `askJev`): a shadow gate would ask JEV and never regenerate anything, which
 * saves nothing and shows Tyler no change, so this feature is live the moment a key exists. The
 * `shadow` key is still accepted and ignored, so a config written as if it had one still loads.
 */
export interface ResolvedWorkspaceTitleRefreshConfig extends ResolvedJevFeatureConfig {
  shadow: false;
  /**
   * A `fit` score at or over this level (0-3, see `TITLE_REFRESH_QUESTIONS`) means the name has
   * drifted enough to spend a regeneration. Code owns this threshold; JEV only answers.
   */
  staleScoreThreshold: number;
  /** An answer below this confidence (0-1) is ignored and the cadence decides instead. */
  minConfidence: number;
  /** Without JEV, or for a D7-excluded workspace: minimum new user turns before regenerating. */
  cadenceMinUserTurns: number;
  /** Without JEV, or for a D7-excluded workspace: minimum minutes since the title was last set. */
  cadenceMinMinutes: number;
  /** Regenerate after this many new user turns even if JEV keeps answering "still fits". */
  ceilingUserTurns: number;
  /** Regenerate after this many hours even if JEV keeps answering "still fits". */
  ceilingHours: number;
}

export const TITLE_REFRESH_DEFAULTS: ResolvedWorkspaceTitleRefreshConfig = {
  enabled: true,
  shadow: false,
  timeoutMs: 3000,
  staleScoreThreshold: 2,
  minConfidence: 0.6,
  cadenceMinUserTurns: 3,
  cadenceMinMinutes: 60,
  ceilingUserTurns: 8,
  ceilingHours: 6,
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInt(value: unknown, fallback: number): number {
  return Math.floor(positive(value, fallback)) || fallback;
}

function fraction(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

function scoreLevel(value: unknown, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(3, Math.max(0, Math.floor(n)));
}

export function resolveWorkspaceTitleRefreshConfig(
  raw: unknown,
): ResolvedWorkspaceTitleRefreshConfig {
  const section = record(raw);
  return {
    enabled: bool(section["enabled"], TITLE_REFRESH_DEFAULTS.enabled),
    shadow: false,
    timeoutMs: positiveInt(section["timeoutMs"], TITLE_REFRESH_DEFAULTS.timeoutMs),
    staleScoreThreshold: scoreLevel(
      section["staleScoreThreshold"],
      TITLE_REFRESH_DEFAULTS.staleScoreThreshold,
    ),
    minConfidence: fraction(section["minConfidence"], TITLE_REFRESH_DEFAULTS.minConfidence),
    cadenceMinUserTurns: positiveInt(
      section["cadenceMinUserTurns"],
      TITLE_REFRESH_DEFAULTS.cadenceMinUserTurns,
    ),
    cadenceMinMinutes: positive(
      section["cadenceMinMinutes"],
      TITLE_REFRESH_DEFAULTS.cadenceMinMinutes,
    ),
    ceilingUserTurns: positiveInt(
      section["ceilingUserTurns"],
      TITLE_REFRESH_DEFAULTS.ceilingUserTurns,
    ),
    ceilingHours: positive(section["ceilingHours"], TITLE_REFRESH_DEFAULTS.ceilingHours),
  };
}
