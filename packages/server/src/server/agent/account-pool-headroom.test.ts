import { describe, expect, it } from "vitest";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import {
  headroomByProvider,
  saturatedProviderIds,
  staleUsageAges,
  windowLimitsModel,
} from "./account-pool-headroom.js";

const NOW_MS = Date.parse("2026-09-22T12:00:00Z");
const hours = (n: number) => new Date(NOW_MS + n * 60 * 60 * 1000).toISOString();
const STALE_AFTER_MS = 15 * 60 * 1000;

function provider(
  providerId: string,
  windows: Array<{ id: string; usedPct?: number | null; resetsAt?: string | null }>,
  fetchedAt?: string | null,
): ProviderUsage {
  return {
    providerId,
    displayName: providerId,
    status: "ok",
    planLabel: null,
    windows: windows.map((window) => ({ label: window.id, ...window })),
    ...(fetchedAt !== undefined ? { fetchedAt } : {}),
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

  it("counts a model's weekly window only for an agent on that model", () => {
    const usage = [
      provider("opus-saturated", [
        { id: "five_hour", usedPct: 10 },
        { id: "weekly", usedPct: 40 },
        { id: "weekly_model_opus", usedPct: 95 },
      ]),
      provider("surface-saturated", [
        { id: "weekly", usedPct: 40 },
        { id: "weekly_surface_code", usedPct: 92 },
      ]),
    ];

    expect([...saturatedProviderIds(usage, "claude-opus-5-5")].sort()).toEqual([
      "opus-saturated",
      "surface-saturated",
    ]);
    expect([...saturatedProviderIds(usage, "claude-sonnet-5")]).toEqual(["surface-saturated"]);
    // A model the daemon cannot place in a family, or no model at all: every window counts.
    expect([...saturatedProviderIds(usage, "default")].sort()).toEqual([
      "opus-saturated",
      "surface-saturated",
    ]);
    expect([...saturatedProviderIds(usage)].sort()).toEqual([
      "opus-saturated",
      "surface-saturated",
    ]);
  });
});

describe("windowLimitsModel", () => {
  it("binds account-wide and surface windows to every model", () => {
    for (const id of ["five_hour", "weekly", "weekly_surface_code", "window-0"]) {
      expect(windowLimitsModel(id, "claude-sonnet-5")).toBe(true);
    }
  });

  it("binds a model window to its own family, whatever shape the id carries", () => {
    expect(windowLimitsModel("weekly_model_opus", "claude-opus-5-5")).toBe(true);
    expect(windowLimitsModel("weekly_model_claude-opus-4-1", "opus")).toBe(true);
    expect(windowLimitsModel("weekly_model_opus", "claude-sonnet-5")).toBe(false);
    expect(windowLimitsModel("weekly_model_omelette", "claude-opus-5-5")).toBe(false);
  });

  it("binds a model window to an agent whose family it cannot tell", () => {
    expect(windowLimitsModel("weekly_model_opus", undefined)).toBe(true);
    expect(windowLimitsModel("weekly_model_opus", "default")).toBe(true);
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

  it("scores an agent's account on the windows that limit its model", () => {
    const usage = [
      provider("worker-a", [
        { id: "weekly", usedPct: 40 },
        { id: "weekly_model_opus", usedPct: 97 },
      ]),
    ];
    expect(headroomByProvider(usage, NOW_MS, "claude-sonnet-5").get("worker-a")).toBe(60);
    expect(headroomByProvider(usage, NOW_MS, "claude-opus-5-5").get("worker-a")).toBe(3);
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

describe("staleUsageAges", () => {
  it("names a provider whose own fetchedAt is older than the bound, with its age", () => {
    const twentyMinAgo = new Date(NOW_MS - 20 * 60 * 1000).toISOString();
    const ages = staleUsageAges(
      [provider("stale", [{ id: "weekly", usedPct: 50 }], twentyMinAgo)],
      NOW_MS,
      STALE_AFTER_MS,
      NOW_MS,
    );
    expect(ages.get("stale")).toBe(20 * 60 * 1000);
  });

  it("leaves a provider fresh within the bound alone", () => {
    const fiveMinAgo = new Date(NOW_MS - 5 * 60 * 1000).toISOString();
    const ages = staleUsageAges(
      [provider("fresh", [{ id: "weekly", usedPct: 50 }], fiveMinAgo)],
      NOW_MS,
      STALE_AFTER_MS,
      NOW_MS,
    );
    expect(ages.has("fresh")).toBe(false);
  });

  it("falls back to the batch fetch time for a row with no fetchedAt of its own", () => {
    // The Claude fetcher never sets a per-row fetchedAt; every row in one response shares the
    // list's own fetchedAt instead.
    const twentyMinAgo = NOW_MS - 20 * 60 * 1000;
    const ages = staleUsageAges(
      [provider("claude-worker", [{ id: "weekly", usedPct: 50 }])],
      NOW_MS,
      STALE_AFTER_MS,
      twentyMinAgo,
    );
    expect(ages.get("claude-worker")).toBe(20 * 60 * 1000);
  });

  it("is never stale with no fetchedAt at all, own or batch", () => {
    const ages = staleUsageAges(
      [provider("unread", [{ id: "weekly", usedPct: 50 }])],
      NOW_MS,
      STALE_AFTER_MS,
      null,
    );
    expect(ages.size).toBe(0);
  });

  it("falls back to the batch time when its own fetchedAt does not parse", () => {
    const twentyMinAgo = NOW_MS - 20 * 60 * 1000;
    const ages = staleUsageAges(
      [provider("odd", [{ id: "weekly", usedPct: 50 }], "not-a-date")],
      NOW_MS,
      STALE_AFTER_MS,
      twentyMinAgo,
    );
    expect(ages.get("odd")).toBe(20 * 60 * 1000);
  });

  it("returns an empty map when usage could not be read at all", () => {
    expect(staleUsageAges(null, NOW_MS, STALE_AFTER_MS, NOW_MS).size).toBe(0);
  });
});
