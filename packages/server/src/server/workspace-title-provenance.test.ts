import pino from "pino";
import { describe, expect, test } from "vitest";
import type { AgentManager } from "./agent/agent-manager.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import {
  createPersistedWorkspaceRecord,
  isAutoTitledWorkspace,
  type PersistedWorkspaceRecord,
  type WorkspaceRegistry,
} from "./workspace-registry.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";

function workspaceRecord(
  overrides: Partial<PersistedWorkspaceRecord> = {},
): PersistedWorkspaceRecord {
  return {
    ...createPersistedWorkspaceRecord({
      workspaceId: "wks_provenance",
      projectId: "prj_provenance",
      cwd: "/workspace",
      kind: "local_checkout",
      displayName: "main",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    }),
    ...overrides,
  };
}

async function runAutoName(workspace: PersistedWorkspaceRecord): Promise<PersistedWorkspaceRecord> {
  let current = workspace;
  let emitted!: () => void;
  const emittedUpdate = new Promise<void>((resolve) => {
    emitted = resolve;
  });
  const autoName = new WorkspaceAutoName({
    agentManager: {} as AgentManager,
    workspaceRegistry: {
      update: async (_workspaceId, updater) => {
        current = updater(current);
        return current;
      },
    } satisfies Pick<WorkspaceRegistry, "update">,
    workspaceGitService: {} as WorkspaceGitService,
    providerSnapshotManager: {} as ProviderSnapshotManager,
    readDaemonConfig: () => ({}),
    gitMutation: { notifyGitMutation: async () => {} },
    emitWorkspaceUpdateForCwd: async () => {},
    emitWorkspaceUpdateForWorkspaceId: async () => emitted(),
    logger: pino({ level: "silent" }),
    generateWorkspaceName: async () => ({ title: "Generated title", branch: null }),
  });
  autoName.scheduleForDirectory({
    workspaceId: current.workspaceId,
    cwd: current.cwd,
    firstAgentContext: { prompt: "Name this workspace" },
  });
  await emittedUpdate;
  return current;
}

describe("workspace title provenance", () => {
  test("a record written before provenance existed reads as hand-set", () => {
    expect(isAutoTitledWorkspace(workspaceRecord({ title: "i ran into a situation" }))).toBe(false);
  });

  test("only an explicit auto stamp makes a title rewritable", () => {
    expect(isAutoTitledWorkspace(workspaceRecord({ titleSource: "manual" }))).toBe(false);
    expect(isAutoTitledWorkspace(workspaceRecord({ titleSource: "auto" }))).toBe(true);
  });

  test("auto-naming an untitled workspace claims provenance", async () => {
    const updated = await runAutoName(workspaceRecord());

    expect(updated.title).toBe("Generated title");
    expect(updated.titleSource).toBe("auto");
    expect(isAutoTitledWorkspace(updated)).toBe(true);
  });

  test("auto-naming replaces the prompt-derived placeholder and keeps it auto", async () => {
    const updated = await runAutoName(
      workspaceRecord({ title: "Name this workspace", titleSource: "auto" }),
    );

    expect(updated.title).toBe("Generated title");
    expect(updated.titleSource).toBe("auto");
  });

  test("auto-naming never overwrites a title the user chose", async () => {
    const updated = await runAutoName(
      workspaceRecord({ title: "Bozeo fork", titleSource: "manual" }),
    );

    expect(updated.title).toBe("Bozeo fork");
    expect(updated.titleSource).toBe("manual");
    expect(isAutoTitledWorkspace(updated)).toBe(false);
  });
});
