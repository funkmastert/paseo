/**
 * The state machine behind AgentLeaderCompactionMonitor, kept free of I/O so every transition can
 * be tested without a daemon. The monitor calls `planLeaderCompactionStep` once per agent per
 * sweep and `applyLeaderCompactionTurnOutcome` when a turn it started ends; this file decides,
 * the monitor acts. See docs/leader-compaction.md.
 */
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";

const DEFAULT_PREPARE_AT_TOKENS = 400_000;
const DEFAULT_RETRY_AFTER_MINUTES = 30;
const DEFAULT_MAX_ATTEMPTS = 3;

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
}

export interface LeaderCompactionConfig {
  dryRun: boolean;
  scope: LeaderCompactionScope;
  prepareAtTokens: number;
  retryAfterMs: number;
  maxAttempts: number;
}

export function resolveLeaderCompactionConfig(
  settings: LeaderCompactionSettings,
): LeaderCompactionConfig {
  return {
    dryRun: settings.dryRun ?? false,
    scope: settings.scope ?? "leaders",
    prepareAtTokens: settings.prepareAtTokens ?? DEFAULT_PREPARE_AT_TOKENS,
    retryAfterMs: (settings.retryAfterMinutes ?? DEFAULT_RETRY_AFTER_MINUTES) * 60_000,
    maxAttempts: settings.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  };
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

/** Everything one compaction carries from the crossing to the restore prompt. */
export interface LeaderCompactionEpisode {
  triggeredAtTokens: number;
  /** Failed or cancelled tries of the current step. Reset when a step succeeds. */
  attempts: number;
  /** The agent's own restore note: the final text of the prepare turn. Null until it exists. */
  note: string | null;
  compactedFromTokens: number | null;
  compactedToTokens: number | null;
}

export type LeaderCompactionState =
  | { phase: "armed" }
  | { phase: "waiting"; step: LeaderCompactionStep; episode: LeaderCompactionEpisode }
  | { phase: "inFlight"; step: LeaderCompactionStep; episode: LeaderCompactionEpisode }
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
  | { kind: "reportDryRun"; usedTokens: number; startsNow: boolean }
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

function isUnderThreshold(agent: LeaderCompactionAgentInput, config: LeaderCompactionConfig) {
  return (
    agent.contextWindowUsedTokens !== undefined &&
    agent.contextWindowUsedTokens < config.prepareAtTokens
  );
}

function planWaiting(
  step: LeaderCompactionStep,
  episode: LeaderCompactionEpisode,
  agent: LeaderCompactionAgentInput,
  config: LeaderCompactionConfig,
): LeaderCompactionPlan {
  // Something else shrank the context before this episode did — the CLI's own auto-compact, or
  // someone typing /compact. Before the note exists there is nothing left to do. After it, the
  // compaction is done for us and the agent still gets its note back.
  if (isUnderThreshold(agent, config)) {
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
        config,
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

/** One agent, one sweep. A state the monitor has no record of is `armed`. */
export function planLeaderCompactionStep(input: {
  state: LeaderCompactionState | undefined;
  agent: LeaderCompactionAgentInput;
  config: LeaderCompactionConfig;
  nowMs: number;
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
      if (!isOverThreshold(agent, config)) {
        return { state, action: NO_ACTION };
      }
      const usedTokens = agent.contextWindowUsedTokens ?? 0;
      if (config.dryRun) {
        return {
          state: { phase: "settled", reason: "dryRun" },
          action: { kind: "reportDryRun", usedTokens, startsNow: canStartTurn(agent) },
        };
      }
      return planWaiting(
        "prepare",
        {
          triggeredAtTokens: usedTokens,
          attempts: 0,
          note: null,
          compactedFromTokens: null,
          compactedToTokens: null,
        },
        agent,
        config,
      );
    }
    case "waiting":
      return planWaiting(state.step, state.episode, agent, config);
    case "backoff":
      if (nowMs < state.untilMs) {
        return { state, action: NO_ACTION };
      }
      return planWaiting(state.step, state.episode, agent, config);
    case "settled":
      return isUnderThreshold(agent, config)
        ? { state: ARMED, action: NO_ACTION }
        : { state, action: NO_ACTION };
  }
}

/** A turn that ended any way other than `completed` with a compaction that took. */
export type LeaderCompactionStepFailure =
  | { kind: "canceled" }
  | { kind: "failed"; error: string }
  | { kind: "busy" }
  | { kind: "notCompacted"; usedTokens: number | undefined };

export type LeaderCompactionTurnResult =
  | { status: "completed"; finalText: string; usedTokensAfter: number | undefined }
  | { status: "canceled" }
  | { status: "failed"; error: string }
  /** The agent picked up work between the sweep and the start, so nothing was sent. */
  | { status: "busy" };

export interface LeaderCompactionTurnApplied {
  state: LeaderCompactionState;
  failure: LeaderCompactionStepFailure | null;
  /** True when this failure used the last attempt and the episode was abandoned. */
  gaveUp: boolean;
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
    case "prepare":
      return {
        state: {
          phase: "waiting",
          step: "compact",
          episode: { ...episode, attempts: 0, note: result.finalText.trim() || null },
        },
        failure: null,
        gaveUp: false,
      };
    case "compact": {
      // The turn completing proves nothing: an interrupted or refused compaction still ends the
      // turn. The context shrinking below the line is the only evidence it happened.
      const used = result.usedTokensAfter;
      if (used === undefined || used >= config.prepareAtTokens) {
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
