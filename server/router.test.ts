import { describe, expect, it, vi } from "vitest";
import type { PluginBeforeRequests, PluginHookContext } from "@getpaseo/plugin/server";
import type { ResolvedPool } from "../shared/pool-config";
import { createHealthTracker } from "./health";
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
      config: { provider: "unused", model: "claude-sonnet", cwd: "/tmp/work" },
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
          provider: "ignored",
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
    health.reportTurnFailure("worker-a", "hit your limit for opus, resets at 3am");
    const router = createRouter({
      poolCache: fakePoolCache(pool),
      health,
      providerIds: fakeProviderIds(["worker-a", "worker-b", "leader"]),
    });

    const sonnetResult = router(
      request({ callerAgentId: "c1", config: { provider: "x", model: "claude-sonnet", cwd: "/tmp" } }),
      fakeContext,
    );
    const opusResult = router(
      request({ callerAgentId: "c1", config: { provider: "x", model: "claude-opus", cwd: "/tmp" } }),
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
      request({ callerAgentId: "c1", config: { provider: "x", model: "claude-sonnet", cwd: "/tmp" } }),
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
      request({ callerAgentId: "c1", config: { provider: "x", model: "claude-sonnet", cwd: "/tmp" } }),
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
      request({ callerAgentId: "c1", config: { provider: "x", model: "claude-sonnet", cwd: "/tmp" } }),
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
      request({ callerAgentId: "c1", config: { provider: "x", model: "claude-sonnet", cwd: "/tmp" } }),
      fakeContext,
    );

    expect(result).toBeUndefined();
    expect(onFailOpen).toHaveBeenCalledWith({
      callerAgentId: "c1",
      reason: "target-missing-from-provider-snapshot",
      targetProviderId: "worker-a",
    });
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
