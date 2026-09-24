/**
 * The return leg of account failover: which rescued agents belong somewhere else and may go back
 * now, and whose home label has stopped pointing at anything. Pure — no I/O, no clock reads; the
 * monitor passes the usage rows, the account identities and `nowMs` in, and performs the moves.
 * See docs/account-failover.md.
 *
 * A return is an optimisation, never a rescue. Every gate below is conjunctive, and anything that
 * cannot be established counts as "not now": the cost of skipping a return is that an agent spends
 * one more window on a borrowed account, and the cost of a wrong one is a move that achieves
 * nothing, or worse, interrupts work. So the burden of proof is the opposite way round from the
 * rescue leg — a worker whose usage is unreadable is still a valid rescue target, but an unreadable
 * home account is never returned to.
 */
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import type { AccountFailoverAgentSummary } from "./agent-manager.js";
import type { AgentAccountAuth } from "./agent-sdk-types.js";
import {
  getHomeProviderFromLabels,
  getMigratedToFromLabels,
  isLimitShapedError,
} from "./account-failover-detector.js";
import { NEUTRAL_HEADROOM } from "./account-pool-headroom.js";
import type { AccountPoolProviderEntry } from "./account-pool-providers.js";

/**
 * How much of every home window has to be free before coming back is worth a move. Half the
 * window: a leader that returns at 95% caps again on its first real turn, which spends two moves
 * and a resume to end up where it started — the ping-pong this threshold exists to prevent. Half
 * is enough headroom for a leader's turn to actually run, and a home account that is already half
 * spent by someone else is not the quiet account the agent left.
 */
const DEFAULT_MAX_HOME_USED_PCT = 50;

/**
 * How quiet the agent has to have been. A return closes and re-opens its session, so an agent
 * between two turns of a conversation someone is having right now must not be touched even though
 * it is technically idle. Ten minutes is long enough that nobody is mid-exchange and short enough
 * that a rescued agent gets home in the same window its account recovered in.
 */
const DEFAULT_MIN_IDLE_MS = 10 * 60 * 1000;

/**
 * The hard cap on moves per agent per window cycle, expressed as time: after a return, that agent
 * does not return again for five hours — the Claude session window, the same clock the reactive
 * signal ages on. It never blocks a legitimate return, because a legitimate one needs a full
 * cap-then-reset cycle first, and it bounds the one loop the health gate cannot see: a monthly
 * spend cap does not appear in the utilization windows at all, so home can read healthy, take the
 * agent back, and cap it on the next turn. That costs one wasted move per five hours instead of
 * one per sweep.
 */
const DEFAULT_COOLDOWN_MS = 5 * 60 * 60 * 1000;

/**
 * How long to wait after a return that could not be made. A refusal is nearly always structural
 * (`session_conflict` from a handle the conversation left behind on home, a provider that went
 * unavailable), so retrying every minute is a minute of pointless work every minute. An hour is
 * short enough to pick up a home account that was merely busy.
 */
const DEFAULT_RETRY_BACKOFF_MS = 60 * 60 * 1000;

/**
 * How stale a usage read may be and still authorise a return. The service caches for ~5 minutes,
 * so a sweep that reads the cache can be looking at numbers from before the window rolled. The
 * monitor forces a refresh before it acts; this is the assertion that the refresh actually
 * produced fresh numbers rather than joining an in-flight fetch that started earlier.
 */
const DEFAULT_MAX_USAGE_AGE_MS = 2 * 60 * 1000;

export interface AccountFailoverReturnConfig {
  returnHome?: boolean;
  returnMaxHomeUsedPct?: number;
  returnMinIdleMinutes?: number;
  returnCooldownMinutes?: number;
  returnRetryBackoffMinutes?: number;
  returnMaxUsageAgeMinutes?: number;
}

export interface ResolvedReturnConfig {
  enabled: boolean;
  maxHomeUsedPct: number;
  minIdleMs: number;
  cooldownMs: number;
  retryBackoffMs: number;
  maxUsageAgeMs: number;
}

function minutesToMs(minutes: number | undefined, fallbackMs: number): number {
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0
    ? minutes * 60 * 1000
    : fallbackMs;
}

