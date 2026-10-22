/**
 * The state machine behind AgentLeaderCompactionMonitor, kept free of I/O so every transition can
 * be tested without a daemon. The monitor calls `planLeaderCompactionStep` once per agent per
 * sweep and `applyLeaderCompactionTurnOutcome` when a turn it started ends; this file decides,
 * the monitor acts. See docs/leader-compaction.md, and docs/jev.md "Feature 9: compaction timing"
 * for the `timing` verdict.
 */
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";

const DEFAULT_PREPARE_AT_TOKENS = 400_000;
const DEFAULT_RETRY_AFTER_MINUTES = 30;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_QUIET_MINUTES = 10;
const DEFAULT_CEILING_TOKENS = 550_000;
const DEFAULT_FINISH_UP_MINUTES = 10;
const DEFAULT_PREPARE_TIMEOUT_MINUTES = 30;
const DEFAULT_MAX_DEFER_MINUTES = 20;
/** A deferral shorter than this is not worth a turn to ask again. */
const MIN_DEFERRAL_MS = 60_000;
/**
 * `ceilingTokens` is the only thing keeping a deferral from running into the CLI's own auto-compact
 * (docs/leader-compaction.md), which fires around 967K by default. A misconfigured ceiling above
 * this is clamped, so deferral eligibility and wait-ending never drift that close to it.
 */
const CEILING_TOKENS_SAFETY_CAP = 900_000;
/** A configured ceiling above this is close enough to the cap to warn about at resolve time. */
const CEILING_TOKENS_WARN_THRESHOLD = 800_000;

/**
 * How every message the monitor sends begins, inside its `<paseo-system>` envelope. The timing
 * advisor reads it to tell the monitor's own turns from the work.
 */
export const LEADER_COMPACTION_MESSAGE_HEADER = "Bozeo leader compaction — step";

/** `/compact` is a Claude Code command; no other transcript format has it. */
const COMPACTABLE_SESSION_FAMILY = "claude";

export type LeaderCompactionScope = "leaders" | "all";

export interface LeaderCompactionSettings {
  enabled?: boolean;
  dryRun?: boolean;
  scope?: LeaderCompactionScope;
  prepareAtTokens?: number;
  retryAfterMinutes?: number;
  maxAttempts?: number;
  quietMinutes?: number;
  ceilingTokens?: number;
  finishUpMinutes?: number;
  prepareTimeoutMinutes?: number;
  maxDeferMinutes?: number;
}

export interface LeaderCompactionConfig {
  dryRun: boolean;
  scope: LeaderCompactionScope;
  prepareAtTokens: number;
  retryAfterMs: number;
  maxAttempts: number;
  /** The quiet gate: how long since the leader's last human prompt before an episode may start. */
  quietMs: number;
  /** The quiet gate's override: at or over this, an episode starts regardless of how recently the
   * leader heard from a person. */
  ceilingTokens: number;
  /**
   * What `prepare` tells the agent it has to finish a step it is partway through (docs/leader-
   * compaction.md, "Finish-up window"). 0: it is told to call no tools, as before.
   */
  finishUpMs: number;
  /** How long the monitor waits for a `prepare` turn before it stops waiting. 0: as long as it
   * takes. Never shorter than `finishUpMs`. */
  prepareTimeoutMs: number;
  /** The most one episode may be deferred at the agent's request, in total. 0: no deferral. */
  maxDeferMs: number;
}

export interface ResolveLeaderCompactionConfigOptions {
  /** Called with the configured (unclamped) value when `ceilingTokens` is above the warn threshold. */
  onCeilingTokensTooHigh?: (rawCeilingTokens: number) => void;
}

