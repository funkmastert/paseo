import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { createPoolCache, loadPool } from "./pool";

type PaseoConfigApi = PluginHandlerContext["paseo"];

function fakePaseo(config: unknown): PaseoConfigApi {
  return {
    config: {
      get: vi.fn().mockResolvedValue({ requestId: "r1", config }),
    },
  } as unknown as PaseoConfigApi;
}

describe("loadPool", () => {
  it("resolves an ordered worker chain and single leader", async () => {
    const paseo = fakePaseo({
      providers: {
        "claude-leader": { params: { accountPool: { role: "leader", priority: 1 } } },
        "claude-worker-a": { params: { accountPool: { role: "worker", priority: 2 } } },
        "claude-worker-b": { params: { accountPool: { role: "worker", priority: 1 } } },
      },
    });

    const result = await loadPool(paseo);

    expect(result.failOpen).toBe(false);
    expect(result.pool.leader).toEqual({ providerId: "claude-leader" });
    expect(result.pool.workers).toEqual([
      { providerId: "claude-worker-b", priority: 1 },
      { providerId: "claude-worker-a", priority: 2 },
    ]);
  });

  it("fails open with an empty pool when accountPool config is missing", async () => {
    const paseo = fakePaseo({ providers: { claude: { params: {} } } });

    const result = await loadPool(paseo);

    expect(result.failOpen).toBe(true);
    expect(result.pool).toEqual({ workers: [], leader: null });
  });

  it("fails open with an empty pool when providers is absent entirely", async () => {
    const paseo = fakePaseo({});

    const result = await loadPool(paseo);

    expect(result.failOpen).toBe(true);
    expect(result.pool).toEqual({ workers: [], leader: null });
  });

  it("fails open with a clear error when worker priorities collide", async () => {
    const paseo = fakePaseo({
      providers: {
        "claude-leader": { params: { accountPool: { role: "leader", priority: 1 } } },
        "claude-worker-a": { params: { accountPool: { role: "worker", priority: 1 } } },
        "claude-worker-b": { params: { accountPool: { role: "worker", priority: 1 } } },
      },
    });

    const result = await loadPool(paseo);

    expect(result.failOpen).toBe(true);
    expect(result.pool).toEqual({ workers: [], leader: null });
    expect(result.error).toMatch(/priority 1/);
    expect(result.error).toMatch(/unique/);
  });

  it("fails open with a clear error when an entry declares an unknown role", async () => {
    const paseo = fakePaseo({
      providers: {
        "claude-a": { params: { accountPool: { role: "manager", priority: 1 } } },
      },
    });

    const result = await loadPool(paseo);

    expect(result.failOpen).toBe(true);
    expect(result.pool).toEqual({ workers: [], leader: null });
    expect(result.error).toBeDefined();
  });

  it("fails open with a clear error when two leaders are configured", async () => {
    const paseo = fakePaseo({
      providers: {
        "claude-leader-a": { params: { accountPool: { role: "leader", priority: 1 } } },
        "claude-leader-b": { params: { accountPool: { role: "leader", priority: 2 } } },
      },
    });

    const result = await loadPool(paseo);

    expect(result.failOpen).toBe(true);
    expect(result.pool).toEqual({ workers: [], leader: null });
    expect(result.error).toMatch(/exactly one leader/);
  });

  it("never throws when the config RPC rejects", async () => {
    const paseo = {
      config: { get: vi.fn().mockRejectedValue(new Error("daemon unreachable")) },
    } as unknown as PaseoConfigApi;

    const result = await loadPool(paseo);

    expect(result.failOpen).toBe(true);
    expect(result.pool).toEqual({ workers: [], leader: null });
    expect(result.error).toMatch(/daemon unreachable/);
  });
});

describe("createPoolCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts empty and fail-open before the first load resolves", () => {
    const paseo = fakePaseo({ providers: {} });
    const cache = createPoolCache(paseo, { intervalMs: 1000 });

    expect(cache.get()).toEqual({ pool: { workers: [], leader: null }, failOpen: true });
    cache.stop();
  });

  it("refreshes on interval ticks", async () => {
    const paseo = fakePaseo({
      providers: {
        "claude-leader": { params: { accountPool: { role: "leader", priority: 1 } } },
      },
    });
    const cache = createPoolCache(paseo, { intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);

    expect(cache.get().failOpen).toBe(false);
    expect(cache.get().pool.leader).toEqual({ providerId: "claude-leader" });
    cache.stop();
  });

  it("refreshes immediately on forceRefresh without waiting for the interval", async () => {
    const paseo = fakePaseo({ providers: {} });
    const cache = createPoolCache(paseo, { intervalMs: 60_000 });

    const before = cache.get();
    const result = await cache.forceRefresh();

    expect(before.failOpen).toBe(true);
    expect(result).toEqual(cache.get());
    cache.stop();
  });

  it("stop() clears the interval so no further refreshes happen", async () => {
    const paseo = fakePaseo({ providers: {} });
    const cache = createPoolCache(paseo, { intervalMs: 1000 });
    cache.stop();

    const getSpy = paseo.config.get as ReturnType<typeof vi.fn>;
    const callsAtStop = getSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);

    expect(getSpy.mock.calls.length).toBe(callsAtStop);
  });
});