export function resolveReturnConfig(
  config: AccountFailoverReturnConfig | undefined,
): ResolvedReturnConfig {
  return {
    enabled: config?.returnHome !== false,
    maxHomeUsedPct: config?.returnMaxHomeUsedPct ?? DEFAULT_MAX_HOME_USED_PCT,
    minIdleMs: minutesToMs(config?.returnMinIdleMinutes, DEFAULT_MIN_IDLE_MS),
    cooldownMs: minutesToMs(config?.returnCooldownMinutes, DEFAULT_COOLDOWN_MS),
    retryBackoffMs: minutesToMs(config?.returnRetryBackoffMinutes, DEFAULT_RETRY_BACKOFF_MS),
    maxUsageAgeMs: minutesToMs(config?.returnMaxUsageAgeMinutes, DEFAULT_MAX_USAGE_AGE_MS),
  };
}

/**
 * Why an agent's home label has stopped pointing at anything, so it is blanked rather than
 * retried forever. Every one of these is permanent as far as this agent is concerned: the pool
 * changed, or the two accounts turned out to be one. The agent stays where it is, which is a
 * healthy account it is already working on.
 */
export type HomeDropReason =
  | "already-home"
  | "not-in-pool"
  | "provider-disabled"
  | "signed-out"
  | "same-account"
  /** A root whose home is a worker. Roots belong on the leader account and are not sent back. */
  | "root-belongs-on-leader"
  /** A child already on a worker whose home is the leader account. Isolation holds already. */
  | "child-belongs-on-worker";

export interface HomeDrop {
  agentId: string;
  homeProviderId: string;
  reason: HomeDropReason;
}

export interface ReturnCandidate {
  agentId: string;
  title: string | null;
  workspaceId: string | undefined;
  /** The rescuer it has been spending on. */
  fromProviderId: string;
  homeProviderId: string;
  /**
   * Where it may go, best first; the monitor takes the first that passes the fresh usage read.
   * Just home, except for a child on the leader account: home first, then every other worker
   * with budget, since any worker gives it back its isolation.
   */
  targetProviderIds: string[];
}

export interface PlanAccountFailoverReturnsInput {
  agents: readonly AccountFailoverAgentSummary[];
  poolEntries: readonly AccountPoolProviderEntry[];
  /** This sweep's dead accounts, from planAccountFailoverSweep. */
  deadProviderIds: ReadonlySet<string>;
  /** Account identity per provider id, from AgentManager.describeProviderAccount. */
  accounts: ReadonlyMap<string, AgentAccountAuth | null>;
  /** Per-agent earliest next attempt, carried between sweeps. */
  cooldowns: ReadonlyMap<string, number>;
  /** Budget left per provider, from headroomByProvider; orders a child's other workers. */
  headroom?: ReadonlyMap<string, number>;
  nowMs: number;
  config: ResolvedReturnConfig;
}

export interface AccountFailoverReturnPlan {
  /** Blank these agents' home labels; no move, nothing else to do. */
  drops: HomeDrop[];
  /** Cleared every cheap gate. Still has to pass `homeReturnBlockedReason` on a fresh usage read. */
  candidates: ReturnCandidate[];
}

function accountKeyOf(auth: AgentAccountAuth | null | undefined): string | null {
  return auth?.state === "signed-in" ? auth.accountLabel : null;
}

/**
 * Whether two providers are provably the same Claude login. Only an equal, non-null account label
 * counts: a pair of `unknown`s is two shrugs, not a match, and a pair of signed-in accounts whose
 * label could not be read is the same. This is the live case in Tyler's pool — two
 * `CLAUDE_CONFIG_DIR`s signed into one email — where the two providers report the same usage
 * windows because they *are* the same windows, and a move between them changes no budget at all.
 */
export function providersShareAccount(
  a: AgentAccountAuth | null | undefined,
  b: AgentAccountAuth | null | undefined,
): boolean {
  const keyA = accountKeyOf(a);
  return keyA !== null && keyA === accountKeyOf(b);
}

