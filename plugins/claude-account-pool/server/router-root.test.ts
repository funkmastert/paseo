import { describe, expect, it, vi } from "vitest";
import type { PluginBeforeRequests, PluginHookContext } from "@getpaseo/plugin/server";
import { ACCOUNT_REROUTED_LABEL } from "../shared/role-policy-schema";
import type { ResolvedPool } from "../shared/pool-config";
import { createHealthTracker, type HealthTracker } from "./health";
import type { PoolCache } from "./pool";
import { createRouter, PoolExhaustedError, type ProviderIdCache, type RootRerouteEpisode } from "./router";
import { WINDOW_FIVE_HOUR, WINDOW_SEVEN_DAY, weeklyModelWindow } from "./windows";

/**
 * Root agents — the ones Tyler starts from the app — used to keep whatever account they were
 * started on, even one with nothing left. The app remembered `claude-backup` for new chats in
 * some workspaces, so two chats started on a weekly-capped account and died on their first turn
 * while the leader account sat at 42%. These cases pin the fix: a root whose account cannot run
 * the request starts where there is budget; a root whose account can is left alone.
 */

type CreateAgentRequest = PluginBeforeRequests["agent.create"];

const POOL: ResolvedPool = {
  workers: [
    { providerId: "claude-personal", priority: 1 },
    { providerId: "claude-backup", priority: 2 },
  ],
  leader: { providerId: "claude" },
};

const NOW = new Date("2026-09-24T22:00:00Z");
const WEEKLY_RESET = new Date("2026-09-26T06:00:00Z");

function fakePoolCache(pool: ResolvedPool = POOL): PoolCache {
  return { get: () => ({ pool, failOpen: false }), forceRefresh: vi.fn(), stop: vi.fn() };
}

function fakeProviderIds(ids: string[] | null = ["claude", "claude-personal", "claude-backup"]): ProviderIdCache {
  return { get: () => (ids === null ? null : new Set(ids)), forceRefresh: vi.fn(), stop: vi.fn() };
}

function tracker(): HealthTracker {
  return createHealthTracker({ now: () => NOW });
}

function rootCreate(provider: string, model?: string, extra: Record<string, unknown> = {}): { request: CreateAgentRequest } {
  return {
    request: {
      config: { provider, ...(model ? { model } : {}), cwd: "/tmp/work" },
      ...extra,
    } as unknown as CreateAgentRequest,
  };
}

const fakeContext = {} as PluginHookContext;

function labelsOf(result: CreateAgentRequest | void): Record<string, string> | undefined {
  return (result as { labels?: Record<string, string> } | undefined)?.labels;
}

function router(health: HealthTracker, extra: Partial<Parameters<typeof createRouter>[0]> = {}) {
  return createRouter({
    poolCache: fakePoolCache(),
    health,
    providerIds: fakeProviderIds(),
    now: () => NOW.getTime(),
    ...extra,
  });
}

