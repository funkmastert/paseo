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

/**
 * `packages/server/src/server/agent/account-failover-detector.ts`'s own label — redeclared
 * locally rather than importing a core server module from this plugin, the same way
 * `PARENT_AGENT_ID_LABEL` is redeclared in `role-router.ts`/`notify.ts`.
 */
const HANDOFF_FROM_LABEL = "handoff-from";

export interface ClassifierDecisionsBackfillResult {
  ran: boolean;
  /** Whether the agent sweep behind this result finished (vs. a thrown page or the page cap). */
  complete: boolean;
  scanned: number;
  backfilled: number;
  skipped: number;
}

/**
 * Splits `v1;key=value;key=value;...` into its fields, reading by key and ignoring any this
 * build doesn't recognize — a leader pick (`role-router.ts`'s `formatLeaderPickLabel`) appends
 * `;role=leader;incumbent=<ref>;streak=<won>/<needed>` to the same v1 shape a worker/reviewer
 * pick writes, and must never break parsing just because this plugin doesn't look for those keys.
 */
function arenaPickFields(value: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const part of value.split(";").slice(1)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return fields;
}

/** A leader pick's `paseo.arena-pick` carries `role=leader` (docs/arena-ranking.md, "Leaders"). */
function isLeaderPickLabel(value: string): boolean {
  return arenaPickFields(value).get("role") === "leader";
}

/** `v1;ref=<ref>;tier=<top|mid>;board=<board>;date=<publishDate>;applied=<0|1>;proxy=<0|1>` (`role-router.ts`'s `formatArenaPickLabel`). */
function parseArenaPickLabel(value: string): Omit<Extract<ClassifierDecisionRow["arena"], { outcome: "ranked" }>, "outcome"> | undefined {
  const fields = arenaPickFields(value);
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

function backfillRowFor(agent: ClassifierDecisionsAgentSnapshot): ClassifierDecisionRow | undefined {
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
    // The decision's own time, not when the sweep happened to run — the sweep runs long after
    // every historical decision, and stamping all ~280 rows with that one moment both misrepresents
    // "when" and sorts them ahead of today's live rows in the newest-first ledger.
    at: agent.createdAt,
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
 * Runs the sweep if (and only if) the ledger has never been backfilled. The marker is set only
 * after a COMPLETE sweep — one a thrown page or the page cap never cut short — so a transient
 * failure (a reload mid-boot is enough) leaves `backfilledAt` unset and the next plugin start
 * tries again, rather than permanently recording a zero/partial backfill as done
 * (docs/solutions/logic-errors/pager-cap-exhaustion-must-fail-not-succeed-silently.md).
 */
export async function runClassifierDecisionsBackfill(
  paseo: ClassifierDecisionsAgentsApi,
  ledger: Pick<ClassifierDecisionsLedger, "backfilledAt" | "appendBackfill">,
): Promise<ClassifierDecisionsBackfillResult> {
  if (ledger.backfilledAt() !== undefined) {
    return { ran: false, complete: true, scanned: 0, backfilled: 0, skipped: 0 };
  }

  const { agents, complete } = await listAllAgents(paseo);
  const rows: ClassifierDecisionRow[] = [];
  let skipped = 0;
  for (const agent of agents) {
    // A failover successor is created with `{ ...predecessor.labels, [HANDOFF_FROM_LABEL]: predecessorId }`
    // (account-failover-migration.ts), so it copies the predecessor's `paseo.arena-pick` verbatim —
    // backfilling it too would count the one decision the predecessor made twice.
    if (agent.labels?.[HANDOFF_FROM_LABEL]) {
      continue;
    }
    const pickLabel = agent.labels?.[ARENA_PICK_LABEL];
    // A leader pick (docs/arena-ranking.md, "Leaders") is the leader rule's own
    // incumbent-vs-challenger decision, not the worker/reviewer ranking this dashboard's
    // agreement and pick-distribution stats are about — and its `tier` is always `top` by
    // construction, which would otherwise skew `topTierRate`. Skip it rather than mixing it in.
    if (pickLabel && isLeaderPickLabel(pickLabel)) {
      continue;
    }
    const row = backfillRowFor(agent);
    if (row) {
      rows.push(row);
    } else if (agent.labels?.[ARENA_PICK_LABEL]) {
      // Carried the label but it didn't parse — count it, don't silently drop it.
      skipped += 1;
    }
  }

  if (!complete) {
    console.error(
      `classifier-decisions: backfill sweep was incomplete (${agents.length} agents scanned); leaving backfilledAt unset so the next plugin start retries`,
    );
    return { ran: false, complete: false, scanned: agents.length, backfilled: 0, skipped };
  }

  await ledger.appendBackfill(rows);
  return { ran: true, complete: true, scanned: agents.length, backfilled: rows.length, skipped };
}
