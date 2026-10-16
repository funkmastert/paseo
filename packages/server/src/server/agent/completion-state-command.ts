/**
 * `set_completion_state` (docs/completion-state.md): an agent's own claim that it is
 * `ready-to-merge` or `done`, verified before it is accepted. Reuses the done janitor's worktree
 * git gate (done-janitor-worktree.ts) for the "work exists nowhere else" check rather than writing
 * a second one.
 */

import {
  checkMergedIntoRemoteBase,
  checkWorktreeDeletionSafety,
  type CheckMergedIntoRemoteBaseInput,
  type CheckWorktreeDeletionSafetyInput,
  type MergedIntoRemoteBase,
  type WorktreeDeletionSafety,
} from "../done-janitor-worktree.js";
import {
  COMPLETION_AT_LABEL,
  COMPLETION_LABEL,
  COMPLETION_NOTE_LABEL,
  getParentAgentIdFromLabels,
  type CompletionState,
} from "@getpaseo/protocol/agent-labels";

export type CompletionStateInputState = CompletionState | "clear";

export interface CompletionStateAgentView {
  id: string;
  workspaceId?: string;
  labels: Record<string, string>;
  pendingPermissionCount: number;
  lifecycle: "initializing" | "idle" | "running" | "error" | "closed";
}

export interface CompletionStateAgentManager {
  getAgent(agentId: string): CompletionStateAgentView | null;
  listAgents(): CompletionStateAgentView[];
  setLabels(agentId: string, labels: Record<string, string | null>): Promise<void>;
}

export interface CompletionStateWorkspaceView {
  kind: "local_checkout" | "worktree" | "directory";
  cwd: string;
  worktreeRoot: string | null;
  baseBranch: string | null;
}

export interface CompletionStateWorkspaceRegistry {
  get(workspaceId: string): Promise<CompletionStateWorkspaceView | null>;
}

export interface SetCompletionStateInput {
  /** The MCP caller: always a real agent id, never absent (the tool requires one). */
  callerAgentId: string;
  /** Target a child the caller created. Omit to target the caller itself. */
  agentId?: string;
  state: CompletionStateInputState;
  note?: string;
}

export interface SetCompletionStateResult {
  success: true;
  state: CompletionState | null;
  note: string | null;
  completionAt: string | null;
  /** Set when a check could not be run (no workspace record, not a worktree, no remote base) and
   * the call was allowed through anyway rather than refused. */
  gateNote?: string;
}

export interface CompletionStateCommandDependencies {
  agentManager: CompletionStateAgentManager;
  workspaceRegistry?: CompletionStateWorkspaceRegistry;
  checkWorktreeDeletionSafety?: (
    input: CheckWorktreeDeletionSafetyInput,
  ) => Promise<WorktreeDeletionSafety>;
  checkMergedIntoRemoteBase?: (
    input: CheckMergedIntoRemoteBaseInput,
  ) => Promise<MergedIntoRemoteBase>;
}

function clearedResult(): SetCompletionStateResult {
  return { success: true, state: null, note: null, completionAt: null };
}

/** Every unarchived agent whose parent chain reaches `rootId`, cycle-safe (a label loop stops). */
function listDescendants(
  rootId: string,
  agents: readonly CompletionStateAgentView[],
): CompletionStateAgentView[] {
  const childrenByParent = new Map<string, CompletionStateAgentView[]>();
  for (const agent of agents) {
    const parent = getParentAgentIdFromLabels(agent.labels);
    if (!parent) continue;
    const siblings = childrenByParent.get(parent);
    if (siblings) siblings.push(agent);
    else childrenByParent.set(parent, [agent]);
  }
  const descendants: CompletionStateAgentView[] = [];
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const next = queue.shift()!;
    for (const child of childrenByParent.get(next) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      descendants.push(child);
      queue.push(child.id);
    }
  }
  return descendants;
}

function resolveTarget(
  agentManager: CompletionStateAgentManager,
  input: SetCompletionStateInput,
): CompletionStateAgentView {
  const targetId = input.agentId ?? input.callerAgentId;
  const target = agentManager.getAgent(targetId);
  if (!target) {
    throw new Error(`Agent ${targetId} not found`);
  }
  if (input.agentId && input.agentId !== input.callerAgentId) {
    const parentId = getParentAgentIdFromLabels(target.labels);
    if (parentId !== input.callerAgentId) {
      throw new Error(`Refused: ${input.callerAgentId} is not the parent of ${input.agentId}`);
    }
  }
  return target;
}

function refuseIfNotFinished(
  agentManager: CompletionStateAgentManager,
  target: CompletionStateAgentView,
): void {
  if (target.pendingPermissionCount > 0) {
    throw new Error("Refused: a pending permission or question is still open");
  }
  for (const descendant of listDescendants(target.id, agentManager.listAgents())) {
    if (descendant.lifecycle === "running" || descendant.lifecycle === "initializing") {
      throw new Error(`Refused: child agent ${descendant.id} is still ${descendant.lifecycle}`);
    }
  }
}

/** Runs the worktree git gate for `target`. Returns a note when a check was skipped or
 * inconclusive; throws to refuse. A no-op (no note) when every check passed cleanly. */
async function runWorktreeGate(
  dependencies: CompletionStateCommandDependencies,
  target: CompletionStateAgentView,
  state: CompletionState,
): Promise<string | undefined> {
  const checkSafety = dependencies.checkWorktreeDeletionSafety ?? checkWorktreeDeletionSafety;
  const checkMerged = dependencies.checkMergedIntoRemoteBase ?? checkMergedIntoRemoteBase;

  const workspace = target.workspaceId
    ? await dependencies.workspaceRegistry?.get(target.workspaceId)
    : null;
  if (!workspace) return "no workspace record for this agent; the worktree gate was skipped";
  if (workspace.kind !== "worktree") return "not a worktree, allowing";

  const worktreePath = workspace.worktreeRoot ?? workspace.cwd;
  const safety = await checkSafety({ worktreePath, baseBranch: workspace.baseBranch });
  if (!safety.safe) {
    throw new Error(`Refused: ${safety.reason}`);
  }
  if (state !== "done") return undefined;

  const merged = await checkMerged({ worktreePath, baseBranch: workspace.baseBranch });
  if (merged.merged === false) {
    throw new Error(`Refused: ${merged.reason}`);
  }
  return merged.merged === null ? merged.reason : undefined;
}

export async function setCompletionStateCommand(
  dependencies: CompletionStateCommandDependencies,
  input: SetCompletionStateInput,
): Promise<SetCompletionStateResult> {
  const { agentManager } = dependencies;
  const target = resolveTarget(agentManager, input);

  if (input.state === "clear") {
    await agentManager.setLabels(target.id, {
      [COMPLETION_LABEL]: null,
      [COMPLETION_NOTE_LABEL]: null,
      [COMPLETION_AT_LABEL]: null,
    });
    return clearedResult();
  }

  refuseIfNotFinished(agentManager, target);
  const gateNote = await runWorktreeGate(dependencies, target, input.state);

  const note = input.note?.trim() || null;
  const completionAt = new Date().toISOString();
  await agentManager.setLabels(target.id, {
    [COMPLETION_LABEL]: input.state,
    [COMPLETION_NOTE_LABEL]: note,
    [COMPLETION_AT_LABEL]: completionAt,
  });

  return {
    success: true,
    state: input.state,
    note,
    completionAt,
    ...(gateNote ? { gateNote } : {}),
  };
}
