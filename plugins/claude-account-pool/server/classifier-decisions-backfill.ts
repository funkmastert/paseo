/**
 * U3's one-time backfill (docs/arena-ranking.md, "Decisions ledger and
 * dashboard"): reconstructs historical ledger rows from the `paseo.arena-pick`
 * label already sitting on every agent the arena-ranking plugin has ever
 * picked for, since those predate the ledger (U2) and would otherwise be
 * invisible to the dashboard. Runs once per `$PASEO_HOME` — gated by the
 * ledger's own `backfilledAt` marker.
 */

import type { ClassifierDecisionsLedger } from "./classifier-decisions-ledger";
import {
  listAllAgents,
  type ClassifierDecisionsAgentSnapshot,
  type ClassifierDecisionsAgentsApi,
} from "./classifier-decisions-agents";
import type { ClassifierDecisionRow } from "../shared/classifier-decisions-schema";
import { ARENA_PICK_LABEL, AGENT_ROLE_LABEL, TASK_CLASS_LABEL, WORK_KIND_LABEL } from "../shared/role-policy-schema";

export type { ClassifierDecisionsAgentsApi } from "./classifier-decisions-agents";

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

function backfillRowFor(agent: ClassifierDecisionsAgentSnapshot, now: () => number): ClassifierDecisionRow | undefined {
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

  const agents = await listAllAgents(paseo);
  const rows: ClassifierDecisionRow[] = [];
  let skipped = 0;
  for (const agent of agents) {
    const row = backfillRowFor(agent, now);
    if (row) {
      rows.push(row);
    } else if (agent.labels?.[ARENA_PICK_LABEL]) {
      // Carried the label but it didn't parse — count it, don't silently drop it.
      skipped += 1;
    }
  }

  await ledger.appendBackfill(rows);
  return { ran: true, scanned: agents.length, backfilled: rows.length, skipped };
}