export function resolveLeaderCompactionConfig(
  settings: LeaderCompactionSettings,
  options: ResolveLeaderCompactionConfigOptions = {},
): LeaderCompactionConfig {
  const finishUpMinutes = settings.finishUpMinutes ?? DEFAULT_FINISH_UP_MINUTES;
  const prepareTimeoutMinutes = settings.prepareTimeoutMinutes ?? DEFAULT_PREPARE_TIMEOUT_MINUTES;
  const rawCeilingTokens = settings.ceilingTokens ?? DEFAULT_CEILING_TOKENS;
  if (rawCeilingTokens > CEILING_TOKENS_WARN_THRESHOLD) {
    options.onCeilingTokensTooHigh?.(rawCeilingTokens);
  }
  return {
    dryRun: settings.dryRun ?? false,
    scope: settings.scope ?? "leaders",
    prepareAtTokens: settings.prepareAtTokens ?? DEFAULT_PREPARE_AT_TOKENS,
    retryAfterMs: (settings.retryAfterMinutes ?? DEFAULT_RETRY_AFTER_MINUTES) * 60_000,
    maxAttempts: settings.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    quietMs: (settings.quietMinutes ?? DEFAULT_QUIET_MINUTES) * 60_000,
    ceilingTokens: Math.min(rawCeilingTokens, CEILING_TOKENS_SAFETY_CAP),
    finishUpMs: finishUpMinutes * 60_000,
    // The bound is on the wait, so it cannot be shorter than the window the agent was promised.
    prepareTimeoutMs:
      prepareTimeoutMinutes === 0 ? 0 : Math.max(prepareTimeoutMinutes, finishUpMinutes) * 60_000,
    maxDeferMs: (settings.maxDeferMinutes ?? DEFAULT_MAX_DEFER_MINUTES) * 60_000,
  };
}

/** Whether a `prepare` turn started at `startedAtMs` has run past the monitor's wait for it. */
export function hasLeaderCompactionPrepareTimedOut(
  startedAtMs: number,
  nowMs: number,
  config: LeaderCompactionConfig,
): boolean {
  return config.prepareTimeoutMs > 0 && nowMs - startedAtMs >= config.prepareTimeoutMs;
}

export interface LeaderCompactionAgentInput {
  sessionFamily: string;
  internal: boolean;
  isDelegated: boolean;
  lifecycle: AgentLifecycleStatus;
  busy: boolean;
  pendingPermissionCount: number;
  contextWindowUsedTokens: number | undefined;
}

export type LeaderCompactionStep = "prepare" | "compact" | "restore";

/**
 * Feature 9's verdict from the agent's last turn (docs/jev.md, "Feature 9: compaction timing").
 * `startEarly` starts an episode under the line at a clean break, against an earlier line of its
 * own; `defer` holds one at or over the line while the leader is mid-way through a multi-step edit,
 * never at or over the ceiling.
 */
export type LeaderCompactionTiming =
  | { kind: "startEarly"; lineTokens: number; reason: string }
  | { kind: "defer"; ceilingTokens: number; reason: string };

/** Why an episode started: the line, or the clean break JEV saw before it. */
export type LeaderCompactionTrigger = { kind: "line" } | { kind: "early"; reason: string };

/** A human prompt the leader received, as the quiet gate and carry-prompts need it. */
export interface LeaderCompactionCarriedPrompt {
  atMs: number;
  text: string;
}

/**
 * What the agent has asked for by replying `DEFER <minutes>: <reason>` to `prepare` (docs/leader-
 * compaction.md, "Deferral").
 */
export interface LeaderCompactionDeferral {
  /** Deferrals granted so far. */
  count: number;
  /** The wait granted across all of them. */
  grantedMs: number;
  /** The agent asked for one it could not have and was told so: this closes the budget. */
  refused: boolean;
  /**
   * The agent deferred again after the refusal and was asked once more, explicitly, instead of
   * being compacted with that reply as the note. A further DEFER after this fails the step.
   */
  refusalEscalated: boolean;
  /** The reason on its latest request, for the log. */
  lastReason: string | null;
}

export const NO_LEADER_COMPACTION_DEFERRAL: LeaderCompactionDeferral = {
  count: 0,
  grantedMs: 0,
  refused: false,
  refusalEscalated: false,
  lastReason: null,
};

