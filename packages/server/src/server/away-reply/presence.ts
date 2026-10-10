/**
 * Is Tyler around? (docs/jev.md, "Feature 14"). The job replies only when he is not: a reply that
 * lands on a thread he is reading or typing into closes the card under him, and his own answer
 * then steers into the turn the auto-reply started.
 *
 * What the daemon has: each app client's heartbeat (the focused agent, whether the app is visible,
 * his last input), his availability mode from the notify policy, and the agent's unread flag.
 */

/**
 * Any app activity this recent means he is around. The effective window is the longer of this and
 * the away threshold, so "away for an hour" can never be true of someone who used the app within
 * the hour.
 */
export const AWAY_PRESENCE_WINDOW_MINUTES = 60;

/** One connected app client, as its last heartbeat described it. */
export interface AwayReplyClientPresence {
  focusedAgentId: string | null;
  appVisible: boolean;
  lastActivityAtMs: number | null;
}

/** `available`, `focus`, `away` or `off` (docs/notification-policy.md). */
export type AwayReplyAvailabilityMode = "available" | "focus" | "away" | "off";

export interface AwayReplyPresence {
  clients: readonly AwayReplyClientPresence[];
  availability: AwayReplyAvailabilityMode | null;
}

/** Why Tyler counts as present for this agent, or null when he is away. */
export function presenceSkipReason(input: {
  presence: AwayReplyPresence;
  agentId: string;
  nowMs: number;
  thresholdMinutes: number;
}): string | null {
  const { presence, agentId, nowMs } = input;
  // Focus mode says he is at work and wants quiet, not that he is gone.
  if (presence.availability === "focus") return "tyler-in-focus-mode";
  const windowMs = Math.max(AWAY_PRESENCE_WINDOW_MINUTES, input.thresholdMinutes) * 60_000;
  for (const client of presence.clients) {
    if (client.appVisible && client.focusedAgentId === agentId) return "tyler-viewing-agent";
    if (client.lastActivityAtMs === null) continue;
    if (nowMs - client.lastActivityAtMs < windowMs) return "tyler-active-recently";
  }
  return null;
}
