import os from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
} from "./workspace-registry.js";
import {
  AUTO_PIN_RECENT_USE_MS,
  AutoPinExpiry,
  autoPinWorkspaceOnSessionStart,
  isHumanAttributableCreate,
  isProtectivePin,
  isWorkspaceActiveForAutoPin,
  resolveWorkspaceCreatedBy,
} from "./workspace-auto-pin.js";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";

describe("isHumanAttributableCreate / resolveWorkspaceCreatedBy", () => {
  test("no caller agent and no labels is human-attributable", () => {
    expect(isHumanAttributableCreate({})).toBe(true);
    expect(resolveWorkspaceCreatedBy({})).toBe("person");
  });

  test("a caller agent is never human-attributable", () => {
    expect(isHumanAttributableCreate({ callerAgentId: "agent-1" })).toBe(false);
    expect(resolveWorkspaceCreatedBy({ callerAgentId: "agent-1" })).toBe("agent");
  });

  test("an inherited parent-agent-id label is never human-attributable, even with no caller", () => {
    expect(isHumanAttributableCreate({ labels: { "paseo.parent-agent-id": "agent-1" } })).toBe(
      false,
    );
    expect(resolveWorkspaceCreatedBy({ labels: { "paseo.parent-agent-id": "agent-1" } })).toBe(
      "agent",
    );
  });

  test("a label other than the parent-agent-id one does not affect the create-time rule", () => {
    // paseo.remediation marks a fixer's workspace for the one-time backfill
    // (workspace-created-by-migration.ts), not the create-time rule.
    expect(isHumanAttributableCreate({ labels: { "paseo.remediation": "true" } })).toBe(true);
    expect(isHumanAttributableCreate({ labels: { "some.other.label": "x" } })).toBe(true);
  });
});

describe("isProtectivePin", () => {
  test("a manual pin is protective", () => {
    expect(isProtectivePin({ pinnedAt: "2026-01-01T00:00:00.000Z", pinSource: "manual" })).toBe(
      true,
    );
  });

  test("a legacy pin with no recorded source is protective", () => {
    expect(isProtectivePin({ pinnedAt: "2026-01-01T00:00:00.000Z", pinSource: undefined })).toBe(
      true,
    );
  });

  test("an auto pin is not protective", () => {
    expect(isProtectivePin({ pinnedAt: "2026-01-01T00:00:00.000Z", pinSource: "auto" })).toBe(
      false,
    );
  });

  test("no pin at all is not protective", () => {
    expect(isProtectivePin({ pinnedAt: null, pinSource: undefined })).toBe(false);
  });
});

describe("autoPinWorkspaceOnSessionStart", () => {
  let tmpDir: string;
  let registry: FileBackedWorkspaceRegistry;
  const logger = createTestLogger();
  const now = () => "2026-06-01T00:00:00.000Z";

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "workspace-auto-pin-"));
    registry = new FileBackedWorkspaceRegistry(path.join(tmpDir, "workspaces.json"), logger);
    await registry.initialize();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("pins an unpinned workspace as auto", async () => {
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-1",
        projectId: "proj-1",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const result = await autoPinWorkspaceOnSessionStart(registry, "ws-1", { now });

    expect(result?.pinnedAt).toBe("2026-06-01T00:00:00.000Z");
    expect(result?.pinSource).toBe("auto");
    const stored = await registry.get("ws-1");
    expect(stored?.pinnedAt).toBe("2026-06-01T00:00:00.000Z");
    expect(stored?.pinSource).toBe("auto");
  });

  test("never touches an already manually pinned workspace", async () => {
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-2",
        projectId: "proj-1",
        cwd: "/tmp/repo2",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        pinnedAt: "2026-02-01T00:00:00.000Z",
        pinSource: "manual",
      }),
    );

    const result = await autoPinWorkspaceOnSessionStart(registry, "ws-2", { now });

    expect(result?.pinnedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(result?.pinSource).toBe("manual");
  });

  test("never touches an already auto-pinned workspace", async () => {
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-3",
        projectId: "proj-1",
        cwd: "/tmp/repo3",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        pinnedAt: "2026-02-01T00:00:00.000Z",
        pinSource: "auto",
      }),
    );

    const result = await autoPinWorkspaceOnSessionStart(registry, "ws-3", { now });

    expect(result?.pinnedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  test("tells clients a workspace still waiting on its first agent is running", async () => {
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-4",
        projectId: "proj-1",
        cwd: "/tmp/repo4",
        kind: "worktree",
        displayName: "feature",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const mutations: Array<{ workspaceId: string; expectsInitialAgent?: boolean }> = [];
    registry.subscribeToMutations((mutation) => {
      mutations.push(mutation);
    });

    await autoPinWorkspaceOnSessionStart(registry, "ws-4", {
      now,
      context: { expectsInitialAgent: true },
    });

    expect(mutations).toEqual([
      expect.objectContaining({ workspaceId: "ws-4", expectsInitialAgent: true }),
    ]);
  });

  test("returns null for a workspace that does not exist", async () => {
    const result = await autoPinWorkspaceOnSessionStart(registry, "does-not-exist", { now });
    expect(result).toBeNull();
  });
});

