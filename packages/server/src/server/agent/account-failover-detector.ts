/**
 * Pure detection for AccountFailoverMonitor: which pool accounts are dead this sweep, and which
 * agents are stuck on them. No I/O, no clock reads — the monitor passes both signals and `nowMs`
 * in. See docs/account-failover.md.
 */
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import type { AccountFailoverAgentSummary } from "./agent-manager.js";

// Loose substring matching by design: provider error copy drifts, and a false positive costs an
// unnecessary migration (conversation, model, and predecessor all survive) while a false
// negative leaves an agent stuck. Beyond the repo's existing pattern (KTD4,
// `hit your limit|rate limit|quota|credits`), `spend limit` and `session limit` are required:
// the real CLI message is "You've hit your monthly spend limit · … · your session limit resets
// 3:10pm (America/Los_Angeles)", which contains neither "hit your limit" nor "usage limit".
const LIMIT_TEXT_PATTERN =
  /hit your limit|spend limit|session limit|usage limit|rate limit|quota|credits/i;

export function isLimitShapedError(text: string | undefined | null): text is string {
  return typeof text === "string" && LIMIT_TEXT_PATTERN.test(text);
}

// "your session limit resets 3:10pm (America/Los_Angeles)" -> "3:10pm (America/Los_Angeles)".
// Free text rather than a Date: it is only ever shown to a person or an agent.
const RESET_HINT_PATTERN = /resets?\s+(?:at\s+)?([^\n.]+)/i;

export function parseResetTimeHint(text: string | undefined | null): string | null {
  if (!text) return null;
  const hint = RESET_HINT_PATTERN.exec(text)?.[1]?.trim();
  return hint && hint.length > 0 ? hint : null;
}

/**
 * Set on a predecessor once it has a successor. A labeled agent is retired: never a candidate
 * again. Durable across restarts because it lives on the agent record.
 */
export const ACCOUNT_FAILOVER_MIGRATED_TO_LABEL = "paseo.account-failover.migrated-to";

/**
 * Set on a successor, naming its predecessor. Deliberately the same un-namespaced key the manual
 * claude-account-handoff procedure writes (`paseo import --label handoff-from=<oldId>`), so an
 * automatic migration recognizes a handoff a person already did, and vice versa.
 */
export const HANDOFF_FROM_LABEL = "handoff-from";

export function getMigratedToFromLabels(
  labels: Record<string, string> | null | undefined,
): string | null {
  const migratedTo = labels?.[ACCOUNT_FAILOVER_MIGRATED_TO_LABEL];
  return typeof migratedTo === "string" && migratedTo.trim().length > 0 ? migratedTo.trim() : null;
}

/**
 * How long one limit-shaped failure keeps its account dead without corroboration. Five hours is
 * the Claude session window, and the default cap TTL the routing plan uses for a reactive cap
 * with no knowable reset (KTD4). Without a bound, a single stuck agent's stale error would mark
 * a recovered account dead forever, excluding it as a target for everyone else.
 */
export const DEFAULT_REACTIVE_SIGNAL_TTL_MS = 5 * 60 * 60 * 1000;

const USAGE_WINDOW_DEAD_THRESHOLD_PCT = 100;

const NON_CANDIDATE_LIFECYCLES: ReadonlySet<AgentLifecycleStatus> = new Set([
  "running",
  "closed",
  "initializing",
]);

/** One limit-shaped failure, identified by its text and the timeline generation it left. */
export interface LimitErrorSighting {
  error: string;
  timelineSeq: number | null;
  firstSeenMs: number;
}

export interface PlanAccountFailoverSweepInput {
  /** Every claude-family provider id in the account pool, leader included. */
  poolProviderIds: ReadonlySet<string>;
  agents: readonly AccountFailoverAgentSummary[];
  /** Null when the usage source could not be read this sweep. */
  usage: readonly ProviderUsage[] | null;
  /** The previous plan's `sightings`. Empty on the first sweep and after a daemon restart. */
  previousSightings: ReadonlyMap<string, LimitErrorSighting>;
  nowMs: number;
  reactiveSignalTtlMs: number;
  migrateSubagents: boolean;
}

export interface AccountFailoverSweepPlan {
  deadProviderIds: Set<string>;
  candidates: AccountFailoverAgentSummary[];
  /** Carry into the next sweep's `previousSightings`. */
  sightings: Map<string, LimitErrorSighting>;
}

/**
 * Two independent dead-account signals, OR'd:
 * - Reactive: a pool agent whose own `lastError` is limit-shaped, first seen within the TTL. It
 *   condemns the whole account, not just itself — the account is chosen by `CLAUDE_CONFIG_DIR`,
 *   so every agent on it is capped. Retired predecessors still count: dropping their evidence
 *   the moment they are migrated would make the account look healthy one sweep later and send
 *   the next stuck agent straight back onto it.
 * - Proactive: a usage window at or over 100%. A provider reporting `unavailable` with no windows
 *   is never dead on that basis alone: it may be serving traffic fine with unreadable usage.
 *   A healthy usage reading never clears a reactive signal either — a monthly spend cap does not
 *   show up in the utilization windows at all.
 *
 * A sighting keeps its first-seen time only while both the error text and the timeline
 * generation are unchanged, so a new attempt that fails with identical text (a resume prompt
 * appends a row first) is fresh evidence rather than the old sighting. Seeing the agent running
 * also drops its sighting.
 *
 * A candidate is a non-retired agent that failed on the cap itself (its own limit-shaped error)
 * and is still on a dead account. An idle agent that merely lives on a dead account is not
 * stuck — it fails, and becomes a candidate, only if someone asks it to do something.
 */
export function planAccountFailoverSweep(
  input: PlanAccountFailoverSweepInput,
): AccountFailoverSweepPlan {
  const sightings = new Map<string, LimitErrorSighting>();
  const deadProviderIds = new Set<string>();

  for (const agent of input.agents) {
    if (agent.internal || !input.poolProviderIds.has(agent.provider)) continue;
    if (agent.lifecycle === "running") continue;
    if (!isLimitShapedError(agent.lastError)) continue;

    const previous = input.previousSightings.get(agent.id);
    const sighting =
      previous && previous.error === agent.lastError && previous.timelineSeq === agent.timelineSeq
        ? previous
        : { error: agent.lastError, timelineSeq: agent.timelineSeq, firstSeenMs: input.nowMs };
    sightings.set(agent.id, sighting);
    if (input.nowMs - sighting.firstSeenMs < input.reactiveSignalTtlMs) {
      deadProviderIds.add(agent.provider);
    }
  }

  for (const provider of input.usage ?? []) {
    if (!input.poolProviderIds.has(provider.providerId)) continue;
    const atCap = provider.windows.some(
      (window) =>
        typeof window.usedPct === "number" && window.usedPct >= USAGE_WINDOW_DEAD_THRESHOLD_PCT,
    );
    if (atCap) deadProviderIds.add(provider.providerId);
  }

  const candidates = input.agents.filter(
    (agent) =>
      sightings.has(agent.id) &&
      !getMigratedToFromLabels(agent.labels) &&
      deadProviderIds.has(agent.provider) &&
      !NON_CANDIDATE_LIFECYCLES.has(agent.lifecycle) &&
      Boolean(agent.sessionId) &&
      (input.migrateSubagents || getParentAgentIdFromLabels(agent.labels) === null),
  );

  return { deadProviderIds, candidates, sightings };
}
