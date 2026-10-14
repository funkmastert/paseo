import type { WorkspaceDescriptor } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

interface PendingWorkspaceArchive {
  workspaceId: string;
}

const pendingWorkspaceArchivesByServer = new Map<string, Map<string, PendingWorkspaceArchive>>();

function pendingArchiveKey(input: { serverId: string; workspaceId: string }): string {
  return `${input.serverId.trim()}::${input.workspaceId.trim()}`;
}

export function markWorkspaceArchivePending(input: {
  serverId: string;
  workspaceId: string;
}): void {
  const serverId = input.serverId.trim();
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if (!serverId || !workspaceId) {
    return;
  }

  const archives = pendingWorkspaceArchivesByServer.get(serverId) ?? new Map();
  archives.set(pendingArchiveKey({ serverId, workspaceId }), {
    workspaceId,
  });
  pendingWorkspaceArchivesByServer.set(serverId, archives);
}

export function clearWorkspaceArchivePending(input: {
  serverId: string;
  workspaceId: string;
}): void {
  const serverId = input.serverId.trim();
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if (!serverId || !workspaceId) {
    return;
  }

  const archives = pendingWorkspaceArchivesByServer.get(serverId);
  if (!archives) {
    return;
  }
  archives.delete(pendingArchiveKey({ serverId, workspaceId }));
  if (archives.size === 0) {
    pendingWorkspaceArchivesByServer.delete(serverId);
  }
}

// How many times the daemon removed each workspace while an archive of it was pending. An archive
// call compares this with the count at its start to learn whether its archive took effect: the
// pending mark can't tell, because a failed overlapping call clears it too.
const archiveRemovalsByKey = new Map<string, number>();

function archiveRemovalKey(input: { serverId: string; workspaceId: string }): string | null {
  const serverId = input.serverId.trim();
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  return serverId && workspaceId ? pendingArchiveKey({ serverId, workspaceId }) : null;
}

/** The daemon removed this workspace; a pending archive of it took effect. */
export function confirmWorkspaceArchiveRemoved(input: {
  serverId: string;
  workspaceId: string;
}): void {
  const key = archiveRemovalKey(input);
  if (!key || !isWorkspaceArchivePending(input)) return;
  archiveRemovalsByKey.set(key, (archiveRemovalsByKey.get(key) ?? 0) + 1);
  clearWorkspaceArchivePending(input);
}

export function countWorkspaceArchiveRemovals(input: {
  serverId: string;
  workspaceId: string;
}): number {
  const key = archiveRemovalKey(input);
  return key ? (archiveRemovalsByKey.get(key) ?? 0) : 0;
}

export function isWorkspaceArchivePending(input: {
  serverId: string;
  workspaceId?: string | null;
}): boolean {
  const serverId = input.serverId.trim();
  if (!serverId) {
    return false;
  }

  const archives = pendingWorkspaceArchivesByServer.get(serverId);
  if (!archives) {
    return false;
  }

  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  return Boolean(workspaceId && archives.has(pendingArchiveKey({ serverId, workspaceId })));
}

export function shouldSuppressWorkspaceForLocalArchive(input: {
  serverId: string;
  workspace: WorkspaceDescriptor;
}): boolean {
  return isWorkspaceArchivePending({
    serverId: input.serverId,
    workspaceId: input.workspace.id,
  });
}
