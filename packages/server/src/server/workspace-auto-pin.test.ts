import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

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
  isProtectivePin,
  isWorkspaceActiveForAutoPin,
} from "./workspace-auto-pin.js";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";

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

    const result = await autoPinWorkspaceOnSessionStart(registry, "ws-1", now);

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

    const result = await autoPinWorkspaceOnSessionStart(registry, "ws-2", now);

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

    const result = await autoPinWorkspaceOnSessionStart(registry, "ws-3", now);

    expect(result?.pinnedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  test("returns null for a workspace that does not exist", async () => {
    const result = await autoPinWorkspaceOnSessionStart(registry, "does-not-exist", now);
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
  ): AutoPinExpiry {
    return new AutoPinExpiry({
      workspaceRegistry,
      listAgents: () => agents,
      readConfig: () => config,
      logger,
      now: () => nowMs,
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
    nowMs = START + 5 * HOUR;

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

  test("a restart gives every auto pin one window from daemon start", async () => {
    await seed("ws-1", { pinnedAt: new Date(START - 10 * HOUR).toISOString(), pinSource: "auto" });
    const expiry = createExpiry();

    nowMs = START + AUTO_PIN_RECENT_USE_MS - 1;
    expect(await expiry.sweep()).toEqual([]);
    nowMs = START + AUTO_PIN_RECENT_USE_MS;
    expect(await expiry.sweep()).toEqual(["ws-1"]);
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