type TestAgent = Parameters<typeof isWorkspaceActiveForAutoPin>[0]["agents"][number];

function idleAgent(workspaceId: string, overrides: Partial<TestAgent> = {}): TestAgent {
  return { workspaceId, lifecycle: "idle", busy: false, pendingPermissionCount: 0, ...overrides };
}

describe("isWorkspaceActiveForAutoPin", () => {
  const nowMs = Date.parse("2026-06-01T12:00:00.000Z");
  const base = { workspaceId: "ws-1", nowMs, recentUseMs: AUTO_PIN_RECENT_USE_MS };
  const longAgo = nowMs - AUTO_PIN_RECENT_USE_MS;

  test("a use inside the window is active", () => {
    expect(isWorkspaceActiveForAutoPin({ ...base, agents: [], lastUsedAtMs: longAgo + 1 })).toBe(
      true,
    );
  });

  test("no use inside the window and no agent working is finished", () => {
    expect(
      isWorkspaceActiveForAutoPin({ ...base, agents: [idleAgent("ws-1")], lastUsedAtMs: longAgo }),
    ).toBe(false);
  });

  test.each([
    ["running", { lifecycle: "running" }],
    ["initializing", { lifecycle: "initializing" }],
    ["mid-turn", { busy: true }],
    ["waiting on a permission", { pendingPermissionCount: 1 }],
  ] as const)("an agent in it that is %s keeps it active", (_label, overrides) => {
    expect(
      isWorkspaceActiveForAutoPin({
        ...base,
        agents: [idleAgent("ws-1", overrides)],
        lastUsedAtMs: longAgo,
      }),
    ).toBe(true);
  });

  test("an agent working in another workspace does not count", () => {
    expect(
      isWorkspaceActiveForAutoPin({
        ...base,
        agents: [idleAgent("ws-2", { lifecycle: "running" })],
        lastUsedAtMs: longAgo,
      }),
    ).toBe(false);
  });
});

test("the default recent-use window is 24 hours", () => {
  expect(AUTO_PIN_RECENT_USE_MS).toBe(24 * 60 * 60 * 1000);
});

