import { describe, expect, it } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import type { AccountFailoverAgentSummary } from "./agent-manager.js";
import type { AgentAccountAuth } from "./agent-sdk-types.js";
import { ACCOUNT_FAILOVER_MIGRATED_TO_LABEL } from "./account-failover-detector.js";
import type { AccountPoolProviderEntry } from "./account-pool-providers.js";
import {
  planSettleBacks,
  SETTLE_BACK_MIN_IDLE_MS,
  type PlanSettleBacksInput,
  type SettleBackEpisode,
} from "./account-failover-settle-back.js";

const NOW = Date.parse("2026-10-01T18:00:00.000Z");
const MINUTE_MS = 60 * 1000;

const POOL: AccountPoolProviderEntry[] = [
  { providerId: "claude", role: "leader", priority: 1, enabled: true },
  { providerId: "claude-personal", role: "worker", priority: 1, enabled: true },
  { providerId: "claude-backup", role: "worker", priority: 2, enabled: true },
];

/**
 * The 2026-10-01 shape: the orchestrator's root, rescued onto `claude-backup` while the leader
 * account was out, sitting between turns now that the leader account has budget again.
 */
function root(overrides: Partial<AccountFailoverAgentSummary> = {}): AccountFailoverAgentSummary {
  return {
    id: "root-1",
    provider: "claude-backup",
    cwd: "/tmp/work",
    workspaceId: "ws-1",
    internal: false,
    lifecycle: "idle",
    lastError: undefined,
    title: "Orchestrator",
    busy: false,
    pendingPermissionCount: 0,
    lastActivityAt: new Date(NOW - 10 * MINUTE_MS).toISOString(),
    timelineSeq: 40,
    lastTimelineAt: new Date(NOW - 10 * MINUTE_MS).toISOString(),
    labels: {},
    sessionId: "session-root-1",
    model: "claude-opus-5-5",
    modeId: "bypassPermissions",
    thinkingOptionId: "max",
    ...overrides,
  };
}

function windows(providerId: string, usedPcts: Record<string, number | null>): ProviderUsage {
  return {
    providerId,
    displayName: providerId,
    status: "available",
    planLabel: null,
    windows: Object.entries(usedPcts).map(([id, usedPct]) => ({
      id,
      label: id,
      usedPct,
      remainingPct: usedPct === null ? null : 100 - usedPct,
      resetsAt: null,
    })),
    balances: [],
    details: [],
    error: null,
  };
}

/** The leader account after its weekly reset: plenty of room on every window. */
const RECOVERED_LEADER = windows("claude", { five_hour: 10, weekly: 20, weekly_model_opus: 15 });

function input(overrides: Partial<PlanSettleBacksInput> = {}): PlanSettleBacksInput {
  return {
    agents: [root()],
    poolEntries: POOL,
    deadProviderIds: new Set(),
    cappedModelWindows: new Map(),
    accounts: new Map(),
    usage: { providers: [RECOVERED_LEADER], fetchedAtMs: NOW - MINUTE_MS },
    episodes: new Map(),
    attempts: new Map(),
    backoffs: new Map(),
    nowMs: NOW,
    ...overrides,
  };
}

function settled(overrides: Partial<PlanSettleBacksInput> = {}): Array<[string, string]> {
  return planSettleBacks(input(overrides)).candidates.map((candidate) => [
    candidate.agent.id,
    candidate.targetProviderId,
  ]);
}

