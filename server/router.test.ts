import { describe, expect, it, vi } from "vitest";
import type { PluginBeforeRequests, PluginHookContext } from "@getpaseo/plugin/server";
import type { ResolvedPool } from "../shared/pool-config";
import { createHealthTracker } from "./health";
import { WINDOW_FIVE_HOUR } from "./windows";
import type { PoolCache } from "./pool";
import { createProviderIdCache, createRouter, type ProviderIdCache } from "./router";

type CreateAgentRequest = PluginBeforeRequests["agent.create"];

function fakePoolCache(pool: ResolvedPool, failOpen = false): PoolCache {
  return {
    get: () => ({ pool, failOpen }),
    forceRefresh: vi.fn(),
    stop: vi.fn(),
  };
}

function fakeProviderIds(ids: string[] | null): ProviderIdCache {
  return {
    get: () => (ids === null ? null : new Set(ids)),
    forceRefresh: vi.fn(),
    stop: vi.fn(),
  };
}

function request(overrides: Record<string, unknown>): { request: CreateAgentRequest } {
  return {
    request: {
      config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp/work" },
      ...overrides,
    } as unknown as CreateAgentRequest,
  };
}

const fakeContext = {} as PluginHookContext;

describe("createRouter", () => {
  it("returns the request untouched when there is no callerAgentId (human-created leaders)", () => {
    const pool: ResolvedPool = {
      workers: [{ providerId: "worker-a", priority: 1 }],
      leader: { providerId: "leader" },
    };
    const router = createRouter({
      poolCache: fakePoolCache(pool),
      health: createHealthTracker(),
      providerIds: fakeProviderIds(["worker-a", "leader"]),
    });

    const result = router(request({}), fakeContext);

    expect(result).toBeUndefined();
  });

  it("rewrites config.provider to the top-priority healthy worker, preserving model/mode/providerOptions", () => {
    const pool: ResolvedPool = {
      workers: [
        { providerId: "worker-a", priority: 1 },
        { providerId: "worker-b", priority: 2 },
      ],
      leader: { providerId: "leader" },
    };
    const router = createRouter({
      poolCache: fakePoolCache(pool),
      health: createHealthTracker(),
      providerIds: fakeProviderIds(["worker-a", "worker-b", "leader"]),
    });

    const result = router(
      request({
        callerAgentId: "caller-1",
        config: {
          provider: "claude",
          model: "claude-sonnet",
          modeId: "default",
          providerOptions: { foo: "bar" },
          cwd: "/tmp/work",
        },
      }),
      fakeContext,
    );

    expect(result?.config.provider).toBe("worker-a");
    expect(result?.config.model).toBe("claude-sonnet");
    expect(result?.config.modeId).toBe("default");
    expect(result?.config.providerOptions).toEqual({ foo: "bar" });
    expect(result?.config.cwd).toBe("/tmp/work");
  });

  it("routes a worker-spawned child (caller is itself a routed worker agent) by the same rule", () => {
    const pool: ResolvedPool = {
      workers: [
        { providerId: "worker-a", priority: 1 },
        { providerId: "worker-b", priority: 2 },
      ],
      leader: { providerId: "leader" },
    };
    const health = createHealthTracker();
    health.reportTurnFailure("worker-a", "hit your limit");
    const router = createRouter({
      poolCache: fakePoolCache(pool),
      health,
      providerIds: fakeProviderIds(["worker-a", "worker-b", "leader"]),
    });

    // callerAgentId here belongs to a child that was itself routed onto worker-a
    // by an earlier hook invocation; the router does not special-case that.
    const result = router(request({ callerAgentId: "worker-a-child-1" }), fakeContext);

    expect(result?.config.provider).toBe("worker-b");
  });

  it("routes per requested model: a model-scoped cap on the top worker only diverts that model's children", () => {
    const pool: ResolvedPool = {
      workers: [
        { providerId: "worker-a", priority: 1 },
        { providerId: "worker-b", priority: 2 },
      ],
      leader: { providerId: "leader" },
    };
    const health = createHealthTracker();
    health.reportTurnFailure("worker-a", "hit your limit — weekly opus cap reached, resets at 3am");
    const router = createRouter({
      poolCache: fakePoolCache(pool),
      health,
      providerIds: fakeProviderIds(["worker-a", "worker-b", "leader"]),
    });

    const sonnetResult = router(
      request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp" } }),
      fakeContext,
    );
    const opusResult = router(
      request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-opus", cwd: "/tmp" } }),
      fakeContext,
    );

    expect(sonnetResult?.config.provider).toBe("worker-a");
    expect(opusResult?.config.provider).toBe("worker-b");
  });

  it("falls back to the leader and emits a pool-dry episode when every worker is unhealthy for the requested model", () => {
    const pool: ResolvedPool = {
      workers: [{ providerId: "worker-a", priority: 1 }],
      leader: { providerId: "leader" },
    };
    const health = createHealthTracker();
    health.reportTurnFailure("worker-a", "hit your limit, resets at 3am");
    const onPoolDry = vi.fn();
    const router = createRouter({
      poolCache: fakePoolCache(pool),
      health,
      providerIds: fakeProviderIds(["worker-a", "leader"]),
      onPoolDry,
    });

    const result = router(
      request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp" } }),
      fakeContext,
    );

    expect(result?.config.provider).toBe("leader");
    expect(onPoolDry).toHaveBeenCalledTimes(1);
    expect(onPoolDry).toHaveBeenCalledWith({
      callerAgentId: "c1",
      requestedModel: "claude-sonnet",
      leaderProviderId: "leader",
    });
  });

  it("passes the request through untouched and emits a fail-open episode when the pool is unconfigured", () => {
    const health = createHealthTracker();
    const onFailOpen = vi.fn();
    const router = createRouter({
      poolCache: fakePoolCache({ workers: [], leader: null }, true),
      health,
      providerIds: fakeProviderIds([]),
      onFailOpen,
    });

    const result = router(
      request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp" } }),
      fakeContext,
    );

    expect(result).toBeUndefined();
    expect(onFailOpen).toHaveBeenCalledWith({ callerAgentId: "c1", reason: "pool-unconfigured" });
  });

  it("passes the request through untouched when the selected target is missing from the provider snapshot", () => {
    const pool: ResolvedPool = {
      workers: [{ providerId: "worker-a", priority: 1 }],
      leader: { providerId: "leader" },
    };
    const health = createHealthTracker();
    const onFailOpen = vi.fn();
    const router = createRouter({
      poolCache: fakePoolCache(pool),
      health,
      providerIds: fakeProviderIds(["leader"]), // worker-a missing from snapshot
      onFailOpen,
    });

    const result = router(
      request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp" } }),
      fakeContext,
    );

    expect(result).toBeUndefined();
    expect(onFailOpen).toHaveBeenCalledWith({
      callerAgentId: "c1",
      reason: "target-missing-from-provider-snapshot",
      targetProviderId: "worker-a",
    });
  });

  it("treats an unloaded provider snapshot (still null) as unknown and fails open rather than guessing", () => {
    const pool: ResolvedPool = {
      workers: [{ providerId: "worker-a", priority: 1 }],
      leader: { providerId: "leader" },
    };
    const health = createHealthTracker();
    const onFailOpen = vi.fn();
    const router = createRouter({
      poolCache: fakePoolCache(pool),
      health,
      providerIds: fakeProviderIds(null),
      onFailOpen,
    });

    const result = router(
      request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp" } }),
      fakeContext,
    );

    expect(result).toBeUndefined();
    expect(onFailOpen).toHaveBeenCalledWith({
      callerAgentId: "c1",
      reason: "target-missing-from-provider-snapshot",
      targetProviderId: "worker-a",
    });
  });

  it("passes a non-claude-family child (codex/gpt) through untouched with no fail-open event", () => {
    const pool: ResolvedPool = {
      workers: [{ providerId: "worker-a", priority: 1 }],
      leader: { providerId: "leader" },
    };
    const onFailOpen = vi.fn();
    const router = createRouter({
      poolCache: fakePoolCache(pool),
      health: createHealthTracker(),
      providerIds: fakeProviderIds(["worker-a", "leader"]),
      onFailOpen,
    });

    const result = router(
      request({ callerAgentId: "c1", config: { provider: "codex/gpt-5.4", model: "gpt-5.4", cwd: "/tmp" } }),
      fakeContext,
    );

    expect(result).toBeUndefined();
    expect(onFailOpen).not.toHaveBeenCalled();
  });

  it("skips the fail-open event too for a non-claude-family child when the pool is unconfigured", () => {
    const onFailOpen = vi.fn();
    const router = createRouter({
      poolCache: fakePoolCache({ workers: [], leader: null }, true),
      health: createHealthTracker(),
      providerIds: fakeProviderIds([]),
      onFailOpen,
    });

    const result = router(
      request({ callerAgentId: "c1", config: { provider: "codex/gpt-5.4", model: "gpt-5.4", cwd: "/tmp" } }),
      fakeContext,
    );

    expect(result).toBeUndefined();
    expect(onFailOpen).not.toHaveBeenCalled();
  });

  it("rewrites a claude-provider child normally", () => {
    const pool: ResolvedPool = {
      workers: [{ providerId: "worker-a", priority: 1 }],
      leader: { providerId: "leader" },
    };
    const router = createRouter({
      poolCache: fakePoolCache(pool),
      health: createHealthTracker(),
      providerIds: fakeProviderIds(["worker-a", "leader"]),
    });

    const result = router(
      request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp" } }),
      fakeContext,
    );

    expect(result?.config.provider).toBe("worker-a");
  });

  it("still normalizes through the healthy-selection chain when a pool worker is requested explicitly", () => {
    const pool: ResolvedPool = {
      workers: [
        { providerId: "worker-a", priority: 1 },
        { providerId: "worker-b", priority: 2 },
      ],
      leader: { providerId: "leader" },
    };
    const health = createHealthTracker();
    health.reportTurnFailure("worker-a", "hit your limit");
    const router = createRouter({
      poolCache: fakePoolCache(pool),
      health,
      providerIds: fakeProviderIds(["worker-a", "worker-b", "leader"]),
    });

    // Explicitly asking for the (capped) in-pool worker engages routing but
    // doesn't pin the target: the ladder still picks the healthy sibling.
    const result = router(
      request({ callerAgentId: "c1", config: { provider: "worker-a", model: "claude-sonnet", cwd: "/tmp" } }),
      fakeContext,
    );

    expect(result?.config.provider).toBe("worker-b");
  });

  it("lands on the top-priority drained worker with no pool-dry episode when every worker is drained", () => {
    const pool: ResolvedPool = {
      workers: [
        { providerId: "worker-a", priority: 1 },
        { providerId: "worker-b", priority: 2 },
      ],
      leader: { providerId: "leader" },
    };
    const health = createHealthTracker();
    health.reportUsage("worker-a", [{ window: WINDOW_FIVE_HOUR, usedPct: 95 }]);
    health.reportUsage("worker-b", [{ window: WINDOW_FIVE_HOUR, usedPct: 95 }]);
    const onPoolDry = vi.fn();
    const router = createRouter({
      poolCache: fakePoolCache(pool),
      health,
      providerIds: fakeProviderIds(["worker-a", "worker-b", "leader"]),
      onPoolDry,
    });

    const result = router(
      request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp" } }),
      fakeContext,
    );

    expect(result?.config.provider).toBe("worker-a");
    expect(onPoolDry).not.toHaveBeenCalled();
  });

  it("falls back to the leader with a pool-dry episode when every worker is capped", () => {
    const pool: ResolvedPool = {
      workers: [
        { providerId: "worker-a", priority: 1 },
        { providerId: "worker-b", priority: 2 },
      ],
      leader: { providerId: "leader" },
    };
    const health = createHealthTracker();
    health.reportTurnFailure("worker-a", "hit your limit");
    health.reportTurnFailure("worker-b", "hit your limit");
    const onPoolDry = vi.fn();
    const router = createRouter({
      poolCache: fakePoolCache(pool),
      health,
      providerIds: fakeProviderIds(["worker-a", "worker-b", "leader"]),
      onPoolDry,
    });

    const result = router(
      request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp" } }),
      fakeContext,
    );

    expect(result?.config.provider).toBe("leader");
    expect(onPoolDry).toHaveBeenCalledTimes(1);
  });

  it("skips a worker capped only on weekly_model_opus at tier 1 for a model-less create", () => {
    const pool: ResolvedPool = {
      workers: [
        { providerId: "worker-a", priority: 1 },
        { providerId: "worker-b", priority: 2 },
      ],
      leader: { providerId: "leader" },
    };
    const health = createHealthTracker();
    health.reportTurnFailure("worker-a", "hit your limit — weekly opus cap reached");
    const router = createRouter({
      poolCache: fakePoolCache(pool),
      health,
      providerIds: fakeProviderIds(["worker-a", "worker-b", "leader"]),
    });

    // No model requested: nothing to scope the cap against, so the opus-only
    // cap must disqualify worker-a outright.
    const modelless = router(
      request({ callerAgentId: "c1", config: { provider: "claude", cwd: "/tmp" } }),
      fakeContext,
    );
    expect(modelless?.config.provider).toBe("worker-b");

    // Contrast: a sonnet request can still use worker-a, since the cap is opus-scoped.
    const sonnet = router(
      request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp" } }),
      fakeContext,
    );
    expect(sonnet?.config.provider).toBe("worker-a");
  });

  it("throttles the failOpen-observed forceRefresh to at most once per throttle window", () => {
    const poolCache = fakePoolCache({ workers: [], leader: null }, true);
    const providerIds = fakeProviderIds([]);
    let nowMs = 0;
    const router = createRouter({
      poolCache,
      health: createHealthTracker(),
      providerIds,
      failOpenRefreshThrottleMs: 5000,
      now: () => nowMs,
    });

    router(request({ callerAgentId: "c1" }), fakeContext);
    router(request({ callerAgentId: "c1" }), fakeContext);
    router(request({ callerAgentId: "c1" }), fakeContext);

    expect(poolCache.forceRefresh).toHaveBeenCalledTimes(1);
    expect(providerIds.forceRefresh).toHaveBeenCalledTimes(1);

    nowMs = 4999;
    router(request({ callerAgentId: "c1" }), fakeContext);
    expect(poolCache.forceRefresh).toHaveBeenCalledTimes(1);

    nowMs = 5000;
    router(request({ callerAgentId: "c1" }), fakeContext);
    expect(poolCache.forceRefresh).toHaveBeenCalledTimes(2);
    expect(providerIds.forceRefresh).toHaveBeenCalledTimes(2);
  });

  it("emits onPoolRecovered when the pool transitions from fail-open back to configured", () => {
    const health = createHealthTracker();
    const onPoolRecovered = vi.fn();
    let failOpen = true;
    let pool: ResolvedPool = { workers: [], leader: null };
    const poolCache: PoolCache = {
      get: () => ({ pool, failOpen }),
      forceRefresh: vi.fn(),
      stop: vi.fn(),
    };
    const router = createRouter({
      poolCache,
      health,
      providerIds: fakeProviderIds(["worker-a", "leader"]),
      onPoolRecovered,
    });

    router(request({ callerAgentId: "c1" }), fakeContext);
    expect(onPoolRecovered).not.toHaveBeenCalled();

    failOpen = false;
    pool = { workers: [{ providerId: "worker-a", priority: 1 }], leader: { providerId: "leader" } };
    router(request({ callerAgentId: "c1" }), fakeContext);

    expect(onPoolRecovered).toHaveBeenCalledTimes(1);
  });
});

describe("createProviderIdCache", () => {
  function fakeProvidersApi(entries: Array<{ provider: string }>) {
    return {
      providers: {
        snapshot: vi.fn().mockResolvedValue({ entries, generatedAt: "now", requestId: "r1" }),
      },
    } as unknown as Pick<PluginHookContext["paseo"], "providers">;
  }

  it("starts null before the first load and populates ids after refresh", async () => {
    const paseo = fakeProvidersApi([{ provider: "worker-a" }, { provider: "leader" }]);
    const cache = createProviderIdCache(paseo, { intervalMs: 1000 });

    expect(cache.get()).toBeNull();
    await cache.forceRefresh();

    expect(cache.get()).toEqual(new Set(["worker-a", "leader"]));
    cache.stop();
  });

  it("keeps the last-known ids when a refresh fails", async () => {
    const paseo = fakeProvidersApi([{ provider: "worker-a" }]);
    const cache = createProviderIdCache(paseo, { intervalMs: 1000 });
    await cache.forceRefresh();
    expect(cache.get()).toEqual(new Set(["worker-a"]));

    (paseo.providers.snapshot as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    await cache.forceRefresh();

    expect(cache.get()).toEqual(new Set(["worker-a"]));
    cache.stop();
  });
});
