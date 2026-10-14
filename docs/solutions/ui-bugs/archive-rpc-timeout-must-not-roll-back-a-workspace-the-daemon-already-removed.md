---
title: An archive RPC timeout is an unknown outcome, so an optimistic rollback must not resurrect a workspace the daemon already removed
date: 2026-10-13
category: ui-bugs
module: workspace-archive
problem_type: ui_bug
component: tooling
symptoms:
  - "an archived pinned worktree workspace reappears in the sidebar Pinned section about a minute after the archive, even though the daemon archived it within seconds"
  - "opening the reappeared workspace shows a draft tab, and sending from its composer fails with 'Workspace <id> not found' because create_agent is rejected for an archived workspace"
  - "daemon.log has a ws_slow_request for archive_workspace_request with durationMs over 60000 (the client RPC timeout), and 'Workspace archived' was logged a few seconds into that request"
root_cause: async_timing
resolution_type: code_fix
severity: medium
related_components:
  - workspace-directory-sync
  - workspace-auto-pin
  - daemon-client
tags:
  [
    optimistic-ui,
    rollback,
    rpc-timeout,
    archive-workspace,
    pinned-workspace,
    workspace-replica,
    auto-pin,
    race-condition,
  ]
---

# An archive RPC timeout is an unknown outcome, so an optimistic rollback must not resurrect a workspace the daemon already removed

## Problem

Archiving a pinned worktree workspace from the app could put it back in the sidebar's Pinned section
about a minute later. Opening it then failed with `Workspace <id> not found`. The client's optimistic
archive rolled back on an RPC timeout and restored a workspace the daemon had already archived.

## Symptoms

- A pinned workspace archived from the app reappears under Pinned shortly after. The pinned grid and
  the broadcast targets show it too: all three read the same session store.
- Opening it shows a draft tab with no live agent. Sending from the draft composer fails because the
  daemon rejects `create_agent` for an archived workspace
  (`packages/server/src/server/session.ts:4373-4374`:
  `if (!workspace || workspace.archivedAt) throw new Error(...)`).
- `daemon.log` has `ws_slow_request` with `requestType: "archive_workspace_request"` and `durationMs`
  over 60000, while `Workspace archived` was logged a few seconds into the same request. This is the
  diagnosis tell. The observed request took 112178 ms.
- The record in `workspaces.json` has `archivedAt` set and still carries `pinnedAt` and
  `pinSource: "auto"`. That is harmless on its own: archived records never reach clients.

## What Didn't Work

- **Looking for the cause in the Pinned projection.** `packages/app/src/components/sidebar/sidebar-projection.ts`
  and `packages/app/src/hooks/use-sidebar-pins.ts` derive only from session-store state. They were correct;
  the store held a workspace it should not have.
- **Suspecting the daemon or auto-pin.** The daemon's workspace directory drops archived records from
  descriptors and sends `workspace_update` remove. Auto-pin runs only after a successful create, and
  `AutoPinExpiry` skips archived records, so neither re-pinned anything. The leftover `pinnedAt` on
  the archived record needs no migration because no client ever sees it.
- **Suspecting the replica cache.** Route prep can load a workspace from the on-disk replica cache,
  but `readRows` flushes pending deletes before reading, so the cache had already dropped it.
- **"The pending mark is gone, so the daemon's remove landed."** The first fix resolved instead of
  restoring when `isWorkspaceArchivePending` was false. Review found a hole: the rollback itself
  (`restoreOptimisticallyHiddenWorkspace`, `packages/app/src/workspace/workspace-archive.ts:59-71`)
  also clears the mark. With two overlapping archives of one workspace, the first one's refusal clears
  the mark, and the second one's refusal then resolves silently, no error shown, while the
  workspace is back.
- **A per-call count of in-flight archives.** It keeps the first refusal from clearing the mark, but
  then the first call's restore is suppressed while the second is pending, and the second call's
  snapshot is `null` because the first call already hid the workspace. A double refusal would lose
  the workspace from the store.

## Solution

Fix on branch `fix/pinned-archived-workspace` (unmerged as of this writing).

Record the authoritative event, the daemon removing the workspace, as its own monotonic count, and
key the rollback on that count instead of on the pending mark.

`packages/app/src/contexts/session-workspace-upserts.ts:51-79`:

```ts
// How many times the daemon removed each workspace while an archive of it was pending.
const archiveRemovalsByKey = new Map<string, number>();

export function confirmWorkspaceArchiveRemoved(input: {
  serverId: string;
  workspaceId: string;
}): void {
  const key = archiveRemovalKey(input);
  if (!key || !isWorkspaceArchivePending(input)) return;
  archiveRemovalsByKey.set(key, (archiveRemovalsByKey.get(key) ?? 0) + 1);
  clearWorkspaceArchivePending(input);
}
```