/** Everything one compaction carries from the crossing to the restore prompt. */
export interface LeaderCompactionEpisode {
  triggeredAtTokens: number;
  /**
   * The context the compaction has to get under: `prepareAtTokens`, or the earlier line an early
   * start began from. Under it before the note exists means something else compacted the agent.
   */
  lineTokens: number;
  trigger: LeaderCompactionTrigger;
  /** Failed or cancelled tries of the current step. Reset when a step succeeds. */
  attempts: number;
  /** The agent's own restore note: the final text of the prepare turn. Null until it exists. */
  note: string | null;
  compactedFromTokens: number | null;
  compactedToTokens: number | null;
  /**
   * Human prompts from shortly before `prepare` (the last one, if the quiet gate let it through)
   * through to the start of `restore`. Quoted verbatim in the restore message.
   */
  carriedPrompts: LeaderCompactionCarriedPrompt[];
  deferral: LeaderCompactionDeferral;
}

export type LeaderCompactionState =
  | { phase: "armed" }
  | { phase: "waiting"; step: LeaderCompactionStep; episode: LeaderCompactionEpisode }
  | { phase: "inFlight"; step: LeaderCompactionStep; episode: LeaderCompactionEpisode }
  /** The agent asked to be asked again at `untilMs`; the ceiling ends the wait early. */
  | {
      phase: "deferred";
      step: "prepare";
      episode: LeaderCompactionEpisode;
      untilMs: number;
    }
  | {
      phase: "backoff";
      step: LeaderCompactionStep;
      episode: LeaderCompactionEpisode;
      untilMs: number;
    }
  /**
   * Hysteresis. Nothing fires again until the context has been seen below the threshold, so a
   * compaction that did not shrink it, or a dry run that already reported it, cannot repeat
   * every sweep.
   */
  | { phase: "settled"; reason: "done" | "gaveUp" | "dryRun" };

export type LeaderCompactionAction =
  | { kind: "none" }
  | {
      kind: "reportDryRun";
      usedTokens: number;
      startsNow: boolean;
      trigger: LeaderCompactionTrigger;
      recentPrompt: LeaderCompactionCarriedPrompt | null;
    }
  /** Over the line, held by a `defer` verdict. The agent stays armed. */
  | { kind: "defer"; usedTokens: number; reason: string }
  /** The quiet gate held a would-be start. Not an attempt: the agent stays armed. */
  | { kind: "quietHold"; usedTokens: number; quietUntilMs: number }
  | { kind: "startTurn"; step: LeaderCompactionStep; episode: LeaderCompactionEpisode };

export interface LeaderCompactionPlan {
  state: LeaderCompactionState;
  action: LeaderCompactionAction;
}

const ARMED: LeaderCompactionState = { phase: "armed" };
const NO_ACTION: LeaderCompactionAction = { kind: "none" };

export function isLeaderCompactionCandidate(
  agent: LeaderCompactionAgentInput,
  config: LeaderCompactionConfig,
): boolean {
  if (agent.internal) return false;
  if (agent.sessionFamily !== COMPACTABLE_SESSION_FAMILY) return false;
  return config.scope === "all" || !agent.isDelegated;
}

/**
 * Idle and owned by nothing. A pending permission is excluded too: the agent is parked mid-turn
 * waiting on a person, and anything sent now would land on top of the question.
 */
function canStartTurn(agent: LeaderCompactionAgentInput): boolean {
  return agent.lifecycle === "idle" && !agent.busy && agent.pendingPermissionCount === 0;
}

function isOverThreshold(agent: LeaderCompactionAgentInput, config: LeaderCompactionConfig) {
  return (
    agent.contextWindowUsedTokens !== undefined &&
    agent.contextWindowUsedTokens >= config.prepareAtTokens
  );
}

