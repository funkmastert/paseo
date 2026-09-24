import { describe, expect, it, vi } from "vitest";
import { createHealthTracker, type CapEvent } from "./health";
import { createNotifier, type NotifierPaseoApi } from "./notify";

interface FakeAgentRow {
  id: string;
  /** Real daemon payloads carry parentage in labels; this is the default shape. */
  parentAgentId?: string | null;
  parentLabel?: string | null;
  title: string | null;
  provider: string;
  archivedAt?: string | null;
  /** Defaults to "running" — a live session — when unset. */
  status?: "initializing" | "idle" | "running" | "error" | "closed";
}

interface FakeSendCall {
  id: string;
  text: string;
  options: unknown;
}

function fakePaseo(
  rows: FakeAgentRow[],
  sendImpl?: (id: string, text: string, options: unknown) => Promise<void> | void,
) {
  const sendCalls: FakeSendCall[] = [];
  const list = vi.fn().mockResolvedValue({
    entries: rows.map((row) => ({
      agent: {
        id: row.id,
        // Only set when a test explicitly exercises the structural fallback.
        parentAgentId: row.parentAgentId ?? null,
        labels: row.parentLabel ? { "paseo.parent-agent-id": row.parentLabel } : {},
        title: row.title,
        provider: row.provider,
        archivedAt: row.archivedAt ?? null,
        status: row.status ?? "running",
      },
    })),
  });
  const ref = (agentId: string) => ({
    send: async (text: string, options: unknown) => {
      sendCalls.push({ id: agentId, text, options });
      if (sendImpl) {
        await sendImpl(agentId, text, options);
      }
    },
  });
  const paseo = { agents: { list, ref } } as unknown as NotifierPaseoApi;
  return { paseo, sendCalls, list };
}

/** Deterministic stand-in for the microtask/timer scheduler: queues fns and drains them (including any fns they schedule) on flush(). */
function fakeScheduler() {
  const pending: Array<() => void | Promise<void>> = [];
  return {
    schedule: (fn: () => void | Promise<void>) => {
      pending.push(fn);
    },
    async flush() {
      let iterations = 0;
      while (pending.length > 0 && iterations < 50) {
        const batch = pending.splice(0, pending.length);
        await Promise.all(batch.map((fn) => fn()));
        iterations += 1;
      }
    },
  };
}

