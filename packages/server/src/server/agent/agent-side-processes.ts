const DEFAULT_SURVIVOR_POLL_MS = 2_000;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface TrackUntilExitOptions {
  /** Test seam; defaults to `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  pollMs?: number;
}

/**
 * Processes the daemon runs as an agent's own work (`ask_jev`'s command): the daemon's children,
 * charged to the agent so the resource monitor attributes, alerts on and throttles them with the
 * rest of its tree (docs/resource-monitor.md). A pid is held only while the process runs.
 */
export class AgentSideProcesses {
  private readonly byAgent = new Map<string, Set<number>>();

  /** Registers `pid` as a root of `agentId`'s tree; the returned function releases it. */
  add(agentId: string, pid: number): () => void {
    const pids = this.byAgent.get(agentId) ?? new Set<number>();
    pids.add(pid);
    this.byAgent.set(agentId, pids);
    return () => {
      const current = this.byAgent.get(agentId);
      if (!current) return;
      current.delete(pid);
      if (current.size === 0) this.byAgent.delete(agentId);
    };
  }

  /**
   * Registers `pid` the same way `add` does, but for a process the daemon never gets an exit
   * event for (`ask_jev`'s `command`, a descendant that left bash's process group with `setsid`
   * and survived the group kill). Polls `isAlive` until it says the pid is gone, then releases:
   * the only signal of its end the daemon can see is that the pid no longer exists.
   */
  trackUntilExit(agentId: string, pid: number, options: TrackUntilExitOptions = {}): void {
    const isAlive = options.isAlive ?? processIsAlive;
    const pollMs = options.pollMs ?? DEFAULT_SURVIVOR_POLL_MS;
    const release = this.add(agentId, pid);
    const timer = setInterval(() => {
      if (isAlive(pid)) return;
      clearInterval(timer);
      release();
    }, pollMs);
    // Never holds the daemon open waiting for a survivor to exit.
    timer.unref?.();
  }

  snapshot(): ReadonlyMap<string, readonly number[]> {
    return new Map([...this.byAgent].map(([agentId, pids]) => [agentId, [...pids]] as const));
  }
}