function isUnder(agent: LeaderCompactionAgentInput, lineTokens: number) {
  return agent.contextWindowUsedTokens !== undefined && agent.contextWindowUsedTokens < lineTokens;
}

function isAtCeiling(agent: LeaderCompactionAgentInput, config: LeaderCompactionConfig) {
  return (
    agent.contextWindowUsedTokens !== undefined &&
    agent.contextWindowUsedTokens >= config.ceilingTokens
  );
}

function isUnderThreshold(agent: LeaderCompactionAgentInput, config: LeaderCompactionConfig) {
  return isUnder(agent, config.prepareAtTokens);
}

function planWaiting(
  step: LeaderCompactionStep,
  episode: LeaderCompactionEpisode,
  agent: LeaderCompactionAgentInput,
): LeaderCompactionPlan {
  // Something else shrank the context before this episode did — the CLI's own auto-compact, or
  // someone typing /compact. Before the note exists there is nothing left to do. After it, the
  // compaction is done for us and the agent still gets its note back.
  if (isUnder(agent, episode.lineTokens)) {
    if (step === "prepare") return { state: ARMED, action: NO_ACTION };
    if (step === "compact") {
      return planWaiting(
        "restore",
        {
          ...episode,
          attempts: 0,
          compactedToTokens: agent.contextWindowUsedTokens ?? null,
        },
        agent,
      );
    }
  }
  if (!canStartTurn(agent)) {
    return { state: { phase: "waiting", step, episode }, action: NO_ACTION };
  }
  return {
    state: { phase: "inFlight", step, episode },
    action: { kind: "startTurn", step, episode },
  };
}

/**
 * Whether an armed agent starts an episode now, and why. A verdict comes from the agent's last
 * turn, so one that is not idle has started another turn and moved past it; then the plan is
 * today's.
 */
function armedTrigger(
  agent: LeaderCompactionAgentInput,
  config: LeaderCompactionConfig,
  timing: LeaderCompactionTiming | null,
): { trigger: LeaderCompactionTrigger; lineTokens: number } | { defer: string } | null {
  const verdict = canStartTurn(agent) ? timing : null;
  const used = agent.contextWindowUsedTokens;
  if (isOverThreshold(agent, config)) {
    if (verdict?.kind === "defer" && used !== undefined && used < verdict.ceilingTokens) {
      return { defer: verdict.reason };
    }
    return { trigger: { kind: "line" }, lineTokens: config.prepareAtTokens };
  }
  if (verdict?.kind === "startEarly" && used !== undefined && used >= verdict.lineTokens) {
    return { trigger: { kind: "early", reason: verdict.reason }, lineTokens: verdict.lineTokens };
  }
  return null;
}

/**
 * A trigger fired; whether the quiet gate holds it, and what it carries if not (docs/leader-
 * compaction.md, "Quiet gate and carried prompts"). Not an attempt either way: a hold leaves the
 * agent armed, same as `armedTrigger` returning null.
 */
function planArmedStart(
  agent: LeaderCompactionAgentInput,
  config: LeaderCompactionConfig,
  start: { trigger: LeaderCompactionTrigger; lineTokens: number },
  lastHumanPrompt: LeaderCompactionCarriedPrompt | null,
  nowMs: number,
): LeaderCompactionPlan {
  const usedTokens = agent.contextWindowUsedTokens ?? 0;
  const quietUntilMs = lastHumanPrompt ? lastHumanPrompt.atMs + config.quietMs : null;
  // Checked twice rather than hoisted to a boolean: TS only narrows `quietUntilMs` to `number`
  // inline, and the first use needs that narrowing to put it on the `quietHold` action.
  if (quietUntilMs !== null && nowMs < quietUntilMs && usedTokens < config.ceilingTokens) {
    return { state: ARMED, action: { kind: "quietHold", usedTokens, quietUntilMs } };
  }
  // A prompt recent enough to have held the gate, were it not for the ceiling, is still live:
  // carry it into the episode so prepare and restore both account for it.
  const recentPrompt = quietUntilMs !== null && nowMs < quietUntilMs ? lastHumanPrompt : null;
  if (config.dryRun) {
    return {
      state: { phase: "settled", reason: "dryRun" },
      action: {
        kind: "reportDryRun",
        usedTokens,
        startsNow: canStartTurn(agent),
        trigger: start.trigger,
        recentPrompt,
      },
    };
  }
  return planWaiting(
    "prepare",
    {
      triggeredAtTokens: usedTokens,
      lineTokens: start.lineTokens,
      trigger: start.trigger,
      attempts: 0,
      note: null,
      compactedFromTokens: null,
      compactedToTokens: null,
      carriedPrompts: recentPrompt ? [recentPrompt] : [],
      deferral: NO_LEADER_COMPACTION_DEFERRAL,
    },
    agent,
  );
}

