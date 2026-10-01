/**
 * Daemon-facing entry point: resolves an agent (optionally its whole parentAgentId tree) against
 * the live fleet plus stored records, then hands plain targets to the provider-independent search
 * core. Shared by the `search_agent_transcript` MCP tool and the `agent.transcript_search.search`
 * RPC the CLI uses, so both answer identically.
 */

import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import {
  searchTranscripts,
  type AgentCoverage,
  type AgentSearchResult,
  type TranscriptExcerpt,
  type TranscriptSearchTarget,
} from "./search-core.js";

export type { AgentCoverage, AgentSearchResult, TranscriptExcerpt };

/** A tree larger than this is searched up to the cap; the rest are not attempted. */
export const MAX_SEARCH_TARGETS = 50;

const COMPACT_LIMITS = { maxMatchesPerAgent: 5, maxExcerptChars: 200, maxTotalBytes: 6_000 };
const FULL_LIMITS = { maxMatchesPerAgent: 20, maxExcerptChars: 500, maxTotalBytes: 30_000 };

interface FleetEntry {
  id: string;
  title: string | null;
  provider: string;
  cwd: string;
  sessionId: string | null;
  labels: Record<string, string>;
}

async function loadEntries(
  agentManager: AgentManager,
  agentStorage: AgentStorage,
): Promise<Map<string, FleetEntry>> {
  const byId = new Map<string, FleetEntry>();
  for (const record of await agentStorage.list()) {
    if (record.internal) continue;
    byId.set(record.id, {
      id: record.id,
      title: record.title ?? null,
      provider: record.provider,
      cwd: record.cwd,
      sessionId: record.persistence?.sessionId ?? record.runtimeInfo?.sessionId ?? null,
      labels: record.labels,
    });
  }
  for (const agent of agentManager.listAgents()) {
    byId.set(agent.id, {
      id: agent.id,
      title: byId.get(agent.id)?.title ?? null,
      provider: agent.provider,
      cwd: agent.cwd,
      sessionId: agent.persistence?.sessionId ?? agent.runtimeInfo?.sessionId ?? null,
      labels: agent.labels,
    });
  }
  return byId;
}

function childrenOf(entries: Map<string, FleetEntry>, parentId: string): FleetEntry[] {
  return [...entries.values()].filter(
    (entry) => getParentAgentIdFromLabels(entry.labels) === parentId,
  );
}

/** Breadth-first so a capped tree keeps the agents closest to the root. */
function collectTree(entries: Map<string, FleetEntry>, rootId: string): FleetEntry[] {
  const root = entries.get(rootId);
  if (!root) return [];
  const result: FleetEntry[] = [root];
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of childrenOf(entries, current)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      result.push(child);
      queue.push(child.id);
    }
  }
  return result;
}

export interface SearchAgentTranscriptInput {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  rootAgentId: string;
  pattern: string;
  tree?: boolean;
  regex?: boolean;
  caseInsensitive?: boolean;
  full?: boolean;
}

export interface SearchAgentTranscriptOutcome {
  backend: "ripgrep" | "node";
  agents: AgentSearchResult[];
  /** True when the tree had more agents than `MAX_SEARCH_TARGETS`; the rest were never attempted. */
  targetSetTruncated: boolean;
}

export async function searchAgentTranscript(
  input: SearchAgentTranscriptInput,
): Promise<SearchAgentTranscriptOutcome> {
  const entries = await loadEntries(input.agentManager, input.agentStorage);
  if (!entries.has(input.rootAgentId)) {
    throw new Error(`Agent ${input.rootAgentId} is not known to the daemon`);
  }

  const fullSet = input.tree
    ? collectTree(entries, input.rootAgentId)
    : [entries.get(input.rootAgentId) as FleetEntry];
  const targetSetTruncated = fullSet.length > MAX_SEARCH_TARGETS;
  const targets: TranscriptSearchTarget[] = fullSet.slice(0, MAX_SEARCH_TARGETS).map((entry) => ({
    agentId: entry.id,
    title: entry.title,
    provider: entry.provider,
    cwd: entry.cwd,
    sessionId: entry.sessionId,
  }));

  const limits = input.full ? FULL_LIMITS : COMPACT_LIMITS;
  const result = await searchTranscripts(targets, {
    pattern: input.pattern,
    regex: input.regex ?? false,
    caseInsensitive: input.caseInsensitive ?? false,
    ...limits,
  });

  return { ...result, targetSetTruncated };
}