describe("planSettleBacks", () => {
  it("settles an idle root on a worker back onto the leader account once it has budget", () => {
    expect(settled()).toEqual([["root-1", "claude"]]);
  });

  it("never moves a child back: its rebuild is the cost the rule exists to avoid", () => {
    const child = root({ id: "child-1", labels: { [PARENT_AGENT_ID_LABEL]: "root-0" } });
    expect(settled({ agents: [child] })).toEqual([]);
  });

  it("leaves a root already on the leader account, or outside the pool, where it is", () => {
    expect(settled({ agents: [root({ provider: "claude" })] })).toEqual([]);
    expect(settled({ agents: [root({ provider: "codex" })] })).toEqual([]);
  });

  it("leaves an internal agent alone", () => {
    expect(settled({ agents: [root({ internal: true })] })).toEqual([]);
  });

  it.each([
    ["running", root({ lifecycle: "running" })],
    ["initializing", root({ lifecycle: "initializing" })],
    ["in error", root({ lifecycle: "error" })],
    ["closed", root({ lifecycle: "closed" })],
    ["busy with a pending run", root({ busy: true })],
    ["waiting on a permission", root({ pendingPermissionCount: 1 })],
    ["without a provider session", root({ sessionId: undefined })],
    ["retired", root({ labels: { [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: "root-2" } })],
  ])("leaves a root that is %s", (_state, agent) => {
    expect(settled({ agents: [agent] })).toEqual([]);
  });

  it("leaves a root cut off by a cap to the rescue leg", () => {
    const capped = root({ lastError: "You've hit your weekly limit · resets 7am" });
    expect(settled({ agents: [capped] })).toEqual([]);
  });

  it("waits two quiet minutes, so a move never lands between two messages of a live exchange", () => {
    const justAnswered = root({ lastActivityAt: new Date(NOW - 90 * 1000).toISOString() });
    expect(settled({ agents: [justAnswered] })).toEqual([]);

    const quietLongEnough = root({
      lastActivityAt: new Date(NOW - SETTLE_BACK_MIN_IDLE_MS).toISOString(),
    });
    expect(settled({ agents: [quietLongEnough] })).toEqual([["root-1", "claude"]]);
  });

  it("treats a root with no readable activity time as not quiet", () => {
    expect(settled({ agents: [root({ lastActivityAt: null })] })).toEqual([]);
  });

  it("leaves a root on a dead worker to the idle leg, which moves it off as a rescue", () => {
    expect(settled({ deadProviderIds: new Set(["claude-backup"]) })).toEqual([]);
    expect(
      settled({ cappedModelWindows: new Map([["claude-backup", ["weekly_model_opus"]]]) }),
    ).toEqual([]);
  });

  it("holds a root in its refusal backoff, and tries again once it has passed", () => {
    const backoffs = new Map([["root-1", NOW + MINUTE_MS]]);
    expect(settled({ backoffs })).toEqual([]);
    expect(settled({ backoffs, nowMs: NOW + MINUTE_MS })).toEqual([["root-1", "claude"]]);
  });

  describe("the leader account's headroom", () => {
    it("is not there while the leader account is dead this sweep", () => {
      expect(settled({ deadProviderIds: new Set(["claude"]) })).toEqual([]);
    });

    it("is not there on a disabled leader entry", () => {
      const disabledLeader: AccountPoolProviderEntry = {
        providerId: "claude",
        role: "leader",
        priority: 1,
        enabled: false,
      };
      expect(settled({ poolEntries: [disabledLeader, ...POOL.slice(1)] })).toEqual([]);
    });

    it("buys nothing when the leader entry is the same Claude login as the worker", () => {
      const shared: AgentAccountAuth = { state: "signed-in", accountLabel: "someone@example.com" };
      const accounts = new Map<string, AgentAccountAuth | null>([
        ["claude", shared],
        ["claude-backup", { ...shared }],
      ]);
      expect(settled({ accounts })).toEqual([]);

      const separate = new Map<string, AgentAccountAuth | null>([
        ["claude", shared],
        ["claude-backup", { state: "signed-in", accountLabel: "backup@example.com" }],
      ]);
      expect(settled({ accounts: separate })).toEqual([["root-1", "claude"]]);
    });

    it("has to be proven: unreadable, unavailable, missing or empty usage settles nobody back", () => {
      expect(settled({ usage: null })).toEqual([]);
      expect(settled({ usage: { providers: [], fetchedAtMs: NOW } })).toEqual([]);
      expect(
        settled({
          usage: {
            providers: [{ ...RECOVERED_LEADER, status: "unavailable", windows: [] }],
            fetchedAtMs: NOW,
          },
        }),
      ).toEqual([]);
      expect(
        settled({
          usage: { providers: [{ ...RECOVERED_LEADER, status: "error" }], fetchedAtMs: NOW },
        }),
      ).toEqual([]);
      expect(settled({ usage: { providers: [windows("claude", {})], fetchedAtMs: NOW } })).toEqual(
        [],
      );
      expect(
        settled({
          usage: {
            providers: [windows("claude", { five_hour: 10, weekly: null })],
            fetchedAtMs: NOW,
          },
        }),
      ).toEqual([]);
    });

    it("has to be fresh: a read older than ten minutes, or undated, settles nobody back", () => {
      const read = (fetchedAtMs: number | null) => ({
        usage: { providers: [RECOVERED_LEADER], fetchedAtMs },
      });
      expect(settled(read(NOW - 10 * MINUTE_MS))).toEqual([["root-1", "claude"]]);
      expect(settled(read(NOW - 10 * MINUTE_MS - 1))).toEqual([]);
      expect(settled(read(null))).toEqual([]);
    });

    it("needs every weekly window under 90%", () => {
      const at = (weekly: number) => ({
        usage: {
          providers: [windows("claude", { five_hour: 10, weekly })],
          fetchedAtMs: NOW,
        },
      });
      expect(settled(at(89))).toEqual([["root-1", "claude"]]);
      expect(settled(at(90))).toEqual([]);
    });

    it("needs the session window under 80%", () => {
      const at = (fiveHour: number) => ({
        usage: {
          providers: [windows("claude", { five_hour: fiveHour, weekly: 20 })],
          fetchedAtMs: NOW,
        },
      });
      expect(settled(at(79))).toEqual([["root-1", "claude"]]);
      expect(settled(at(80))).toEqual([]);
    });

    it("counts a model's weekly window only against roots on that model", () => {
      const opus = root({ id: "opus-root", model: "claude-opus-5-5" });
      const sonnet = root({ id: "sonnet-root", model: "claude-sonnet-5" });
      const unknown = root({ id: "unknown-root", model: undefined });
      const usage = {
        providers: [windows("claude", { five_hour: 10, weekly: 20, weekly_model_opus: 95 })],
        fetchedAtMs: NOW,
      };

      expect(settled({ agents: [opus, sonnet, unknown], usage })).toEqual([
        ["sonnet-root", "claude"],
      ]);
    });
  });

  describe("recovery episodes", () => {
    /** One sweep carrying state forward, with every planned move counted as attempted. */
    function sweep(
      state: { episodes: Map<string, SettleBackEpisode>; attempts: Map<string, string> },
      overrides: Partial<PlanSettleBacksInput> = {},
    ): { settled: string[] } {
      const plan = planSettleBacks(
        input({ episodes: state.episodes, attempts: state.attempts, ...overrides }),
      );
      for (const candidate of plan.candidates) {
        state.attempts.set(candidate.agent.id, candidate.episode);
      }
      state.episodes = plan.episodes;
      return { settled: plan.candidates.map((candidate) => candidate.agent.id) };
    }

    it("tries a root once per episode, whether or not the move worked", () => {
      const state = { episodes: new Map(), attempts: new Map<string, string>() };
      expect(sweep(state).settled).toEqual(["root-1"]);
      // The move was refused or failed, and the backoff has passed: still the same episode.
      const later = NOW + 2 * 60 * MINUTE_MS;
      const freshRead = { providers: [RECOVERED_LEADER], fetchedAtMs: later };
      expect(sweep(state, { nowMs: later, usage: freshRead }).settled).toEqual([]);
    });

    it("starts a new episode after the leader account was unusable, and tries once more", () => {
      // The ping-pong bound: the root went back, ran the leader account dry, and was rescued
      // onto a worker. While the leader is out nothing moves; once it recovers, one more try.
      const state = { episodes: new Map(), attempts: new Map<string, string>() };
      expect(sweep(state).settled).toEqual(["root-1"]);
      expect(sweep(state, { deadProviderIds: new Set(["claude"]) }).settled).toEqual([]);
      expect(sweep(state).settled).toEqual(["root-1"]);
      expect(sweep(state).settled).toEqual([]);
    });

    it("ends an episode on any sweep the leader fails the gate, unreadable usage included", () => {
      const state = { episodes: new Map(), attempts: new Map<string, string>() };
      expect(sweep(state).settled).toEqual(["root-1"]);
      expect(sweep(state, { usage: null }).settled).toEqual([]);
      expect(sweep(state).settled).toEqual(["root-1"]);
    });

    it("keeps watching the leader on sweeps where nobody can move", () => {
      // The root is busy across the leader's cap and recovery. The episode boundary still has
      // to be seen, or the root would never be tried again.
      const state = { episodes: new Map(), attempts: new Map<string, string>() };
      expect(sweep(state).settled).toEqual(["root-1"]);
      const busy = [root({ lifecycle: "running" })];
      expect(sweep(state, { agents: busy, deadProviderIds: new Set(["claude"]) }).settled).toEqual(
        [],
      );
      expect(sweep(state, { agents: busy }).settled).toEqual([]);
      expect(sweep(state).settled).toEqual(["root-1"]);
    });

    it("scopes an episode to the model family a weekly model window stops", () => {
      // An Opus cap on the leader account ends the Opus roots' episode and not the Sonnet roots'.
      const state = { episodes: new Map(), attempts: new Map<string, string>() };
      const opus = root({ id: "opus-root", model: "claude-opus-5-5" });
      const sonnet = root({ id: "sonnet-root", model: "claude-sonnet-5" });
      expect(sweep(state, { agents: [opus, sonnet] }).settled).toEqual([
        "opus-root",
        "sonnet-root",
      ]);

      const opusCapped = {
        providers: [windows("claude", { five_hour: 10, weekly: 20, weekly_model_opus: 100 })],
        fetchedAtMs: NOW,
      };
      expect(sweep(state, { agents: [opus, sonnet], usage: opusCapped }).settled).toEqual([]);
      expect(sweep(state, { agents: [opus, sonnet] }).settled).toEqual(["opus-root"]);
    });
  });
});
