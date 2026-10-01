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

  snapshot(): ReadonlyMap<string, readonly number[]> {
    return new Map([...this.byAgent].map(([agentId, pids]) => [agentId, [...pids]] as const));
  }
}
