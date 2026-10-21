/**
 * Handlers for `classifier-decisions.list` / `.summary` (U5, docs/arena-ranking.md).
 * Both join the ledger's rows against CURRENT agent state per request (KTD-1).
 * The agent sweep behind that join is the expensive part (the live directory
 * is in the thousands), so it is cached for a short TTL and single-flighted
 * across `list`/`summary`/Load-more calls that land close together — the
 * same `inFlight` + rewarm shape `parent-profiles.ts`'s `warm()` uses — rather
 * than re-swept on every call.
 */

import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  joinOutcome,
  rowAgreement,
  summarize,
  type ClassifierDecisionWithOutcome,
} from "../shared/classifier-decisions-aggregate";
import type { ClassifierDecisionsLedger } from "./classifier-decisions-ledger";
import { listAllAgents, type ListAllAgentsResult } from "./classifier-decisions-agents";
import { classifierDecisionsRpc } from "../shared/classifier-decisions-rpc";
import { findUnpooledLeaderChallengers, unpooledChallengerMessage } from "../shared/arena-unpooled";
import type { ArenaRankingsFile } from "../shared/arena-aliases";
import type { RoleModelPolicy } from "../shared/role-policy-schema";

export interface ClassifierDecisionsRpcDeps {
  ledger: Pick<ClassifierDecisionsLedger, "all">;
  now?: () => number;
  /** The live policy, for the unpooled-challenger line. Absent (or undefined) leaves the line out. */
  policy?: () => RoleModelPolicy | undefined;
  /** The cached rankings file, the same one the classifier reads. Absent (or undefined) leaves the line out. */
  arenaRanking?: () => ArenaRankingsFile | undefined;
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
/** How long a sweep is trusted before the next call pays for a fresh one. */
const AGENT_SWEEP_TTL_MS = 30_000;

export function createClassifierDecisionsRpcHandlers(deps: ClassifierDecisionsRpcDeps): ClassifierDecisionsRpcHandlers {
  const now = deps.now ?? Date.now;
  let cached: ListAllAgentsResult | undefined;
  let cachedAt = 0;
  let inFlight: Promise<ListAllAgentsResult> | undefined;

  function getAgents(paseo: PluginHandlerContext["paseo"]): Promise<ListAllAgentsResult> {
    if (inFlight) {
      return inFlight;
    }
    if (cached && now() - cachedAt < AGENT_SWEEP_TTL_MS) {
      return Promise.resolve(cached);
    }
    const run = listAllAgents(paseo)
      .then((result) => {
        cached = result;
        cachedAt = now();
        return result;
      })
      .finally(() => {
        if (inFlight === run) {
          inFlight = undefined;
        }
      });
    inFlight = run;
    return run;
  }

  async function joinedEntries(
    context: PluginHandlerContext,
    filters: { role?: string; workKind?: string },
  ): Promise<ClassifierDecisionWithOutcome[]> {
    const rows = deps.ledger
      .all()
      .filter((row) => (filters.role === undefined || row.role === filters.role))
      .filter((row) => (filters.workKind === undefined || row.workKind === filters.workKind));
    const { agents } = await getAgents(context.paseo);
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    return rows.map((row) => ({ row, outcome: joinOutcome(agentsById.get(row.agentId)) }));
  }

  return {
    async list(input, context) {
      const entries = await joinedEntries(context, input);
      const filtered = input.disagreementsOnly
        ? entries.filter((entry) => rowAgreement(entry.row) === "disagree")
        : entries;
      const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
      // An id-based cursor, not an offset: `resolveAgent` prepends a row on every arena-eligible
      // create, which happens several times an hour on this fleet, so an offset shifts under a
      // Load-more sequence and repeats rows. Resume right after the last row previously returned;
      // if it is gone from the current filtered set (archived out of range, filters changed),
      // start over from the top rather than guessing where it would have been.
      const startIndex = input.cursor ? Math.max(0, filtered.findIndex((entry) => entry.row.id === input.cursor) + 1) : 0;
      const page = filtered.slice(startIndex, startIndex + limit);
      const lastRow = page.at(-1)?.row;
      return {
        rows: page.map((entry) => ({ ...entry.row, outcome: entry.outcome })),
        nextCursor: lastRow && startIndex + page.length < filtered.length ? lastRow.id : undefined,
      };
    },
    async summary(input, context) {
      const entries = await joinedEntries(context, input);
      const summary = summarize(entries);
      const policy = deps.policy?.();
      const [top] = policy ? findUnpooledLeaderChallengers({ rankings: deps.arenaRanking?.(), policy }) : [];
      return top ? { ...summary, unpooledLeaderChallenger: { message: unpooledChallengerMessage(top), challenger: top } } : summary;
    },
  };
}
