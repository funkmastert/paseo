import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
} from "./workspace-registry.js";
import { autoPinWorkspaceOnSessionStart, isProtectivePin } from "./workspace-auto-pin.js";

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
