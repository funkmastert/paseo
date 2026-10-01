/**
 * Pure attribution of an OS-level `ps` snapshot to live agents, for AgentResourceMonitor. An
 * agent's root process is the one whose command line carries `callerAgentId=<agentId>` — the
 * Paseo MCP URL `withRuntimePaseoMcpServer` (runtime-mcp-config.ts) injects into every launch —
 * and its process tree is everything reachable from that root by walking `ppid`. Processes that
 * get reparented to pid 1 (a crashed shell, a detached daemon) fall out of every agent's tree;
 * see docs/resource-monitor.md for why that's a separate machine-level signal instead of an
 * attribution gap we try to paper over.
 *
 * `buildChildrenByPpid` and `collectDescendants` are exported for build-daemon-reaper.ts, which
 * reuses the same walk to sum a build daemon's worker children into its own CPU reading.
 */

import { isOrphanBuildDaemonCommand } from "./build-daemon-signatures.js";
import type { ProcessSampleRow } from "./process-sampler.js";

export interface AgentProcessTree {
  agentId: string;
  rssBytes: number;
  cpuPercent: number;
  pids: number[];
}

export interface OrphanBuildDaemonSummary {
  count: number;
  rssBytes: number;
  pids: number[];
}

export interface AttributeProcessTreesResult {
  agentTrees: AgentProcessTree[];
  orphanBuildDaemons: OrphanBuildDaemonSummary;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The marker must end at a query-string or shell boundary so `callerAgentId=abc` never claims
 * `callerAgentId=abcd`'s process. Agent ids are UUIDs today, which makes a prefix collision
 * impossible in practice; the anchor keeps that true if ids ever change shape.
 */
function findRootPid(rows: readonly ProcessSampleRow[], agentId: string): number | undefined {
  const marker = new RegExp(`callerAgentId=${escapeRegExp(agentId)}(?=[&\\s"'\\]}]|$)`);
  return rows.find((row) => marker.test(row.command))?.pid;
}

export function buildChildrenByPpid(
  rows: readonly ProcessSampleRow[],
): Map<number, ProcessSampleRow[]> {
  const childrenByPpid = new Map<number, ProcessSampleRow[]>();
  for (const row of rows) {
    const siblings = childrenByPpid.get(row.ppid) ?? [];
    siblings.push(row);
    childrenByPpid.set(row.ppid, siblings);
  }
  return childrenByPpid;
}

export function collectDescendants(
  rootPid: number,
  rowsByPid: Map<number, ProcessSampleRow>,
  childrenByPpid: Map<number, ProcessSampleRow[]>,
): ProcessSampleRow[] {
  const collected: ProcessSampleRow[] = [];
  const seen = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = rowsByPid.get(pid);
    if (!row) continue;
    collected.push(row);
    for (const child of childrenByPpid.get(pid) ?? []) {
      queue.push(child.pid);
    }
  }
  return collected;
}

function summarize(rows: readonly ProcessSampleRow[]): {
  rssBytes: number;
  cpuPercent: number;
  pids: number[];
} {
  let rssKb = 0;
  let cpuPercent = 0;
  const pids: number[] = [];
  for (const row of rows) {
    rssKb += row.rssKb;
    cpuPercent += row.cpuPercent;
    pids.push(row.pid);
  }
  return { rssBytes: rssKb * 1024, cpuPercent, pids };
}

/**
 * Build daemons commonly left running by an agent's tool calls — Gradle, Kotlin and .NET compiler
 * servers, MSBuild node-reuse workers and Metro all detach (ppid 1) by design once their parent
 * shell exits, so they can never join an agent's process tree above. What counts is decided in
 * build-daemon-signatures.ts, which keeps the list small and exact: a matcher that's too broad
 * risks folding an unrelated process into "orphan build daemon" accounting.
 */
function findOrphanBuildDaemons(
  rows: readonly ProcessSampleRow[],
  attributedPids: ReadonlySet<number>,
): OrphanBuildDaemonSummary {
  const daemonRows = rows.filter(
    (row) =>
      row.ppid === 1 && !attributedPids.has(row.pid) && isOrphanBuildDaemonCommand(row.command),
  );
  const { rssBytes, pids } = summarize(daemonRows);
  return { count: daemonRows.length, rssBytes, pids };
}

export interface AttributeProcessTreesOptions {
  /**
   * Processes the daemon itself started on an agent's behalf (`ask_jev`'s command), by agent.
   * They are the daemon's children, not the agent CLI's, so no marker or ppid walk finds them;
   * each is a second root of the agent's tree (agent/agent-side-processes.ts).
   */
  extraRoots?: ReadonlyMap<string, readonly number[]>;
}

export function attributeProcessTrees(
  rows: readonly ProcessSampleRow[],
  agentIds: readonly string[],
  options: AttributeProcessTreesOptions = {},
): AttributeProcessTreesResult {
  const rowsByPid = new Map(rows.map((row) => [row.pid, row] as const));
  const childrenByPpid = buildChildrenByPpid(rows);
  const attributedPids = new Set<number>();

  const agentTrees: AgentProcessTree[] = [];
  for (const agentId of agentIds) {
    const markerRoot = findRootPid(rows, agentId);
    const roots = [
      ...(markerRoot === undefined ? [] : [markerRoot]),
      ...(options.extraRoots?.get(agentId) ?? []),
    ];
    const treeRows: ProcessSampleRow[] = [];
    const inTree = new Set<number>();
    for (const root of roots) {
      for (const row of collectDescendants(root, rowsByPid, childrenByPpid)) {
        if (inTree.has(row.pid)) continue;
        inTree.add(row.pid);
        treeRows.push(row);
      }
    }
    if (treeRows.length === 0) continue;
    for (const row of treeRows) attributedPids.add(row.pid);
    const { rssBytes, cpuPercent, pids } = summarize(treeRows);
    agentTrees.push({ agentId, rssBytes, cpuPercent, pids });
  }

  return { agentTrees, orphanBuildDaemons: findOrphanBuildDaemons(rows, attributedPids) };
}
