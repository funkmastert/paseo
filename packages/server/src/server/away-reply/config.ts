import type { ResolvedJevFeatureConfig } from "../jev/config.js";

/**
 * `agents.jev.awayReply` (docs/jev.md, "Feature 14: away auto-reply"). Lenient like the rest of
 * `agents.jev`: a malformed value falls back to its default. Tyler asked this feature to act, so
 * it is live by default (D10), not shadow; `dryRun` is its shadow switch, and the service reads it
 * as `shadow`. Like every JEV feature it needs the dedicated key (D5), so without one it does
 * nothing.
 */
export interface ResolvedAwayReplyConfig extends ResolvedJevFeatureConfig {
  /** Log and record the decision, send nothing, write nothing. The service's `shadow`. */
  dryRun: boolean;
  /** How long a leader must have waited on Tyler before the job looks at it. */
  thresholdMinutes: number;
  maxRepliesPerAgentPerDay: number;
  /** Across every leader. */
  maxRepliesPerDay: number;
  /** A JEV destructive-intent probability at or over this sends nothing. At most 0.5. */
  destructiveThreshold: number;
  /** Approve a tool permission that code and JEV both judge read-only. */
  approveReadOnlyPermissions: boolean;
  /** Skip every agent in a pinned workspace. */
  skipPinnedWorkspaces: boolean;
}

/** Config can lower the destructive-intent threshold, never raise it past this. */
export const AWAY_REPLY_MAX_DESTRUCTIVE_THRESHOLD = 0.5;

export const AWAY_REPLY_DEFAULTS: ResolvedAwayReplyConfig = {
  enabled: true,
  shadow: false,
  dryRun: false,
  timeoutMs: 5000,
  thresholdMinutes: 60,
  maxRepliesPerAgentPerDay: 3,
  maxRepliesPerDay: 12,
  destructiveThreshold: 0.2,
  approveReadOnlyPermissions: true,
  skipPinnedWorkspaces: false,
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

export function resolveAwayReplyConfig(raw: unknown): ResolvedAwayReplyConfig {
  const section = record(raw);
  const dryRun = bool(section["dryRun"], AWAY_REPLY_DEFAULTS.dryRun);
  return {
    enabled: bool(section["enabled"], AWAY_REPLY_DEFAULTS.enabled),
    shadow: dryRun,
    dryRun,
    timeoutMs: positiveInt(section["timeoutMs"], AWAY_REPLY_DEFAULTS.timeoutMs),
    thresholdMinutes: positive(section["thresholdMinutes"], AWAY_REPLY_DEFAULTS.thresholdMinutes),
    maxRepliesPerAgentPerDay: positiveInt(
      section["maxRepliesPerAgentPerDay"],
      AWAY_REPLY_DEFAULTS.maxRepliesPerAgentPerDay,
    ),
    maxRepliesPerDay: positiveInt(
      section["maxRepliesPerDay"],
      AWAY_REPLY_DEFAULTS.maxRepliesPerDay,
    ),
    destructiveThreshold: Math.min(
      AWAY_REPLY_MAX_DESTRUCTIVE_THRESHOLD,
      positive(section["destructiveThreshold"], AWAY_REPLY_DEFAULTS.destructiveThreshold),
    ),
    approveReadOnlyPermissions: bool(
      section["approveReadOnlyPermissions"],
      AWAY_REPLY_DEFAULTS.approveReadOnlyPermissions,
    ),
    skipPinnedWorkspaces: bool(
      section["skipPinnedWorkspaces"],
      AWAY_REPLY_DEFAULTS.skipPinnedWorkspaces,
    ),
  };
}
