import { describe, expect, it } from "vitest";

import { presenceSkipReason } from "./presence.js";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const MINUTE = 60_000;

function reason(
  clients: Array<{
    focusedAgentId: string | null;
    appVisible: boolean;
    lastActivityAtMs: number | null;
  }>,
  availability: "available" | "focus" | "away" | "off" | null = "available",
  thresholdMinutes = 60,
) {
  return presenceSkipReason({
    presence: { clients, availability },
    agentId: "leader-1",
    nowMs: NOW,
    thresholdMinutes,
  });
}

describe("presenceSkipReason", () => {
  it("is away with no clients, or none active in the window", () => {
    expect(reason([])).toBeNull();
    expect(
      reason([{ focusedAgentId: "x", appVisible: false, lastActivityAtMs: NOW - 61 * MINUTE }]),
    ).toBeNull();
    expect(
      reason([{ focusedAgentId: null, appVisible: false, lastActivityAtMs: null }]),
    ).toBeNull();
  });

  it("is present with any activity in the window, whatever the mode", () => {
    for (const mode of ["available", "away", "off"] as const) {
      expect(
        reason(
          [{ focusedAgentId: "x", appVisible: false, lastActivityAtMs: NOW - 59 * MINUTE }],
          mode,
        ),
      ).toBe("tyler-active-recently");
    }
  });

  it("widens the window to a longer away threshold", () => {
    const client = { focusedAgentId: "x", appVisible: false, lastActivityAtMs: NOW - 90 * MINUTE };
    expect(reason([client], "available", 60)).toBeNull();
    expect(reason([client], "available", 120)).toBe("tyler-active-recently");
  });

  it("is present while he has this agent open, and in focus mode", () => {
    expect(
      reason([
        { focusedAgentId: "leader-1", appVisible: true, lastActivityAtMs: NOW - 5 * 60 * MINUTE },
      ]),
    ).toBe("tyler-viewing-agent");
    expect(reason([], "focus")).toBe("tyler-in-focus-mode");
  });
});
