import { describe, expect, it } from "vitest";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AccountFailoverAgentSummary } from "./agent-manager.js";
import {
  ACCOUNT_FAILOVER_MIGRATED_TO_LABEL,
  getMigratedToFromLabels,
  isLimitShapedError,
  parseResetTimeHint,
  planAccountFailoverSweep,
  type LimitErrorSighting,
  type PlanAccountFailoverSweepInput,
} from "./account-failover-detector.js";

const REAL_LIMIT_MESSAGE =
  "You've hit your monthly spend limit · raise it at " +
  "claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets " +
  "3:10pm (America/Los_Angeles)";

const TTL_MS = 60 * 60 * 1000;
const POOL = new Set(["claude", "claude-personal", "claude-backup"]);

function agent(
  overrides: Partial<AccountFailoverAgentSummary> & Pick<AccountFailoverAgentSummary, "id">,
): AccountFailoverAgentSummary {
  return {
    provider: "claude",
    cwd: "/tmp/work",
    workspaceId: "ws-1",
    internal: false,
    lifecycle: "error",
    lastError: undefined,
    title: `Agent ${overrides.id}`,
    busy: false,
    pendingPermissionCount: 0,
    lastActivityAt: null,
    timelineSeq: 7,
    lastTimelineAt: null,
    labels: {},
    sessionId: `session-${overrides.id}`,
    model: "claude-opus-5",
    modeId: "bypassPermissions",
    thinkingOptionId: "max",
    ...overrides,
  };
}

function usage(providerId: string, usedPcts: Array<number | null>): ProviderUsage {
  return {
    providerId,
    displayName: providerId,
    status: "available",
    planLabel: null,
    windows: usedPcts.map((usedPct, index) => ({
      id: `window-${index}`,
      label: `Window ${index}`,
      usedPct,
      remainingPct: usedPct === null ? null : Math.max(0, 100 - usedPct),
      resetsAt: null,
    })),
    balances: [],
    details: [],
    error: null,
  };
}

function plan(overrides: Partial<PlanAccountFailoverSweepInput>) {
  return planAccountFailoverSweep({
    poolProviderIds: POOL,
    agents: [],
    usage: [],
    previousSightings: new Map(),
    previousProviderSightings: new Map(),
    nowMs: 1_000_000,
    reactiveSignalTtlMs: TTL_MS,
    migrateSubagents: true,
    ...overrides,
  });
}

function ids(agents: readonly AccountFailoverAgentSummary[]): string[] {
  return agents.map((entry) => entry.id);
}

describe("isLimitShapedError", () => {
  it("matches the real observed Claude CLI spend-limit message", () => {
    expect(isLimitShapedError(REAL_LIMIT_MESSAGE)).toBe(true);
  });

  it("matches generic limit/quota/credits phrasing, case-insensitively", () => {
    expect(isLimitShapedError("You've hit your limit for this account.")).toBe(true);
    expect(isLimitShapedError("429 RATE LIMIT exceeded")).toBe(true);
    expect(isLimitShapedError("weekly usage limit reached")).toBe(true);
    expect(isLimitShapedError("quota exceeded for this billing period")).toBe(true);
    expect(isLimitShapedError("you are out of credits")).toBe(true);
  });

  it("matches every distinct cap message the CLI wrote into real transcripts", () => {
    // The weekly cap is the one that stranded agents on 2026-09-18, and it names neither "hit your
    // limit" nor "usage limit" nor "session limit": it is "hit your weekly limit".
    expect(
      isLimitShapedError("You've hit your weekly limit · resets 7am (America/Los_Angeles)"),
    ).toBe(true);
    expect(
      isLimitShapedError("You've hit your session limit · resets 5:20pm (America/Los_Angeles)"),
    ).toBe(true);
    expect(
      isLimitShapedError(
        "You've hit your monthly spend limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.",
      ),
    ).toBe(true);
    expect(isLimitShapedError("You've hit your Opus limit · resets 9pm")).toBe(true);
  });

  it("matches the error the stalled-agent sweep leaves when it cancels a dead turn", () => {
    // Workstream S cancels a turn stuck in running on a capped account and leaves this lastError
    // so failover resumes the agent as cut off mid-turn. Its wording may change; its shape — it
    // names the account and the stall and says the account is at its limit — is the contract.
    expect(
      isLimitShapedError(
        "Account claude-backup is at its usage limit or unusable, and this turn stalled in " +
          "running with no activity; the daemon canceled it so account failover can move the agent.",
      ),
    ).toBe(true);
  });

  it("does not match the other API errors that now end a turn as a failure", () => {
    expect(isLimitShapedError("API Error: 529 Overloaded. This is a server-side issue.")).toBe(
      false,
    );
    expect(isLimitShapedError("Not logged in · Please run /login")).toBe(false);
    expect(isLimitShapedError("Prompt is too long")).toBe(false);
  });

  it("does not match unrelated turn failures or absent text", () => {
    expect(isLimitShapedError("ENOTFOUND: could not resolve host")).toBe(false);
    expect(isLimitShapedError("Permission denied for tool call")).toBe(false);
    expect(isLimitShapedError(undefined)).toBe(false);
    expect(isLimitShapedError(null)).toBe(false);
    expect(isLimitShapedError("")).toBe(false);
  });
});

