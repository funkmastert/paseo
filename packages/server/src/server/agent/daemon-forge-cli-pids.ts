/**
 * Live registry of forge CLI (`tea`/`gh`/`glab`) child pids the daemon has spawned directly and
 * that are still running, for the done janitor's occupied-directory check (R4,
 * docs/done-janitor.md). `createForgeCliRunner` (services/forge-cli-command.ts) marks every call
 * it makes, a poll (`tea pr list`) and a mutating call (a merge, a comment) alike -- excusing a
 * mutating call from R4 is harmless, since the janitor only ever asks whether a pid occupies a
 * directory, never what it is doing there.
 *
 * `DaemonProcessOwnershipTracker` (daemon-process-ownership.ts) answers the same question from the
 * resource monitor's once-a-minute `ps` sample, which a short-lived call -- `tea pr list` typically
 * exits before the next sample -- can start and finish between two samples without ever appearing
 * in one. A pid absent from every sample reads as a confident "not the daemon's own"
 * (`isDaemonOwnChildPid` finds no row and returns `false`), not "unknown", so that gap used to
 * make the janitor keep a worktree for a process that was the daemon's own forge CLI child the
 * whole time. This registry is updated synchronously at spawn and at exit, so it never depends on
 * a sample's timing.
 */

const liveForgeCliChildPids = new Set<number>();

export function markForgeCliChildPidLive(pid: number): void {
  liveForgeCliChildPids.add(pid);
}

export function clearForgeCliChildPid(pid: number): void {
  liveForgeCliChildPids.delete(pid);
}

export function isForgeCliChildPidLive(pid: number): boolean {
  return liveForgeCliChildPids.has(pid);
}
