import { afterEach, describe, expect, it, vi } from "vitest";
import type { JevStatus } from "@getpaseo/protocol/jev/rpc-schemas";
import {
  JEV_SCOPE_CHECK_TIMEOUT_MS,
  createJevAvailability,
  jevToolsWorldFor,
  snapshotOf,
  type JevAvailabilityPaseo,
  type JevAvailabilitySnapshot,
} from "./jev-availability";

const LANE = {
  today: { calls: 0, answered: 0, failed: 0, unavailable: 0, inputTokens: 0, usd: 0, usdSource: "none" },
  maxUsdPerDay: 1,
  exhausted: false,
  circuit: "closed",
  resetsAt: "2026-09-30T00:00:00.000Z",
};

/** A status as `jev.status` sends it: key present, every feature on, spawn hint in shadow. */
function status(overrides: Partial<JevStatus> = {}): JevStatus {
  return {
    available: true,
    reason: null,
    keyPresent: true,
    provider: "fake",
    providerInferred: false,
    model: "jev-fake",
    features: {
      spawnHint: { enabled: true, shadow: true },
      agentTools: { enabled: true, shadow: false },
    },
    lanes: { control: LANE, agentTools: LANE, interactive: LANE },
    spawnHint: { applyHard: false, applyRole: false },
    agentTools: { assignShare: 0.5 },
    todayByFeature: {},
    last7Days: [],
    ...overrides,
  };
}

const ON: JevAvailabilitySnapshot = {
  spawnHint: { active: true, reason: null, shadow: true, applyHard: false, applyRole: false },
  agentTools: { active: true, assignShare: 0.5 },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("snapshotOf", () => {
  it("reads a live status", () => {
    expect(snapshotOf(status())).toEqual(ON);
  });

  it("is inactive with no key, a feature off, a spent lane or an open circuit", () => {
    expect(snapshotOf(status({ available: false, reason: "no-key" })).spawnHint).toMatchObject({
      active: false,
      reason: "no-key",
    });
    expect(
      snapshotOf(status({ features: { spawnHint: { enabled: false, shadow: true }, agentTools: { enabled: true, shadow: false } } }))
        .spawnHint,
    ).toMatchObject({ active: false, reason: "feature-disabled" });
    expect(snapshotOf(status({ lanes: { control: { ...LANE, exhausted: true }, agentTools: LANE } })).spawnHint).toMatchObject(
      { active: false, reason: "daily-budget" },
    );
    expect(
      snapshotOf(status({ lanes: { control: LANE, agentTools: { ...LANE, circuit: "open" } } })).agentTools.active,
    ).toBe(false);
  });

  it("reads the switches, shadow defaulting on, and clamps the share", () => {
    const snapshot = snapshotOf(
      status({
        features: { spawnHint: { enabled: true, shadow: false }, agentTools: { enabled: true, shadow: false } },
        spawnHint: { applyHard: true, applyRole: true },
        agentTools: { assignShare: 7 },
      }),
    );

    expect(snapshot.spawnHint).toMatchObject({ shadow: false, applyHard: true, applyRole: true });
    expect(snapshot.agentTools.assignShare).toBe(1);
    expect(snapshotOf(status({ features: {} })).spawnHint.shadow).toBe(true);
  });
});

describe("createJevAvailability", () => {
  const noInterval = { setIntervalFn: (() => 0) as unknown as typeof setInterval, clearIntervalFn: (() => {}) as typeof clearInterval };

  it("stays empty on a daemon without JEV", async () => {
    const availability = createJevAvailability({}, noInterval);

    expect(await availability.refresh()).toBeUndefined();
    expect(availability.get()).toBeUndefined();
  });

  it("reads the status, and forgets it when a poll fails", async () => {
    const statusFn = vi.fn().mockResolvedValueOnce(status()).mockRejectedValueOnce(new Error("closed"));
    const availability = createJevAvailability({ jev: { status: statusFn } } as unknown as JevAvailabilityPaseo, noInterval);

    expect(await availability.refresh()).toEqual(ON);
    expect(statusFn).toHaveBeenCalledWith({ timeout: 5_000 });
    expect(await availability.refresh()).toBeUndefined();
  });
});

describe("jevToolsWorldFor", () => {
  function paseoWith(checkScope: (...args: unknown[]) => Promise<"ok" | "excluded">) {
    const fn = vi.fn(checkScope);
    return { paseo: { jev: { checkScope: fn } } as unknown as JevAvailabilityPaseo, checkScope: fn };
  }

  it("is not evaluated before a status arrives", async () => {
    const { paseo, checkScope } = paseoWith(async () => "ok");

    expect(await jevToolsWorldFor({ availability: undefined, paseo, cwd: "/w", callerAgentId: "p", draw: 0 })).toBeUndefined();
    expect(checkScope).not.toHaveBeenCalled();
  });

  it("asks nothing while the tools are off", async () => {
    const { paseo, checkScope } = paseoWith(async () => "ok");
    const off = { ...ON, agentTools: { active: false, assignShare: 0.5 } };

    expect(await jevToolsWorldFor({ availability: off, paseo, cwd: "/w", callerAgentId: "p", draw: 0.3 })).toBeUndefined();
    expect(checkScope).not.toHaveBeenCalled();
  });

  it("checks the new agent's cwd and parent", async () => {
    const { paseo, checkScope } = paseoWith(async () => "excluded");

    const world = await jevToolsWorldFor({ availability: ON, paseo, cwd: "/w", callerAgentId: "p", draw: 0.3 });

    expect(checkScope).toHaveBeenCalledWith({ cwd: "/w", parentAgentId: "p" }, { timeout: JEV_SCOPE_CHECK_TIMEOUT_MS });
    expect(world?.scope).toBe("excluded");
  });

  it("fails closed: a rejected, missing or stalled check is unknown", async () => {
    const rejected = paseoWith(async () => {
      throw new Error("closed");
    });
    expect(
      (await jevToolsWorldFor({ availability: ON, paseo: rejected.paseo, cwd: "/w", callerAgentId: undefined, draw: 0 }))?.scope,
    ).toBe("unknown");
    expect((await jevToolsWorldFor({ availability: ON, paseo: {}, cwd: "/w", callerAgentId: undefined, draw: 0 }))?.scope).toBe(
      "unknown",
    );

    vi.useFakeTimers();
    const stalled = paseoWith(() => new Promise(() => {}));
    let scope: string | undefined;
    void jevToolsWorldFor({ availability: ON, paseo: stalled.paseo, cwd: "/w", callerAgentId: undefined, draw: 0 }).then(
      (world) => {
        scope = world?.scope;
      },
    );
    await vi.advanceTimersByTimeAsync(JEV_SCOPE_CHECK_TIMEOUT_MS);
    expect(scope).toBe("unknown");
  });
});