describe("createNotifier", () => {
  it("sends one steer message per affected leader naming the capped provider, reset time, and affected children", async () => {
    const rows: FakeAgentRow[] = [
      { id: "leader-1", parentLabel: null, title: "Leader One", provider: "human-claude" },
      { id: "child-1", parentLabel: "leader-1", title: "Child One", provider: "worker-a" },
      { id: "child-2", parentLabel: "child-1", title: "Child Two", provider: "worker-a" },
      { id: "leader-2", parentLabel: null, title: "Leader Two", provider: "human-claude" },
      { id: "child-3", parentLabel: "leader-2", title: "Child Three", provider: "worker-b" },
    ];
    const { paseo, sendCalls } = fakePaseo(rows);
    const health = createHealthTracker();
    const { schedule, flush } = fakeScheduler();
    // Fixed clock, deliberately before resetsAt: delivery must not depend on
    // wall-clock time relative to a fixture date.
    const notifier = createNotifier({
      paseo,
      health,
      schedule,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    notifier.onTurnEnded("leader-1");
    const resetsAt = "2026-01-01T03:00:00.000Z";
    health.reportTurnFailure("worker-a", `hit your limit, resets at ${resetsAt}`);
    await flush();

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].id).toBe("leader-1");
    expect(sendCalls[0].options).toEqual({ activeTurnBehavior: "steer" });
    expect(sendCalls[0].text).toContain("worker-a");
    expect(sendCalls[0].text).toContain(resetsAt);
    expect(sendCalls[0].text).toContain("Child One");
    expect(sendCalls[0].text).toContain("Child Two");
    expect(sendCalls[0].text).not.toContain("Child Three");

    notifier.stop();
  });

  it("sends at most one pool-dry notification per leader per episode, and a health recovery re-arms it", async () => {
    const rows: FakeAgentRow[] = [
      { id: "leader-1", parentLabel: null, title: "Leader", provider: "human-claude" },
      { id: "caller-1", parentLabel: "leader-1", title: "Worker Agent", provider: "worker-a" },
    ];
    const { paseo, sendCalls } = fakePaseo(rows);
    const health = createHealthTracker();
    const { schedule, flush } = fakeScheduler();
    const notifier = createNotifier({ paseo, health, schedule });

    notifier.onTurnEnded("leader-1");
    notifier.notePoolDry({ callerAgentId: "caller-1", requestedModel: "claude-sonnet", leaderProviderId: "leader-provider" });
    notifier.notePoolDry({ callerAgentId: "caller-1", requestedModel: "claude-sonnet", leaderProviderId: "leader-provider" });
    notifier.notePoolDry({ callerAgentId: "caller-1", requestedModel: "claude-opus", leaderProviderId: "leader-provider" });
    await flush();

    expect(sendCalls).toHaveLength(1);

    // Cap then heal a window to emit a "recovered" CapEvent and re-arm the episode.
    health.reportTurnFailure("worker-z", "hit your limit");
    health.reportUsage("worker-z", [{ window: "account", usedPct: 10 }]);
    await flush();

    notifier.notePoolDry({ callerAgentId: "caller-1", requestedModel: "claude-sonnet", leaderProviderId: "leader-provider" });
    await flush();

    expect(sendCalls).toHaveLength(2);
    notifier.stop();
  });

  it("says the pool collapsed onto one account exactly once, and re-arms when capacity returns", async () => {
    const rows: FakeAgentRow[] = [
      { id: "leader-1", parentLabel: null, title: "Leader", provider: "claude-leader" },
      { id: "caller-1", parentLabel: "leader-1", title: "Worker Agent", provider: "claude-leader" },
    ];
    const { paseo, sendCalls } = fakePaseo(rows);
    const health = createHealthTracker();
    const { schedule, flush } = fakeScheduler();
    const notifier = createNotifier({ paseo, health, schedule });
    const episode = {
      callerAgentId: "caller-1",
      requestedModel: "claude-sonnet",
      targetProviderId: "claude-leader",
      sharedProviderIds: ["claude-leader", "claude-personal"],
      exhaustedProviderIds: ["worker-a", "backup"],
    };

    notifier.onTurnEnded("leader-1");
    notifier.notePoolCollapsed(episode);
    notifier.notePoolCollapsed(episode);
    notifier.notePoolCollapsed({ ...episode, requestedModel: "claude-opus" });
    await flush();

    // Once, however many spawns hit the collapsed pool.
    expect(sendCalls).toHaveLength(1);
    const text = sendCalls[0].text;
    expect(text).toContain("ONE usable account");
    expect(text).toContain("claude-leader");
    // Names the duplicate-login entries, so a "move" between them is visibly pointless.
    expect(text).toContain("claude-personal");
    expect(text).toContain("worker-a, backup");
    // Informational, not a call to action: failover already collapsed onto this account, and
    // will spread back out on its own once another account has budget.
    expect(text).toContain("informational");
    expect(text).not.toMatch(/sign in|raise a limit|wind the fleet down/i);
    // And that it undoes itself.
    expect(text).toContain("Isolation resumes");

    // An account recovering re-arms it: losing isolation again is a new thing to say.
    health.reportTurnFailure("worker-a", "hit your limit");
    health.reportUsage("worker-a", [{ window: "account", usedPct: 10 }]);
    await flush();
    notifier.notePoolCollapsed(episode);
    await flush();

    expect(sendCalls).toHaveLength(2);
    notifier.stop();
  });

  it("says an exhausted pool is refusing spawns, naming the earliest reset", async () => {
    const rows: FakeAgentRow[] = [
      { id: "leader-1", parentLabel: null, title: "Leader", provider: "claude-leader" },
      { id: "caller-1", parentLabel: "leader-1", title: "Worker Agent", provider: "worker-a" },
    ];
    const { paseo, sendCalls } = fakePaseo(rows);
    const health = createHealthTracker();
    const { schedule, flush } = fakeScheduler();
    const notifier = createNotifier({ paseo, health, schedule });

    notifier.onTurnEnded("leader-1");
    const earliestResetAt = new Date("2026-09-26T09:00:00.000Z");
    notifier.notePoolExhausted({
      callerAgentId: "caller-1",
      requestedModel: "claude-sonnet",
      exhaustedProviderIds: ["worker-a", "backup", "claude-leader"],
      earliestResetAt,
    });
    notifier.notePoolExhausted({
      callerAgentId: "caller-1",
      requestedModel: "claude-sonnet",
      exhaustedProviderIds: ["worker-a", "backup", "claude-leader"],
      earliestResetAt,
    });
    await flush();

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].text).toContain("EVERY Claude account is out of budget");
    expect(sendCalls[0].text).toContain("being refused");
    expect(sendCalls[0].text).toContain(earliestResetAt.toISOString());
    notifier.stop();
  });

  it("sends at most one fail-open notification per leader until notePoolRecovered re-arms it", async () => {
    const rows: FakeAgentRow[] = [{ id: "leader-1", parentLabel: null, title: "Leader", provider: "human-claude" }];
    const { paseo, sendCalls } = fakePaseo(rows);
    const health = createHealthTracker();
    const { schedule, flush } = fakeScheduler();
    const notifier = createNotifier({ paseo, health, schedule });

    notifier.onTurnEnded("leader-1");
    notifier.noteFailOpen({ callerAgentId: "leader-1", reason: "pool-unconfigured" });
    notifier.noteFailOpen({ callerAgentId: "leader-1", reason: "pool-unconfigured" });
    await flush();
    expect(sendCalls).toHaveLength(1);

    notifier.noteFailOpen({ callerAgentId: "leader-1", reason: "pool-unconfigured" });
    await flush();
    expect(sendCalls).toHaveLength(1);

    notifier.notePoolRecovered();
    notifier.noteFailOpen({ callerAgentId: "leader-1", reason: "pool-unconfigured" });
    await flush();
    expect(sendCalls).toHaveLength(2);

    notifier.stop();
  });

  it("holds a notification for a leader with a pending permission and delivers it once permissions resolve", async () => {
    const rows: FakeAgentRow[] = [
      { id: "leader-1", parentLabel: null, title: "Leader", provider: "human-claude" },
      { id: "child-1", parentLabel: "leader-1", title: "Child", provider: "worker-a" },
    ];
    const { paseo, sendCalls } = fakePaseo(rows);
    const health = createHealthTracker();
    const { schedule, flush } = fakeScheduler();
    const notifier = createNotifier({ paseo, health, schedule });

    notifier.onPermissionRequested("leader-1");
    health.reportTurnFailure("worker-a", "hit your limit");
    await flush();

    expect(sendCalls).toHaveLength(0);

    notifier.onPermissionResolved("leader-1");
    await flush();

    expect(sendCalls).toHaveLength(1);
    notifier.stop();
  });

  it("retries a rejected steer send after the leader's next turn_ended", async () => {
    const rows: FakeAgentRow[] = [
      { id: "leader-1", parentLabel: null, title: "Leader", provider: "human-claude" },
      { id: "child-1", parentLabel: "leader-1", title: "Child", provider: "worker-a" },
    ];
    let shouldReject = true;
    const { paseo, sendCalls } = fakePaseo(rows, () => {
      if (shouldReject) {
        shouldReject = false;
        throw new Error("cannot steer: turn not active");
      }
    });
    const health = createHealthTracker();
    const { schedule, flush } = fakeScheduler();
    const notifier = createNotifier({ paseo, health, schedule });

    notifier.onTurnEnded("leader-1"); // Leader is in steady state: boundary already observed.
    health.reportTurnFailure("worker-a", "hit your limit");
    await flush();
    expect(sendCalls).toHaveLength(1);

    notifier.onTurnEnded("leader-1");
    await flush();
    expect(sendCalls).toHaveLength(2);

    notifier.stop();
  });

  it("resolves parentage from labels across a multi-hop chain, not a structural parentAgentId field", async () => {
    // The real daemon payload has no parentAgentId key at all; only labels
    // carry parentage. Leave parentAgentId entirely absent to prove the
    // labels path is what resolves this, not a structural fallback.
    const rows: FakeAgentRow[] = [
      { id: "leader-1", parentLabel: null, title: "Leader", provider: "human-claude" },
      { id: "worker-child-1", parentLabel: "leader-1", title: "Worker Child", provider: "human-claude" },
      { id: "grandchild-1", parentLabel: "worker-child-1", title: "Grandchild", provider: "worker-a" },
    ];
    const { paseo, sendCalls } = fakePaseo(rows);
    const health = createHealthTracker();
    const { schedule, flush } = fakeScheduler();
    const notifier = createNotifier({ paseo, health, schedule });

    notifier.onTurnEnded("leader-1");
    notifier.noteFailOpen({ callerAgentId: "grandchild-1", reason: "pool-unconfigured" });
    await flush();

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].id).toBe("leader-1");

    notifier.stop();
  });

  it("still honors a structural parentAgentId property when the daemon supplies one", async () => {
    const rows: FakeAgentRow[] = [
      { id: "leader-1", parentAgentId: null, title: "Leader", provider: "human-claude" },
      { id: "child-1", parentAgentId: "leader-1", title: "Child", provider: "worker-a" },
    ];
    const { paseo, sendCalls } = fakePaseo(rows);
    const health = createHealthTracker();
    const { schedule, flush } = fakeScheduler();
    const notifier = createNotifier({ paseo, health, schedule });

    notifier.onTurnEnded("leader-1");
    notifier.noteFailOpen({ callerAgentId: "child-1", reason: "pool-unconfigured" });
    await flush();

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].id).toBe("leader-1");

    notifier.stop();
  });

  it("drops a held send for an archived leader instead of delivering it once permissions resolve", async () => {
    const rows: FakeAgentRow[] = [
      { id: "leader-1", parentLabel: null, title: "Leader", provider: "human-claude" },
      { id: "child-1", parentLabel: "leader-1", title: "Child", provider: "worker-a" },
    ];
    const { paseo, sendCalls } = fakePaseo(rows);
    const health = createHealthTracker();
    const { schedule, flush } = fakeScheduler();
    const notifier = createNotifier({ paseo, health, schedule });

    notifier.onPermissionRequested("leader-1");
    health.reportTurnFailure("worker-a", "hit your limit");
    await flush();
    expect(sendCalls).toHaveLength(0); // Held: leader-1 has a pending permission.

    notifier.onAgentArchived("leader-1");
    notifier.onPermissionResolved("leader-1");
    await flush();

    expect(sendCalls).toHaveLength(0); // Dropped, not delivered: leader-1 is archived.
    notifier.stop();
  });

  it("clears a pending-permission count for an archived agent so it stops holding sends", async () => {
    const rows: FakeAgentRow[] = [
      { id: "leader-1", parentLabel: null, title: "Leader", provider: "human-claude" },
      { id: "child-1", parentLabel: "leader-1", title: "Child", provider: "worker-a" },
    ];
    const { paseo, sendCalls } = fakePaseo(rows);
    const health = createHealthTracker();
    const { schedule, flush } = fakeScheduler();
    const notifier = createNotifier({ paseo, health, schedule });

    notifier.onPermissionRequested("leader-1");
    notifier.onAgentArchived("leader-1");
    // A late-arriving turn_ended re-establishes the steer boundary; the
    // pending-permission count must not have survived archival.
    notifier.onTurnEnded("leader-1");

    health.reportTurnFailure("worker-a", "hit your limit");
    await flush();

    // The pending-permission entry was pruned on archival, so this delivers
    // immediately instead of being held.
    expect(sendCalls).toHaveLength(1);
    notifier.stop();
  });

  it("holds a steer for a leader until this notifier instance has observed a turn boundary for it", async () => {
    // A fresh notifier (e.g. after a plugin reload) can't know whether the
    // leader is mid-permission-prompt, so it must not steer until turn_ended
    // or permission_resolved proves the turn is at a safe point.
    const rows: FakeAgentRow[] = [
      { id: "leader-1", parentLabel: null, title: "Leader", provider: "human-claude" },
      { id: "child-1", parentLabel: "leader-1", title: "Child", provider: "worker-a" },
    ];
    const { paseo, sendCalls } = fakePaseo(rows);
    const health = createHealthTracker();
    const { schedule, flush } = fakeScheduler();
    const notifier = createNotifier({ paseo, health, schedule });

    health.reportTurnFailure("worker-a", "hit your limit");
    await flush();
    expect(sendCalls).toHaveLength(0); // Held: no boundary observed yet.

    notifier.onTurnEnded("leader-1");
    await flush();
    expect(sendCalls).toHaveLength(1);

    notifier.stop();
  });

  it("treats a leader whose creation it observed as steer-safe without a turn boundary", async () => {
    // A newborn agent cannot carry a pending permission the notifier never
    // saw, so observing agent.created is as good as a turn boundary; the
    // conservative hold applies only to agents that pre-date the notifier.
    const rows: FakeAgentRow[] = [
      { id: "leader-1", parentLabel: null, title: "Leader", provider: "human-claude" },
      { id: "child-1", parentLabel: "leader-1", title: "Child", provider: "worker-a" },
    ];
    const { paseo, sendCalls } = fakePaseo(rows);
    const health = createHealthTracker();
    const { schedule, flush } = fakeScheduler();
    const notifier = createNotifier({ paseo, health, schedule });

    notifier.onAgentCreated("leader-1");
    health.reportTurnFailure("worker-a", "hit your limit");
    await flush();
    expect(sendCalls).toHaveLength(1); // Delivered: creation observed, no hold.

    notifier.stop();
  });

  it("serializes concurrent pool-dry episodes so exactly one delivers", async () => {
    const rows: FakeAgentRow[] = [
      { id: "leader-1", parentLabel: null, title: "Leader", provider: "human-claude" },
      { id: "caller-1", parentLabel: "leader-1", title: "Worker Agent", provider: "worker-a" },
    ];
    const { paseo, sendCalls } = fakePaseo(rows);
    const health = createHealthTracker();
    const { schedule, flush } = fakeScheduler();
    const notifier = createNotifier({ paseo, health, schedule });

    notifier.onTurnEnded("leader-1");
    // Same episode scheduled twice back-to-back with no await in between: both
    // would otherwise be in flight across the agents.list() await at once.
    notifier.notePoolDry({ callerAgentId: "caller-1", requestedModel: "claude-sonnet", leaderProviderId: "leader-provider" });
    notifier.notePoolDry({ callerAgentId: "caller-1", requestedModel: "claude-sonnet", leaderProviderId: "leader-provider" });
    await flush();

    expect(sendCalls).toHaveLength(1);
    notifier.stop();
  });

  it("never calls agents.list or send synchronously inside notePoolDry/noteFailOpen/a health cap event", () => {
    const { paseo } = fakePaseo([]);
    const health = createHealthTracker();
    const scheduled: Array<() => void | Promise<void>> = [];
    const schedule = (fn: () => void | Promise<void>) => {
      scheduled.push(fn);
    };
    const notifier = createNotifier({ paseo, health, schedule });

    notifier.notePoolDry({ callerAgentId: "c1", requestedModel: "m", leaderProviderId: "leader-provider" });
    expect(paseo.agents.list).not.toHaveBeenCalled();

    notifier.noteFailOpen({ callerAgentId: "c1", reason: "pool-unconfigured" });
    expect(paseo.agents.list).not.toHaveBeenCalled();

    health.reportTurnFailure("worker-a", "hit your limit");
    expect(paseo.agents.list).not.toHaveBeenCalled();

    expect(scheduled.length).toBeGreaterThan(0);
    notifier.stop();
  });

  it("drops a held cap notification whose window already reset by delivery time, without sending it", async () => {
    const rows: FakeAgentRow[] = [
      { id: "leader-1", parentLabel: null, title: "Leader", provider: "human-claude" },
      { id: "child-1", parentLabel: "leader-1", title: "Child", provider: "worker-a" },
    ];
    const { paseo, sendCalls } = fakePaseo(rows);
    const health = createHealthTracker();
    const { schedule, flush } = fakeScheduler();
    let currentTime = new Date("2026-01-01T00:00:00.000Z");
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const notifier = createNotifier({ paseo, health, schedule, now: () => currentTime });

    // Held behind a pending permission, so it can't deliver immediately.
    notifier.onPermissionRequested("leader-1");
    health.reportTurnFailure("worker-a", "hit your limit, resets at 2026-01-01T00:30:00.000Z");
    await flush();
    expect(sendCalls).toHaveLength(0);

    // The window's reset time has now passed while the notification sat held.
    currentTime = new Date("2026-01-01T00:30:01.000Z");
    notifier.onPermissionResolved("leader-1");
    await flush();

    expect(sendCalls).toHaveLength(0); // Dropped, not delivered: stale by delivery time.
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy.mock.calls[0][0]).toContain("leader-1");

    debugSpy.mockRestore();
    notifier.stop();
  });

  it("delivers a cap notification whose window has not yet reset at delivery time", async () => {
    const rows: FakeAgentRow[] = [
      { id: "leader-1", parentLabel: null, title: "Leader", provider: "human-claude" },
      { id: "child-1", parentLabel: "leader-1", title: "Child", provider: "worker-a" },
    ];
    const { paseo, sendCalls } = fakePaseo(rows);
    const health = createHealthTracker();
    const { schedule, flush } = fakeScheduler();
    const currentTime = new Date("2026-01-01T00:00:00.000Z");
    const notifier = createNotifier({ paseo, health, schedule, now: () => currentTime });

    notifier.onTurnEnded("leader-1");
    health.reportTurnFailure("worker-a", "hit your limit, resets at 2026-01-01T00:30:00.000Z");
    await flush();

    expect(sendCalls).toHaveLength(1);
    notifier.stop();
  });

  it("excludes closed agents from an affected-children list, and skips notifying a leader entirely when every affected agent is closed", async () => {
    const rows: FakeAgentRow[] = [
      { id: "leader-1", parentLabel: null, title: "Leader One", provider: "human-claude" },
      { id: "child-1", parentLabel: "leader-1", title: "Live Child", provider: "worker-a", status: "running" },
      { id: "child-2", parentLabel: "leader-1", title: "Dead Child", provider: "worker-a", status: "closed" },
      { id: "leader-2", parentLabel: null, title: "Leader Two", provider: "human-claude" },
      { id: "child-3", parentLabel: "leader-2", title: "Only Closed Child", provider: "worker-a", status: "closed" },
    ];
    const { paseo, sendCalls } = fakePaseo(rows);
    const health = createHealthTracker({ now: () => new Date("2026-01-01T00:00:00.000Z") });
    const { schedule, flush } = fakeScheduler();
    const notifier = createNotifier({
      paseo,
      health,
      schedule,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    notifier.onTurnEnded("leader-1");
    notifier.onTurnEnded("leader-2");
    health.reportTurnFailure("worker-a", "hit your limit, resets at 2026-01-01T03:00:00.000Z");
    await flush();

    // Only leader-1 gets steered: leader-2's only affected child is closed,
    // so it has no live affected children and is skipped entirely.
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].id).toBe("leader-1");
    expect(sendCalls[0].text).toContain("Live Child");
    expect(sendCalls[0].text).not.toContain("Dead Child");

    notifier.stop();
  });

  it("excludes idle and errored children too: only running or initializing counts as still there", async () => {
    // The incident this fixes: a leader was told 21 children "were running there" when most
    // had long since finished their turn (idle) or failed (error) — isAffectedByCapRow only
    // excluded `closed`. `initializing` still counts: a child mid-launch on the capped account
    // is as much "there" as a running one.
    const rows: FakeAgentRow[] = [
      { id: "leader-1", parentLabel: null, title: "Leader One", provider: "human-claude" },
      { id: "child-1", parentLabel: "leader-1", title: "Running Child", provider: "worker-a", status: "running" },
      { id: "child-2", parentLabel: "leader-1", title: "Starting Child", provider: "worker-a", status: "initializing" },
      { id: "child-3", parentLabel: "leader-1", title: "Idle Child", provider: "worker-a", status: "idle" },
      { id: "child-4", parentLabel: "leader-1", title: "Errored Child", provider: "worker-a", status: "error" },
    ];
    const { paseo, sendCalls } = fakePaseo(rows);
    const health = createHealthTracker({ now: () => new Date("2026-01-01T00:00:00.000Z") });
    const { schedule, flush } = fakeScheduler();
    const notifier = createNotifier({
      paseo,
      health,
      schedule,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    notifier.onTurnEnded("leader-1");
    health.reportTurnFailure("worker-a", "hit your limit, resets at 2026-01-01T03:00:00.000Z");
    await flush();

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].text).toContain("Running Child");
    expect(sendCalls[0].text).toContain("Starting Child");
    expect(sendCalls[0].text).not.toContain("Idle Child");
    expect(sendCalls[0].text).not.toContain("Errored Child");

    notifier.stop();
  });

  it("skips a leader entirely when its only affected children are idle or errored, not running", async () => {
    const rows: FakeAgentRow[] = [
      { id: "leader-1", parentLabel: null, title: "Leader One", provider: "human-claude" },
      { id: "child-1", parentLabel: "leader-1", title: "Idle Child", provider: "worker-a", status: "idle" },
    ];
    const { paseo, sendCalls } = fakePaseo(rows);
    const health = createHealthTracker({ now: () => new Date("2026-01-01T00:00:00.000Z") });
    const { schedule, flush } = fakeScheduler();
    const notifier = createNotifier({
      paseo,
      health,
      schedule,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    notifier.onTurnEnded("leader-1");
    health.reportTurnFailure("worker-a", "hit your limit, resets at 2026-01-01T03:00:00.000Z");
    await flush();

    expect(sendCalls).toHaveLength(0);
    notifier.stop();
  });

  it("tells the leader failover handles the cap automatically, without asking it to act", async () => {
    const rows: FakeAgentRow[] = [
      { id: "leader-1", parentLabel: null, title: "Leader One", provider: "human-claude" },
      { id: "child-1", parentLabel: "leader-1", title: "Child One", provider: "worker-a", status: "running" },
    ];
    const { paseo, sendCalls } = fakePaseo(rows);
    const health = createHealthTracker({ now: () => new Date("2026-01-01T00:00:00.000Z") });
    const { schedule, flush } = fakeScheduler();
    const notifier = createNotifier({
      paseo,
      health,
      schedule,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    notifier.onTurnEnded("leader-1");
    health.reportTurnFailure("worker-a", "hit your limit, resets at 2026-01-01T03:00:00.000Z");
    await flush();

    const text = sendCalls[0].text;
    expect(text).toContain("automatically");
    expect(text).not.toMatch(/you should|please|sign in|raise a limit/i);

    notifier.stop();
  });

  it("suppresses a re-announced cap episode (same provider+window+resetsAt) but still announces a genuinely new one", async () => {
    // Models what a plugin restart does in practice: a fresh health tracker
    // rediscovers the same still-open cap from the next usage poll and
    // re-emits a "capped" CapEvent with the same resetsAt. Driving the
    // listener directly (rather than through a real HealthTracker) isolates
    // the notifier's own episode dedup from HealthTracker's separate
    // within-process capped-transition guard.
    const rows: FakeAgentRow[] = [
      { id: "leader-1", parentLabel: null, title: "Leader", provider: "human-claude" },
      { id: "child-1", parentLabel: "leader-1", title: "Child", provider: "worker-a" },
    ];
    const { paseo, sendCalls } = fakePaseo(rows);
    const { schedule, flush } = fakeScheduler();
    let capListener: ((event: CapEvent) => void) | undefined;
    const health = {
      onChange: (listener: (event: CapEvent) => void) => {
        capListener = listener;
        return () => {};
      },
    };
    const notifier = createNotifier({
      paseo,
      health,
      schedule,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    notifier.onTurnEnded("leader-1");

    const firstReset = new Date("2026-01-01T03:00:00.000Z");
    capListener?.({ providerId: "worker-a", window: "weekly", kind: "capped", resetsAt: firstReset });
    await flush();
    expect(sendCalls).toHaveLength(1);

    // Same episode rediscovered: must not re-notify.
    capListener?.({ providerId: "worker-a", window: "weekly", kind: "capped", resetsAt: firstReset });
    await flush();
    expect(sendCalls).toHaveLength(1);

    // A genuinely new cap after the window actually reset carries a
    // different resetsAt, and must notify again.
    const secondReset = new Date("2026-01-08T03:00:00.000Z");
    capListener?.({ providerId: "worker-a", window: "weekly", kind: "capped", resetsAt: secondReset });
    await flush();
    expect(sendCalls).toHaveLength(2);

    notifier.stop();
  });
});
