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