describe("createRouter — root agents", () => {
  it("moves a root off a weekly-capped account onto the leader, and labels it", () => {
    const health = tracker();
    health.reportUsage("claude-backup", [{ window: WINDOW_SEVEN_DAY, usedPct: 100, resetsAt: WEEKLY_RESET }]);
    health.reportUsage("claude", [{ window: WINDOW_SEVEN_DAY, usedPct: 42 }]);
    health.reportUsage("claude-personal", [{ window: WINDOW_SEVEN_DAY, usedPct: 19 }]);
    const episodes: RootRerouteEpisode[] = [];

    const result = router(health, { onRootRerouted: (episode) => episodes.push(episode) })(
      rootCreate("claude-backup", "claude-opus-5-5", { labels: { "paseo.agent-type": "chat" } }),
      fakeContext,
    );

    expect(result?.config.provider).toBe("claude");
    expect(result?.config.model).toBe("claude-opus-5-5");
    expect(result?.config.cwd).toBe("/tmp/work");
    expect(labelsOf(result)).toEqual({ "paseo.agent-type": "chat", [ACCOUNT_REROUTED_LABEL]: "claude-backup" });
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ requestedProviderId: "claude-backup", targetProviderId: "claude", window: "weekly" });
    expect(episodes[0]?.reason).toContain("claude-backup");
    expect(episodes[0]?.reason).toContain(WEEKLY_RESET.toISOString());
  });

  it("leaves a root alone when its own account still has budget — even a worker account", () => {
    const health = tracker();
    health.reportUsage("claude-backup", [{ window: WINDOW_SEVEN_DAY, usedPct: 42 }]);

    expect(router(health)(rootCreate("claude-backup", "claude-opus-5-5"), fakeContext)).toBeUndefined();
  });

  it("leaves a root alone on a drained account: only a window at its cap is 'cannot run'", () => {
    const health = tracker();
    health.reportUsage("claude-backup", [{ window: WINDOW_FIVE_HOUR, usedPct: 96 }]);

    expect(router(health)(rootCreate("claude-backup", "claude-opus-5-5"), fakeContext)).toBeUndefined();
  });

  it("treats a capped window for the requested model as 'cannot run', and one for another model as irrelevant", () => {
    const opusCapped = tracker();
    opusCapped.reportUsage("claude-backup", [{ window: weeklyModelWindow("opus"), usedPct: 100 }]);
    expect(router(opusCapped)(rootCreate("claude-backup", "claude-opus-5-5"), fakeContext)?.config.provider).toBe(
      "claude",
    );

    const fableCapped = tracker();
    fableCapped.reportUsage("claude-backup", [{ window: weeklyModelWindow("fable"), usedPct: 100 }]);
    expect(router(fableCapped)(rootCreate("claude-backup", "claude-opus-5-5"), fakeContext)).toBeUndefined();
  });

  it("moves a root to the worker with the most headroom when the leader is out too", () => {
    const health = tracker();
    health.reportUsage("claude", [{ window: WINDOW_FIVE_HOUR, usedPct: 100 }]);
    health.reportUsage("claude-backup", [{ window: WINDOW_SEVEN_DAY, usedPct: 100 }]);
    health.reportUsage("claude-personal", [{ window: WINDOW_SEVEN_DAY, usedPct: 19 }]);

    const result = router(health)(rootCreate("claude", "claude-opus-5-5"), fakeContext);

    expect(result?.config.provider).toBe("claude-personal");
    expect(labelsOf(result)?.[ACCOUNT_REROUTED_LABEL]).toBe("claude");
  });

  it("passes a root through when nothing can serve it — a root is never refused", () => {
    const health = tracker();
    for (const providerId of ["claude", "claude-personal", "claude-backup"]) {
      health.reportUsage(providerId, [{ window: WINDOW_SEVEN_DAY, usedPct: 100 }]);
    }
    const stranded = vi.fn();

    const result = router(health, { onRootStranded: stranded })(rootCreate("claude-backup", "claude-opus-5-5"), fakeContext);

    expect(result).toBeUndefined();
    expect(stranded).toHaveBeenCalledWith(expect.objectContaining({ requestedProviderId: "claude-backup" }));
  });

  it("leaves a root on a non-pooled provider alone", () => {
    const health = tracker();
    health.reportUsage("codex", [{ window: WINDOW_SEVEN_DAY, usedPct: 100 }]);

    expect(router(health)(rootCreate("codex", "gpt-5.1"), fakeContext)).toBeUndefined();
  });

  it("passes a root through when the reroute target is missing from the provider snapshot", () => {
    const health = tracker();
    health.reportUsage("claude-backup", [{ window: WINDOW_SEVEN_DAY, usedPct: 100 }]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = router(health, { providerIds: fakeProviderIds(["claude-backup"]) })(
      rootCreate("claude-backup", "claude-opus-5-5"),
      fakeContext,
    );

    expect(result).toBeUndefined();
    errors.mockRestore();
  });

  it("with no model named, any capped window on the account counts", () => {
    const health = tracker();
    health.reportUsage("claude-backup", [{ window: weeklyModelWindow("opus"), usedPct: 100 }]);

    expect(router(health)(rootCreate("claude-backup"), fakeContext)?.config.provider).toBe("claude");
  });
});

