/**
 * Auto-pinning: a workspace gets pinned automatically the first time Tyler starts a session in
 * it — a brand new workspace, or a new agent tab in an existing one — so it sorts to the top of
 * the sidebar while it's active. Only a human-attributable create does this; agent- and
 * daemon-triggered creates (MCP `create_workspace`/`create_agent`, Hub executions, schedules,
 * heartbeats, remediation, restart recovery) never do, because they happen constantly and would
 * flood the pinned list.
 *
 * The pin this sets is not the same guarantee as a pin Tyler sets by hand: see isProtectivePin.
 * See docs/done-janitor.md#manual-pin-vs-auto-pin.
 */

import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "./workspace-registry.js";

/**
 * Whether a workspace's `pinnedAt` still protects it from the done janitor's dead pass, its
 * finished-question pass, and worktree reclamation. A manual pin — Tyler's own gesture, or any
 * record written before `pinSource` existed — always does. An auto pin only holds the workspace
 * at the top of the sidebar while it's active; once the janitor's normal quiet-and-done rules
 * would otherwise reclaim it, an auto pin no longer stands in the way.
 */
export function isProtectivePin(
  workspace: Pick<PersistedWorkspaceRecord, "pinnedAt" | "pinSource">,
): boolean {
  return Boolean(workspace.pinnedAt) && workspace.pinSource !== "auto";
}

/**
 * Pins `workspaceId` as `"auto"` unless it is already pinned by any means. Pinning by hand always
 * takes precedence and is never downgraded or overwritten here — this only ever moves a workspace
 * from unpinned to auto-pinned.
 *
 * Callers gate this on a human-attributable create (see docs/done-janitor.md#manual-pin-vs-auto-pin for the
 * signal and its known gap) and on the `agents.autoPinSessions` config flag.
 */
export async function autoPinWorkspaceOnSessionStart(
  registry: Pick<WorkspaceRegistry, "get" | "update">,
  workspaceId: string,
  now: () => string = () => new Date().toISOString(),
): Promise<PersistedWorkspaceRecord | null> {
  const existing = await registry.get(workspaceId);
  if (!existing) return null;
  if (existing.pinnedAt) return existing;
  return registry.update(workspaceId, (record) => {
    if (record.pinnedAt) return record;
    const timestamp = now();
    return { ...record, pinnedAt: timestamp, pinSource: "auto", updatedAt: timestamp };
  });
}
