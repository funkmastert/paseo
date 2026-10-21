/**
 * Handlers for `classifier-decisions.list` / `.summary` (U5, docs/arena-ranking.md).
 * Both join the ledger's rows against CURRENT agent state per request (KTD-1)
 * — a fresh `listAllAgents` sweep each call, not a cache, since this is a
 * dashboard a human opens occasionally, not a create's hot path.
 */

import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { joinOutcome, summarize, type ClassifierDecisionWithOutcome } from "../shared/classifier-decisions-aggregate";
import type { ClassifierDecisionsLedger } from "./classifier-decisions-ledger";
import { listAllAgents } from "./classifier-decisions-agents";
import { classifierDecisionsRpc } from "../shared/classifier-decisions-rpc";

export interface ClassifierDecisionsRpcDeps {
  ledger: Pick<ClassifierDecisionsLedger, "all">;
}

export interface ClassifierDecisionsRpcHandlers {
  list(
    input: RpcInput<typeof classifierDecisionsRpc.list>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof classifierDecisionsRpc.list>>;
  summary(
    input: RpcInput<typeof classifierDecisionsRpc.summary>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof classifierDecisionsRpc.summary>>;
}

const DEFAULT_PAGE_LIMIT = 50;

export function createClassifierDecisionsRpcHandlers(deps: ClassifierDecisionsRpcDeps): ClassifierDecisionsRpcHandlers {
  async function joinedEntries(
    context: PluginHandlerContext,
    filters: { role?: string; workKind?: string },
  ): Promise<ClassifierDecisionWithOutcome[]> {
    const rows = deps.ledger
      .all()
      .filter((row) => (filters.role === undefined || row.role === filters.role))
      .filter((row) => (filters.workKind === undefined || row.workKind === filters.workKind));
    const agents = await listAllAgents(context.paseo);
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    return rows.map((row) => ({ row, outcome: joinOutcome(agentsById.get(row.agentId)) }));
  }

  return {
    async list(input, context) {
      const entries = await joinedEntries(context, input);
      const filtered = input.disagreementsOnly
        ? entries.filter(
            (entry) =>
              entry.row.arena.outcome === "ranked" && entry.row.modelRan !== null && entry.row.modelRan !== entry.row.arena.ref,
          )
        : entries;
      const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
      const start = input.cursor ? Number(input.cursor) : 0;
      const page = filtered.slice(start, start + limit);
      return {
        rows: page.map((entry) => ({ ...entry.row, outcome: entry.outcome })),
        nextCursor: start + limit < filtered.length ? String(start + limit) : undefined,
      };
    },
    async summary(input, context) {
      const entries = await joinedEntries(context, input);
      return summarize(entries);
    },
  };
}
