import { readFile } from "node:fs/promises";

import { writeFileAtomic } from "./atomic-file.js";
import type {
  PersistedWorkspaceRecord,
  WorkspaceCreatedBy,
  WorkspaceRegistry,
} from "./workspace-registry.js";

/**
 * One-time backfill of `createdBy` (docs/done-janitor.md#manual-pin-vs-auto-pin). Every record
 * written before this field existed carries none. A workspace is classified "agent" from
 * evidence that survives it: any agent it ever held carrying `paseo.parent-agent-id` (an
 * orchestrator's child) or `paseo.remediation` (a self-heal fixer), or the workspace itself being
 * a Paseo-owned worktree (always created on an agent's behalf). Everything else is "person". A
 * stored value, including one this pass already set, is never touched again.
 */

const MIGRATION_VERSION = 1;
const PARENT_AGENT_LABEL = "paseo.parent-agent-id";
const REMEDIATION_LABEL = "paseo.remediation";

/** The slice of a stored agent the migration reads. */
export interface CreatedByMigrationAgent {
  workspaceId?: string | null;
  labels?: Record<string, string> | null;
}

export interface CreatedByMigrationCounts {
  scanned: number;
  setToAgent: number;
  setToPerson: number;
}

function agentMadeWorkspace(
  workspace: PersistedWorkspaceRecord,
  agentsInWorkspace: readonly CreatedByMigrationAgent[],
): boolean {
  if (workspace.isPaseoOwnedWorktree) return true;
  return agentsInWorkspace.some(
    (agent) =>
      Boolean(agent.labels?.[PARENT_AGENT_LABEL]) || Boolean(agent.labels?.[REMEDIATION_LABEL]),
  );
}

/** The value a record with no stored `createdBy` should get. */
export function classifyWorkspaceCreatedBy(
  workspace: PersistedWorkspaceRecord,
  agentsInWorkspace: readonly CreatedByMigrationAgent[],
): WorkspaceCreatedBy {
  return agentMadeWorkspace(workspace, agentsInWorkspace) ? "agent" : "person";
}

function agentsByWorkspaceId(
  agents: readonly CreatedByMigrationAgent[],
): Map<string, CreatedByMigrationAgent[]> {
  const byWorkspace = new Map<string, CreatedByMigrationAgent[]>();
  for (const agent of agents) {
    if (!agent.workspaceId) continue;
    const list = byWorkspace.get(agent.workspaceId);
    if (list) list.push(agent);
    else byWorkspace.set(agent.workspaceId, [agent]);
  }
  return byWorkspace;
}

async function markerExists(markerPath: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(markerPath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "number" && parsed.version >= MIGRATION_VERSION;
  } catch {
    return false;
  }
}

/**
 * Runs the backfill once per PASEO_HOME. Returns the counts, or null when the marker says it
 * already ran.
 */
export async function migrateWorkspaceCreatedBy(input: {
  workspaceRegistry: Pick<WorkspaceRegistry, "list" | "update">;
  listAgents: () => Promise<readonly CreatedByMigrationAgent[]>;
  markerPath: string;
  logger: { info: (obj: object, msg?: string) => void };
}): Promise<CreatedByMigrationCounts | null> {
  if (await markerExists(input.markerPath)) {
    return null;
  }
  const agentsByWorkspace = agentsByWorkspaceId(await input.listAgents());
  const counts: CreatedByMigrationCounts = { scanned: 0, setToAgent: 0, setToPerson: 0 };
  for (const workspace of await input.workspaceRegistry.list()) {
    counts.scanned += 1;
    if (workspace.createdBy !== undefined) continue;
    const createdBy = classifyWorkspaceCreatedBy(
      workspace,
      agentsByWorkspace.get(workspace.workspaceId) ?? [],
    );
    let changed = false;
    await input.workspaceRegistry.update(workspace.workspaceId, (current) => {
      // Re-check against the stored record: a value set since list() wins.
      if (current.createdBy !== undefined) return current;
      changed = true;
      return { ...current, createdBy };
    });
    if (!changed) continue;
    if (createdBy === "agent") counts.setToAgent += 1;
    else counts.setToPerson += 1;
  }
  await writeFileAtomic(
    input.markerPath,
    `${JSON.stringify({ version: MIGRATION_VERSION, at: new Date().toISOString(), counts })}\n`,
  );
  input.logger.info(
    { workspaceCreatedByMigration: counts },
    "Backfilled workspace creator provenance",
  );
  return counts;
}