describe("AutoPinExpiry", () => {
  let tmpDir: string;
  let registry: FileBackedWorkspaceRegistry;
  let nowMs: number;
  let agents: TestAgent[];
  let config: { autoPinRecentUseMinutes?: number };
  const logger = createTestLogger();
  const START = Date.parse("2026-06-01T00:00:00.000Z");
  const HOUR = 60 * 60 * 1000;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "workspace-auto-pin-expiry-"));
    registry = new FileBackedWorkspaceRegistry(path.join(tmpDir, "workspaces.json"), logger);
    await registry.initialize();
    nowMs = START;
    agents = [];
    config = {};
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createExpiry(
    workspaceRegistry: ConstructorParameters<
      typeof AutoPinExpiry
    >[0]["workspaceRegistry"] = registry,
    usesFilePath?: string,
  ): AutoPinExpiry {
    return new AutoPinExpiry({
      workspaceRegistry,
      listAgents: () => agents,
      readConfig: () => config,
      logger,
      now: () => nowMs,
      usesFilePath,
    });
  }

  async function seed(
    workspaceId: string,
    pin: Partial<Pick<PersistedWorkspaceRecord, "pinnedAt" | "pinSource">>,
  ): Promise<void> {
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: "proj-1",
        cwd: `/tmp/${workspaceId}`,
        kind: "local_checkout",
        displayName: workspaceId,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...pin,
      }),
    );
  }

  test("clears a finished auto pin and leaves manual and legacy pins alone", async () => {
    const old = new Date(START - 10 * HOUR).toISOString();
    await seed("ws-auto", { pinnedAt: old, pinSource: "auto" });
    await seed("ws-manual", { pinnedAt: old, pinSource: "manual" });
    await seed("ws-legacy", { pinnedAt: old });
    const expiry = createExpiry();
    nowMs = START + AUTO_PIN_RECENT_USE_MS;

    expect(await expiry.sweep()).toEqual(["ws-auto"]);

    const cleared = await registry.get("ws-auto");
    expect(cleared?.pinnedAt).toBeNull();
    expect(cleared?.pinSource).toBeUndefined();
    // Expiry is not activity: the done janitor's quiet clock reads updatedAt.
    expect(cleared?.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect((await registry.get("ws-manual"))?.pinnedAt).toBe(old);
    expect((await registry.get("ws-legacy"))?.pinnedAt).toBe(old);
  });

  test("keeps an auto pin while an agent in it works, then clears it", async () => {
    await seed("ws-1", { pinnedAt: new Date(START).toISOString(), pinSource: "auto" });
    const expiry = createExpiry();
    agents = [idleAgent("ws-1", { lifecycle: "running" })];
    // Well past the recent-use window: only the agent working keeps this pin alive.
    nowMs = START + AUTO_PIN_RECENT_USE_MS + HOUR;

    expect(await expiry.sweep()).toEqual([]);

    agents = [idleAgent("ws-1")];
    expect(await expiry.sweep()).toEqual(["ws-1"]);
  });

  test("a use restarts the window", async () => {
    await seed("ws-1", { pinnedAt: new Date(START).toISOString(), pinSource: "auto" });
    const expiry = createExpiry();
    nowMs = START + AUTO_PIN_RECENT_USE_MS - 1;
    expiry.noteWorkspaceUsed("ws-1");
    nowMs = START + 2 * AUTO_PIN_RECENT_USE_MS - 2;

    expect(await expiry.sweep()).toEqual([]);

    nowMs = START + 2 * AUTO_PIN_RECENT_USE_MS;
    expect(await expiry.sweep()).toEqual(["ws-1"]);
  });

  test("a client clock ahead of the daemon's counts as now", async () => {
    await seed("ws-1", { pinnedAt: new Date(START).toISOString(), pinSource: "auto" });
    const expiry = createExpiry();
    expiry.noteWorkspaceUsed("ws-1", START + 10 * HOUR);
    nowMs = START + AUTO_PIN_RECENT_USE_MS;

    expect(await expiry.sweep()).toEqual(["ws-1"]);
  });

  test("a restart never gives an auto pin a fresh window: an already-overdue pin expires on the first post-restart sweep", async () => {
    const overdue = new Date(START - (AUTO_PIN_RECENT_USE_MS + HOUR)).toISOString();
    await seed("ws-1", { pinnedAt: overdue, pinSource: "auto" });
    // A fresh AutoPinExpiry instance, as a restarted daemon would construct, with no prior
    // in-memory uses and no uses file to recover from.
    const expiry = createExpiry();
    nowMs = START;

    expect(await expiry.sweep()).toEqual(["ws-1"]);
  });

  test("a restart keeps a not-yet-overdue auto pin's real clock instead of resetting it from boot", async () => {
    const recent = new Date(START - (AUTO_PIN_RECENT_USE_MS - HOUR)).toISOString();
    await seed("ws-1", { pinnedAt: recent, pinSource: "auto" });
    const expiry = createExpiry();
    nowMs = START; // 1 hour short of the window measured from the pin, not from boot

    expect(await expiry.sweep()).toEqual([]);

    nowMs = START + 2 * HOUR; // now past the pin's real window
    expect(await expiry.sweep()).toEqual(["ws-1"]);
  });

  test("a restart recovers a use recorded before it from the persisted uses file", async () => {
    const usesFilePath = path.join(tmpDir, "auto-pin-uses.json");
    const overdue = new Date(START - 10 * HOUR).toISOString();
    await seed("ws-1", { pinnedAt: overdue, pinSource: "auto" });

    const before = createExpiry(registry, usesFilePath);
    before.noteWorkspaceUsed("ws-1", START - HOUR);
    await before.flushPersistedUses();

    // A fresh instance pointed at the same file, as a restarted daemon would construct.
    const after = createExpiry(registry, usesFilePath);
    await after.start();
    await after.stop();

    nowMs = START + (AUTO_PIN_RECENT_USE_MS - HOUR) - 1;
    expect(await after.sweep()).toEqual([]);
    nowMs = START + (AUTO_PIN_RECENT_USE_MS - HOUR) + 1;
    expect(await after.sweep()).toEqual(["ws-1"]);
  });

  test("a restart tolerates a missing uses file", async () => {
    await seed("ws-1", { pinnedAt: new Date(START).toISOString(), pinSource: "auto" });
    const expiry = createExpiry(registry, path.join(tmpDir, "does-not-exist.json"));

    await expect(expiry.start()).resolves.toBeUndefined();
    await expiry.stop();
  });

  test("a restart tolerates a corrupt uses file", async () => {
    await seed("ws-1", { pinnedAt: new Date(START).toISOString(), pinSource: "auto" });
    const usesFilePath = path.join(tmpDir, "corrupt-uses.json");
    writeFileSync(usesFilePath, "not json");
    const expiry = createExpiry(registry, usesFilePath);

    await expect(expiry.start()).resolves.toBeUndefined();
    await expiry.stop();
    // A use noted after a failed load still works: the bad file didn't poison state.
    expiry.noteWorkspaceUsed("ws-1", START);
    nowMs = START + AUTO_PIN_RECENT_USE_MS - 1;
    expect(await expiry.sweep()).toEqual([]);
  });

  test("noteWorkspaceUsed debounces the write: a burst of uses persists once, after persistDebounceMs", async () => {
    const usesFilePath = path.join(tmpDir, "debounced-uses.json");
    // Real timers: the debounced write is a real setTimeout firing a real fs write, which
    // a faked timer can advance past without the real I/O it kicked off landing in time.
    const expiry = new AutoPinExpiry({
      workspaceRegistry: registry,
      listAgents: () => agents,
      readConfig: () => config,
      logger,
      now: () => nowMs,
      usesFilePath,
      persistDebounceMs: 50,
    });

    // noteWorkspaceUsed clamps atMs to now(), so now() has to advance with each call for the
    // later, larger timestamps to actually win over the first.
    nowMs = START;
    expiry.noteWorkspaceUsed("ws-1", START);
    nowMs = START + 1;
    expiry.noteWorkspaceUsed("ws-1", START + 1);
    nowMs = START + 2;
    expiry.noteWorkspaceUsed("ws-1", START + 2);
    expect(existsSync(usesFilePath)).toBe(false);

    await expect
      .poll(
        () => (existsSync(usesFilePath) ? JSON.parse(readFileSync(usesFilePath, "utf8")) : null),
        {
          timeout: 2_000,
          interval: 10,
        },
      )
      .toEqual({ "ws-1": START + 2 });
  });

  test("stop() flushes a still-pending debounced write before returning", async () => {
    const usesFilePath = path.join(tmpDir, "stop-flush-uses.json");
    const expiry = new AutoPinExpiry({
      workspaceRegistry: registry,
      listAgents: () => agents,
      readConfig: () => config,
      logger,
      now: () => nowMs,
      usesFilePath,
      // Long enough that the real timer can't fire on its own before stop() clears it.
      persistDebounceMs: 60_000,
    });

    expiry.noteWorkspaceUsed("ws-1", START);
    expect(existsSync(usesFilePath)).toBe(false);

    await expiry.stop();

    expect(JSON.parse(readFileSync(usesFilePath, "utf8"))).toEqual({ "ws-1": START });
  });

  test("a sweep that prunes a stale use schedules a persist of the prune", async () => {
    const usesFilePath = path.join(tmpDir, "prune-uses.json");
    await seed("ws-1", { pinnedAt: new Date(START).toISOString(), pinSource: "auto" });
    const expiry = new AutoPinExpiry({
      workspaceRegistry: registry,
      listAgents: () => agents,
      readConfig: () => config,
      logger,
      now: () => nowMs,
      usesFilePath,
      persistDebounceMs: 50,
    });
    expiry.noteWorkspaceUsed("ws-1", START);
    await expect
      .poll(
        () => (existsSync(usesFilePath) ? JSON.parse(readFileSync(usesFilePath, "utf8")) : null),
        {
          timeout: 2_000,
          interval: 10,
        },
      )
      .toEqual({ "ws-1": START });

    nowMs = START + AUTO_PIN_RECENT_USE_MS;
    expect(await expiry.sweep()).toEqual(["ws-1"]);

    // ws-1 is no longer auto-pinned, so its stale use is dropped — a later restart can't
    // resurrect a timestamp for a workspace the uses file has no business tracking anymore.
    // The sweep itself schedules this debounced persist, with no explicit flush call here.
    await expect
      .poll(() => JSON.parse(readFileSync(usesFilePath, "utf8")), { timeout: 2_000, interval: 10 })
      .toEqual({});
  });

  test("agents.autoPinRecentUseMinutes sets the window", async () => {
    await seed("ws-1", { pinnedAt: new Date(START).toISOString(), pinSource: "auto" });
    config = { autoPinRecentUseMinutes: 1 };
    const expiry = createExpiry();
    nowMs = START + 59_000;
    expect(await expiry.sweep()).toEqual([]);
    nowMs = START + 60_000;
    expect(await expiry.sweep()).toEqual(["ws-1"]);
  });

  test("an agent resuming never re-pins an expired workspace", async () => {
    await seed("ws-1", { pinnedAt: new Date(START).toISOString(), pinSource: "auto" });
    const expiry = createExpiry();
    nowMs = START + AUTO_PIN_RECENT_USE_MS;
    await expiry.sweep();

    agents = [idleAgent("ws-1", { lifecycle: "running" })];
    expiry.noteWorkspaceUsed("ws-1");
    await expiry.sweep();

    expect((await registry.get("ws-1"))?.pinnedAt).toBeNull();
  });

  test("a hand pin made after the sweep listed the workspace wins", async () => {
    const pinnedAt = new Date(START).toISOString();
    await seed("ws-1", { pinnedAt, pinSource: "auto" });
    const staleList = await registry.list();
    await registry.update("ws-1", (record) => ({ ...record, pinSource: "manual" }));
    const expiry = createExpiry({
      list: async () => staleList,
      update: registry.update.bind(registry),
    });
    nowMs = START + AUTO_PIN_RECENT_USE_MS;

    expect(await expiry.sweep()).toEqual([]);
    expect((await registry.get("ws-1"))?.pinSource).toBe("manual");
    expect((await registry.get("ws-1"))?.pinnedAt).toBe(pinnedAt);
  });
});
