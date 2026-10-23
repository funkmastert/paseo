import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";

export type ResolveAgentIdentifierResult =
  | { ok: true; agentId: string }
  | { ok: false; error: string };

export interface ResolveAgentIdentifierDeps {
  agentStorage: Pick<AgentStorage, "list">;
  agentManager: Pick<AgentManager, "listAgents">;
}

export async function resolveAgentIdentifier(
  identifier: string,
  deps: ResolveAgentIdentifierDeps,
): Promise<ResolveAgentIdentifierResult> {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return { ok: false, error: "Agent identifier cannot be empty" };
  }

  const stored = await deps.agentStorage.list();
  const storedRecords = stored.filter((record) => !record.internal);
  const knownIds = new Set<string>();
  for (const record of storedRecords) {
    knownIds.add(record.id);
  }
  for (const agent of deps.agentManager.listAgents()) {
    knownIds.add(agent.id);
  }

  if (knownIds.has(trimmed)) {
    return { ok: true, agentId: trimmed };
  }

  const prefixMatches = Array.from(knownIds).filter((id) => id.startsWith(trimmed));
  if (prefixMatches.length === 1) {
    return { ok: true, agentId: prefixMatches[0] };
  }
  if (prefixMatches.length > 1) {
    return {
      ok: false,
      error: `Agent identifier "${trimmed}" is ambiguous (${prefixMatches
        .slice(0, 5)
        .map((id) => id.slice(0, 8))
        .join(", ")}${prefixMatches.length > 5 ? ", …" : ""})`,
    };
  }

  const titleMatches = storedRecords.filter((record) => record.title === trimmed);
  if (titleMatches.length === 1) {
    return { ok: true, agentId: titleMatches[0].id };
  }
  if (titleMatches.length > 1) {
    return {
      ok: false,
      error: `Agent title "${trimmed}" is ambiguous (${titleMatches
        .slice(0, 5)
        .map((r) => r.id.slice(0, 8))
        .join(", ")}${titleMatches.length > 5 ? ", …" : ""})`,
    };
  }

  return { ok: false, error: `Agent not found: ${trimmed}` };
}