/** One agent, one sweep. A state the monitor has no record of is `armed`. */
export function planLeaderCompactionStep(input: {
  state: LeaderCompactionState | undefined;
  agent: LeaderCompactionAgentInput;
  config: LeaderCompactionConfig;
  nowMs: number;
  /** Feature 9's verdict, read only in `armed`. Absent or null: today's plan. */
  timing?: LeaderCompactionTiming | null;
  /** The leader's most recent human prompt the daemon has seen, read only in `armed`. Absent or
   * null: no quiet gate, same as today. */
  lastHumanPrompt?: LeaderCompactionCarriedPrompt | null;
}): LeaderCompactionPlan {
  const { agent, config, nowMs } = input;
  const state = input.state ?? ARMED;
  // A turn the monitor started is still running. Its outcome, not a sweep, moves it on — and it
  // must not be dropped even if the agent stopped being a candidate, or its outcome would land
  // on no state at all.
  if (state.phase === "inFlight") {
    return { state, action: NO_ACTION };
  }
  if (!isLeaderCompactionCandidate(agent, config)) {
    return { state: ARMED, action: NO_ACTION };
  }

  switch (state.phase) {
    case "armed": {
      const start = armedTrigger(agent, config, input.timing ?? null);
      if (!start) {
        return { state, action: NO_ACTION };
      }
      if ("defer" in start) {
        const usedTokens = agent.contextWindowUsedTokens ?? 0;
        return { state, action: { kind: "defer", usedTokens, reason: start.defer } };
      }
      return planArmedStart(agent, config, start, input.lastHumanPrompt ?? null, nowMs);
    }
    case "waiting":
      return planWaiting(state.step, state.episode, agent);
    case "deferred":
      // A request for more time never outranks the ceiling.
      if (nowMs < state.untilMs && !isAtCeiling(agent, config)) {
        return { state, action: NO_ACTION };
      }
      return planWaiting(state.step, state.episode, agent);
    case "backoff":
      if (nowMs < state.untilMs) {
        return { state, action: NO_ACTION };
      }
      return planWaiting(state.step, state.episode, agent);
    case "settled":
      return isUnderThreshold(agent, config)
        ? { state: ARMED, action: NO_ACTION }
        : { state, action: NO_ACTION };
  }
}

/** A turn that ended any way other than `completed` with a compaction that took. */
export type LeaderCompactionStepFailure =
  | { kind: "canceled" }
  /** The monitor stopped waiting for the turn. It was not cancelled and may still be running. */
  | { kind: "timedOut" }
  | { kind: "failed"; error: string }
  | { kind: "busy" }
  | { kind: "notCompacted"; usedTokens: number | undefined }
  /** The agent deferred again after the refusal and the one explicit re-ask that followed it. */
  | { kind: "deferredAfterRefusal" };

export type LeaderCompactionTurnResult =
  | { status: "completed"; finalText: string; usedTokensAfter: number | undefined }
  | { status: "canceled" }
  | { status: "timedOut" }
  | { status: "failed"; error: string }
  /** The agent picked up work between the sweep and the start, so nothing was sent. */
  | { status: "busy" };