`packages/app/src/runtime/directory-sync/workspace-replica.ts` calls `confirmWorkspaceArchiveRemoved`
from both paths where a daemon delta removes a workspace: the `workspace_update` remove handler
(line 185) and the project-remove cascade (line 138).

`packages/app/src/workspace/workspace-archive.ts:83-108`, before:

```ts
const snapshot = hideWorkspaceOptimistically(input.workspace);
try {
  await archiveWorkspaceOrThrow({ client: input.client, workspaceId: input.workspace.workspaceId });
} catch (error) {
  restoreOptimisticallyHiddenWorkspace({ ...input.workspace, snapshot });
  throw error;
}
```

After:

```ts
const removalsBefore = countWorkspaceArchiveRemovals(input.workspace);
const snapshot = hideWorkspaceOptimistically(input.workspace);
try {
  await archiveWorkspaceOrThrow({ client: input.client, workspaceId: input.workspace.workspaceId });
} catch (error) {
  if (countWorkspaceArchiveRemovals(input.workspace) !== removalsBefore) return;
  restoreOptimisticallyHiddenWorkspace({ ...input.workspace, snapshot });
  throw error;
}
```

A refusal with no daemon remove keeps the old behavior: restore and rethrow. Because only a daemon
remove bumps the count, the overlapping-refusal case still restores and reports.

The same change closes a daemon-side race: `autoPinWorkspaceOnSessionStart`
(`packages/server/src/server/workspace-auto-pin.ts:129-148`) now skips archived records, both in the
pre-check (line 137) and inside the `registry.update` callback (line 142), so a create that resolved
the workspace before an archive cannot pin the archived record afterwards.

## Why This Works

`archiveByScopeWithPriority` (`packages/server/src/server/workspace-archive-service.ts`) archives the
records in `archiveTargetRecords` (line 212), whose registry write makes each session send its
`workspace_update` remove, and only then
runs the slow steps: a forced git snapshot of the main repo (lines 218-221) and worktree teardown
and deletion in `maybeRemoveDirectory` (line 233). The response waits for all of it. The client waits 60 s
by default (`DEFAULT_SESSION_RPC_TIMEOUT_MS`, `packages/client/src/daemon-client.ts:1024`), and
`archiveWorkspace` sets no longer timeout. On a big worktree under load, the remove arrives in seconds
and the request times out a minute later.

A timeout means the client stopped waiting, not that the daemon refused. The old code treated every
rejection as a refusal and restored a snapshot taken before the archive. The daemon had already sent
its only remove, so nothing corrected the store until the next directory refresh. Counting daemon
removes gives the rollback a signal that means one thing on every path: the daemon took the workspace
away. Nothing else touches that count.

## Prevention

- When an optimistic update rolls back on "the request failed", check first whether the server's push
  channel already confirmed the change. Key that check on an explicit record of the confirmation, never
  on the absence of local bookkeeping that other paths also clear.
- A mutating RPC that can outlive the client timeout needs a test where the authoritative delta lands
  and then the request times out. `packages/app/src/workspace/workspace-archive.test.ts`
  ("keeps a pinned workspace gone when the daemon removed it before the request timed out"):

  ```ts
  const archive = archiveWorkspaceOptimistically({ client, workspace: target() });
  new WorkspaceDirectoryReplica(SERVER_ID).applyDelta({ kind: "remove", id: archived.id });
  releaseArchive.reject(new Error("Timed out waiting for archive_workspace_response"));
  const outcome = await archive.then(
    () => "archived",
    () => "failed",
  );

  expect(storedWorkspace(archived.id)).toBeUndefined();
  expect(outcome).toBe("archived");
  ```

  Pair it with the refusal cases: "restores the workspace and clears pending state when the daemon
  rejects the archive" and "still reports a refused archive when an overlapping archive of the same
  workspace failed first".

- Known gaps left open: a reconnect during the archive replaces the directory from a snapshot, which
  does not bump the count, so a failure after a reconnect still restores until the next refresh. The
  archive RPC still uses the 60 s default although
  [architecture.md](../../architecture.md) says genuinely long-running RPCs should not. A daemon error
  reported after the remove landed (an unexpected failure in a later step) resolves without a toast.

## Related Issues

- [timeline-sync.md](../../timeline-sync.md) — the same rule for prompt submission: a canonical
  acknowledgement that arrives first stops a later transport error from rolling back the prompt.
- [agent-lifecycle.md](../../agent-lifecycle.md) — archive semantics; archive is global and the
  daemon owns it.
- [done-janitor.md](../../done-janitor.md) — `pinnedAt` and `pinSource`, manual pin vs. auto-pin.
- [suspect-auth-evidence-must-never-overwrite-confirmed-signed-out-state.md](../logic-errors/suspect-auth-evidence-must-never-overwrite-confirmed-signed-out-state.md)
  — weaker evidence must not overwrite a confirmed state; same family of lesson.
