import type { ResolvedJevFeatureConfig } from "../jev/config.js";

/**
 * `agents.jev.awayReply` (docs/jev.md, "Feature 14: away auto-reply"). Lenient like the rest of
 * `agents.jev`: a malformed value falls back to its default. It starts in dry run like every JEV
 * feature (D6): it records what it would have sent and sends nothing, and `dryRun: false` is
 * Tyler's switch to let it act once he has read a day of those decisions. Agents cannot edit
 * `config.json`, so this code default is the lever. Like every JEV feature it needs the dedicated
 * key (D5), so without one it does nothing at all.
 */
export interface ResolvedAwayReplyConfig extends ResolvedJevFeatureConfig {
  /** Log and record the decision, send nothing, write nothing. The service's `shadow`. */
  dryRun: boolean;
  /** How long a leader must have waited on Tyler before the job looks at it. */
  thresholdMinutes: number;
  maxRepliesPerAgentPerDay: number;
  /** Across every leader. */
  maxRepliesPerDay: number;
  /** A JEV destructive-intent probability at or over this sends nothing. At most 0.05. */
  destructiveThreshold: number;
  /** Approve a tool permission that code and JEV both judge read-only. */
  approveReadOnlyPermissions: boolean;
  /** Skip every agent in a pinned workspace. */
  skipPinnedWorkspaces: boolean;
}

/**
 * Config can lower the destructive-intent threshold, never raise it past this. JEV's calibration
 * error is 0.13-0.25, so a reply needs JEV nearly certain nothing destructive is in play; the code
 * exclusion carries the safety, and this is the second opinion.
 */
export const AWAY_REPLY_MAX_DESTRUCTIVE_THRESHOLD = 0.05;

export const AWAY_REPLY_DEFAULTS: ResolvedAwayReplyConfig = {
  enabled: true,
  shadow: true,
  dryRun: true,
  timeoutMs: 5000,
  thresholdMinutes: 60,
  maxRepliesPerAgentPerDay: 3,
  maxRepliesPerDay: 12,
  destructiveThreshold: 0.05,
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
