import { describe, expect, test, vi } from "vitest";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import type { AgentManager, TokenBurnMonitorAgentSummary } from "./agent/agent-manager.js";
import type { BudgetPacingAdvisory, BudgetPacingSettings } from "./agent/budget-pacing-advisor.js";
import {
  AgentBudgetPacingMonitor,
  formatBudgetPacingAdvisory,
} from "./agent-budget-pacing-monitor.js";

const NOW_MS = Date.parse("2026-09-19T12:00:00Z");
const MS_PER_MINUTE = 60_000;

/** Tyler's pool: one leader account and two workers, exactly as `agents.providers` carries it. */
const ACCOUNT_POOL = {
  claude: { params: { accountPool: { role: "leader", priority: 1 } } },
  "claude-personal": {
    extends: "claude",
    params: { accountPool: { role: "worker", priority: 1 } },
  },
  "claude-backup": {
    extends: "claude",
    params: { accountPool: { role: "worker", priority: 2 } },
  },
};

function at(minutesFromNow: number): number {
  return NOW_MS + minutesFromNow * MS_PER_MINUTE;
}

function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function agentSummary(
  overrides: Partial<TokenBurnMonitorAgentSummary>,
): TokenBurnMonitorAgentSummary {
  return {
    id: "leader-1",
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

/** A worker account that has spent 40% then 48% of a session window resetting in 34 minutes. */
function usageSnapshot(usedPct: number, fetchedAtMinutes: number) {
  const providers: ProviderUsage[] = [
    {
      providerId: "claude-personal",
      displayName: "Claude (personal)",
      status: "available",
      planLabel: "Max",
      windows: [
        {
          id: "five_hour",
          label: "Session",
          usedPct,
          resetsAt: new Date(at(34)).toISOString(),
        },
      ],
    },
    {
      providerId: "claude-backup",
      displayName: "Claude (backup)",
      status: "available",
      planLabel: "Max",
      windows: [
        {
          id: "five_hour",
          label: "Session",
          usedPct: 9,
          resetsAt: new Date(at(200)).toISOString(),
        },
      ],
    },
  ];
  return { fetchedAt: new Date(at(fetchedAtMinutes)).toISOString(), providers };
}

interface Harness {
  monitor: AgentBudgetPacingMonitor;
  steered: Array<{ agentId: string; body: string }>;
  logger: ReturnType<typeof createLogger>;
  listUsage: ReturnType<typeof vi.fn>;
  setClock: (minutesFromNow: number) => void;
  setUsage: (usedPct: number, fetchedAtMinutes: number) => void;
  setAgents: (agents: TokenBurnMonitorAgentSummary[]) => void;
  setSettings: (settings: BudgetPacingSettings | undefined) => void;
}

function createHarness(
  options: {
    settings?: BudgetPacingSettings;
    agents?: TokenBurnMonitorAgentSummary[];
    providers?: Record<string, unknown>;
    steer?: (agentId: string, body: string) => Promise<void>;
  } = {},
): Harness {
  let nowMs = NOW_MS;
  let usage = usageSnapshot(40, -22);
  let agents = options.agents ?? [agentSummary({})];
  let settings = options.settings;
  const steered: Array<{ agentId: string; body: string }> = [];
  const logger = createLogger();
  const listUsage = vi.fn(async () => usage);
  const monitor = new AgentBudgetPacingMonitor({
    agentManager: {
      listAgentsForTokenBurnMonitor: () => agents,
    } as Pick<AgentManager, "listAgentsForTokenBurnMonitor">,
    providerUsage: { listUsage },
    sendSystemMessageToAgent: async (agentId, body) => {
      if (options.steer) await options.steer(agentId, body);
      steered.push({ agentId, body });
    },
    readDaemonConfig: () => ({
      ...(settings ? { budgetPacing: settings } : {}),
      providers: options.providers ?? ACCOUNT_POOL,
    }),
    logger,
    now: () => nowMs,
  });
  return {
    monitor,
    steered,
    logger,
    listUsage,
    setClock: (minutesFromNow) => {
      nowMs = at(minutesFromNow);
    },
    setUsage: (usedPct, fetchedAtMinutes) => {
      usage = usageSnapshot(usedPct, fetchedAtMinutes);
    },
    setAgents: (next) => {
      agents = next;
    },
    setSettings: (next) => {
      settings = next;
    },
  };
}

/** Two sweeps 22 minutes apart, which is the shortest history that is a pace at all. */
async function observeUnderuse(harness: Harness): Promise<void> {
  harness.setClock(-22);
  harness.setUsage(40, -22);
  await harness.monitor.tick();
  harness.setClock(0);
  harness.setUsage(48, 0);
  await harness.monitor.tick();
}

describe("AgentBudgetPacingMonitor", () => {
  test("absent config reads the usage API not at all", async () => {
    const harness = createHarness();

    await observeUnderuse(harness);

    expect(harness.listUsage).not.toHaveBeenCalled();
    expect(harness.steered).toEqual([]);
  });

  test("enabled: false is the same as absent", async () => {
    const harness = createHarness({ settings: { enabled: false } });

    await observeUnderuse(harness);

    expect(harness.listUsage).not.toHaveBeenCalled();
    expect(harness.steered).toEqual([]);
  });

  test("advises every running leader once", async () => {
    const harness = createHarness({
      settings: { enabled: true },
      agents: [
        agentSummary({ id: "leader-a" }),
        agentSummary({ id: "leader-b" }),
        agentSummary({ id: "subagent", isDelegated: true, provider: "claude-personal" }),
        agentSummary({ id: "idle-leader", isRunning: false }),
      ],
    });

    await observeUnderuse(harness);

    expect(harness.steered.map((entry) => entry.agentId)).toEqual(["leader-a", "leader-b"]);
    expect(harness.steered[0]!.body).toContain("52% of its Session window left");
    expect(harness.steered[0]!.body).toContain("Be more aggressive with subagents");
  });

  test("says it once, not once a minute", async () => {
    const harness = createHarness({ settings: { enabled: true } });

    await observeUnderuse(harness);
    harness.setClock(1);
    await harness.monitor.tick();
    harness.setClock(2);
    await harness.monitor.tick();

    expect(harness.steered).toHaveLength(1);
  });

  test("an idle fleet is told nothing, and hears it when a leader starts", async () => {
    const harness = createHarness({
      settings: { enabled: true },
      agents: [agentSummary({ isRunning: false })],
    });

    await observeUnderuse(harness);
    expect(harness.steered).toEqual([]);

    harness.setAgents([agentSummary({ id: "leader-woke-up" })]);
    harness.setClock(1);
    await harness.monitor.tick();

    expect(harness.steered.map((entry) => entry.agentId)).toEqual(["leader-woke-up"]);
  });

  test("a dry run logs what it would have said, to whom, and steers nobody", async () => {
    const harness = createHarness({ settings: { enabled: true, dryRun: true } });

    await observeUnderuse(harness);

    expect(harness.steered).toEqual([]);
    const logged = harness.logger.info.mock.calls.at(-1);
    expect(logged?.[1]).toBe("Budget pacing would advise running leaders");
    expect(logged?.[0]).toMatchObject({
      dryRun: true,
      direction: "speedUp",
      providerId: "claude-personal",
      remainingPct: 52,
      minutesToReset: 34,
      gapPct: 40,
      leaderIds: ["leader-1"],
    });
    const fields = logged?.[0] as { advice?: string } | undefined;
    expect(fields?.advice).toContain("Be more aggressive with subagents");
  });

  test("a dry run does not repeat itself either", async () => {
    const harness = createHarness({ settings: { enabled: true, dryRun: true } });

    await observeUnderuse(harness);
    harness.setClock(1);
    await harness.monitor.tick();

    expect(harness.logger.info).toHaveBeenCalledTimes(1);
  });

  test("a pool with no worker accounts is nothing to pace", async () => {
    const harness = createHarness({
      settings: { enabled: true },
      providers: { claude: { params: { accountPool: { role: "leader", priority: 1 } } } },
    });

    await observeUnderuse(harness);

    expect(harness.steered).toEqual([]);
  });

  test("turning it off drops the observations it had gathered", async () => {
    const harness = createHarness({ settings: { enabled: true } });

    harness.setClock(-22);
    harness.setUsage(40, -22);
    await harness.monitor.tick();
    harness.setSettings({ enabled: false });
    await harness.monitor.tick();
    harness.setSettings({ enabled: true });
    harness.setClock(0);
    harness.setUsage(48, 0);
    await harness.monitor.tick();

    // The second reading is the only one left, so there is no span to measure a pace over.
    expect(harness.steered).toEqual([]);
  });

  test("a failed steer leaves the advice to be said again", async () => {
    const harness = createHarness({
      settings: { enabled: true },
      steer: async () => {
        throw new Error("agent went away");
      },
    });

    await observeUnderuse(harness);
    expect(harness.logger.warn).toHaveBeenCalledTimes(1);

    harness.setClock(1);
    await harness.monitor.tick();

    expect(harness.logger.warn).toHaveBeenCalledTimes(2);
  });

  test("an unreadable usage API is a quiet sweep, not a failed one", async () => {
    const harness = createHarness({ settings: { enabled: true } });
    harness.listUsage.mockRejectedValue(new Error("no credentials"));

    await observeUnderuse(harness);

    expect(harness.steered).toEqual([]);
    expect(harness.logger.warn).toHaveBeenCalled();
  });

  test("an overlapping sweep does not start a second one", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness({
      settings: { enabled: true },
      steer: async () => {
        await gate;
      },
    });

    harness.setClock(-22);
    harness.setUsage(40, -22);
    await harness.monitor.tick();
    harness.setClock(0);
    harness.setUsage(48, 0);
    const first = harness.monitor.tick();
    await harness.monitor.tick();
    release();
    await first;

    expect(harness.steered).toHaveLength(1);
  });
});

const SPEED_UP_ADVISORY: BudgetPacingAdvisory = {
  direction: "speedUp",
  trackKey: "claude-personal:five_hour",
  providerId: "claude-personal",
  providerDisplayName: "Claude (personal)",
  windowLabel: "Session",
  remainingPct: 52,
  minutesToReset: 34,
  resetsAt: "2026-09-19T12:34:00.000Z",
  observedPctPerMin: 8 / 22,
  requiredPctPerMin: 52 / 34,
  gapPct: 52 - (8 / 22) * 34,
  minutesToExhaust: null,
  earlyByMinutes: null,
  observationMinutes: 22,
  observationSamples: 4,
  usageAgeMinutes: 3,
  runningAgentsOnAccount: 1,
  accountTokenRatePerMinute: 118_000,
  alternatives: [{ providerId: "claude-backup", displayName: "Claude (backup)", remainingPct: 91 }],
};

const SLOW_DOWN_ADVISORY: BudgetPacingAdvisory = {
  ...SPEED_UP_ADVISORY,
  direction: "slowDown",
  remainingPct: 18,
  minutesToReset: 120,
  resetsAt: "2026-09-19T14:00:00.000Z",
  observedPctPerMin: 0.4,
  requiredPctPerMin: 18 / 120,
  gapPct: 30,
  minutesToExhaust: 45,
  earlyByMinutes: 75,
  observationMinutes: 30,
  runningAgentsOnAccount: 4,
  accountTokenRatePerMinute: 385_000,
};

describe("formatBudgetPacingAdvisory", () => {
  test("the speed-up message", () => {
    expect(formatBudgetPacingAdvisory(SPEED_UP_ADVISORY)).toBe(
      [
        "Bozeo budget pacing — advice only. Nothing has been throttled, cancelled, downgraded or refused, and nothing will be on account of this message.",
        "Worker account claude-personal has 52% of its Session window left and it resets in 34 min (2026-09-19T12:34:00.000Z). Over the last 22 min it has been consumed at about 0.36%/min; spending the rest of it before the reset would take about 1.5%/min. At the current pace roughly 40 points of the window expire unused, and a window that expires does not roll over — that capacity is gone rather than carried forward. 1 agent is running on it, burning about 118K weighted tokens/min.",
        'Be more aggressive with subagents while it lasts: run in parallel what you were going to run in sequence, give the work that deserves a bigger model one now, and start anything you were holding in a queue. Pass the account explicitly — provider "claude-personal/<model>" — so the spend lands on this window rather than wherever the default placement sends it. The other worker accounts\' Session windows: claude-backup (91% left).',
        "Both figures are estimates. The usage reading is a cached snapshot taken 3 min ago — the daemon refreshes it every five minutes — and the pace is the difference between 4 readings over 22 min. Treat the projection as a direction, not a measurement.",
      ].join("\n\n"),
    );
  });

  test("the slow-down message", () => {
    expect(formatBudgetPacingAdvisory(SLOW_DOWN_ADVISORY)).toBe(
      [
        "Bozeo budget pacing — advice only. Nothing has been throttled, cancelled, downgraded or refused, and nothing will be on account of this message.",
        "Worker account claude-personal has 18% of its Session window left, and that window does not reset for 2h (2026-09-19T14:00:00.000Z). Over the last 30 min it has been consumed at about 0.40%/min, against the 0.15%/min that would make what is left last to the reset. At that pace it runs out in about 45 min — roughly 1h 15m before the reset — and reaching the reset would take about 30 points more of the window than it has. 4 agents are running on it, burning about 385K weighted tokens/min between them.",
        'Ease off on that account: stop adding parallel subagents there, and prefer a cheaper model for anything that does not need a big one. Work already in flight there is the thing at risk — it is the turn that gets cut off when the window caps. Put new work on another account instead: claude-backup has 91% of its Session window left, so create subagents there with provider "claude-backup/<model>" rather than letting the default placement choose.',
        "Both figures are estimates. The usage reading is a cached snapshot taken 3 min ago — the daemon refreshes it every five minutes — and the pace is the difference between 4 readings over 30 min. Treat the projection as a direction, not a measurement.",
      ].join("\n\n"),
    );
  });

  test("with nothing running on the account it says so", () => {
    const body = formatBudgetPacingAdvisory({
      ...SPEED_UP_ADVISORY,
      runningAgentsOnAccount: 0,
      accountTokenRatePerMinute: 0,
    });

    expect(body).toContain("Nothing is running on that account right now.");
  });

  test("with nowhere else to send work it does not pretend there is", () => {
    const body = formatBudgetPacingAdvisory({ ...SLOW_DOWN_ADVISORY, alternatives: [] });

    expect(body).toContain("There is no other worker account to move new work to");
  });
});
