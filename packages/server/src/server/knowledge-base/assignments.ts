import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";

/**
 * What has no other home (docs/knowledge-base.md, KTD-15): each agent's session-start summary
 * snapshot and each worktree workspace's project. An agent's own project lives in its
 * `paseo.kb-project` label and an Inbox entry's agent in the entry itself, so neither is here.
 * Lives at `<notesDir>/.bozeo/assignments.json`; Basic Memory skips dot-directories.
 */

const AgentSnapshotSchema = z.object({
  /** The project's slug when the snapshot was taken; follows renames and merges. */
  project: z.string(),
  text: z.string(),
  takenAt: z.string(),
});

const WorkspaceTagSchema = z.object({
  project: z.string(),
  taggedAt: z.string(),
});

const AssignmentsFileSchema = z.object({
  version: z.literal(1),
  agents: z.record(z.string(), AgentSnapshotSchema),
  workspaces: z.record(z.string(), WorkspaceTagSchema),
});

export type AgentSnapshot = z.infer<typeof AgentSnapshotSchema>;
export type WorkspaceTag = z.infer<typeof WorkspaceTagSchema>;
type AssignmentsFile = z.infer<typeof AssignmentsFileSchema>;

export function assignmentsFilePath(notesDir: string): string {
  return path.join(notesDir, ".bozeo", "assignments.json");
}

function emptyAssignments(): AssignmentsFile {
  return { version: 1, agents: {}, workspaces: {} };
}

export class AssignmentsStore {
  private state: AssignmentsFile;
  private writeTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    state: AssignmentsFile,
  ) {
    this.state = state;
  }

  /**
   * A missing file starts empty. A file that is not valid JSON or does not match the schema is
   * moved aside to `assignments.json.corrupt-<ms>` and the store starts empty: agents keep their
   * projects through their labels, and only snapshots and workspace tags are lost.
   */
  static async load(input: { filePath: string; logger: Logger }): Promise<AssignmentsStore> {
    let raw: string;
    try {
      raw = await fs.readFile(input.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new AssignmentsStore(input.filePath, emptyAssignments());
      }
      throw error;
    }
    const parsed = AssignmentsFileSchema.safeParse(parseJson(raw));
    if (parsed.success) return new AssignmentsStore(input.filePath, parsed.data);

    const asidePath = `${input.filePath}.corrupt-${Date.now()}`;
    await fs.rename(input.filePath, asidePath);
    input.logger.warn(
      { filePath: input.filePath, asidePath },
      "Knowledge-base assignments file is corrupt; moved it aside and started empty",
    );
    return new AssignmentsStore(input.filePath, emptyAssignments());
  }

  getSnapshot(agentId: string): AgentSnapshot | null {
    return this.state.agents[agentId] ?? null;
  }

  async setSnapshot(agentId: string, snapshot: AgentSnapshot): Promise<void> {
    this.state = { ...this.state, agents: { ...this.state.agents, [agentId]: snapshot } };
    await this.persist();
  }

  getWorkspaceProject(workspaceId: string): string | null {
    return this.state.workspaces[workspaceId]?.project ?? null;
  }

  workspacesTaggedWith(project: string): string[] {
    return Object.entries(this.state.workspaces)
      .filter(([, tag]) => tag.project === project)
      .map(([workspaceId]) => workspaceId);
  }

  /** Tags `workspaceId` unless it already has a project. Returns whether it tagged. */
  async tagWorkspace(workspaceId: string, tag: WorkspaceTag): Promise<boolean> {
    if (this.state.workspaces[workspaceId]) return false;
    this.state = { ...this.state, workspaces: { ...this.state.workspaces, [workspaceId]: tag } };
    await this.persist();
    return true;
  }

  /** Points every snapshot and workspace tag on `from` at `to`: a rename or a merge. */
  async retargetProject(input: { from: string; to: string }): Promise<void> {
    const agents = Object.fromEntries(
      Object.entries(this.state.agents).map(([agentId, snapshot]) => [
        agentId,
        snapshot.project === input.from ? { ...snapshot, project: input.to } : snapshot,
      ]),
    );
    const workspaces = Object.fromEntries(
      Object.entries(this.state.workspaces).map(([workspaceId, tag]) => [
        workspaceId,
        tag.project === input.from ? { ...tag, project: input.to } : tag,
      ]),
    );
    this.state = { ...this.state, agents, workspaces };
    await this.persist();
  }

  /** Writes the latest state; concurrent mutations queue behind each other. */
  private async persist(): Promise<void> {
    const write = this.writeTail.then(() => writeJsonFileAtomic(this.filePath, this.state));
    this.writeTail = write.catch(() => undefined);
    await write;
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
