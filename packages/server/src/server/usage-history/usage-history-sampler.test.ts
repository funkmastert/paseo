import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentManager, TokenBurnMonitorAgentSummary } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { AgentTokenBurnMonitor } from "../agent-token-burn-monitor.js";
import { UsageHistorySampler, accountSamplesFromUsage } from "./usage-history-sampler.js";
import { UsageHistoryStore } from "./usage-history-store.js";
import { buildAccountUsageView } from "./usage-history-view.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 8, 23, 12, 0, 0);

let rootDir: string;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-history-sampler-"));
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

function usageRow(overrides: Partial<ProviderUsage> & { usedPct?: number } = {}): ProviderUsage {
  const { usedPct = 40, ...rest } = overrides;
  return {
    providerId: "claude-personal",
    displayName: "Claude Personal",
    status: "available",
    planLabel: null,
    fetchedAt: new Date(T0).toISOString(),
    windows: [
      {
        id: "five_hour",
        label: "Session",
        usedPct,
        remainingPct: 100 - usedPct,
        resetsAt: new Date(T0 + 5 * HOUR).toISOString(),
      },
      {
        id: "weekly_model_fable",
        label: "Fable weekly",
        usedPct: 10,
        remainingPct: 90,
        resetsAt: new Date(T0 + 3 * 24 * HOUR).toISOString(),
      },
    ],
    ...rest,
  };
}

function summary(overrides: Partial<TokenBurnMonitorAgentSummary>): TokenBurnMonitorAgentSummary {
  return {
    id: "agent-1",
    workspaceId: "workspace-1",
    internal: false,
    isDelegated: false,
    isRunning: true,
    tokenRate: undefined,
    totalTokens: undefined,
    labels: {},
    model: "claude-opus-5",
    provider: "claude",
    ...overrides,
  };
}

function createHarness(input: {
  agents: () => TokenBurnMonitorAgentSummary[];
  usage: () => ProviderUsage[] | null;
  settings?: () => { enabled?: boolean } | undefined;
  store?: UsageHistoryStore;
}) {
  const clock = { nowMs: T0 };
  const store =
    input.store ??
    new UsageHistoryStore({ rootDir, logger: { warn: () => undefined }, flushIntervalMs: 0 });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const agentManager = {
    listAgentsForTokenBurnMonitor: vi.fn(() => input.agents()),
    getTokenBurnMonitorState: vi.fn(() => undefined),
    setTokenBurnMonitorState: vi.fn(),
    setTokenBurnAlert: vi.fn(),
    clearTokenBurnAlert: vi.fn(),
    getSpendGovernorState: vi.fn(() => undefined),
    setSpendGovernorState: vi.fn(),
    setAgentModel: vi.fn(async () => {}),
    cancelAgentRun: vi.fn(async () => ({ status: "settled" as const })),
  } as unknown as AgentManager;
  const readProviderUsage = async () => input.usage();
  const monitor = new AgentTokenBurnMonitor({
    agentManager,
    agentStorage: { get: vi.fn(async () => null) } as Pick<AgentStorage, "get">,
    pushNotificationSender: { send: vi.fn(async () => {}) },
    serverId: "server-1",
    sendSystemMessageToAgent: async () => {},
    readProviderUsage,
    usageHistory: new UsageHistorySampler({
      store,
      readProviderUsage,
      readSettings: input.settings ?? (() => undefined),
      logger,
    }),
    readDaemonConfig: () => ({ tokenBurnMonitor: {} }),
    logger,
    now: () => clock.nowMs,
  });
  return { monitor, store, clock, logger, agentManager };
}

describe("accountSamplesFromUsage", () => {
  test("turns each available window into a reading stamped by the snapshot's own fetchedAt", () => {
    const samples = accountSamplesFromUsage([usageRow()]);
    expect(samples).toEqual([
      {
        providerId: "claude-personal",
        windowId: "five_hour",
        label: "Session",
        atMs: T0,
        usedPct: 40,
        resetsAtMs: T0 + 5 * HOUR,
      },
      {
        providerId: "claude-personal",
        windowId: "weekly_model_fable",
        label: "Fable weekly",
        atMs: T0,
        usedPct: 10,
        resetsAtMs: T0 + 3 * 24 * HOUR,
      },
    ]);
  });

  test("skips rows that carry no reading or cannot be placed in time", () => {
    expect(
      accountSamplesFromUsage([
        usageRow({ status: "unavailable" }),
        usageRow({ status: "error" }),
        usageRow({ fetchedAt: null }),
        usageRow({ fetchedAt: "not a date" }),
        {
          ...usageRow(),
          windows: [{ id: "five_hour", label: "Session", usedPct: null }],
        },
      ]),
    ).toEqual([]);
  });

  test("rounds the reset time to the minute so fetch noise does not split a cycle", () => {
    const noisy = usageRow();
    noisy.windows[0]!.resetsAt = new Date(T0 + 5 * HOUR + 961).toISOString();
    expect(accountSamplesFromUsage([noisy])[0]?.resetsAtMs).toBe(T0 + 5 * HOUR);
  });
});

