/**
 * Live registry of forge CLI (`tea`/`gh`/`glab`) child pids the daemon has spawned directly and
 * that are still running, for the done janitor's occupied-directory check (R4,
 * docs/done-janitor.md). `DaemonProcessOwnershipTracker` (daemon-process-ownership.ts) answers the
 * same question from the resource monitor's once-a-minute `ps` sample, which a short-lived forge
 * poll — `tea pr list` typically exits before the next sample — can start and finish between two
 * samples without ever appearing in one. A pid absent from every sample reads as a confident
 * "not the daemon's own" (`isDaemonOwnChildPid` finds no row and returns `false`), not "unknown",
 * so that gap used to make the janitor keep a worktree for a process that was the daemon's own
 * forge poll the whole time. This registry is updated synchronously at spawn and at exit, so it
 * never depends on a sample's timing.
 */

const liveForgePollPids = new Set<number>();

export function markForgePollPidLive(pid: number): void {
  liveForgePollPids.add(pid);
}

export function clearForgePollPid(pid: number): void {
  liveForgePollPids.delete(pid);
}

export function isForgePollPidLive(pid: number): boolean {
  return liveForgePollPids.has(pid);
}
