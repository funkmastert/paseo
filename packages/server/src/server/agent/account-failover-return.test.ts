import { describe, expect, it } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import type { AccountFailoverAgentSummary } from "./agent-manager.js";
import type { AgentAccountAuth } from "./agent-sdk-types.js";
import {
  ACCOUNT_FAILOVER_HOME_PROVIDER_LABEL,
  ACCOUNT_FAILOVER_MIGRATED_TO_LABEL,
  getHomeProviderFromLabels,
} from "./account-failover-detector.js";
import type { AccountPoolProviderEntry } from "./account-pool-providers.js";
import {
  homeReturnBlockedReason,
  planAccountFailoverReturns,
  providersShareAccount,
  resolveReturnConfig,
  type PlanAccountFailoverReturnsInput,
} from "./account-failover-return.js";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const MINUTE_MS = 60 * 1000;
const CONFIG = resolveReturnConfig(undefined);

const POOL: AccountPoolProviderEntry[] = [
  { providerId: "claude", role: "leader", priority: 1, enabled: true },
  { providerId: "claude-personal", role: "worker", priority: 1, enabled: true },
  { providerId: "claude-backup", role: "worker", priority: 2, enabled: true },
];

/** Rescued off `claude`, now on `claude-personal`, quiet for an hour: every cheap gate cleared. */
function rescued(
  overrides: Partial<AccountFailoverAgentSummary> = {},
): AccountFailoverAgentSummary {
  return {
    id: "leader-1",
    provider: "claude-personal",
    cwd: "/tmp/work",
    workspaceId: "ws-1",
    internal: false,
    lifecycle: "idle",
    lastError: undefined,
    title: "Build failover",
    busy: false,
    pendingPermissionCount: 0,
    lastActivityAt: new Date(NOW - 60 * MINUTE_MS).toISOString(),
    timelineSeq: 12,
    lastTimelineAt: new Date(NOW - 60 * MINUTE_MS).toISOString(),
    labels: { [ACCOUNT_FAILOVER_HOME_PROVIDER_LABEL]: "claude" },
    sessionId: "session-leader-1",
    model: "claude-opus-5",
    modeId: "bypassPermissions",
    thinkingOptionId: "max",
    ...overrides,
  };
}

function plan(
  agents: AccountFailoverAgentSummary[],
  overrides: Partial<PlanAccountFailoverReturnsInput> = {},
) {
  return planAccountFailoverReturns({
    agents,
    poolEntries: POOL,
    deadProviderIds: new Set<string>(),
    accounts: new Map<string, AgentAccountAuth | null>(),
    cooldowns: new Map<string, number>(),
    nowMs: NOW,
    config: CONFIG,
    ...overrides,
  });
}

function usageRow(
  providerId: string,
  windows: Array<{ usedPct?: number | null; resetsAt?: string | null }>,
  status: ProviderUsage["status"] = "available",
): ProviderUsage {
  return {
    providerId,
    displayName: providerId,
    status,
    planLabel: null,
    windows: windows.map((window, index) => ({
      id: `window-${index}`,
      label: `Window ${index}`,
      usedPct: window.usedPct ?? null,
      remainingPct: null,
      resetsAt: window.resetsAt ?? null,
    })),
    balances: [],
    details: [],
    error: null,
  };
}

function health(
  overrides: {
    usage?: readonly ProviderUsage[] | null;
    fetchedAtMs?: number | null;
  } = {},
) {
  return homeReturnBlockedReason({
    homeProviderId: "claude",
    usage: overrides.usage === undefined ? [usageRow("claude", [{ usedPct: 4 }])] : overrides.usage,
    fetchedAtMs: overrides.fetchedAtMs === undefined ? NOW : overrides.fetchedAtMs,
    nowMs: NOW,
    config: CONFIG,
  });
}

describe("getHomeProviderFromLabels", () => {
  it("reads a home account, and reads a blanked one as unset", () => {
    expect(getHomeProviderFromLabels({ [ACCOUNT_FAILOVER_HOME_PROVIDER_LABEL]: "claude" })).toBe(
      "claude",
    );
    // Blanking is how the label is removed; it has to read exactly like never having been set.
    expect(getHomeProviderFromLabels({ [ACCOUNT_FAILOVER_HOME_PROVIDER_LABEL]: "" })).toBeNull();
    expect(getHomeProviderFromLabels({})).toBeNull();
    expect(getHomeProviderFromLabels(undefined)).toBeNull();
  });
});

