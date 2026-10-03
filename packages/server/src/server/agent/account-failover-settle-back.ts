/**
 * The settle-back leg of account failover: a root that a cap pushed onto a worker goes back to
 * the leader account once that account demonstrably has budget again. Pure; the monitor passes
 * this sweep's dead accounts, usage and account identities in, and performs the moves. See
 * docs/account-failover.md.
 *
 * Tyler asked for it on 2026-09-22 and again on 2026-10-01, after his orchestrator stayed on a
 * capped worker while the leader account had budget. A root is his own session, and it belongs on
 * the leader account. A move rebuilds the whole prompt cache, so only roots go back, only between
 * turns, and only once per recovery episode. A child stays where it is: its rebuild is the cost
 * the rest of failover exists to avoid.
 *
 * The burden of proof is the reverse of the rescue's. A rescue moves an agent that cannot run, so
 * an account whose usage cannot be read still counts as a target. A settle-back moves an agent
 * that runs fine, so the leader account has to show a fresh reading with room on every window
 * that would stop the agent.
 */
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import type { AccountFailoverAgentSummary } from "./agent-manager.js";
import type { AgentAccountAuth } from "./agent-sdk-types.js";
import {
  getMigratedToFromLabels,
  isAccountDeadFor,
  isLimitShapedError,
} from "./account-failover-detector.js";
import {
  headroomByProvider,
  MODEL_FAMILIES,
  modelFamilyOf,
  NEUTRAL_HEADROOM,
  USABLE_BELOW_PCT,
  windowLimitsModel,
} from "./account-pool-headroom.js";
import { providersShareAccount, type AccountPoolProviderEntry } from "./account-pool-providers.js";

/** How long a root has to be quiet, so a move never lands between two messages of a live exchange. */
export const SETTLE_BACK_MIN_IDLE_MS = 2 * 60 * 1000;

/** A read older than this can predate a window rolling over, so it proves nothing. */
const MAX_USAGE_AGE_MS = 10 * 60 * 1000;

/**
 * The session window has to be further from its cap than the weekly ones. It is five hours long
 * and a leader's turns fill it first: at 85% the root would cap again within the hour and be
 * rescued straight back off.
 */
const SESSION_WINDOW_ID = "five_hour";
const SESSION_BELOW_PCT = 80;

/** The account's own windows. Without readings for both, a usage row proves nothing. */
const ACCOUNT_WINDOW_IDS = [SESSION_WINDOW_ID, "weekly"] as const;

/** The episode key for a model in no known family, which every window limits. */
const ANY_MODEL = "any";

/** Where one leader account stands for one model family. */
export interface SettleBackEpisode {
  /** Counts the episodes this monitor has seen open. */
  id: number;
  /** Whether the account passed the headroom gate on the last sweep. */
  open: boolean;
}

export interface SettleBackCandidate {
  agent: AccountFailoverAgentSummary;
  targetProviderId: string;
  /** The episode this move spends the agent's one attempt in. Recorded once the move is tried. */
  episode: string;
}

export interface PlanSettleBacksInput {
  agents: readonly AccountFailoverAgentSummary[];
  poolEntries: readonly AccountPoolProviderEntry[];
  /** This sweep's dead accounts and capped model windows, from planAccountFailoverSweep. */
  deadProviderIds: ReadonlySet<string>;
  cappedModelWindows: ReadonlyMap<string, readonly string[]>;
  /** Account identity per pool provider id, from AgentManager.describeProviderAccount. */
  accounts: ReadonlyMap<string, AgentAccountAuth | null>;
  /** This sweep's usage read and when it was fetched; null when it could not be read. */
  usage: { providers: readonly ProviderUsage[]; fetchedAtMs: number | null } | null;
  /** The previous plan's `episodes`. Empty at monitor start. */
  episodes: ReadonlyMap<string, SettleBackEpisode>;
  /** Per agent, the episode it already had its attempt in. */
  attempts: ReadonlyMap<string, string>;
  /** Per agent, the earliest next attempt after a refused move. */
  backoffs: ReadonlyMap<string, number>;
  nowMs: number;
}

export interface SettleBackPlan {
  candidates: SettleBackCandidate[];
  /** Carry into the next sweep's `episodes`. */
  episodes: Map<string, SettleBackEpisode>;
}

/**
 * Whether a root is between turns and has been for a while: idle, nothing pending, nothing
 * waiting on a permission, no provider subagent still running, and quiet for
 * SETTLE_BACK_MIN_IDLE_MS. The monitor asks again right
 * before the move, since a turn can start while the move waits for its pace slot.
 */
export function isQuietBetweenTurns(agent: AccountFailoverAgentSummary, nowMs: number): boolean {
  if (agent.lifecycle !== "idle" || agent.busy || agent.pendingPermissionCount > 0) return false;
  // A Task-tool subagent still working in the background: the move closes the session, which
  // cancels it.
  if (agent.runningProviderSubagentCount > 0) return false;
  if (!agent.sessionId || getMigratedToFromLabels(agent.labels)) return false;
  // Cut off by a cap: the rescue leg moves it and resumes the turn it lost.
  if (isLimitShapedError(agent.lastError)) return false;
  const lastActivityMs =
    agent.lastActivityAt === null ? Number.NaN : Date.parse(agent.lastActivityAt);
  return Number.isFinite(lastActivityMs) && nowMs - lastActivityMs >= SETTLE_BACK_MIN_IDLE_MS;
}

