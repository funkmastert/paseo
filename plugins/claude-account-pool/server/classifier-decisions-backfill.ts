/**
 * U3's one-time backfill (docs/arena-ranking.md, "Decisions ledger and
 * dashboard"): reconstructs historical ledger rows from the `paseo.arena-pick`
 * label already sitting on every agent the arena-ranking plugin has ever
 * picked for, since those predate the ledger (U2) and would otherwise be
 * invisible to the dashboard. Runs once per `$PASEO_HOME` — gated by the
 * ledger's own `backfilledAt` marker — and pages through the plugin's
 * sanctioned `paseo.agents.list()` API (never the agent-storage filesystem
 * layout directly, which this plugin has no sanctioned reason to know).
 */

import type { ClassifierDecisionsLedger } from "./classifier-decisions-ledger";
import type { ClassifierDecisionRow } from "../shared/classifier-decisions-schema";
import { ARENA_PICK_LABEL, AGENT_ROLE_LABEL, TASK_CLASS_LABEL, WORK_KIND_LABEL } from "../shared/role-policy-schema";

/** Mirrors `parent-profiles.ts`'s `warm()` sweep: 200/page is the daemon's documented maximum. */
const PAGE_LIMIT = 200;
/** 25 pages is 5,000 agents; a bigger directory is not this backfill's problem (same bound as `parent-profiles.ts`). */
const MAX_PAGES = 25;

export interface ClassifierDecisionsAgentsApi {
  agents: {
    list(options: {
      filter?: { includeArchived?: boolean };
      page?: { limit: number; cursor?: string };
    }): Promise<{
      entries: readonly { agent: { id: string; title?: string | null; labels?: Record<string, string> } }[];
      pageInfo?: { hasMore?: boolean; nextCursor?: string | null };
    }>;
  };
}

export interface ClassifierDecisionsBackfillResult {
  ran: boolean;
  scanned: number;
  backfilled: number;
  skipped: number;
}

/** `v1;ref=<ref>;tier=<top|mid>;board=<board>;date=<publishDate>;applied=<0|1>;proxy=<0|1>` (`role-router.ts`'s `formatArenaPickLabel`). */
function parseArenaPickLabel(value: string): Omit<Extract<ClassifierDecisionRow["arena"], { outcome: "ranked" }>, "outcome"> | undefined {
  const fields = new Map<string, string>();
  for (const part of value.split(";").slice(1)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const ref = fields.get("ref");
  const tier = fields.get("tier");
  const board = fields.get("board");
  const publishDate = fields.get("date");
  const applied = fields.get("applied");
  const proxy = fields.get("proxy");
  if (!ref || (tier !== "top" && tier !== "mid") || !board || !publishDate || applied === undefined || proxy === undefined) {
    return undefined;
  }
  return {
    applied: applied === "1",
    ref,
    tier,
    board,
    publishDate,
    pick: { ref, proxy: proxy === "1" },
  };
}

function backfillRowFor(
  agent: { id: string; title?: string | null; labels?: Record<string, string> },
  now: () => number,
): ClassifierDecisionRow | undefined {
  const pickLabel = agent.labels?.[ARENA_PICK_LABEL];
  if (!pickLabel) {
    return undefined;
  }
  const parsed = parseArenaPickLabel(pickLabel);
  if (!parsed) {
    return undefined;
  }
  return {
    id: `backfill-${agent.id}`,
    at: new Date(now()).toISOString(),
    agentId: agent.id,
    agentTitle: agent.title ?? null,
    role: agent.labels?.[AGENT_ROLE_LABEL] ?? null,
    taskClass: agent.labels?.[TASK_CLASS_LABEL] ?? null,
    workKind: agent.labels?.[WORK_KIND_LABEL] ?? null,
    modelRan: null,
    arena: { outcome: "ranked", ...parsed },
    backfilled: true,
  };
}

/**
 * Runs the sweep if (and only if) the ledger has never been backfilled. Never throws — a failed
 * sweep leaves `backfilledAt` unset, so the next plugin start tries again rather than losing the
 * historical picks for good.
 */
export async function runClassifierDecisionsBackfill(
  paseo: ClassifierDecisionsAgentsApi,
  ledger: Pick<ClassifierDecisionsLedger, "backfilledAt" | "appendBackfill">,
  now: () => number = Date.now,
): Promise<ClassifierDecisionsBackfillResult> {
  if (ledger.backfilledAt() !== undefined) {
    return { ran: false, scanned: 0, backfilled: 0, skipped: 0 };
  }

  const rows: ClassifierDecisionRow[] = [];
  let scanned = 0;
  let skipped = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.agents.list({ filter: { includeArchived: true }, page: { limit: PAGE_LIMIT, cursor } });
    for (const entry of result.entries) {
      scanned += 1;
      const row = backfillRowFor(entry.agent, now);
      if (row) {
        rows.push(row);
      } else if (entry.agent.labels?.[ARENA_PICK_LABEL]) {
        // Carried the label but it didn't parse — count it, don't silently drop it.
        skipped += 1;
      }
    }
    const nextCursor = result.pageInfo?.nextCursor;
    if (result.pageInfo?.hasMore !== true || !nextCursor) {
      break;
    }
    cursor = nextCursor;
  }

  await ledger.appendBackfill(rows);
  return { ran: true, scanned, backfilled: rows.length, skipped };
}