export interface LeaderCompactionTurnApplied {
  state: LeaderCompactionState;
  failure: LeaderCompactionStepFailure | null;
  /** True when this failure used the last attempt and the episode was abandoned. */
  gaveUp: boolean;
  /**
   * Set when a `prepare` reply became the note, but its first or last line still looked like an
   * attempted `DEFER` that did not parse as one — worth a log line so a near-miss format gets
   * noticed. Absent otherwise.
   */
  noteLooksLikeAttemptedDeferral?: boolean;
}

function failStep(
  step: LeaderCompactionStep,
  episode: LeaderCompactionEpisode,
  failure: LeaderCompactionStepFailure,
  config: LeaderCompactionConfig,
  nowMs: number,
): LeaderCompactionTurnApplied {
  // Losing a race to other work is not a failure of the step: nothing was sent, so nothing was
  // tried. It waits for the next idle moment like any other step.
  if (failure.kind === "busy") {
    return { state: { phase: "waiting", step, episode }, failure, gaveUp: false };
  }
  const attempts = episode.attempts + 1;
  if (attempts >= config.maxAttempts) {
    return { state: { phase: "settled", reason: "gaveUp" }, failure, gaveUp: true };
  }
  return {
    state: {
      phase: "backoff",
      step,
      episode: { ...episode, attempts },
      untilMs: nowMs + config.retryAfterMs,
    },
    failure,
    gaveUp: false,
  };
}

const DEFER_REPLY = /^DEFER\s+(\d+)\s*:\s*(\S.*)$/i;

/**
 * The reply `prepare` offers instead of a note: `DEFER <minutes>: <reason>`, one line, case-
 * insensitive, markdown emphasis stripped. Anything else, a note that merely mentions it included,
 * is the note.
 */
export function parseLeaderCompactionDeferral(
  text: string,
): { minutes: number; reason: string } | null {
  const trimmed = text
    .trim()
    .replace(/^[`*_]+/, "")
    .replace(/[`*_]+$/, "");
  if (trimmed.includes("\n")) return null;
  const match = DEFER_REPLY.exec(trimmed);
  if (!match) return null;
  const minutes = Number(match[1]);
  const reason = match[2]?.trim();
  if (!reason || !Number.isInteger(minutes) || minutes < 1) return null;
  return { minutes, reason };
}

/** A line that reads like an attempted `DEFER` even though it did not parse as one. */
const DEFER_LOOKALIKE = /^\W*defer\b/i;

/**
 * Whether a reply that became the note still looked like it was trying to ask for a deferral —
 * a near-miss format, worth surfacing even though the note stands as written.
 */
export function looksLikeAttemptedDeferral(text: string): boolean {
  const lines = text.split("\n");
  const first = lines[0]?.trim() ?? "";
  const last = lines[lines.length - 1]?.trim() ?? "";
  return DEFER_LOOKALIKE.test(first) || DEFER_LOOKALIKE.test(last);
}

/**
 * Whole minutes the agent may still ask to defer by: none at the ceiling, after a refusal, when
 * the budget is under a minute, or when the context size is unknown.
 */
export function leaderCompactionDeferMinutesLeft(
  deferral: LeaderCompactionDeferral,
  config: LeaderCompactionConfig,
  usedTokens: number | undefined,
): number {
  if (deferral.refused) return 0;
  if (usedTokens === undefined || usedTokens >= config.ceilingTokens) return 0;
  const leftMs = config.maxDeferMs - deferral.grantedMs;
  return leftMs < MIN_DEFERRAL_MS ? 0 : Math.floor(leftMs / 60_000);
}

