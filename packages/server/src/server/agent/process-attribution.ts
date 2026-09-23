/**
 * Pure attribution of an OS-level `ps` snapshot to live agents, for AgentResourceMonitor. An
 * agent's root process is the one whose command line carries `callerAgentId=<agentId>` — the
 * Paseo MCP URL `withRuntimePaseoMcpServer` (runtime-mcp-config.ts) injects into every launch —
 * and its process tree is everything reachable from that root by walking `ppid`. Processes that
 * get reparented to pid 1 (a crashed shell, a detached daemon) fall out of every agent's tree;
 * see docs/resource-monitor.md for why that's a separate machine-level signal instead of an
 * attribution gap we try to paper over.
 */

import type { ProcessSampleRow } from "./process-sampler.js";

export interface AgentProcessTree {
  agentId: string;
  rssBytes: number;
  cpuPercent: number;
  pids: number[];
}

/**
 * Build daemons commonly left running by an agent's tool calls — Gradle and Kotlin's daemons
 * both detach (ppid 1) by design once their parent shell exits, so they can never join an
 * agent's process tree above. Keep this list small and additive: a marker that's too broad
 * risks folding an unrelated process into "orphan build daemon" accounting.
 */
export const ORPHAN_BUILD_DAEMON_MARKERS = ["GradleDaemon", "KotlinCompileDaemon"] as const;

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

function buildChildrenByPpid(rows: readonly ProcessSampleRow[]): Map<number, ProcessSampleRow[]> {
  const childrenByPpid = new Map<number, ProcessSampleRow[]>();
  for (const row of rows) {
    const siblings = childrenByPpid.get(row.ppid) ?? [];
    siblings.push(row);
    childrenByPpid.set(row.ppid, siblings);
  }
  return childrenByPpid;
}

function collectDescendants(
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

function findOrphanBuildDaemons(
  rows: readonly ProcessSampleRow[],
  attributedPids: ReadonlySet<number>,
): OrphanBuildDaemonSummary {
  const daemonRows = rows.filter(
    (row) =>
      row.ppid === 1 &&
      !attributedPids.has(row.pid) &&
      ORPHAN_BUILD_DAEMON_MARKERS.some((marker) => row.command.includes(marker)),
  );
  const { rssBytes, pids } = summarize(daemonRows);
  return { count: daemonRows.length, rssBytes, pids };
}

export function attributeProcessTrees(
  rows: readonly ProcessSampleRow[],
  agentIds: readonly string[],
): AttributeProcessTreesResult {
  const rowsByPid = new Map(rows.map((row) => [row.pid, row] as const));
  const childrenByPpid = buildChildrenByPpid(rows);
  const attributedPids = new Set<number>();

  const agentTrees: AgentProcessTree[] = [];
  for (const agentId of agentIds) {
    const rootPid = findRootPid(rows, agentId);
    if (rootPid === undefined) continue;
    const treeRows = collectDescendants(rootPid, rowsByPid, childrenByPpid);
    for (const row of treeRows) attributedPids.add(row.pid);
    const { rssBytes, cpuPercent, pids } = summarize(treeRows);
    agentTrees.push({ agentId, rssBytes, cpuPercent, pids });
  }

  return { agentTrees, orphanBuildDaemons: findOrphanBuildDaemons(rows, attributedPids) };
}
