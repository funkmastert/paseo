/**
 * Placement once isolation is a preference rather than a rule: which account absorbs a spawn
 * when several are usable, what happens when only one is left, and what happens when none are.
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginBeforeRequests, PluginHookContext } from "@getpaseo/plugin/server";
import type { ResolvedPool } from "../shared/pool-config";
import { createAccountIdentity } from "./account-identity";
import { createHealthTracker } from "./health";
import { createRouter, PoolExhaustedError, type ProviderIdCache } from "./router";
import type { PoolCache } from "./pool";
import { WINDOW_FIVE_HOUR, WINDOW_SEVEN_DAY } from "./windows";

type CreateAgentRequest = PluginBeforeRequests["agent.create"];

const NOW = new Date("2026-09-22T12:00:00Z");
const SONNET = "claude-sonnet-5";
const fakeContext = {} as PluginHookContext;

const POOL: ResolvedPool = {
  workers: [
    { providerId: "worker-a", priority: 1 },
    { providerId: "backup", priority: 2 },
  ],
  leader: { providerId: "claude-leader" },
};
const ALL_IDS = ["worker-a", "backup", "claude-leader"];

function fakePoolCache(pool: ResolvedPool = POOL): PoolCache {
  return { get: () => ({ pool, failOpen: false }), forceRefresh: vi.fn(), stop: vi.fn() };
}

function fakeProviderIds(ids: string[] = ALL_IDS): ProviderIdCache {
  return { get: () => new Set(ids), forceRefresh: vi.fn(), stop: vi.fn() };
}

function request(callerAgentId: string, model: string | undefined = SONNET): { request: CreateAgentRequest } {
  return {
    request: {
      callerAgentId,
      config: { provider: "claude", model, cwd: "/tmp/work" },
    } as unknown as CreateAgentRequest,
  };
}

function targetOf(result: CreateAgentRequest | void): string | undefined {
  return (result as CreateAgentRequest | undefined)?.config.provider;
}

/** usedPct per window, with no reset time unless one is given. */
function usage(pct: Partial<Record<string, number>>, resetsAt: Date | null = null) {
  return Object.entries(pct).map(([window, usedPct]) => ({ window, usedPct, resetsAt }));
}

function build(overrides: Partial<Parameters<typeof createRouter>[0]> = {}) {
  const health = createHealthTracker({ now: () => NOW });
  const router = createRouter({
    poolCache: fakePoolCache(),
    health,
    providerIds: fakeProviderIds(),
    now: () => NOW.getTime(),
    ...overrides,
  });
  return { health, router };
}

describe("headroom-ranked placement", () => {
  it("sends the spawn to the barely-used backup rather than the top-priority worker", () => {
    const { health, router } = build();
    health.reportUsage("worker-a", usage({ [WINDOW_SEVEN_DAY]: 77 }));
    health.reportUsage("backup", usage({ [WINDOW_SEVEN_DAY]: 12 }));

    expect(targetOf(router(request("leader-1"), fakeContext))).toBe("backup");
  });

  it("falls back to priority order when no usage has been read yet", () => {
    const { router } = build();

    expect(targetOf(router(request("leader-1"), fakeContext))).toBe("worker-a");
  });

  it("keeps a healthy worker ahead of a drained one with a flattering reset time", () => {
    const { health, router } = build();
    // backup is drained (>=90%) but its window resets within the hour, so headroom alone would
    // rank it top. The health tier keeps the healthy worker in front.
    health.reportUsage("worker-a", usage({ [WINDOW_SEVEN_DAY]: 77 }));
    health.reportUsage("backup", [
      { window: WINDOW_FIVE_HOUR, usedPct: 95, resetsAt: new Date(NOW.getTime() + 60 * 60 * 1000) },
    ]);

    expect(targetOf(router(request("leader-1"), fakeContext))).toBe("worker-a");
  });

  it("still prefers a worker over the leader account when the only worker left is drained", () => {
    const { health, router } = build();
    health.reportUsage("worker-a", usage({ [WINDOW_SEVEN_DAY]: 100 }));
    health.reportUsage("backup", usage({ [WINDOW_SEVEN_DAY]: 95 }));
    health.reportUsage("claude-leader", usage({ [WINDOW_SEVEN_DAY]: 5 }));

    expect(targetOf(router(request("leader-1"), fakeContext))).toBe("backup");
  });
});

