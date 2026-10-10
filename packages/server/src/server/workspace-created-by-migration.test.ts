import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
  PersistedWorkspaceRecordSchema,
  type PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import {
  classifyWorkspaceCreatedBy,
  migrateWorkspaceCreatedBy,
  type CreatedByMigrationAgent,
} from "./workspace-created-by-migration.js";

const CREATED = "2026-09-20T10:00:00.000Z";

function record(overrides: Partial<PersistedWorkspaceRecord> = {}): PersistedWorkspaceRecord {
  return {
    ...createPersistedWorkspaceRecord({
      workspaceId: "wks_a",
      projectId: "prj_a",
      cwd: "/repo/worktree-a",
      kind: "worktree",
      displayName: "feat/thing",
      branch: "feat/thing",
      createdAt: CREATED,
      updatedAt: CREATED,
    }),
    ...overrides,
  };
}

describe("classifyWorkspaceCreatedBy", () => {
  test("a Paseo-owned worktree is agent-made regardless of its agents", () => {
    expect(classifyWorkspaceCreatedBy(record({ isPaseoOwnedWorktree: true }), [])).toBe("agent");
  });

  test("an agent carrying paseo.parent-agent-id makes its workspace agent-made", () => {
    const agent: CreatedByMigrationAgent = {
      workspaceId: "wks_a",
      labels: { "paseo.parent-agent-id": "leader-1" },
    };
    expect(classifyWorkspaceCreatedBy(record(), [agent])).toBe("agent");
  });

  test("an agent carrying paseo.remediation makes its workspace agent-made", () => {
    const agent: CreatedByMigrationAgent = {
      workspaceId: "wks_a",
      labels: { "paseo.remediation": "disk-falling" },
    };
    expect(classifyWorkspaceCreatedBy(record(), [agent])).toBe("agent");
  });

  test("a workspace with only an unlabelled agent is person-made", () => {
    const agent: CreatedByMigrationAgent = { workspaceId: "wks_a", labels: {} };
    expect(classifyWorkspaceCreatedBy(record(), [agent])).toBe("person");
    expect(classifyWorkspaceCreatedBy(record(), [])).toBe("person");
  });
});

describe("migrateWorkspaceCreatedBy", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "created-by-migration-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function harness(records: PersistedWorkspaceRecord[], agents: CreatedByMigrationAgent[]) {
    const byId = new Map(records.map((r) => [r.workspaceId, r]));
    return {
      byId,
      deps: {
        workspaceRegistry: {
          list: async () => Array.from(byId.values()),
          update: async (
            id: string,
            updater: (r: PersistedWorkspaceRecord) => PersistedWorkspaceRecord,
          ) => {
            const current = byId.get(id);
            if (!current) return null;
            const next = updater(current);
            byId.set(id, next);
            return next;
          },
        },
        listAgents: async () => agents,
        markerPath: path.join(dir, "workspace-created-by-migration.json"),
        logger: pino({ level: "silent" }),
      },
    };
  }

  test("backfills once, counts, and never overrides a stored value", async () => {
    const h = harness(
      [
        record({ workspaceId: "wks_child" }),
        record({ workspaceId: "wks_worktree", isPaseoOwnedWorktree: true }),
        record({ workspaceId: "wks_person" }),
        // Already stamped by the create path — the migration must leave it alone.
        record({ workspaceId: "wks_already_person", createdBy: "person" }),
      ],
      [{ workspaceId: "wks_child", labels: { "paseo.parent-agent-id": "leader-1" } }],
    );

    const counts = await migrateWorkspaceCreatedBy(h.deps);

    expect(h.byId.get("wks_child")?.createdBy).toBe("agent");
    expect(h.byId.get("wks_worktree")?.createdBy).toBe("agent");
    expect(h.byId.get("wks_person")?.createdBy).toBe("person");
    expect(h.byId.get("wks_already_person")?.createdBy).toBe("person");
    expect(counts).toMatchObject({ scanned: 4, setToAgent: 2, setToPerson: 1 });
    expect(JSON.parse(await readFile(h.deps.markerPath, "utf8"))).toMatchObject({ version: 1 });

    h.byId.set("wks_later", record({ workspaceId: "wks_later" }));
    const again = await migrateWorkspaceCreatedBy({
      ...h.deps,
      listAgents: async () => [],
    });
    expect(again).toBeNull();
    expect(h.byId.get("wks_later")?.createdBy).toBeUndefined();
  });

  test("a workspaces.json the new code writes parses with the previous build's schema", async () => {
    // The rollback build parses the whole file with z.array(schema), omitting createdBy from its
    // own schema entirely; the field being optional on the new schema means an older parser just
    // never sees it, and never fails the whole file.
    const previousSchema = PersistedWorkspaceRecordSchema.omit({ createdBy: true });
    const filePath = path.join(dir, "projects", "workspaces.json");
    const registry = new FileBackedWorkspaceRegistry(filePath, pino({ level: "silent" }));
    await registry.initialize();
    for (const seeded of [
      record({ workspaceId: "wks_child" }),
      record({ workspaceId: "wks_worktree", isPaseoOwnedWorktree: true }),
      record({ workspaceId: "wks_person" }),
    ]) {
      await registry.upsert(seeded);
    }

    await migrateWorkspaceCreatedBy({
      workspaceRegistry: registry,
      listAgents: async () => [
        { workspaceId: "wks_child", labels: { "paseo.parent-agent-id": "leader-1" } },
      ],
      markerPath: path.join(dir, "projects", "workspace-created-by-migration.json"),
      logger: pino({ level: "silent" }),
    });

    const written = JSON.parse(await readFile(filePath, "utf8")) as unknown[];
    const parsed = z.array(previousSchema).parse(written);
    expect(parsed).toHaveLength(3);
  });
});