function applyDeferralRequest(input: {
  episode: LeaderCompactionEpisode;
  request: { minutes: number; reason: string };
  usedTokensAfter: number | undefined;
  config: LeaderCompactionConfig;
  nowMs: number;
}): LeaderCompactionTurnApplied {
  const { episode, request, usedTokensAfter, config, nowMs } = input;
  const minutesLeft = leaderCompactionDeferMinutesLeft(episode.deferral, config, usedTokensAfter);
  if (minutesLeft === 0) {
    // Closes the budget and asks once more. A note is used as one; another DEFER is handled by
    // the `prepare` case above, which escalates once before treating it as a failed try.
    return {
      state: {
        phase: "waiting",
        step: "prepare",
        episode: { ...episode, attempts: 0, deferral: { ...episode.deferral, refused: true } },
      },
      failure: null,
      gaveUp: false,
    };
  }
  const grantedMs = Math.min(request.minutes, minutesLeft) * 60_000;
  return {
    state: {
      phase: "deferred",
      step: "prepare",
      untilMs: nowMs + grantedMs,
      episode: {
        ...episode,
        attempts: 0,
        deferral: {
          count: episode.deferral.count + 1,
          grantedMs: episode.deferral.grantedMs + grantedMs,
          refused: false,
          refusalEscalated: false,
          lastReason: request.reason,
        },
      },
    },
    failure: null,
    gaveUp: false,
  };
}

export function applyLeaderCompactionTurnOutcome(input: {
  step: LeaderCompactionStep;
  episode: LeaderCompactionEpisode;
  result: LeaderCompactionTurnResult;
  config: LeaderCompactionConfig;
  nowMs: number;
}): LeaderCompactionTurnApplied {
  const { step, episode, result, config, nowMs } = input;
  if (result.status !== "completed") {
    const failure: LeaderCompactionStepFailure =
      result.status === "failed"
        ? { kind: "failed", error: result.error }
        : { kind: result.status };
    return failStep(step, episode, failure, config, nowMs);
  }
  switch (step) {
    case "prepare": {
      if (episode.deferral.refused) {
        const stillDeferring = parseLeaderCompactionDeferral(result.finalText);
        if (stillDeferring) {
          if (!episode.deferral.refusalEscalated) {
            // Not the note: ask once more, now explicit that the deferral is closed and a note
            // is needed. A further DEFER after this fails the step like any other failed try.
            return {
              state: {
                phase: "waiting",
                step: "prepare",
                episode: {
                  ...episode,
                  attempts: 0,
                  deferral: { ...episode.deferral, refusalEscalated: true },
                },
              },
              failure: null,
              gaveUp: false,
            };
          }
          return failStep(step, episode, { kind: "deferredAfterRefusal" }, config, nowMs);
        }
      } else {
        const request = parseLeaderCompactionDeferral(result.finalText);
        if (request) {
          return applyDeferralRequest({
            episode,
            request,
            usedTokensAfter: result.usedTokensAfter,
            config,
            nowMs,
          });
        }
      }
      const note = result.finalText.trim() || null;
      return {
        state: {
          phase: "waiting",
          step: "compact",
          episode: { ...episode, attempts: 0, note },
        },
        failure: null,
        gaveUp: false,
        ...(looksLikeAttemptedDeferral(result.finalText)
          ? { noteLooksLikeAttemptedDeferral: true as const }
          : {}),
      };
    }
    case "compact": {
      // The turn completing proves nothing: an interrupted or refused compaction still ends the
      // turn. The context shrinking below the line is the only evidence it happened.
      const used = result.usedTokensAfter;
      if (used === undefined || used >= episode.lineTokens) {
        return failStep(step, episode, { kind: "notCompacted", usedTokens: used }, config, nowMs);
      }
      return {
        state: {
          phase: "waiting",
          step: "restore",
          episode: {
            ...episode,
            attempts: 0,
            compactedFromTokens: episode.compactedFromTokens ?? episode.triggeredAtTokens,
            compactedToTokens: used,
          },
        },
        failure: null,
        gaveUp: false,
      };
    }
    case "restore":
      return { state: { phase: "settled", reason: "done" }, failure: null, gaveUp: false };
  }
}