describe("createRouter — a root routing decision never fails a create", () => {
  it("reroutes when the capped window's reset is an Invalid Date, and names no reset", () => {
    const health = tracker();
    health.reportUsage("claude-backup", [{ window: WINDOW_SEVEN_DAY, usedPct: 100, resetsAt: new Date("not-a-real-date") }]);
    const episodes: RootRerouteEpisode[] = [];

    const result = router(health, { onRootRerouted: (episode) => episodes.push(episode) })(
      rootCreate("claude-backup", "claude-opus-5-5"),
      fakeContext,
    );

    expect(result?.config.provider).toBe("claude");
    expect(episodes[0]?.resetsAt).toBeUndefined();
    expect(episodes[0]?.reason).not.toContain("until");
  });

  it("caps the model a reroute's logged reason names, so a huge model id cannot make a huge line", () => {
    const health = tracker();
    health.reportUsage("claude-backup", [{ window: WINDOW_SEVEN_DAY, usedPct: 100, resetsAt: WEEKLY_RESET }]);
    health.reportUsage("claude", [{ window: WINDOW_SEVEN_DAY, usedPct: 42 }]);
    const episodes: RootRerouteEpisode[] = [];

    router(health, { onRootRerouted: (episode) => episodes.push(episode) })(
      rootCreate("claude-backup", "z".repeat(2_000_000)),
      fakeContext,
    );

    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.reason.length).toBeLessThan(1_000);
    expect(episodes[0]?.reason).toContain(`out of budget for ${"z".repeat(120)}…`);
  });

  it("keeps the requested provider and logs when root routing throws", () => {
    const health = tracker();
    health.reportUsage("claude-backup", [{ window: WINDOW_SEVEN_DAY, usedPct: 100 }]);
    const broken: HealthTracker = {
      ...health,
      describeWindow: () => {
        throw new Error("boom");
      },
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = router(broken)(rootCreate("claude-backup", "claude-opus-5-5"), fakeContext);

    expect(result).toBeUndefined();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).toContain("keeping the requested provider");
    errors.mockRestore();
  });
});

describe("createRouter — a root asking for the bare claude id", () => {
  const NAMED_POOL: ResolvedPool = {
    workers: [
      { providerId: "claude-worker-1", priority: 1 },
      { providerId: "claude-worker-2", priority: 2 },
    ],
    leader: { providerId: "claude-leader" },
  };
  const namedRouter = (health: HealthTracker) =>
    router(health, {
      poolCache: fakePoolCache(NAMED_POOL),
      providerIds: fakeProviderIds(["claude", "claude-leader", "claude-worker-1", "claude-worker-2"]),
    });

  it("is a pool-family request even when no pool entry is named claude, as for a child", () => {
    const health = tracker();
    health.reportUsage("claude", [{ window: WINDOW_SEVEN_DAY, usedPct: 100 }]);

    const result = namedRouter(health)(rootCreate("claude", "claude-opus-5-5"), fakeContext);

    expect(result?.config.provider).toBe("claude-leader");
    expect(labelsOf(result)?.[ACCOUNT_REROUTED_LABEL]).toBe("claude");
  });

  it("stays on claude while that entry has budget", () => {
    const health = tracker();
    health.reportUsage("claude", [{ window: WINDOW_SEVEN_DAY, usedPct: 42 }]);

    expect(namedRouter(health)(rootCreate("claude", "claude-opus-5-5"), fakeContext)).toBeUndefined();
  });
});

