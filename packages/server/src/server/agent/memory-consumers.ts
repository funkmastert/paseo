/**
 * Ranks the process trees in one `ps` sample by RSS, for the system-memory condition's evidence:
 * "what holds the memory" is the first thing a person or a remediation agent asks, and the
 * monitor already has the answer in the rows it sampled. Pure.
 *
 * A tree is everything under a top-level ancestor. A live agent's tree is carved out first and
 * labelled with the agent, otherwise the daemon (every agent's parent) would absorb them all.
 */

import type { AgentProcessTree } from "./process-attribution.js";
import type { ProcessSampleRow } from "./process-sampler.js";

const DEFAULT_LIMIT = 8;
const GIBIBYTE = 1024 ** 3;

export interface MemoryConsumer {
  label: string;
  rssBytes: number;
  processCount: number;
  /** Set when the tree is a live agent's. */
  agentId?: string;
}

export interface SummarizeMemoryConsumersInput {
  rows: readonly ProcessSampleRow[];
  agentTrees: readonly AgentProcessTree[];
  /** Human names for agents, by id. An agent without one is labelled by id. */
  agentLabels?: ReadonlyMap<string, string>;
  limit?: number;
}

const FULLY_QUALIFIED_CLASS = /^[A-Za-z_][\w$]*(\.[A-Za-z_$][\w$]*)+$/;

/** A short name for a process from its `ps` command line: the program, or the JVM's main class. */
export function describeProcess(command: string): string {
  // `ps` joins argv with spaces, so a path holding one ("Android Studio.app") cannot be split
  // by whitespace. The executable ends where the first option starts.
  const optionStart = command.search(/\s-/);
  const executable = optionStart === -1 ? command : command.slice(0, optionStart);
  const firstToken = executable.trim().split(/\s+/)[0] ?? "";
  const name = (executable.includes("/") ? executable.split("/").pop() : firstToken) ?? "";
  const base = name.trim().split(/\s+/)[0] || "unknown";
  if (base === "java") {
    const mainClass = command
      .split(/\s+/)
      .find(
        (token) => FULLY_QUALIFIED_CLASS.test(token) && /[A-Z]/.test(token.split(".").pop() ?? ""),
      );
    if (mainClass) return `java ${mainClass}`;
  }
  return base;
}

export function summarizeMemoryConsumers(input: SummarizeMemoryConsumersInput): MemoryConsumer[] {
  const consumers: MemoryConsumer[] = [];
  const claimed = new Set<number>();

  for (const tree of input.agentTrees) {
    for (const pid of tree.pids) claimed.add(pid);
    consumers.push({
      agentId: tree.agentId,
      label: `agent ${input.agentLabels?.get(tree.agentId) ?? tree.agentId}`,
      rssBytes: tree.rssBytes,
      processCount: tree.pids.length,
    });
  }

  const remaining = new Map<number, ProcessSampleRow>();
  for (const row of input.rows) {
    if (!claimed.has(row.pid)) remaining.set(row.pid, row);
  }

  const topOf = new Map<number, number>();
  const findTop = (pid: number): number => {
    const known = topOf.get(pid);
    if (known !== undefined) return known;
    const path: number[] = [];
    const seen = new Set<number>();
    let current = pid;
    for (;;) {
      const cached = topOf.get(current);
      if (cached !== undefined) {
        current = cached;
        break;
      }
      const parent = remaining.get(current)?.ppid;
      if (seen.has(current) || parent === undefined || !remaining.has(parent)) break;
      seen.add(current);
      path.push(current);
      current = parent;
    }
    for (const visited of path) topOf.set(visited, current);
    topOf.set(pid, current);
    return current;
  };

  const trees = new Map<number, { rssKb: number; count: number }>();
  for (const pid of remaining.keys()) {
    const top = findTop(pid);
    const tree = trees.get(top) ?? { rssKb: 0, count: 0 };
    tree.rssKb += remaining.get(pid)?.rssKb ?? 0;
    tree.count += 1;
    trees.set(top, tree);
  }
  for (const [top, tree] of trees) {
    const root = remaining.get(top);
    consumers.push({
      label: `${describeProcess(root?.command ?? "")} (pid ${top})`,
      rssBytes: tree.rssKb * 1024,
      processCount: tree.count,
    });
  }

  consumers.sort((a, b) => b.rssBytes - a.rssBytes);
  return consumers.slice(0, input.limit ?? DEFAULT_LIMIT);
}

export function formatMemoryConsumers(consumers: readonly MemoryConsumer[]): string {
  return consumers
    .map((consumer) => {
      const size = `${(consumer.rssBytes / GIBIBYTE).toFixed(1)} GB`;
      const processes =
        consumer.processCount === 1 ? "(1 process)" : `across ${consumer.processCount} processes`;
      return `- ${consumer.label}: ${size} ${processes}`;
    })
    .join("\n");
}
