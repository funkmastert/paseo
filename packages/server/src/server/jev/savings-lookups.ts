/**
 * What the savings ledger shows beside each record (docs/jev.md, "Savings"): an agent's title, the
 * workspace it belongs to, and that workspace's name, for the dashboard's "where agents use it".
 * The ledger asks synchronously, so the stored agents and the workspaces are held in a cache that
 * refreshes in the background; a live agent answers first, without waiting for it.
 */

export interface SavingsLookupAgent {
  title?: string | null;
  workspaceId?: string | null;
}

export interface SavingsLookupStoredAgent extends SavingsLookupAgent {
  id: string;
}

export interface SavingsLookupWorkspace {
  workspaceId: string;
  title?: string | null;
  displayName: string;
}

export interface SavingsLookupSources {
  liveAgent: (agentId: string) => SavingsLookupAgent | null;
  listStoredAgents: () => Promise<readonly SavingsLookupStoredAgent[]>;
  listWorkspaces: () => Promise<readonly SavingsLookupWorkspace[]>;
  /** How old the cache may get before a lookup refreshes it. Default one minute. */
  refreshMs?: number;
  now?: () => number;
}

export interface SavingsLookups {
  agentTitle: (agentId: string) => string | null;
  workspaceOf: (agentId: string) => string | null;
  workspaceLabel: (workspaceId: string) => string | null;
  /** Reloads both caches now. Never rejects. */
  refresh: () => Promise<void>;
}

const DEFAULT_REFRESH_MS = 60_000;
/** A miss refreshes sooner: an agent or workspace created since the last load. */
const MISS_REFRESH_MS = 5_000;

function text(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function createSavingsLookups(sources: SavingsLookupSources): SavingsLookups {
  const now = sources.now ?? Date.now;
  const refreshMs = sources.refreshMs ?? DEFAULT_REFRESH_MS;
  let agents = new Map<string, SavingsLookupStoredAgent>();
  let workspaces = new Map<string, SavingsLookupWorkspace>();
  let loadedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;

  async function load(): Promise<void> {
    // A source that throws, even synchronously, leaves its cache as it was.
    const [stored, listed] = await Promise.all([
      Promise.resolve()
        .then(() => sources.listStoredAgents())
        .catch(() => null),
      Promise.resolve()
        .then(() => sources.listWorkspaces())
        .catch(() => null),
    ]);
    if (stored) agents = new Map(stored.map((agent) => [agent.id, agent]));
    if (listed) workspaces = new Map(listed.map((space) => [space.workspaceId, space]));
    loadedAt = now();
  }

  function refresh(): Promise<void> {
    inFlight ??= load().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function cached(hit: boolean): void {
    if (now() - loadedAt >= (hit ? refreshMs : MISS_REFRESH_MS)) void refresh();
  }

  function live(agentId: string): SavingsLookupAgent | null {
    try {
      return sources.liveAgent(agentId);
    } catch {
      return null;
    }
  }

  return {
    agentTitle: (agentId) => {
      cached(agents.has(agentId));
      return text(agents.get(agentId)?.title) ?? text(live(agentId)?.title);
    },
    workspaceOf: (agentId) => {
      cached(agents.has(agentId));
      return text(live(agentId)?.workspaceId) ?? text(agents.get(agentId)?.workspaceId);
    },
    workspaceLabel: (workspaceId) => {
      const space = workspaces.get(workspaceId);
      cached(space !== undefined);
      return space ? (text(space.title) ?? text(space.displayName)) : null;
    },
    refresh,
  };
}