describe("createRouter — children keep today's behaviour", () => {
  it("routes a child off a capped worker by headroom, with no reroute label", () => {
    const health = tracker();
    health.reportUsage("claude-backup", [{ window: WINDOW_SEVEN_DAY, usedPct: 100 }]);

    const result = router(health)(
      rootCreate("claude-backup", "claude-sonnet-5", { callerAgentId: "leader-1" }),
      fakeContext,
    );

    expect(result?.config.provider).toBe("claude-personal");
    expect(labelsOf(result)).toBeUndefined();
  });

  it("still refuses a child when every pooled account is out", () => {
    const health = tracker();
    for (const providerId of ["claude", "claude-personal", "claude-backup"]) {
      health.reportUsage(providerId, [{ window: WINDOW_SEVEN_DAY, usedPct: 100 }]);
    }

    expect(() =>
      router(health)(rootCreate("claude-backup", "claude-sonnet-5", { callerAgentId: "leader-1" }), fakeContext),
    ).toThrow(PoolExhaustedError);
  });
});

/**
 * The CLI refuses a turn with "You've hit your <window> limit · resets …" before the usage API
 * reads 100%. The plugin used to miss every one of those messages, so a refusing account kept
 * taking spawns — even ahead of a healthy worker when it had no usage reading at all.
 */
describe("createRouter — an account the CLI is refusing", () => {
  const SESSION_REFUSAL = "You've hit your session limit · resets 2:50pm (America/Los_Angeles)";
  const minutes = (n: number) => new Date(NOW.getTime() + n * 60 * 1000);

  it("does not outrank a healthy worker when it has no usage reading yet", () => {
    const health = tracker();
    health.reportUsage("claude-personal", [{ window: WINDOW_FIVE_HOUR, usedPct: 50 }]);
    health.reportTurnFailure("claude-backup", SESSION_REFUSAL);

    const result = router(health)(rootCreate("claude", "claude-sonnet-5", { callerAgentId: "leader-1" }), fakeContext);

    expect(result?.config.provider).toBe("claude-personal");
  });

  it("is not a last resort while the other worker is merely drained", () => {
    const health = tracker();
    health.reportUsage("claude-backup", [{ window: WINDOW_FIVE_HOUR, usedPct: 98, resetsAt: minutes(25) }]);
    health.reportUsage("claude-personal", [{ window: WINDOW_FIVE_HOUR, usedPct: 92, resetsAt: minutes(240) }]);
    health.reportTurnFailure("claude-backup", SESSION_REFUSAL);

    const result = router(health)(rootCreate("claude", "claude-opus-5-5", { callerAgentId: "leader-1" }), fakeContext);

    expect(result?.config.provider).toBe("claude-personal");
  });

  it("moves a root that asked for it", () => {
    const health = tracker();
    health.reportTurnFailure("claude-backup", SESSION_REFUSAL);

    const result = router(health)(rootCreate("claude-backup", "claude-opus-5-5"), fakeContext);

    expect(result?.config.provider).toBe("claude");
  });

  it("refusing one model leaves every other model running there, and refuses nothing else", () => {
    const health = tracker();
    for (const providerId of ["claude", "claude-personal", "claude-backup"]) {
      health.reportTurnFailure(providerId, "You've hit your Opus limit · resets Oct 2, 9am");
    }

    const sonnet = router(health)(rootCreate("claude", "claude-sonnet-5", { callerAgentId: "leader-1" }), fakeContext);
    expect(sonnet?.config.provider).toBe("claude-personal");
    expect(() =>
      router(health)(rootCreate("claude", "claude-opus-5-5", { callerAgentId: "leader-1" }), fakeContext),
    ).toThrow(PoolExhaustedError);
  });
});

