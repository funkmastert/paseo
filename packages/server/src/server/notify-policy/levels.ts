import { NOTIFY_LEVELS, type NotifyLevel } from "@getpaseo/protocol/notify-policy/types";

export type { NotifyLevel };

/** What a caller passes alongside a push. `level` is the only required decision. */
export interface PushSendMeta {
  level?: NotifyLevel;
  /**
   * Identifies the situation being announced (for example one account window, or one agent's
   * failover). A second notification with the same key inside the policy's cooldown is counted
   * against the first instead of being sent, so a condition that re-fires every sweep is
   * announced once. Leave it off for events that are genuinely new each time.
   */
  dedupeKey?: string;
}

/** A push with no declared level is a notice: it waits for a digest instead of interrupting. */
export const DEFAULT_NOTIFY_LEVEL: NotifyLevel = "notice";

export function levelRank(level: NotifyLevel): number {
  return NOTIFY_LEVELS.indexOf(level);
}

export function levelAtLeast(level: NotifyLevel, minimum: NotifyLevel): boolean {
  return levelRank(level) >= levelRank(minimum);
}
