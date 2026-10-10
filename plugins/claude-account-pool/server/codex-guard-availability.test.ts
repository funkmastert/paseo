import { describe, expect, it, vi } from "vitest";
import {
  UNKNOWN_RPC_BACKOFF_MS,
  createCodexGuardAvailability,
  snapshotOf,
  type CodexGuardAvailabilityPaseo,
} from "./codex-guard-availability";

const NOW = new Date("2026-10-10T12:00:00.000Z").getTime();

interface FakeCodexGuardStatus {
  status: string;
  reason: string;
  checkedAt: string;
  codexVersion: string | null;
  runningChildren: number;
}

function status(overrides: Partial<FakeCodexGuardStatus> = {}): FakeCodexGuardStatus {
  return {
    status: "green",
    reason: "ok",
    checkedAt: new Date(NOW).toISOString(),
    codexVersion: "0.160.0",
    runningChildren: 1,
    ...overrides,
  };
}

describe("snapshotOf", () => {
  const now = () => NOW;

  it("is healthy on a fresh green verdict", () => {
    expect(snapshotOf(status(), now)).toEqual({ healthy: true, runningChildren: 1 });
  });

  it("is unhealthy when the verdict is red or unknown", () => {
    expect(snapshotOf(status({ status: "red" }), now).healthy).toBe(false);
    expect(snapshotOf(status({ status: "unknown" }), now).healthy).toBe(false);
  });

  it("is unhealthy when a green verdict has gone stale (over 26h)", () => {
    const stale = new Date(NOW - 27 * 60 * 60 * 1000).toISOString();
    expect(snapshotOf(status({ checkedAt: stale }), now).healthy).toBe(false);
  });

  it("is healthy right at the edge of the freshness window", () => {
    const fresh = new Date(NOW - 25 * 60 * 60 * 1000).toISOString();
    expect(snapshotOf(status({ checkedAt: fresh }), now).healthy).toBe(true);
  });

  it("is unhealthy when checkedAt cannot be parsed", () => {
    expect(snapshotOf(status({ checkedAt: "not-a-date" }), now).healthy).toBe(false);
  });

  it("carries runningChildren through regardless of health", () => {
    expect(snapshotOf(status({ status: "red", runningChildren: 2 }), now).runningChildren).toBe(2);
  });
});

describe("createCodexGuardAvailability", () => {
  const noInterval = {
    setIntervalFn: (() => 0) as unknown as typeof setInterval,
    clearIntervalFn: (() => {}) as typeof clearInterval,
    now: () => NOW,
  };

  it("stays empty on a daemon without the RPC", async () => {
    const availability = createCodexGuardAvailability({}, noInterval);

    expect(await availability.refresh()).toBeUndefined();
    expect(availability.get()).toBeUndefined();
  });

  it("reads a healthy status", async () => {
    const statusFn = vi.fn().mockResolvedValue(status());
    const availability = createCodexGuardAvailability(
      { codexGuard: { status: statusFn } } as unknown as CodexGuardAvailabilityPaseo,
      noInterval,
    );

    expect(await availability.refresh()).toEqual({ healthy: true, runningChildren: 1 });
    expect(statusFn).toHaveBeenCalledWith({ timeout: 5_000 });
  });

  it("forgets the snapshot when a poll fails", async () => {
    const statusFn = vi
      .fn()
      .mockResolvedValueOnce(status())
      .mockRejectedValueOnce(new Error("closed"));
    const availability = createCodexGuardAvailability(
      { codexGuard: { status: statusFn } } as unknown as CodexGuardAvailabilityPaseo,
      noInterval,
    );

    expect(await availability.refresh()).toEqual({ healthy: true, runningChildren: 1 });
    expect(await availability.refresh()).toBeUndefined();
  });

  it("stops asking for 10 minutes once the daemon does not know codexGuard.status", async () => {
    let nowMs = 1_000_000;
    const statusFn = vi.fn<() => Promise<FakeCodexGuardStatus>>(async () => {
      throw Object.assign(new Error("Unknown request, try upgrading the daemon"), {
        code: "unknown_schema",
      });
    });
    const availability = createCodexGuardAvailability(
      { codexGuard: { status: statusFn } } as unknown as CodexGuardAvailabilityPaseo,
      { ...noInterval, now: () => nowMs },
    );

    expect(await availability.refresh()).toBeUndefined();
    nowMs += UNKNOWN_RPC_BACKOFF_MS - 1;
    expect(await availability.refresh()).toBeUndefined();
    expect(statusFn).toHaveBeenCalledTimes(1);

    nowMs += 1;
    statusFn.mockResolvedValueOnce(status({ checkedAt: new Date(nowMs).toISOString() }));
    expect(await availability.refresh()).toEqual({ healthy: true, runningChildren: 1 });
    expect(statusFn).toHaveBeenCalledTimes(2);
  });

  it("stop() stops the interval", () => {
    const clearIntervalFn = vi.fn();
    const availability = createCodexGuardAvailability(
      {},
      { setIntervalFn: (() => 123) as unknown as typeof setInterval, clearIntervalFn: clearIntervalFn as unknown as typeof clearInterval },
    );
    availability.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(123);
  });
});
