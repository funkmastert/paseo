import { describe, expect, it } from "vitest";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import { headroomByProvider, saturatedProviderIds } from "./account-pool-headroom.js";

const NOW_MS = Date.parse("2026-09-22T12:00:00Z");
const hours = (n: number) => new Date(NOW_MS + n * 60 * 60 * 1000).toISOString();

function provider(
  providerId: string,
  windows: Array<{ id: string; usedPct?: number | null; resetsAt?: string | null }>,
): ProviderUsage {
  return {
    providerId,
    displayName: providerId,
    status: "ok",
    planLabel: null,
    windows: windows.map((window) => ({ label: window.id, ...window })),
  } as ProviderUsage;
}

describe("saturatedProviderIds", () => {
  it("names every account with a window at 90% or more: never a move target", () => {
    const saturated = saturatedProviderIds([
      provider("at-90", [
        { id: "five_hour", usedPct: 10 },
        { id: "weekly", usedPct: 90 },
      ]),
      provider("at-89", [
        { id: "five_hour", usedPct: 89 },
        { id: "weekly", usedPct: 40 },
      ]),
      provider("capped", [{ id: "weekly", usedPct: 100 }]),
      provider("unread", [{ id: "weekly", usedPct: null }]),
    ]);
    expect([...saturated].sort()).toEqual(["at-90", "capped"]);
  });

  it("names nothing when usage could not be read", () => {
    expect(saturatedProviderIds(null).size).toBe(0);
  });
});

describe("headroomByProvider", () => {
  it("scores an account on its tightest window, not an average of them", () => {
    const scores = headroomByProvider(
      [
        provider("worker-a", [
          { id: "five_hour", usedPct: 5 },
          { id: "weekly", usedPct: 98 },
        ]),
      ],
      NOW_MS,
    );
    expect(scores.get("worker-a")).toBe(2);
  });

  it("ranks 20% left resetting in an hour above 30% left resetting on Friday", () => {
    const scores = headroomByProvider(
      [
        provider("soon", [{ id: "five_hour", usedPct: 80, resetsAt: hours(1) }]),
        provider("friday", [{ id: "weekly", usedPct: 70, resetsAt: hours(72) }]),
      ],
      NOW_MS,
    );
    expect(scores.get("soon")!).toBeGreaterThan(scores.get("friday")!);
    // Friday is beyond the horizon, so it is worth exactly what is left in it.
    expect(scores.get("friday")).toBe(30);
  });

  it("puts Tyler's barely-used backup ahead of two accounts at 77% weekly", () => {
    const scores = headroomByProvider(
      [
        provider("claude-leader", [{ id: "weekly", usedPct: 77, resetsAt: hours(80) }]),
        provider("claude-worker", [{ id: "weekly", usedPct: 77, resetsAt: hours(80) }]),
        provider("claude-backup", [{ id: "weekly", usedPct: 12, resetsAt: hours(80) }]),
      ],
      NOW_MS,
    );
    const best = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
    expect(best?.[0]).toBe("claude-backup");
  });

  it("omits a provider with no numeric reading, so the caller can treat it as full", () => {
    const scores = headroomByProvider(
      [provider("unreadable", [{ id: "weekly", usedPct: null }]), provider("empty", [])],
      NOW_MS,
    );
    expect(scores.has("unreadable")).toBe(false);
    expect(scores.has("empty")).toBe(false);
  });

  it("ignores an unparseable reset time rather than scoring against NaN", () => {
    const scores = headroomByProvider(
      [provider("worker-a", [{ id: "weekly", usedPct: 40, resetsAt: "not-a-date" }])],
      NOW_MS,
    );
    expect(scores.get("worker-a")).toBe(60);
  });

  it("returns an empty map when usage could not be read at all", () => {
    expect(headroomByProvider(null, NOW_MS).size).toBe(0);
  });
});