/** Every reason this one agent cannot go home yet, or null when only the usage read is left. */
function returnBlockedReason(
  agent: AccountFailoverAgentSummary,
  input: PlanAccountFailoverReturnsInput,
): string | null {
  if (agent.internal) return "internal";
  // A limit-shaped error means the rescue leg owns this agent: it is stuck, not tidy-uppable, and
  // both legs moving one agent in a sweep would race.
  if (isLimitShapedError(agent.lastError)) return "failed on a cap";
  if (agent.lifecycle !== "idle") return `is ${agent.lifecycle}`;
  if (agent.busy) return "has a turn in flight";
  if (agent.pendingPermissionCount > 0) return "is waiting on a permission";
  if (!agent.sessionId) return "has no provider session";

  const until = input.cooldowns.get(agent.id);
  if (typeof until === "number" && input.nowMs < until) return "is within its return cooldown";

  const lastActivityMs = agent.lastActivityAt === null ? NaN : Date.parse(agent.lastActivityAt);
  if (!Number.isFinite(lastActivityMs)) return "has no readable activity timestamp";
  if (input.nowMs - lastActivityMs < input.config.minIdleMs) return "was active too recently";
  return null;
}

/**
 * Split every agent carrying a home label into the ones whose label is now meaningless and the
 * ones that may go back. An agent that clears nothing appears in neither list: it is left exactly
 * as it is, with its label, and reconsidered next sweep.
 */
export function planAccountFailoverReturns(
  input: PlanAccountFailoverReturnsInput,
): AccountFailoverReturnPlan {
  const drops: HomeDrop[] = [];
  const candidates: ReturnCandidate[] = [];
  if (!input.config.enabled) {
    return { drops, candidates };
  }
  const poolById = new Map(input.poolEntries.map((entry) => [entry.providerId, entry]));

  for (const agent of input.agents) {
    const homeProviderId = getHomeProviderFromLabels(agent.labels);
    if (!homeProviderId) continue;
    // A retired predecessor is a dead handle that happens to remember where its conversation came
    // from. Moving it would put a second record on that account for a session its live successor
    // may want back, so it is left alone entirely — label included, since that is history now.
    if (getMigratedToFromLabels(agent.labels)) continue;

    const decision = decideReturn({ agent, homeProviderId, poolById, input });
    if (decision.kind === "drop") {
      drops.push({ agentId: agent.id, homeProviderId, reason: decision.reason });
    } else if (decision.kind === "return") {
      candidates.push(candidateOf(agent, homeProviderId, decision.targetProviderIds));
    }
  }
  return { drops, candidates };
}

type ReturnDecision =
  | { kind: "drop"; reason: HomeDropReason }
  | { kind: "return"; targetProviderIds: string[] }
  /** Not now; the label stays and the agent is reconsidered next sweep. */
  | { kind: "wait" };

function decideReturn(params: {
  agent: AccountFailoverAgentSummary;
  homeProviderId: string;
  poolById: ReadonlyMap<string, AccountPoolProviderEntry>;
  input: PlanAccountFailoverReturnsInput;
}): ReturnDecision {
  const { agent, homeProviderId, poolById, input } = params;
  const drop = (reason: HomeDropReason): ReturnDecision => ({ kind: "drop", reason });
  // Drops are decided for any agent, busy or not: the label is wrong, and leaving a wrong
  // pointer in place so a busy agent can be re-examined next sweep only defers the same answer.
  if (homeProviderId === agent.provider) return drop("already-home");
  const home = poolById.get(homeProviderId);
  if (!home) return drop("not-in-pool");
  const isRoot = getParentAgentIdFromLabels(agent.labels) === null;
  if (isRoot && home.role !== "leader") return drop("root-belongs-on-leader");
  if (!isRoot && poolById.get(agent.provider)?.role === "leader") {
    // A child failover collapsed onto the leader account. Any worker with budget restores the
    // isolation, so it does not wait for its own; with none, it waits here, label kept.
    const targetProviderIds = workerTargetsFor(agent, homeProviderId, input);
    if (targetProviderIds.length === 0 || returnBlockedReason(agent, input) !== null) {
      return { kind: "wait" };
    }
    return { kind: "return", targetProviderIds };
  }
  if (!isRoot && home.role === "leader") return drop("child-belongs-on-worker");
  if (!home.enabled) return drop("provider-disabled");
  const homeAccount = input.accounts.get(homeProviderId);
  if (homeAccount?.state === "signed-out") return drop("signed-out");
  if (providersShareAccount(homeAccount, input.accounts.get(agent.provider))) {
    return drop("same-account");
  }
  if (input.deadProviderIds.has(homeProviderId) || returnBlockedReason(agent, input) !== null) {
    return { kind: "wait" };
  }
  return { kind: "return", targetProviderIds: [homeProviderId] };
}