describe("the sampler riding the token-burn sweep", () => {
  test("records account windows and agent spend without a loop or a fetch of its own", async () => {
    let totalTokens = 1_000;
    const harness = createHarness({
      agents: () => [summary({ totalTokens })],
      usage: () => [usageRow()],
    });
    await harness.monitor.tick();
    harness.clock.nowMs += MINUTE;
    totalTokens = 5_000;
    await harness.monitor.tick();

    const series = await harness.store.readAccountSeries();
    expect(series.map((entry) => entry.windowId).sort()).toEqual([
      "five_hour",
      "weekly_model_fable",
    ]);
    // Two sweeps read one cached snapshot: one reading per window.
    expect(series.every((entry) => entry.samples.length === 1)).toBe(true);
    const spend = await harness.store.readAgentSpend("agent-1", 10);
    expect(spend?.totalWeightedTokens).toBe(5_000);
  });

  test("records with no live agents: an account is filling whether or not anything runs", async () => {
    const harness = createHarness({ agents: () => [], usage: () => [usageRow()] });
    await harness.monitor.tick();
    expect(await harness.store.readAccountSeries()).toHaveLength(2);
  });

  test("keeps no internal agent's spend", async () => {
    const harness = createHarness({
      agents: () => [summary({ id: "internal-1", internal: true, totalTokens: 900 })],
      usage: () => null,
    });
    await harness.monitor.tick();
    expect(await harness.store.readAgentSpend("internal-1", 10)).toBeNull();
  });

  test("records nothing once switched off", async () => {
    const harness = createHarness({
      agents: () => [summary({ totalTokens: 1_000 })],
      usage: () => [usageRow()],
      settings: () => ({ enabled: false }),
    });
    await harness.monitor.tick();
    expect(await harness.store.readAccountSeries()).toEqual([]);
    expect(await harness.store.readAgentSpend("agent-1", 10)).toBeNull();
  });

  test("a store that cannot write never costs the sweep its governor", async () => {
    const store = new UsageHistoryStore({
      rootDir: path.join(rootDir, "does", "not", "matter"),
      logger: { warn: () => undefined },
    });
    vi.spyOn(store, "record").mockRejectedValue(new Error("disk full"));
    const harness = createHarness({
      agents: () => [summary({ totalTokens: 1_000 })],
      usage: () => [usageRow()],
      store,
    });
    await harness.monitor.tick();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Failed to record usage history",
    );
    // The sweep carried on to the per-agent legs after the sampler failed.
    expect(harness.agentManager.setSpendGovernorState).toHaveBeenCalled();
  });
});

describe("end to end: from sweeps to a time-to-cap", () => {
  test("a window filling at 10 points an hour projects its cap, and not before it can be measured", async () => {
    let usedPct = 30;
    let fetchedAtMs = T0;
    const harness = createHarness({
      agents: () => [],
      usage: () => [usageRow({ usedPct, fetchedAt: new Date(fetchedAtMs).toISOString() })],
    });

    // Five minutes of history is not a measurement.
    await harness.monitor.tick();
    harness.clock.nowMs = T0 + 5 * MINUTE;
    usedPct = 30.8;
    fetchedAtMs = T0 + 5 * MINUTE;
    await harness.monitor.tick();
    const early = buildAccountUsageView({
      series: await harness.store.readAccountSeries(),
      nowMs: harness.clock.nowMs,
    });
    const earlyWindow = early[0]?.windows.find((window) => window.windowId === "five_hour");
    expect(earlyWindow?.projection).toMatchObject({
      status: "unknown",
      reason: "insufficient_samples",
    });

    // Then an hour of fetches, every five minutes, filling at 10 points an hour.
    for (let minutes = 10; minutes <= 60; minutes += 5) {
      harness.clock.nowMs = T0 + minutes * MINUTE;
      fetchedAtMs = harness.clock.nowMs;
      usedPct = 30 + minutes / 6;
      await harness.monitor.tick();
    }
    const view = buildAccountUsageView({
      series: await harness.store.readAccountSeries(),
      nowMs: harness.clock.nowMs,
    });
    const window = view[0]?.windows.find((entry) => entry.windowId === "five_hour");
    // 40% at T0+60min, 10 points/hour: 6 hours to 100%, but the window resets in 4 hours.
    expect(window?.projection).toMatchObject({ status: "projected" });
    expect(window?.projection.capsAt).toBeUndefined();
    expect(window?.projection.projectedPctAtReset).toBeCloseTo(80, 0);
    expect(window?.usedPct).toBeCloseTo(40, 5);
  });

  test("the same fill rate inside the window's remaining time gives a cap time", async () => {
    let usedPct = 60;
    let fetchedAtMs = T0;
    const harness = createHarness({
      agents: () => [],
      usage: () => [
        {
          ...usageRow({ usedPct, fetchedAt: new Date(fetchedAtMs).toISOString() }),
        },
      ],
    });
    for (let minutes = 0; minutes <= 60; minutes += 5) {
      harness.clock.nowMs = T0 + minutes * MINUTE;
      fetchedAtMs = harness.clock.nowMs;
      usedPct = 60 + minutes / 3;
      await harness.monitor.tick();
    }
    const view = buildAccountUsageView({
      series: await harness.store.readAccountSeries(),
      nowMs: harness.clock.nowMs,
    });
    const window = view[0]?.windows.find((entry) => entry.windowId === "five_hour");
    // 80% now, 20 points/hour: capped in an hour, four hours before the reset.
    expect(window?.projection.status).toBe("projected");
    expect(window?.projection.minutesToCap).toBeCloseTo(60, 0);
    expect(Date.parse(window?.projection.capsAt ?? "")).toBeCloseTo(T0 + 2 * HOUR, -3);
  });
});
