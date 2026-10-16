import { afterEach, describe, expect, it, vi } from "vitest";
import type { JevStatus } from "@getpaseo/protocol/jev/rpc-schemas";
import {
  JEV_SCOPE_CHECK_TIMEOUT_MS,
  UNKNOWN_RPC_BACKOFF_MS,
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

/** `agentTools.served`, which only a daemon carrying the JEV agent tools sends. Not in the foundation's schema. */
const SERVED = { assignShare: 0.5, served: true } as JevStatus["agentTools"];

/** A status as `jev.status` sends it: key present, every feature on and the tools served, spawn hint in shadow. */
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
    spawnHint: { applyHard: false, applyRole: false, auditDeclared: false },
    agentTools: SERVED,
    todayByFeature: {},
    last7Days: [],
    ...overrides,
  };
}

const ON: JevAvailabilitySnapshot = {
  spawnHint: { active: true, reason: null, shadow: true, applyHard: false, applyRole: false, auditDeclared: false },
  agentTools: { active: true, served: true, assignShare: 0.5 },
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
        spawnHint: { applyHard: true, applyRole: true, auditDeclared: true },
        agentTools: { assignShare: 7 },
      }),
    );

    expect(snapshot.spawnHint).toMatchObject({
      shadow: false,
      applyHard: true,
      applyRole: true,
      auditDeclared: true,
    });
    expect(snapshot.agentTools.assignShare).toBe(1);
    expect(snapshotOf(status({ features: {} })).spawnHint.shadow).toBe(true);
  });

  it("defaults auditDeclared off when an older daemon omits it", () => {
    expect(snapshotOf(status({ spawnHint: { applyHard: false, applyRole: false } })).spawnHint.auditDeclared).toBe(
      false,
    );
  });
});

describe("createJevAvailability", () => {
  const noInterval = { setIntervalFn: (() => 0) as unknown as typeof setInterval, clearIntervalFn: (() => {}) as typeof clearInterval };

  it("stays empty on a daemon without JEV", async () => {
    const availability = createJevAvailability({}, noInterval);

    expect(await availability.refresh()).toBeUndefined();
    expect(availability.get()).toBeUndefined();
  });

  it("reads a daemon without the JEV tools as not serving them, whatever agentTools.enabled says", () => {
    expect(snapshotOf(status({ agentTools: { assignShare: 0.5 } })).agentTools).toEqual({
      active: true,
      served: false,
      assignShare: 0.5,
    });
  });

  it("stops asking for 10 minutes once the daemon does not know jev.status", async () => {
    let nowMs = 1_000_000;
    const statusFn = vi.fn(async (): Promise<JevStatus> => {
      throw Object.assign(new Error("Unknown request, try upgrading the daemon"), { code: "unknown_schema" });
    });
    const availability = createJevAvailability({ jev: { status: statusFn } } as unknown as JevAvailabilityPaseo, {
      ...noInterval,
      now: () => nowMs,
    });

    expect(await availability.refresh()).toBeUndefined();
    nowMs += UNKNOWN_RPC_BACKOFF_MS - 1;
    expect(await availability.refresh()).toBeUndefined();
    expect(statusFn).toHaveBeenCalledTimes(1);

    nowMs += 1;
    statusFn.mockResolvedValueOnce(status());
    expect(await availability.refresh()).toEqual(ON);
    expect(statusFn).toHaveBeenCalledTimes(2);
  });

  it("keeps polling every interval after an ordinary failure", async () => {
    const statusFn = vi.fn().mockRejectedValueOnce(new Error("socket closed")).mockResolvedValueOnce(status());
    const availability = createJevAvailability({ jev: { status: statusFn } } as unknown as JevAvailabilityPaseo, noInterval);

    expect(await availability.refresh()).toBeUndefined();
    expect(await availability.refresh()).toEqual(ON);
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
    const off = { ...ON, agentTools: { active: false, served: true, assignShare: 0.5 } };

    expect(await jevToolsWorldFor({ availability: off, paseo, cwd: "/w", callerAgentId: "p", draw: 0.3 })).toBeUndefined();
    expect(checkScope).not.toHaveBeenCalled();
  });

  it("gives no arm until the daemon serves the tools, so no agent is labelled with nothing behind it", async () => {
    const { paseo, checkScope } = paseoWith(async () => "ok");
    const unserved = { ...ON, agentTools: { active: true, served: false, assignShare: 0.5 } };

    expect(await jevToolsWorldFor({ availability: unserved, paseo, cwd: "/w", callerAgentId: "p", draw: 0 })).toBeUndefined();
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
