import { readFile } from "node:fs/promises";

import { writeFileAtomic } from "./atomic-file.js";
import type {
  PersistedWorkspaceRecord,
  WorkspaceRegistry,
  WorkspaceTitleSource,
} from "./workspace-registry.js";

/**
 * One-time reclassification of workspace title provenance (docs/agent-lifecycle.md).
 *
 * Every title supplied at creation used to be stamped "manual", so a workspace an orchestrator
 * named for its child read as hand-named and the title tracker never touched it. Records written
 * before provenance existed carry no source at all and read as manual too. This pass moves a
 * record to "auto" only on evidence that a person did not name it; everything else stays (or
 * becomes explicitly) "manual". It only ever writes those two values, which every daemon version
 * parses, so rolling back after it ran loses nothing. Titles are never rewritten here.
 */

const MIGRATION_VERSION = 1;
const PARENT_AGENT_LABEL = "paseo.parent-agent-id";

/** The slice of a stored agent the migration reads. */
export interface TitleSourceMigrationAgent {
  workspaceId?: string | null;
  createdAt: string;
  labels?: Record<string, string> | null;
}

export interface TitleSourceMigrationCounts {
  scanned: number;
  manualToAuto: number;
  absentToAuto: number;
  absentToManual: number;
}

function namedAtCreationByAnAgent(
  workspace: PersistedWorkspaceRecord,
  firstAgent: TitleSourceMigrationAgent | null,
): boolean {
  // A rename after creation bumps updatedAt, so an untouched record still carries the name it
  // was created with. Its first agent being an agent's child means an orchestrator made it.
  return (
    workspace.createdAt === workspace.updatedAt && Boolean(firstAgent?.labels?.[PARENT_AGENT_LABEL])
  );
}

/** The source a record should move to, or null to leave it as it is. */
export function classifyWorkspaceTitleSource(
  workspace: PersistedWorkspaceRecord,
  firstAgent: TitleSourceMigrationAgent | null,
): WorkspaceTitleSource | null {
  if (workspace.titleSource === "manual") {
    return namedAtCreationByAnAgent(workspace, firstAgent) ? "auto" : null;
  }
  if (workspace.titleSource !== undefined) {
    return null;
  }
  const title = workspace.title?.trim() ?? "";
  if (!title || title === workspace.branch || title === workspace.displayName) {
    // Nobody named it, or the name is the branch placeholder the daemon derived.
    return "auto";
  }
  return namedAtCreationByAnAgent(workspace, firstAgent) ? "auto" : "manual";
}

function earliestAgentByWorkspaceId(
  agents: readonly TitleSourceMigrationAgent[],
): Map<string, TitleSourceMigrationAgent> {
  const earliest = new Map<string, TitleSourceMigrationAgent>();
  for (const agent of agents) {
    if (!agent.workspaceId) continue;
    const current = earliest.get(agent.workspaceId);
    if (!current || agent.createdAt < current.createdAt) {
      earliest.set(agent.workspaceId, agent);
    }
  }
  return earliest;
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
 * Runs the reclassification once per PASEO_HOME. Returns the counts, or null when the marker
 * says it already ran.
 */
export async function migrateWorkspaceTitleSources(input: {
  workspaceRegistry: Pick<WorkspaceRegistry, "list" | "update">;
  listAgents: () => Promise<readonly TitleSourceMigrationAgent[]>;
  markerPath: string;
  logger: { info: (obj: object, msg?: string) => void };
}): Promise<TitleSourceMigrationCounts | null> {
  if (await markerExists(input.markerPath)) {
    return null;
  }
  const firstAgents = earliestAgentByWorkspaceId(await input.listAgents());
  const counts: TitleSourceMigrationCounts = {
    scanned: 0,
    manualToAuto: 0,
    absentToAuto: 0,
    absentToManual: 0,
  };
  for (const workspace of await input.workspaceRegistry.list()) {
    counts.scanned += 1;
    const next = classifyWorkspaceTitleSource(
      workspace,
      firstAgents.get(workspace.workspaceId) ?? null,
    );
    if (!next) continue;
    const from = workspace.titleSource;
    let changed = false;
    await input.workspaceRegistry.update(workspace.workspaceId, (current) => {
      // Re-check against the stored record: provenance that moved since list() wins.
      if (current.titleSource !== from || current.title !== workspace.title) return current;
      changed = true;
      // updatedAt stays: provenance is bookkeeping, not an edit to the workspace.
      return { ...current, titleSource: next };
    });
    if (!changed) continue;
    if (from === "manual") counts.manualToAuto += 1;
    else if (next === "auto") counts.absentToAuto += 1;
    else counts.absentToManual += 1;
  }
  await writeFileAtomic(
    input.markerPath,
    `${JSON.stringify({ version: MIGRATION_VERSION, at: new Date().toISOString(), counts })}\n`,
  );
  input.logger.info({ titleSourceMigration: counts }, "Reclassified workspace title provenance");
  return counts;
}
