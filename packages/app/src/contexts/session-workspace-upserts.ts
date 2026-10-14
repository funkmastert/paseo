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

// How many archiveWorkspaceOptimistically calls are currently in flight for a workspace. Gating
// confirmWorkspaceArchiveRemoved on this instead of on isWorkspaceArchivePending matters when two
// archive calls overlap: call B can fail on a real (non-timeout) error and clear the pending mark
// via clearWorkspaceArchivePending before call A's daemon remove arrives. If the confirm only looked
// at the pending mark it would see "not pending" and drop the removal, so call A's later timeout
// would find no recorded removal and wrongly restore a workspace the daemon already removed. This
// counter tracks "is any call for this workspace still running" independently of the pending mark,
// so a sibling call's restore can't suppress a confirmation another call still needs. It also bounds
// archiveRemovalsByKey: once the last call for a key settles, both entries are dropped.
const outstandingArchiveCallsByKey = new Map<string, number>();

function archiveRemovalKey(input: { serverId: string; workspaceId: string }): string | null {
  const serverId = input.serverId.trim();
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  return serverId && workspaceId ? pendingArchiveKey({ serverId, workspaceId }) : null;
}

/** Call once an archive attempt begins, before any `countWorkspaceArchiveRemovals` read. */
export function trackWorkspaceArchiveCallStarted(input: {
  serverId: string;
  workspaceId: string;
}): void {
  const key = archiveRemovalKey(input);
  if (!key) return;
  outstandingArchiveCallsByKey.set(key, (outstandingArchiveCallsByKey.get(key) ?? 0) + 1);
}

/** Call once an archive attempt settles (success or failure) so its removal-count entry can be freed. */
export function trackWorkspaceArchiveCallSettled(input: {
  serverId: string;
  workspaceId: string;
}): void {
  const key = archiveRemovalKey(input);
  if (!key) return;
  const count = outstandingArchiveCallsByKey.get(key) ?? 0;
  if (count <= 1) {
    outstandingArchiveCallsByKey.delete(key);
    archiveRemovalsByKey.delete(key);
  } else {
    outstandingArchiveCallsByKey.set(key, count - 1);
  }
}

function hasOutstandingWorkspaceArchiveCall(input: {
  serverId: string;
  workspaceId: string;
}): boolean {
  const key = archiveRemovalKey(input);
  return Boolean(key && (outstandingArchiveCallsByKey.get(key) ?? 0) > 0);
}

/** The daemon removed this workspace; a pending archive of it took effect. */
export function confirmWorkspaceArchiveRemoved(input: {
  serverId: string;
  workspaceId: string;
}): void {
  const key = archiveRemovalKey(input);
  if (!key) return;
  // Either signal is enough: the pending mark covers the ordinary case (including tests that mark it
  // directly), and the outstanding-call count covers the case where a sibling call's restore already
  // cleared the pending mark while this workspace's own archive call is still running (see the
  // outstandingArchiveCallsByKey comment above).
  if (!isWorkspaceArchivePending(input) && !hasOutstandingWorkspaceArchiveCall(input)) return;
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