function modelKeyOf(model: string | undefined): string {
  return (model ? modelFamilyOf(model) : undefined) ?? ANY_MODEL;
}

function episodeKeyOf(leaderId: string, modelKey: string): string {
  return `${leaderId}/${modelKey}`;
}

/**
 * Whether the leader account has real room for an agent on this model family: not dead this
 * sweep, a fresh and readable usage row, the session window under 80%, and every other window
 * that stops the model under 90%.
 */
function leaderHasHeadroom(
  input: PlanSettleBacksInput,
  leaderId: string,
  modelKey: string,
): boolean {
  if (input.deadProviderIds.has(leaderId)) return false;
  const usage = input.usage;
  if (usage?.fetchedAtMs == null || input.nowMs - usage.fetchedAtMs > MAX_USAGE_AGE_MS) {
    return false;
  }
  const row = usage.providers.find((provider) => provider.providerId === leaderId);
  if (!row || row.status !== "available") return false;
  const readable = ACCOUNT_WINDOW_IDS.every((id) =>
    row.windows.some((window) => window.id === id && typeof window.usedPct === "number"),
  );
  if (!readable) return false;
  const model = modelKey === ANY_MODEL ? undefined : modelKey;
  return row.windows.every(
    (window) =>
      typeof window.usedPct !== "number" ||
      !windowLimitsModel(window.id, model) ||
      window.usedPct < (window.id === SESSION_WINDOW_ID ? SESSION_BELOW_PCT : USABLE_BELOW_PCT),
  );
}

/**
 * Every leader account's episode per model family, advanced by this sweep. An episode opens on
 * the first sweep the account passes the headroom gate after one where it did not, or at monitor
 * start. Watched every sweep, whoever is waiting, so a root that was busy through a cap and a
 * recovery still sees the episode change.
 */
function advanceEpisodes(input: PlanSettleBacksInput): Map<string, SettleBackEpisode> {
  const episodes = new Map<string, SettleBackEpisode>();
  for (const entry of input.poolEntries) {
    if (entry.role !== "leader" || !entry.enabled) continue;
    for (const modelKey of [...MODEL_FAMILIES, ANY_MODEL]) {
      const key = episodeKeyOf(entry.providerId, modelKey);
      const previous = input.episodes.get(key);
      const open = leaderHasHeadroom(input, entry.providerId, modelKey);
      const id = (previous?.id ?? 0) + Number(open && !previous?.open);
      episodes.set(key, { id, open });
    }
  }
  return episodes;
}

/** Whether this agent is a root on a worker that may be moved, leaving the leader aside. */
function isSettleBackRoot(
  agent: AccountFailoverAgentSummary,
  input: PlanSettleBacksInput,
  roles: ReadonlyMap<string, AccountPoolProviderEntry["role"]>,
): boolean {
  if (agent.internal) return false;
  if (getParentAgentIdFromLabels(agent.labels) !== null) return false;
  if (roles.get(agent.provider) !== "worker") return false;
  // On a dead worker it cannot run where it is, which makes it the idle leg's to move.
  if (isAccountDeadFor(input, agent)) return false;
  if (!isQuietBetweenTurns(agent, input.nowMs)) return false;
  const until = input.backoffs.get(agent.id);
  return !(typeof until === "number" && input.nowMs < until);
}

/**
 * Which idle roots go back to the leader account this sweep, and where. Among several leader
 * accounts the one with the most budget left for the agent's model wins.
 */
export function planSettleBacks(input: PlanSettleBacksInput): SettleBackPlan {
  const episodes = advanceEpisodes(input);
  const roles = new Map(input.poolEntries.map((entry) => [entry.providerId, entry.role]));
  const leaders = input.poolEntries.filter((entry) => entry.role === "leader" && entry.enabled);
  const candidates: SettleBackCandidate[] = [];

  for (const agent of input.agents) {
    if (!isSettleBackRoot(agent, input, roles)) continue;
    const modelKey = modelKeyOf(agent.model);
    const source = input.accounts.get(agent.provider);
    const headroom = headroomByProvider(input.usage?.providers ?? null, input.nowMs, agent.model);
    const open = leaders.flatMap((entry) => {
      const key = episodeKeyOf(entry.providerId, modelKey);
      const episode = episodes.get(key);
      if (!episode?.open) return [];
      const token = `${key}#${episode.id}`;
      if (input.attempts.get(agent.id) === token) return [];
      // Two entries on one Claude login are one budget: moving between them buys nothing.
      if (providersShareAccount(source, input.accounts.get(entry.providerId))) return [];
      return [{ entry, token }];
    });
    const best = open.sort(
      (a, b) =>
        (headroom.get(b.entry.providerId) ?? NEUTRAL_HEADROOM) -
          (headroom.get(a.entry.providerId) ?? NEUTRAL_HEADROOM) ||
        a.entry.priority - b.entry.priority ||
        a.entry.providerId.localeCompare(b.entry.providerId),
    )[0];
    if (best) {
      candidates.push({ agent, targetProviderId: best.entry.providerId, episode: best.token });
    }
  }
  return { candidates, episodes };
}
