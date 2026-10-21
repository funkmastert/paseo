/**
 * The one place the classifier-decisions dashboard touches agent state: a
 * bounded, paginated sweep of the plugin's sanctioned `paseo.agents.list()`
 * API (never the agent-storage filesystem layout directly). Shared by U3's
 * backfill (every agent, built once) and U5's RPC handlers (every agent,
 * rebuilt per request to join the ledger's rows against CURRENT state —
 * KTD-1, outcome is never stored on a row).
 */

import type { PaseoAgentListResult } from "@getpaseo/client";

/** The real wire shape `paseo.agents.list()` returns one entry's agent as (`AgentSnapshotPayload`). */
type AgentListEntryAgent = PaseoAgentListResult["entries"][number]["agent"];

/**
 * What the backfill and the outcome join each need off one agent snapshot — a `Pick` of the real
 * SDK type rather than a hand-written shape, so a field that doesn't exist (or is renamed) fails
 * typecheck instead of silently reading `undefined` forever. This is how `status` got hand-written
 * as `lastStatus` (no such field on `AgentSnapshotPayload`) and passed typecheck anyway: every
 * agent non-archived read as `"finished"`.
 */
export type ClassifierDecisionsAgentSnapshot = Pick<
  AgentListEntryAgent,
  "id" | "title" | "labels" | "status" | "archivedAt" | "totalTokens" | "createdAt" | "updatedAt"
>;

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
/**
 * 25 pages is 5,000 agents. This is a last-resort circuit breaker against a runaway loop, not a
 * normal stopping condition: running out of pages while `hasMore` is still true is a FAILURE
 * (`complete: false`), the same way a thrown page is, per
 * docs/solutions/logic-errors/pager-cap-exhaustion-must-fail-not-succeed-silently.md — silently
 * returning the partial collection as if the sweep finished would under-report every caller that
 * trusts it (the backfill marking itself done; an outcome join reading a missing agent as
 * "unknown" instead of "the sweep never reached it").
 */
const MAX_PAGES = 25;

export interface ListAllAgentsResult {
  agents: ClassifierDecisionsAgentSnapshot[];
  /** False when a page threw, or the page cap ran out while more agents remained. */
  complete: boolean;
}

/** Every agent, active or archived, across every workspace. Never throws; a failed or capped-out sweep reports `complete: false`. */
export async function listAllAgents(paseo: ClassifierDecisionsAgentsApi): Promise<ListAllAgentsResult> {
  const agents: ClassifierDecisionsAgentSnapshot[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let result: Awaited<ReturnType<ClassifierDecisionsAgentsApi["agents"]["list"]>>;
    try {
      result = await paseo.agents.list({ filter: { includeArchived: true }, page: { limit: PAGE_LIMIT, cursor } });
    } catch (error) {
      console.error("classifier-decisions: agent sweep page failed", error);
      return { agents, complete: false };
    }
    for (const entry of result.entries) {
      agents.push(entry.agent);
    }
    const nextCursor = result.pageInfo?.nextCursor;
    if (result.pageInfo?.hasMore !== true || !nextCursor) {
      return { agents, complete: true };
    }
    cursor = nextCursor;
  }
  console.error(`classifier-decisions: agent sweep hit the ${MAX_PAGES}-page cap with more agents remaining`);
  return { agents, complete: false };
}