describe("providersShareAccount", () => {
  it("matches only on an equal, readable account", () => {
    const tyler: AgentAccountAuth = { state: "signed-in", accountLabel: "tyler@example.com" };
    expect(providersShareAccount(tyler, { ...tyler })).toBe(true);
    expect(
      providersShareAccount(tyler, { state: "signed-in", accountLabel: "worker@example.com" }),
    ).toBe(false);
    // Two shrugs are not a match: "cannot tell" must never be read as "the same".
    expect(providersShareAccount({ state: "unknown" }, { state: "unknown" })).toBe(false);
    expect(
      providersShareAccount(
        { state: "signed-in", accountLabel: null },
        { state: "signed-in", accountLabel: null },
      ),
    ).toBe(false);
    expect(providersShareAccount(null, null)).toBe(false);
  });
});

describe("planAccountFailoverReturns", () => {
  it("returns a quiet rescued agent to the account it was taken off", () => {
    const result = plan([rescued()]);

    expect(result.drops).toEqual([]);
    expect(result.candidates).toEqual([
      {
        agentId: "leader-1",
        title: "Build failover",
        workspaceId: "ws-1",
        fromProviderId: "claude-personal",
        homeProviderId: "claude",
        targetProviderIds: ["claude"],
      },
    ]);
  });

  it("ignores an agent with no home label", () => {
    expect(plan([rescued({ labels: {} })])).toEqual({ drops: [], candidates: [] });
  });

  it("waits while home is still dead", () => {
    // The whole point of the freshness gates: the clock passing a reset is not a reset.
    expect(plan([rescued()], { deadProviderIds: new Set(["claude"]) })).toEqual({
      drops: [],
      candidates: [],
    });
  });

  it.each([
    ["running", rescued({ lifecycle: "running" })],
    ["in error", rescued({ lifecycle: "error" })],
    ["closed", rescued({ lifecycle: "closed" })],
    ["mid-turn", rescued({ busy: true })],
    ["waiting on a permission", rescued({ pendingPermissionCount: 1 })],
    ["without a session", rescued({ sessionId: undefined })],
    ["internal", rescued({ internal: true })],
  ])("never interrupts an agent that is %s", (_label, agent) => {
    expect(plan([agent]).candidates).toEqual([]);
  });

  it("leaves an agent that failed on a cap to the rescue leg", () => {
    // Both legs acting on one agent in a sweep would race, and this one is stuck, not tidy-uppable.
    const capped = rescued({
      lifecycle: "error",
      lastError: "You've hit your monthly spend limit · your session limit resets 3:10pm",
    });
    expect(plan([capped])).toEqual({ drops: [], candidates: [] });
  });

  it("does not take an agent that was active a minute ago", () => {
    const busyConversation = rescued({
      lastActivityAt: new Date(NOW - MINUTE_MS).toISOString(),
    });
    expect(plan([busyConversation]).candidates).toEqual([]);

    // Ten minutes later the same agent is fair game.
    expect(plan([busyConversation], { nowMs: NOW + 10 * MINUTE_MS }).candidates).toHaveLength(1);
  });

  it("holds an agent inside its cooldown and releases it after", () => {
    const cooldowns = new Map([["leader-1", NOW + 5 * MINUTE_MS]]);
    expect(plan([rescued()], { cooldowns }).candidates).toEqual([]);
    expect(plan([rescued()], { cooldowns, nowMs: NOW + 6 * MINUTE_MS }).candidates).toHaveLength(1);
  });

  it("leaves a retired predecessor alone, label and all", () => {
    const retired = rescued({
      labels: {
        [ACCOUNT_FAILOVER_HOME_PROVIDER_LABEL]: "claude",
        [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: "successor-1",
      },
    });
    expect(plan([retired])).toEqual({ drops: [], candidates: [] });
  });

  it("drops a home label that points at the account the agent is already on", () => {
    const home = rescued({ provider: "claude" });
    expect(plan([home])).toEqual({
      drops: [{ agentId: "leader-1", homeProviderId: "claude", reason: "already-home" }],
      candidates: [],
    });
  });

  it("drops a home account that left the pool or was disabled", () => {
    expect(plan([rescued()], { poolEntries: POOL.slice(1) }).drops).toEqual([
      { agentId: "leader-1", homeProviderId: "claude", reason: "not-in-pool" },
    ]);
    const disabled = POOL.map((entry) =>
      entry.providerId === "claude" ? { ...entry, enabled: false } : entry,
    );
    expect(plan([rescued()], { poolEntries: disabled }).drops).toEqual([
      { agentId: "leader-1", homeProviderId: "claude", reason: "provider-disabled" },
    ]);
  });

  it("drops a home account nobody is signed into any more", () => {
    const accounts = new Map<string, AgentAccountAuth | null>([
      ["claude", { state: "signed-out", signInCommand: "claude /login" }],
    ]);
    expect(plan([rescued()], { accounts }).drops).toEqual([
      { agentId: "leader-1", homeProviderId: "claude", reason: "signed-out" },
    ]);
  });

  it("drops a home account that turns out to be the account the agent is on", () => {
    // Tyler's live shape: two CLAUDE_CONFIG_DIRs, one login. The two providers report the same
    // windows because they are the same windows, so there is nothing to go back to.
    const oneAccount: AgentAccountAuth = { state: "signed-in", accountLabel: "tyler@example.com" };
    const accounts = new Map<string, AgentAccountAuth | null>([
      ["claude", oneAccount],
      ["claude-personal", { ...oneAccount }],
    ]);
    expect(plan([rescued()], { accounts })).toEqual({
      drops: [{ agentId: "leader-1", homeProviderId: "claude", reason: "same-account" }],
      candidates: [],
    });
  });

  it("drops a busy agent's dead home label without waiting for it to go quiet", () => {
    // A wrong pointer is wrong whatever the agent is doing, and nothing is moved to fix it.
    const busy = rescued({ lifecycle: "running", busy: true });
    expect(plan([busy], { poolEntries: POOL.slice(1) }).drops).toHaveLength(1);
  });

  it("never returns a root to a worker: roots stay on the leader account", () => {
    // Tyler's own sessions belong on the leader account. A root that was moved there off an
    // exhausted worker has nothing to go back for, so the label goes.
    const root = rescued({
      provider: "claude",
      labels: { [ACCOUNT_FAILOVER_HOME_PROVIDER_LABEL]: "claude-backup" },
    });
    expect(plan([root])).toEqual({
      drops: [
        { agentId: "leader-1", homeProviderId: "claude-backup", reason: "root-belongs-on-leader" },
      ],
      candidates: [],
    });
  });

  it("returns a child on the leader account to its own worker first, then any worker", () => {
    const child = rescued({
      id: "child-1",
      provider: "claude",
      labels: {
        [PARENT_AGENT_ID_LABEL]: "leader-1",
        [ACCOUNT_FAILOVER_HOME_PROVIDER_LABEL]: "claude-backup",
      },
    });

    expect(plan([child]).candidates).toEqual([
      expect.objectContaining({
        agentId: "child-1",
        fromProviderId: "claude",
        homeProviderId: "claude-backup",
        targetProviderIds: ["claude-backup", "claude-personal"],
      }),
    ]);
    // Home is still out for the week, but claude-personal has budget: isolation comes back now.
    expect(
      plan([child], { deadProviderIds: new Set(["claude-backup"]) }).candidates[0]
        ?.targetProviderIds,
    ).toEqual(["claude-personal"]);
    // No worker can take it yet: it waits on the leader account, label kept.
    expect(
      plan([child], { deadProviderIds: new Set(["claude-backup", "claude-personal"]) }),
    ).toEqual({ drops: [], candidates: [] });
  });

  it("orders the other workers by budget left", () => {
    const pool: AccountPoolProviderEntry[] = [
      ...POOL,
      { providerId: "claude-spare", role: "worker", priority: 3, enabled: true },
    ];
    const child = rescued({
      id: "child-1",
      provider: "claude",
      labels: {
        [PARENT_AGENT_ID_LABEL]: "leader-1",
        [ACCOUNT_FAILOVER_HOME_PROVIDER_LABEL]: "claude-backup",
      },
    });
    const headroom = new Map([
      ["claude-personal", 10],
      ["claude-spare", 80],
    ]);
    expect(
      plan([child], { poolEntries: pool, headroom, deadProviderIds: new Set(["claude-backup"]) })
        .candidates[0]?.targetProviderIds,
    ).toEqual(["claude-spare", "claude-personal"]);
  });

  it("keeps a child that is already on a worker off the leader account", () => {
    const child = rescued({
      id: "child-1",
      provider: "claude-personal",
      labels: {
        [PARENT_AGENT_ID_LABEL]: "leader-1",
        [ACCOUNT_FAILOVER_HOME_PROVIDER_LABEL]: "claude",
      },
    });
    expect(plan([child])).toEqual({
      drops: [{ agentId: "child-1", homeProviderId: "claude", reason: "child-belongs-on-worker" }],
      candidates: [],
    });
  });

  it("does nothing at all when the return leg is switched off", () => {
    const off = resolveReturnConfig({ returnHome: false });
    expect(plan([rescued(), rescued({ id: "x", provider: "claude" })], { config: off })).toEqual({
      drops: [],
      candidates: [],
    });
  });
});

describe("homeReturnBlockedReason", () => {
  it("passes a fresh read of a quiet account", () => {
    expect(health()).toBeNull();
  });

  it("refuses to act on a read it cannot trust", () => {
    expect(health({ usage: null })).toBe("usage is unreadable");
    expect(health({ fetchedAtMs: null })).toBe("the usage read has no timestamp");
    // The service caches for ~5 minutes; a read from before the window rolled proves nothing.
    expect(health({ fetchedAtMs: NOW - 10 * MINUTE_MS })).toBe("the usage read is stale");
    expect(health({ usage: [] })).toBe("there is no usage row for it");
  });

  it("requires positive evidence, unlike the choice of a rescue target", () => {
    // A worker whose usage is unreadable is still somewhere to be rescued to. It is never
    // somewhere to be returned to.
    expect(health({ usage: [usageRow("claude", [], "unavailable")] })).toBe(
      "its usage reports unavailable",
    );
    expect(health({ usage: [usageRow("claude", [])] })).toBe("it reports no usage window");
    expect(health({ usage: [usageRow("claude", [{ usedPct: null }])] })).toBe(
      'window "window-0" has no utilization',
    );
  });

  it("wants real headroom, not merely a window under its cap", () => {
    expect(health({ usage: [usageRow("claude", [{ usedPct: 50 }])] })).toBeNull();
    expect(health({ usage: [usageRow("claude", [{ usedPct: 51 }])] })).toBe(
      'window "window-0" is at 51%',
    );
    // Every window has to be clear, not just the first.
    expect(health({ usage: [usageRow("claude", [{ usedPct: 4 }, { usedPct: 96 }])] })).toBe(
      'window "window-1" is at 96%',
    );
  });

  it("treats a reset that already passed as a stale row, not as proof of a reset", () => {
    expect(
      health({
        usage: [
          usageRow("claude", [{ usedPct: 4, resetsAt: new Date(NOW - MINUTE_MS).toISOString() }]),
        ],
      }),
    ).toBe('window "window-0" reports a reset that already passed');
    expect(
      health({
        usage: [
          usageRow("claude", [
            { usedPct: 4, resetsAt: new Date(NOW + 60 * MINUTE_MS).toISOString() },
          ]),
        ],
      }),
    ).toBeNull();
  });
});

describe("resolveReturnConfig", () => {
  it("defaults to the round trip being on, with the documented hysteresis", () => {
    expect(resolveReturnConfig(undefined)).toEqual({
      enabled: true,
      maxHomeUsedPct: 50,
      minIdleMs: 10 * MINUTE_MS,
      cooldownMs: 5 * 60 * MINUTE_MS,
      retryBackoffMs: 60 * MINUTE_MS,
      maxUsageAgeMs: 2 * MINUTE_MS,
    });
  });

  it("takes every knob in minutes, and ignores a value that makes no sense", () => {
    expect(
      resolveReturnConfig({
        returnMaxHomeUsedPct: 10,
        returnMinIdleMinutes: 30,
        returnCooldownMinutes: 0,
        returnRetryBackoffMinutes: -5,
      }),
    ).toMatchObject({
      maxHomeUsedPct: 10,
      minIdleMs: 30 * MINUTE_MS,
      // Zero is a real answer (no cooldown); a negative one is not, so it falls back.
      cooldownMs: 0,
      retryBackoffMs: 60 * MINUTE_MS,
    });
  });
});
