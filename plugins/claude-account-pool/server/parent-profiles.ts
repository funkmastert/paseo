import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { TOOLS_DENIED_LABEL } from "../shared/role-policy-schema";
import { parseDeniedTools } from "../shared/tool-profiles";

/**
 * What the agent that spawned this one had denied, so a child can never come
 * out less restricted than its parent.
 *
 * Without this, `read-only` is a suggestion: a read-only agent still has
 * `mcp__paseo__create_agent` (kept deliberately — delegation is the sanctioned
 * path, see the README's leader section) and can spawn an unrestricted worker
 * to do the writing it cannot. Commit 35e6d2e argued that was safe because a
 * child is independently role-resolved. Inheritance is what makes that
 * argument true rather than merely hopeful.
 *
 * The parent's denials are read off its own `TOOLS_DENIED_LABEL` label, from
 * two sources that never disagree:
 * - `note()`, fed by the `agent.created` lifecycle event the plugin already
 *   subscribes to. Free, and covers everything created since plugin start.
 * - `warm()`, one paginated `paseo.agents.list()` sweep at plugin start, which
 *   covers agents that predate it (including every live agent at the moment
 *   the operator activates a plugin change).
 *
 * `lookup()` is deliberately SYNCHRONOUS. The role hook sits in front of every
 * agent create and its standing contract is that it never blocks one; making
 * it await a daemon round trip per spawn would trade a guard rail for latency
 * on the hottest path in the product. A miss instead schedules a rate-limited
 * background re-sweep and answers from what is known now.
 */

/** Page size for the warm sweep. 200 is the daemon's documented maximum. */
const PAGE_LIMIT = 200;
/** Bound on the sweep. 25 pages is 5,000 agents; a bigger directory is not this plugin's problem. */
const MAX_PAGES = 25;
/** Floor between background re-sweeps triggered by a miss. */
const REWARM_INTERVAL_MS = 10_000;

export type PaseoAgentsApi = PluginHandlerContext["paseo"];

export type ParentLookup =
  /** The parent's applied denials. An empty array means it was genuinely unrestricted. */
  | { status: "known"; denied: readonly string[] }
  /**
   * No sweep has succeeded yet, so there is no directory to be absent from.
   * Indistinguishable from "we have not started"; callers fail OPEN here, the
   * same posture every other cache in this plugin takes before its first
   * refresh.
   */
  | { status: "cold" }
  /**
   * A sweep succeeded and this agent was not in it. Something is wrong — a
   * live agent is making a create — so the parent's profile is genuinely
   * unknowable and callers fail SAFE.
   */
  | { status: "unknown" };

export interface ParentToolProfiles {
  /** Record an agent's applied denials from its labels. Idempotent. */
  note(agentId: string, labels: Record<string, string> | undefined): void;
  lookup(agentId: string): ParentLookup;
  /** Runs (or joins) a sweep and resolves when it has finished. */
  warm(): Promise<void>;
  stop(): void;
}

export interface ParentToolProfilesOptions {
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

export function createParentToolProfiles(
  paseo: PaseoAgentsApi,
  options: ParentToolProfilesOptions = {},
): ParentToolProfiles {
  const now = options.now ?? Date.now;
  const denials = new Map<string, readonly string[]>();
  let warmed = false;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let lastSweepAt = 0;

  function note(agentId: string, labels: Record<string, string> | undefined): void {
    denials.set(agentId, parseDeniedTools(labels?.[TOOLS_DENIED_LABEL]));
  }

  async function sweep(): Promise<void> {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await paseo.agents.list({ scope: "active", page: { limit: PAGE_LIMIT, cursor } });
      for (const entry of result.entries) {
        // Never clobber a value recorded at create time: that one is what the
        // hook actually wrote into providerOptions, whereas a label read back
        // later could have been edited since. (Restrictive profiles deny
        // `mcp__paseo__update_agent` precisely to make that edit impossible,
        // but preferring the create-time value costs nothing.)
        if (!denials.has(entry.agent.id)) {
          denials.set(entry.agent.id, parseDeniedTools(entry.agent.labels?.[TOOLS_DENIED_LABEL]));
        }
      }
      const nextCursor = result.pageInfo?.nextCursor;
      if (result.pageInfo?.hasMore !== true || !nextCursor) {
        break;
      }
      cursor = nextCursor;
    }
    warmed = true;
  }

  function scheduleSweep(): Promise<void> {
    if (stopped) {
      return Promise.resolve();
    }
    if (inFlight) {
      return inFlight;
    }
    if (warmed && now() - lastSweepAt < REWARM_INTERVAL_MS) {
      return Promise.resolve();
    }
    lastSweepAt = now();
    const run = sweep()
      .catch((error: unknown) => {
        console.error(
          "[claude-account-pool] parent-profiles: could not read the agent directory; parent tool profiles stay unresolved",
          error,
        );
      })
      .finally(() => {
        if (inFlight === run) {
          inFlight = null;
        }
      });
    inFlight = run;
    return run;
  }

  return {
    note,
    lookup(agentId) {
      const denied = denials.get(agentId);
      if (denied !== undefined) {
        return { status: "known", denied };
      }
      // Fire and forget: the answer for THIS create comes from what is known
      // now, but a miss is evidence the map has drifted and is worth fixing.
      void scheduleSweep();
      return warmed ? { status: "unknown" } : { status: "cold" };
    },
    warm() {
      return scheduleSweep();
    },
    stop() {
      stopped = true;
      denials.clear();
    },
  };
}
