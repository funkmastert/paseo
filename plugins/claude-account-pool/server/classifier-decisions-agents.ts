/**
 * The one place the classifier-decisions dashboard touches agent state: a
 * bounded, paginated sweep of the plugin's sanctioned `paseo.agents.list()`
 * API (never the agent-storage filesystem layout directly). Shared by U3's
 * backfill (every agent, built once) and U5's RPC handlers (every agent,
 * rebuilt per request to join the ledger's rows against CURRENT state —
 * KTD-1, outcome is never stored on a row).
 */

/** What the backfill and the outcome join each need off one agent snapshot. */
export interface ClassifierDecisionsAgentSnapshot {
  id: string;
  title?: string | null;
  labels?: Record<string, string>;
  lastStatus?: string;
  archivedAt?: string | null;
  /** Cost-weighted total, as `AgentSnapshotPayloadSchema.totalTokens` reports it. */
  totalTokens?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ClassifierDecisionsAgentsApi {
  agents: {
    list(options: {
      filter?: { includeArchived?: boolean };
      page?: { limit: number; cursor?: string };
    }): Promise<{
      entries: readonly { agent: ClassifierDecisionsAgentSnapshot }[];
      pageInfo?: { hasMore?: boolean; nextCursor?: string | null };
    }>;
  };
}

/** Mirrors `parent-profiles.ts`'s `warm()` sweep: 200/page is the daemon's documented maximum. */
const PAGE_LIMIT = 200;
/** 25 pages is 5,000 agents; a bigger directory is not this sweep's problem (same bound as `parent-profiles.ts`). */
const MAX_PAGES = 25;

/** Every agent, active or archived, across every workspace. Never throws; a failed page just ends the sweep early. */
export async function listAllAgents(paseo: ClassifierDecisionsAgentsApi): Promise<ClassifierDecisionsAgentSnapshot[]> {
  const agents: ClassifierDecisionsAgentSnapshot[] = [];
  let cursor: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await paseo.agents.list({ filter: { includeArchived: true }, page: { limit: PAGE_LIMIT, cursor } });
      for (const entry of result.entries) {
        agents.push(entry.agent);
      }
      const nextCursor = result.pageInfo?.nextCursor;
      if (result.pageInfo?.hasMore !== true || !nextCursor) {
        break;
      }
      cursor = nextCursor;
    }
  } catch {
    // A degraded sweep (one bad page) still returns whatever it already collected.
  }
  return agents;
}
