import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";

export type ResolveAgentIdentifierResult =
  | { ok: true; agentId: string }
  | { ok: false; error: string };

export interface ResolveAgentIdentifierDeps {
  agentStorage: Pick<AgentStorage, "list" | "get">;
  agentManager: Pick<AgentManager, "listAgents" | "getAgent">;
}

export interface ResolveAgentIdentifierOptions {
  /**
   * Whether archived records are eligible for prefix/title matching. An exact id always resolves
   * an archived agent regardless of this option — it is only the ambiguous "which agent did you
   * mean" paths (prefix, title) that need to leave archived agents out, since several MCP tools
   * (send_agent_prompt) unarchive on resolve and a title match landing on a long-dead agent would
   * silently revive it.
   */
  includeArchived?: boolean;
}

/** Below this length, a prefix is too likely to collide by accident; fall through to title/not-found. */
const MIN_PREFIX_LENGTH = 4;

/** The length at which an ambiguity list's ids start getting truncated for display. */
const MIN_DISPLAY_PREFIX_LENGTH = 8;

function shortestDisambiguatingLength(ids: string[]): number {
  const maxLength = Math.max(...ids.map((id) => id.length));
  for (let length = MIN_DISPLAY_PREFIX_LENGTH; length < maxLength; length++) {
    const prefixes = new Set(ids.map((id) => id.slice(0, length)));
    if (prefixes.size === ids.length) {
      return length;
    }
  }
  return maxLength;
}

function formatAmbiguousIds(ids: string[]): string {
  const shown = ids.slice(0, 5);
  const display =
    ids.length <= 5 ? shown : shown.map((id) => id.slice(0, shortestDisambiguatingLength(shown)));
  const suffix = ids.length > 5 ? ", …" : "";
  return `${display.join(", ")}${suffix}`;
}

export async function resolveAgentIdentifier(
  identifier: string,
  deps: ResolveAgentIdentifierDeps,
  options: ResolveAgentIdentifierOptions = {},
): Promise<ResolveAgentIdentifierResult> {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return { ok: false, error: "Agent identifier cannot be empty" };
  }
  const includeArchived = options.includeArchived ?? false;

  // Fast path: most callers already have the full id. Resolve it without building the full
  // agent list — an exact id always resolves, archived or not.
  const liveAgent = deps.agentManager.getAgent(trimmed);
  if (liveAgent && !liveAgent.internal) {
    return { ok: true, agentId: trimmed };
  }
  const storedRecord = await deps.agentStorage.get(trimmed);
  if (storedRecord && !storedRecord.internal) {
    return { ok: true, agentId: trimmed };
  }

  // Miss: the fast path above already covers every exact id an internal-consistent
  // AgentStorage/AgentManager pair can produce, so the only work left is prefix/title matching.
  const stored = await deps.agentStorage.list();
  const nonInternalRecords = stored.filter((record) => !record.internal);
  const nonInternalLiveAgents = deps.agentManager.listAgents().filter((agent) => !agent.internal);

  const candidateRecords = includeArchived
    ? nonInternalRecords
    : nonInternalRecords.filter((record) => !record.archivedAt);
  const candidateIds = new Set<string>();
  for (const record of candidateRecords) {
    candidateIds.add(record.id);
  }
  for (const agent of nonInternalLiveAgents) {
    candidateIds.add(agent.id);
  }

  if (trimmed.length >= MIN_PREFIX_LENGTH) {
    const prefixMatches = Array.from(candidateIds).filter((id) => id.startsWith(trimmed));
    if (prefixMatches.length === 1) {
      return { ok: true, agentId: prefixMatches[0] };
    }
    if (prefixMatches.length > 1) {
      return {
        ok: false,
        error: `Agent identifier "${trimmed}" is ambiguous (${formatAmbiguousIds(prefixMatches)})`,
      };
    }
  }

  const titleMatches = candidateRecords.filter((record) => record.title === trimmed);
  if (titleMatches.length === 1) {
    return { ok: true, agentId: titleMatches[0].id };
  }
  if (titleMatches.length > 1) {
    return {
      ok: false,
      error: `Agent title "${trimmed}" is ambiguous (${formatAmbiguousIds(titleMatches.map((r) => r.id))})`,
    };
  }

  return { ok: false, error: `Agent not found: ${trimmed}` };
}
