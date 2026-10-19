/**
 * Is Tyler around? (docs/jev.md, "Feature 14"). The job replies only when he is not: a reply that
 * lands on a thread he is reading or typing into closes the card under him, and his own answer
 * then steers into the turn the auto-reply started.
 *
 * What the daemon has: each app client's heartbeat (the focused agent and its workspace, whether
 * the app is visible, his last input), his availability mode from the notify policy, and the
 * agent's unread flag.
 *
 * Presence is scoped to the waiting leader: a client only counts as "around" for this leader when
 * it is focused on the leader itself or on another agent in the leader's workspace. His activity
 * on an unrelated agent elsewhere does not hold back this leader's reply.
 */

/**
 * The shortest the presence window can be, whatever `thresholdMinutes` says: a heartbeat lags
 * real activity by a little, so a window under a few minutes would call him away moments after he
 * touched the app. Tyler picked 20 (`agents.jev.awayReply.thresholdMinutes`, "Away reply sooner",
 * 2026-10-19) and the window must honour it, not quietly widen it to an hour.
 */
export const AWAY_PRESENCE_MIN_WINDOW_MINUTES = 5;

/** One connected app client, as its last heartbeat described it. */
export interface AwayReplyClientPresence {
  focusedAgentId: string | null;
  /** The focused agent's workspace, so activity there can count for a sibling leader. */
  focusedWorkspaceId: string | null;
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
  /** The waiting leader's workspace, so a sibling agent's focus also counts. */
  workspaceId: string | null;
  nowMs: number;
  thresholdMinutes: number;
}): string | null {
  const { presence, agentId, workspaceId, nowMs } = input;
  // Focus mode says he is at work and wants quiet, not that he is gone.
  if (presence.availability === "focus") return "tyler-in-focus-mode";
  const windowMs = Math.max(AWAY_PRESENCE_MIN_WINDOW_MINUTES, input.thresholdMinutes) * 60_000;
  for (const client of presence.clients) {
    if (client.appVisible && client.focusedAgentId === agentId) return "tyler-viewing-agent";
    if (client.lastActivityAtMs === null) continue;
    // Scoped to this leader: his focus is on this agent, on another agent in its workspace, or
    // on nothing in particular (no named agent to exclude — the app's general recency still
    // counts, a short global grace for a heartbeat that hasn't settled on any agent yet).
    // Activity on a specifically different, unrelated agent must not block this leader's reply.
    const inScope =
      client.focusedAgentId === null ||
      client.focusedAgentId === agentId ||
      (workspaceId !== null && client.focusedWorkspaceId === workspaceId);
    if (!inScope) continue;
    if (nowMs - client.lastActivityAtMs < windowMs) return "tyler-active-recently";
  }
  return null;
}
