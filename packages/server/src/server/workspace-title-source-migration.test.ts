import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createPersistedWorkspaceRecord,
  isAutoTitledWorkspace,
  type PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import {
  classifyWorkspaceTitleSource,
  migrateWorkspaceTitleSources,
  type TitleSourceMigrationAgent,
} from "./workspace-title-source-migration.js";

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
      title: "Polish the thing",
      titleSource: "manual",
      createdAt: CREATED,
      updatedAt: CREATED,
    }),
    ...overrides,
  };
}

function childAgent(overrides: Partial<TitleSourceMigrationAgent> = {}): TitleSourceMigrationAgent {
  return {
    workspaceId: "wks_a",
    createdAt: "2026-09-20T10:00:30.000Z",
    labels: { "paseo.parent-agent-id": "leader-1" },
    ...overrides,
  };
}

describe("classifyWorkspaceTitleSource", () => {
  test("a creation-time manual title whose first agent an agent spawned becomes agent", () => {
    expect(classifyWorkspaceTitleSource(record(), childAgent())).toBe("agent");
  });

  test("a manual title renamed after creation stays manual even with a child first agent", () => {
    expect(
      classifyWorkspaceTitleSource(record({ updatedAt: "2026-09-21T09:00:00.000Z" }), childAgent()),
    ).toBeNull();
  });

  test("a manual title whose first agent a person started stays manual", () => {
    expect(classifyWorkspaceTitleSource(record(), childAgent({ labels: {} }))).toBeNull();
    expect(classifyWorkspaceTitleSource(record(), null)).toBeNull();
  });

  test("auto and agent records are left alone", () => {
    expect(classifyWorkspaceTitleSource(record({ titleSource: "auto" }), childAgent())).toBeNull();
    expect(classifyWorkspaceTitleSource(record({ titleSource: "agent" }), childAgent())).toBeNull();
  });

  describe("absent provenance (M1)", () => {
    test("no title at all hands naming to Paseo", () => {
      expect(
        classifyWorkspaceTitleSource(record({ title: null, titleSource: undefined }), null),
      ).toBe("auto");
    });

    test("a title equal to the branch or display name is the branch derivation", () => {
      expect(
        classifyWorkspaceTitleSource(record({ title: "feat/thing", titleSource: undefined }), null),
      ).toBe("auto");
      expect(
        classifyWorkspaceTitleSource(
          record({ title: "brave-otter", displayName: "brave-otter", titleSource: undefined }),
          null,
        ),
      ).toBe("auto");
    });

    test("a creation-time title from an agent-spawned first agent is agent", () => {
      expect(classifyWorkspaceTitleSource(record({ titleSource: undefined }), childAgent())).toBe(
        "agent",
      );
    });

    test("anything else is a hand-set title", () => {
      expect(classifyWorkspaceTitleSource(record({ titleSource: undefined }), null)).toBe("manual");
      expect(
        classifyWorkspaceTitleSource(
          record({ titleSource: undefined, updatedAt: "2026-09-22T00:00:00.000Z" }),
          childAgent(),
        ),
      ).toBe("manual");
    });
  });
});

describe("migrateWorkspaceTitleSources", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "title-source-migration-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function harness(records: PersistedWorkspaceRecord[], agents: TitleSourceMigrationAgent[]) {
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
        markerPath: path.join(dir, "workspace-title-source-migration.json"),
        logger: pino({ level: "silent" }),
      },
    };
  }

  test("reclassifies once, counts, and never runs again", async () => {
    const h = harness(
      [
        record({ workspaceId: "wks_child" }),
        record({ workspaceId: "wks_typed" }),
        record({ workspaceId: "wks_null", title: null, titleSource: undefined }),
        record({ workspaceId: "wks_old", titleSource: undefined, title: "Bozeo fork" }),
      ],
      [
        childAgent({ workspaceId: "wks_child" }),
        // The earliest agent decides; a later child does not make a person's name an agent's.
        childAgent({ workspaceId: "wks_typed", createdAt: "2026-09-20T10:00:01.000Z", labels: {} }),
        childAgent({ workspaceId: "wks_typed", createdAt: "2026-09-20T11:00:00.000Z" }),
      ],
    );

    const counts = await migrateWorkspaceTitleSources(h.deps);

    expect(h.byId.get("wks_child")?.titleSource).toBe("agent");
    expect(isAutoTitledWorkspace(h.byId.get("wks_child")!)).toBe(true);
    expect(h.byId.get("wks_typed")?.titleSource).toBe("manual");
    expect(h.byId.get("wks_null")?.titleSource).toBe("auto");
    expect(h.byId.get("wks_old")?.titleSource).toBe("manual");
    expect(counts).toMatchObject({
      manualToAgent: 1,
      absentToAuto: 1,
      absentToAgent: 0,
      absentToManual: 1,
    });
    // Titles are never rewritten by the migration, only their provenance.
    expect(h.byId.get("wks_child")?.title).toBe("Polish the thing");
    expect(JSON.parse(await readFile(h.deps.markerPath, "utf8"))).toMatchObject({ version: 1 });

    h.byId.set("wks_later", record({ workspaceId: "wks_later" }));
    const again = await migrateWorkspaceTitleSources({
      ...h.deps,
      listAgents: async () => [childAgent({ workspaceId: "wks_later" })],
    });
    expect(again).toBeNull();
    expect(h.byId.get("wks_later")?.titleSource).toBe("manual");
  });
});