describe("collapsing onto one account", () => {
  it("places children on the leader account when every worker is capped, and says so once", () => {
    const onPoolCollapsed = vi.fn();
    const onPoolDry = vi.fn();
    const { health, router } = build({ onPoolCollapsed, onPoolDry });
    health.reportUsage("worker-a", usage({ [WINDOW_SEVEN_DAY]: 100 }));
    health.reportUsage("backup", usage({ [WINDOW_SEVEN_DAY]: 100 }));
    health.reportUsage("claude-leader", usage({ [WINDOW_SEVEN_DAY]: 60 }));

    expect(targetOf(router(request("leader-1"), fakeContext))).toBe("claude-leader");
    expect(onPoolDry).toHaveBeenCalledTimes(1);
    expect(onPoolCollapsed).toHaveBeenCalledWith(
      expect.objectContaining({
        targetProviderId: "claude-leader",
        exhaustedProviderIds: ["worker-a", "backup"],
      }),
    );
  });

  it("reports a collapse onto a surviving WORKER too, when the leader account is the dead one", () => {
    const onPoolCollapsed = vi.fn();
    const { health, router } = build({ onPoolCollapsed });
    health.reportUsage("worker-a", usage({ [WINDOW_SEVEN_DAY]: 100 }));
    health.reportUsage("claude-leader", usage({ [WINDOW_SEVEN_DAY]: 100 }));
    health.reportUsage("backup", usage({ [WINDOW_SEVEN_DAY]: 40 }));

    expect(targetOf(router(request("leader-1"), fakeContext))).toBe("backup");
    expect(onPoolCollapsed).toHaveBeenCalledWith(
      expect.objectContaining({ targetProviderId: "backup", sharedProviderIds: ["backup"] }),
    );
  });

  it("stays quiet while two accounts are still usable", () => {
    const onPoolCollapsed = vi.fn();
    const { health, router } = build({ onPoolCollapsed });
    health.reportUsage("worker-a", usage({ [WINDOW_SEVEN_DAY]: 100 }));
    health.reportUsage("backup", usage({ [WINDOW_SEVEN_DAY]: 40 }));
    health.reportUsage("claude-leader", usage({ [WINDOW_SEVEN_DAY]: 40 }));

    router(request("leader-1"), fakeContext);
    expect(onPoolCollapsed).not.toHaveBeenCalled();
  });

  it("is not fooled by two entries signed into one account", () => {
    const onPoolCollapsed = vi.fn();
    const identity = createAccountIdentity();
    const shared = [
      { window: WINDOW_FIVE_HOUR, usedPct: 31, resetsAt: new Date("2026-09-22T15:10:00Z") },
      { window: WINDOW_SEVEN_DAY, usedPct: 77, resetsAt: new Date("2026-09-26T09:00:00Z") },
    ];
    const pool: ResolvedPool = {
      workers: [{ providerId: "worker-a", priority: 1 }, { providerId: "claude-personal", priority: 2 }],
      leader: { providerId: "claude" },
    };
    const health = createHealthTracker({ now: () => NOW });
    const router = createRouter({
      poolCache: fakePoolCache(pool),
      health,
      providerIds: fakeProviderIds(["worker-a", "claude-personal", "claude"]),
      accountIdentity: identity,
      now: () => NOW.getTime(),
      onPoolCollapsed,
    });

    health.reportUsage("worker-a", usage({ [WINDOW_SEVEN_DAY]: 100 }));
    for (const id of ["claude", "claude-personal"]) {
      health.reportUsage(id, shared);
      identity.reportUsage(id, shared);
    }

    router(request("leader-1"), fakeContext);
    // Two usable ENTRIES, one usable ACCOUNT: without identity this would look like a healthy
    // two-account pool and say nothing.
    expect(onPoolCollapsed).toHaveBeenCalledWith(
      expect.objectContaining({ sharedProviderIds: ["claude", "claude-personal"] }),
    );
  });
});

describe("an exhausted pool", () => {
  function exhaust(health: ReturnType<typeof createHealthTracker>, resetsAt: Date | null = null) {
    for (const id of ALL_IDS) {
      health.reportUsage(id, usage({ [WINDOW_SEVEN_DAY]: 100 }, resetsAt));
    }
  }

  it("refuses the spawn instead of starting it on a dead account", () => {
    const onPoolExhausted = vi.fn();
    const { health, router } = build({ onPoolExhausted });
    exhaust(health, new Date("2026-09-26T09:00:00Z"));

    expect(() => router(request("leader-1"), fakeContext)).toThrow(PoolExhaustedError);
    expect(onPoolExhausted).toHaveBeenCalledWith(
      expect.objectContaining({
        exhaustedProviderIds: ALL_IDS,
        earliestResetAt: new Date("2026-09-26T09:00:00Z"),
      }),
    );
  });

  it("names the accounts and the reset, so the caller can tell waiting from stopping", () => {
    const { health, router } = build();
    exhaust(health, new Date("2026-09-26T09:00:00Z"));

    expect(() => router(request("leader-1"), fakeContext)).toThrow(
      /every Claude account is out of budget \(worker-a, backup, claude-leader\).*2026-09-26T09:00:00\.000Z/s,
    );
  });

  it("never blocks a human-created agent — those carry no callerAgentId", () => {
    const { health, router } = build();
    exhaust(health);

    expect(
      router({ request: { config: { provider: "claude", model: SONNET, cwd: "/tmp" } } as unknown as CreateAgentRequest }, fakeContext),
    ).toBeUndefined();
  });

  it("passes through instead of refusing when refuseWhenExhausted is off", () => {
    const onFailOpen = vi.fn();
    const { health, router } = build({ refuseWhenExhausted: false, onFailOpen });
    exhaust(health);

    expect(router(request("leader-1"), fakeContext)).toBeUndefined();
    expect(onFailOpen).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "every-pool-account-capped" }),
    );
  });

  it("fails open rather than refusing when the pool has no leader configured at all", () => {
    const onFailOpen = vi.fn();
    const onPoolExhausted = vi.fn();
    const health = createHealthTracker({ now: () => NOW });
    const router = createRouter({
      poolCache: fakePoolCache({ workers: [{ providerId: "worker-a", priority: 1 }], leader: null }),
      health,
      providerIds: fakeProviderIds(["worker-a"]),
      now: () => NOW.getTime(),
      onFailOpen,
      onPoolExhausted,
    });
    health.reportUsage("worker-a", usage({ [WINDOW_SEVEN_DAY]: 100 }));

    expect(router(request("leader-1"), fakeContext)).toBeUndefined();
    expect(onPoolExhausted).not.toHaveBeenCalled();
    expect(onFailOpen).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "no-healthy-worker-and-no-leader" }),
    );
  });
});