describe("parseResetTimeHint", () => {
  it("extracts the reset clause from the real observed message", () => {
    expect(parseResetTimeHint(REAL_LIMIT_MESSAGE)).toBe("3:10pm (America/Los_Angeles)");
  });

  it("returns null when there is no reset clause, and never throws", () => {
    expect(parseResetTimeHint("You've hit your limit for this account.")).toBeNull();
    expect(parseResetTimeHint("resets")).toBeNull();
    expect(parseResetTimeHint(undefined)).toBeNull();
  });
});

describe("getMigratedToFromLabels", () => {
  it("returns the successor id only when the label is non-empty", () => {
    expect(getMigratedToFromLabels({ [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: "agent-456" })).toBe(
      "agent-456",
    );
    expect(getMigratedToFromLabels({ [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: "  " })).toBeNull();
    expect(getMigratedToFromLabels({})).toBeNull();
    expect(getMigratedToFromLabels(undefined)).toBeNull();
  });
});

describe("planAccountFailoverSweep", () => {
  it("treats the pool leader account like any other: its capped agents are candidates", () => {
    const leader = agent({ id: "leader", provider: "claude", lastError: REAL_LIMIT_MESSAGE });

    const result = plan({ agents: [leader] });

    expect([...result.deadProviderIds]).toEqual(["claude"]);
    expect(ids(result.candidates)).toEqual(["leader"]);
  });

  it("takes an agent the stalled-agent sweep cancelled: idle, with its limit-shaped error", () => {
    // The cancel lands the agent idle, not in error. Its lastError is what makes it a turn cut
    // off mid-way, so it is moved and resumed like any other capped agent.
    const stalled = agent({
      id: "stalled",
      provider: "claude-backup",
      lifecycle: "idle",
      lastError:
        "Account claude-backup is at its usage limit or unusable, and this turn stalled in " +
        "running with no activity; the daemon canceled it so account failover can move the agent.",
    });

    const result = plan({ agents: [stalled] });

    expect([...result.deadProviderIds]).toEqual(["claude-backup"]);
    expect(ids(result.candidates)).toEqual(["stalled"]);
  });

  it("takes an agent in error on a dead account even when the error is not limit-shaped", () => {
    // Its turn ended while its account was out; whatever the text, it is resumed where it can run.
    const errored = agent({ id: "errored", provider: "claude-backup", lastError: "stream closed" });
    const idle = agent({ id: "idle", provider: "claude-backup", lifecycle: "idle" });

    const dead = plan({ agents: [errored, idle], usage: [usage("claude-backup", [100])] });
    expect(ids(dead.candidates)).toEqual(["errored"]);
    // It does not condemn the account by itself: only a limit-shaped error does.
    const alive = plan({ agents: [errored] });
    expect(alive.deadProviderIds.size).toBe(0);
    expect(alive.candidates).toEqual([]);
  });

  it("keeps an account dead on evidence a move left behind, until the TTL runs out", () => {
    const left = new Map([
      ["claude-personal", { error: REAL_LIMIT_MESSAGE, firstSeenMs: 900_000 }],
    ]);

    const fresh = plan({ previousProviderSightings: left, nowMs: 1_000_000 });
    expect([...fresh.deadProviderIds]).toEqual(["claude-personal"]);
    expect(fresh.providerSightings.get("claude-personal")?.firstSeenMs).toBe(900_000);

    const expired = plan({ previousProviderSightings: left, nowMs: 900_000 + TTL_MS });
    expect(expired.deadProviderIds.size).toBe(0);
    expect(expired.providerSightings.size).toBe(0);
  });

  it("ignores evidence left on a provider that is no longer in the pool", () => {
    const left = new Map([
      ["retired-account", { error: REAL_LIMIT_MESSAGE, firstSeenMs: 999_000 }],
    ]);

    const result = plan({ previousProviderSightings: left });

    expect(result.deadProviderIds.size).toBe(0);
    expect(result.providerSightings.has("retired-account")).toBe(true);
  });

  it("does not treat an unavailable provider with no windows as dead", () => {
    const unreadable: ProviderUsage = {
      ...usage("claude-personal", []),
      status: "unavailable",
    };

    const result = plan({ usage: [unreadable] });

    expect(result.deadProviderIds.size).toBe(0);
  });

  it("marks a provider dead when any usage window is at or over 100%", () => {
    const result = plan({
      usage: [
        usage("claude-personal", [40, 100]),
        usage("claude-backup", [99.9, null]),
        usage("codex", [100]),
      ],
    });

    expect([...result.deadProviderIds]).toEqual(["claude-personal"]);
  });

  it("never makes an idle agent without its own limit failure a candidate, but takes one in error", () => {
    const failed = agent({ id: "failed", lastError: REAL_LIMIT_MESSAGE });
    const idle = agent({ id: "idle", lifecycle: "idle", lastError: undefined });
    const otherError = agent({ id: "other", lastError: "ECONNRESET" });

    const result = plan({ agents: [failed, idle, otherError] });

    // "other" is in error on the account "failed" condemned, so it is resumed too.
    expect(ids(result.candidates)).toEqual(["failed", "other"]);
  });

  it("accepts idle and error lifecycles, never running, closed, or initializing", () => {
    const lifecycles = ["idle", "error", "running", "closed", "initializing"] as const;
    const agents = lifecycles.map((lifecycle) =>
      agent({ id: lifecycle, lifecycle, lastError: REAL_LIMIT_MESSAGE }),
    );

    const result = plan({ agents });

    expect(ids(result.candidates)).toEqual(["idle", "error"]);
  });

  it("drops a running agent's sighting so a later failure counts as fresh", () => {
    const previousSightings = new Map<string, LimitErrorSighting>([
      ["a", { error: REAL_LIMIT_MESSAGE, timelineSeq: 7, firstSeenMs: 0 }],
    ]);
    const running = agent({ id: "a", lifecycle: "running", lastError: REAL_LIMIT_MESSAGE });

    const whileRunning = plan({ agents: [running], previousSightings, nowMs: 10 * TTL_MS });
    expect(whileRunning.sightings.has("a")).toBe(false);
    expect(whileRunning.deadProviderIds.size).toBe(0);

    const failedAgain = plan({
      agents: [{ ...running, lifecycle: "error" }],
      previousSightings: whileRunning.sightings,
      nowMs: 10 * TTL_MS,
    });
    expect(failedAgain.sightings.get("a")).toEqual({
      error: REAL_LIMIT_MESSAGE,
      timelineSeq: 7,
      firstSeenMs: 10 * TTL_MS,
    });
    expect(ids(failedAgain.candidates)).toEqual(["a"]);
  });

  it("keeps a retired predecessor's failure as evidence but never makes it a candidate", () => {
    const retired = agent({
      id: "retired",
      provider: "claude-personal",
      lastError: REAL_LIMIT_MESSAGE,
      labels: { [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: "successor" },
    });

    const result = plan({ agents: [retired] });

    expect([...result.deadProviderIds]).toEqual(["claude-personal"]);
    expect(result.candidates).toEqual([]);
  });

  it("treats identical failure text after new timeline activity as a fresh sighting", () => {
    const previousSightings = new Map<string, LimitErrorSighting>([
      ["a", { error: REAL_LIMIT_MESSAGE, timelineSeq: 7, firstSeenMs: 0 }],
    ]);

    const untouched = plan({
      agents: [agent({ id: "a", lastError: REAL_LIMIT_MESSAGE, timelineSeq: 7 })],
      previousSightings,
      nowMs: 2 * TTL_MS,
    });
    expect(untouched.candidates).toEqual([]);

    const retried = plan({
      agents: [agent({ id: "a", lastError: REAL_LIMIT_MESSAGE, timelineSeq: 9 })],
      previousSightings,
      nowMs: 2 * TTL_MS,
    });
    expect(retried.sightings.get("a")?.firstSeenMs).toBe(2 * TTL_MS);
    expect(ids(retried.candidates)).toEqual(["a"]);
  });

  it("stops trusting a stale reactive signal after the TTL unless usage corroborates it", () => {
    const stale = agent({ id: "stale", lastError: REAL_LIMIT_MESSAGE });
    const previousSightings = new Map<string, LimitErrorSighting>([
      ["stale", { error: REAL_LIMIT_MESSAGE, timelineSeq: 7, firstSeenMs: 0 }],
    ]);

    const expired = plan({ agents: [stale], previousSightings, nowMs: TTL_MS });
    expect(expired.deadProviderIds.size).toBe(0);
    expect(expired.candidates).toEqual([]);
    expect(expired.sightings.get("stale")?.firstSeenMs).toBe(0);

    const corroborated = plan({
      agents: [stale],
      previousSightings,
      nowMs: TTL_MS,
      usage: [usage("claude", [100])],
    });
    expect(ids(corroborated.candidates)).toEqual(["stale"]);
  });

  it("dates a new sighting by the agent's last timeline row, clamped to now", () => {
    const nowMs = Date.parse("2026-09-16T12:00:00.000Z");
    const failedEarlier = agent({
      id: "earlier",
      lastError: REAL_LIMIT_MESSAGE,
      lastTimelineAt: "2026-09-16T11:30:00.000Z",
    });
    const clockSkewed = agent({
      id: "skewed",
      lastError: REAL_LIMIT_MESSAGE,
      lastTimelineAt: "2026-09-16T13:00:00.000Z",
    });
    const undated = agent({ id: "undated", lastError: REAL_LIMIT_MESSAGE, lastTimelineAt: "junk" });

    const result = plan({ agents: [failedEarlier, clockSkewed, undated], nowMs });

    expect(result.sightings.get("earlier")?.firstSeenMs).toBe(nowMs - 30 * 60 * 1000);
    expect(result.sightings.get("skewed")?.firstSeenMs).toBe(nowMs);
    expect(result.sightings.get("undated")?.firstSeenMs).toBe(nowMs);
  });

  it("ignores an old failure seen for the first time, e.g. after a daemon restart", () => {
    const nowMs = Date.parse("2026-09-16T12:00:00.000Z");
    const abandoned = agent({
      id: "abandoned",
      lastError: REAL_LIMIT_MESSAGE,
      lastTimelineAt: "2026-09-10T08:00:00.000Z",
    });

    const result = plan({ agents: [abandoned], nowMs });

    expect(result.deadProviderIds.size).toBe(0);
    expect(result.candidates).toEqual([]);
  });

  it("keeps first-seen time for an unchanged error and resets it when the text changes", () => {
    const previousSightings = new Map<string, LimitErrorSighting>([
      ["a", { error: "rate limit exceeded", timelineSeq: 7, firstSeenMs: 5 }],
    ]);

    const same = plan({
      agents: [agent({ id: "a", lastError: "rate limit exceeded" })],
      previousSightings,
      nowMs: 50,
    });
    expect(same.sightings.get("a")?.firstSeenMs).toBe(5);

    const changed = plan({
      agents: [agent({ id: "a", lastError: REAL_LIMIT_MESSAGE })],
      previousSightings,
      nowMs: 50,
    });
    expect(changed.sightings.get("a")?.firstSeenMs).toBe(50);
  });

  it("leaves subagents alone when migrateSubagents is off", () => {
    const leader = agent({ id: "leader", lastError: REAL_LIMIT_MESSAGE });
    const sub = agent({
      id: "sub",
      lastError: REAL_LIMIT_MESSAGE,
      labels: { [PARENT_AGENT_ID_LABEL]: "leader" },
    });

    expect(ids(plan({ agents: [leader, sub] }).candidates)).toEqual(["leader", "sub"]);
    expect(ids(plan({ agents: [leader, sub], migrateSubagents: false }).candidates)).toEqual([
      "leader",
    ]);
  });

  it("ignores internal agents and providers outside the pool", () => {
    const internal = agent({ id: "internal", internal: true, lastError: REAL_LIMIT_MESSAGE });
    const outside = agent({ id: "outside", provider: "codex", lastError: REAL_LIMIT_MESSAGE });

    const result = plan({ agents: [internal, outside] });

    expect(result.deadProviderIds.size).toBe(0);
    expect(result.candidates).toEqual([]);
  });

  it("counts an agent with no session as evidence but never as a candidate", () => {
    const sessionless = agent({
      id: "sessionless",
      sessionId: undefined,
      lastError: REAL_LIMIT_MESSAGE,
    });

    const result = plan({ agents: [sessionless] });

    expect([...result.deadProviderIds]).toEqual(["claude"]);
    expect(result.candidates).toEqual([]);
  });
});
