import { describe, expect, it } from "vitest";

import { presenceSkipReason } from "./presence.js";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const MINUTE = 60_000;

function reason(
  clients: Array<{
    focusedAgentId: string | null;
    focusedWorkspaceId: string | null;
    appVisible: boolean;
    lastActivityAtMs: number | null;
  }>,
  availability: "available" | "focus" | "away" | "off" | null = "available",
  thresholdMinutes = 60,
  workspaceId: string | null = "ws-1",
) {
  return presenceSkipReason({
    presence: { clients, availability },
    agentId: "leader-1",
    workspaceId,
    nowMs: NOW,
    thresholdMinutes,
  });
}

describe("presenceSkipReason", () => {
  it("is away with no clients, or none active in the window", () => {
    expect(reason([])).toBeNull();
    expect(
      reason([
        {
          focusedAgentId: "x",
          focusedWorkspaceId: "ws-1",
          appVisible: false,
          lastActivityAtMs: NOW - 61 * MINUTE,
        },
      ]),
    ).toBeNull();
    expect(
      reason([
        {
          focusedAgentId: null,
          focusedWorkspaceId: null,
          appVisible: false,
          lastActivityAtMs: null,
        },
      ]),
    ).toBeNull();
  });

  it("is present with activity in the window with no agent focused, whatever the mode", () => {
    for (const mode of ["available", "away", "off"] as const) {
      expect(
        reason(
          [
            {
              focusedAgentId: null,
              focusedWorkspaceId: null,
              appVisible: false,
              lastActivityAtMs: NOW - 59 * MINUTE,
            },
          ],
          mode,
        ),
      ).toBe("tyler-active-recently");
    }
  });

  it("is present with activity on the leader itself, or a sibling agent in its workspace", () => {
    expect(
      reason([
        {
          focusedAgentId: "leader-1",
          focusedWorkspaceId: "ws-1",
          appVisible: false,
          lastActivityAtMs: NOW - 59 * MINUTE,
        },
      ]),
    ).toBe("tyler-active-recently");
    expect(
      reason([
        {
          focusedAgentId: "sibling-agent",
          focusedWorkspaceId: "ws-1",
          appVisible: false,
          lastActivityAtMs: NOW - 59 * MINUTE,
        },
      ]),
    ).toBe("tyler-active-recently");
  });

  it("is away despite recent activity on a specific, unrelated agent in another workspace", () => {
    expect(
      reason([
        {
          focusedAgentId: "other-leader",
          focusedWorkspaceId: "ws-unrelated",
          appVisible: false,
          lastActivityAtMs: NOW - 1 * MINUTE,
        },
      ]),
    ).toBeNull();
  });

  it("widens the window to a longer away threshold", () => {
    const client = {
      focusedAgentId: "leader-1",
      focusedWorkspaceId: "ws-1",
      appVisible: false,
      lastActivityAtMs: NOW - 90 * MINUTE,
    };
    expect(reason([client], "available", 60)).toBeNull();
    expect(reason([client], "available", 120)).toBe("tyler-active-recently");
  });

  it("honours a short threshold instead of floor-ing it to an hour", () => {
    const client = {
      focusedAgentId: "leader-1",
      focusedWorkspaceId: "ws-1",
      appVisible: false,
      lastActivityAtMs: NOW - 25 * MINUTE,
    };
    // 20-minute threshold: activity 25 minutes ago is outside it, so he counts as away.
    expect(reason([client], "available", 20)).toBeNull();
  });

  it("never shrinks the window below the sanity floor", () => {
    const client = {
      focusedAgentId: "leader-1",
      focusedWorkspaceId: "ws-1",
      appVisible: false,
      lastActivityAtMs: NOW - 2 * MINUTE,
    };
    // A 1-minute threshold still floors to AWAY_PRESENCE_MIN_WINDOW_MINUTES (5).
    expect(reason([client], "available", 1)).toBe("tyler-active-recently");
  });

  it("is present while he has this agent open, and in focus mode", () => {
    expect(
      reason([
        {
          focusedAgentId: "leader-1",
          focusedWorkspaceId: "ws-1",
          appVisible: true,
          lastActivityAtMs: NOW - 5 * 60 * MINUTE,
        },
      ]),
    ).toBe("tyler-viewing-agent");
    expect(reason([], "focus")).toBe("tyler-in-focus-mode");
  });
});