describe("createRouter — another model's weekly window", () => {
  it("does not exclude an account from an Opus spawn when only Sonnet's week is used up", () => {
    const health = tracker();
    for (const providerId of ["claude", "claude-personal", "claude-backup"]) {
      health.reportUsage(providerId, [
        { window: WINDOW_FIVE_HOUR, usedPct: 91 },
        { window: WINDOW_SEVEN_DAY, usedPct: 60 },
        { window: weeklyModelWindow("sonnet"), usedPct: 100 },
      ]);
    }

    const result = router(health)(rootCreate("claude", "claude-opus-5-5", { callerAgentId: "leader-1" }), fakeContext);

    expect(result?.config.provider).toBe("claude-personal");
  });

  it("does not demote an account for an Opus spawn because its Sonnet week is nearly full", () => {
    const health = tracker();
    health.reportUsage("claude-personal", [
      { window: WINDOW_FIVE_HOUR, usedPct: 20 },
      { window: weeklyModelWindow("sonnet"), usedPct: 99 },
    ]);
    health.reportUsage("claude-backup", [{ window: WINDOW_FIVE_HOUR, usedPct: 60 }]);

    const result = router(health)(rootCreate("claude", "claude-opus-5-5", { callerAgentId: "leader-1" }), fakeContext);

    expect(result?.config.provider).toBe("claude-personal");
  });

  it("names the reset of a window that blocks the requested model when it refuses", () => {
    const health = tracker();
    const sessionReset = new Date("2026-09-25T02:00:00Z");
    const sonnetReset = new Date("2026-09-24T23:00:00Z");
    for (const providerId of ["claude", "claude-personal", "claude-backup"]) {
      health.reportUsage(providerId, [
        { window: WINDOW_FIVE_HOUR, usedPct: 100, resetsAt: sessionReset },
        { window: weeklyModelWindow("sonnet"), usedPct: 100, resetsAt: sonnetReset },
      ]);
    }

    expect(() =>
      router(health)(rootCreate("claude", "claude-opus-5-5", { callerAgentId: "leader-1" }), fakeContext),
    ).toThrow(sessionReset.toISOString());
  });
});

/**
 * Daemon jobs start agents with no calling agent and say what they are with a role label. Such a
 * create is placed like a child — a worker account first — but, having no caller to read a
 * refusal, it is never refused.
 */
describe("createRouter — a caller-less create that declares a worker role", () => {
  const declaresWorker = (labels: Record<string, string> | undefined) => labels?.["paseo.agent-type"] === "worker";
  const workerLabels = { labels: { "paseo.agent-type": "worker" } };

  it("is placed on the pooled worker with the most headroom, not kept on the leader account", () => {
    const health = tracker();
    health.reportUsage("claude", [{ window: WINDOW_FIVE_HOUR, usedPct: 10 }]);
    health.reportUsage("claude-personal", [{ window: WINDOW_FIVE_HOUR, usedPct: 70 }]);
    health.reportUsage("claude-backup", [{ window: WINDOW_FIVE_HOUR, usedPct: 20 }]);

    const result = router(health, { placesRootAsChild: declaresWorker })(
      rootCreate("claude", "claude-haiku-4-5", workerLabels),
      fakeContext,
    );

    expect(result?.config.provider).toBe("claude-backup");
    expect(labelsOf(result)).toEqual(workerLabels.labels);
  });

  it("is never refused, even when every pooled account is out", () => {
    const health = tracker();
    for (const providerId of ["claude", "claude-personal", "claude-backup"]) {
      health.reportUsage(providerId, [{ window: WINDOW_SEVEN_DAY, usedPct: 100 }]);
    }
    const onFailOpen = vi.fn();

    const result = router(health, { placesRootAsChild: declaresWorker, onFailOpen })(
      rootCreate("claude", "claude-haiku-4-5", workerLabels),
      fakeContext,
    );

    expect(result).toBeUndefined();
    expect(onFailOpen).toHaveBeenCalledWith(expect.objectContaining({ reason: "every-pool-account-capped" }));
  });

  it("an unlabelled caller-less create is still a root: it keeps the account it asked for", () => {
    const health = tracker();
    health.reportUsage("claude", [{ window: WINDOW_FIVE_HOUR, usedPct: 10 }]);

    const result = router(health, { placesRootAsChild: declaresWorker })(
      rootCreate("claude", "claude-opus-5-5"),
      fakeContext,
    );

    expect(result).toBeUndefined();
  });
});