function candidateOf(
  agent: AccountFailoverAgentSummary,
  homeProviderId: string,
  targetProviderIds: string[],
): ReturnCandidate {
  return {
    agentId: agent.id,
    title: agent.title,
    workspaceId: agent.workspaceId,
    fromProviderId: agent.provider,
    homeProviderId,
    targetProviderIds,
  };
}

/** Every worker a child on the leader account could go to now: home first, then most budget. */
function workerTargetsFor(
  agent: AccountFailoverAgentSummary,
  homeProviderId: string,
  input: PlanAccountFailoverReturnsInput,
): string[] {
  const current = input.accounts.get(agent.provider);
  const headroomOf = (providerId: string) => input.headroom?.get(providerId) ?? NEUTRAL_HEADROOM;
  return input.poolEntries
    .filter(
      (entry) =>
        entry.role === "worker" &&
        entry.enabled &&
        !input.deadProviderIds.has(entry.providerId) &&
        input.accounts.get(entry.providerId)?.state !== "signed-out" &&
        !providersShareAccount(current, input.accounts.get(entry.providerId)),
    )
    .sort(
      (a, b) =>
        Number(b.providerId === homeProviderId) - Number(a.providerId === homeProviderId) ||
        headroomOf(b.providerId) - headroomOf(a.providerId) ||
        a.priority - b.priority ||
        a.providerId.localeCompare(b.providerId),
    )
    .map((entry) => entry.providerId);
}

export interface HomeReturnHealthInput {
  homeProviderId: string;
  /** The forced usage read's rows, or null when it could not be read at all. */
  usage: readonly ProviderUsage[] | null;
  /** When those rows were fetched. Null when unparseable, which reads as "not fresh". */
  fetchedAtMs: number | null;
  nowMs: number;
  config: ResolvedReturnConfig;
}

/**
 * Why the home account is not demonstrably reset and healthy, or null when it is. This is the one
 * gate that needs a fresh read, so the monitor applies it after the cheap ones and only when some
 * agent is actually waiting on the answer.
 *
 * `resetsAt` in the past is a block rather than a pass. The clock passing a window's reset says
 * the numbers alongside it describe the window that just ended, not the new one — the read is
 * stale relative to the boundary it crossed. Treating it as proof of a reset is exactly the
 * mistake that returns an agent onto a window something else has already spent.
 */
export function homeReturnBlockedReason(input: HomeReturnHealthInput): string | null {
  if (input.usage === null) return "usage is unreadable";
  if (input.fetchedAtMs === null) return "the usage read has no timestamp";
  if (input.nowMs - input.fetchedAtMs > input.config.maxUsageAgeMs)
    return "the usage read is stale";

  const row = input.usage.find((provider) => provider.providerId === input.homeProviderId);
  if (!row) return "there is no usage row for it";
  if (row.status !== "available") return `its usage reports ${row.status}`;
  if (row.windows.length === 0) return "it reports no usage window";

  for (const window of row.windows) {
    if (typeof window.usedPct !== "number") {
      return `window "${window.id}" has no utilization`;
    }
    if (window.usedPct > input.config.maxHomeUsedPct) {
      return `window "${window.id}" is at ${window.usedPct}%`;
    }
    const resetsAtMs = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
    if (Number.isFinite(resetsAtMs) && resetsAtMs <= input.nowMs) {
      return `window "${window.id}" reports a reset that already passed`;
    }
  }
  return null;
}
