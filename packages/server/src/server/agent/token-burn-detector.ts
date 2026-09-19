/**
 * Pure breach detector for AgentTokenBurnMonitor. No I/O, no clock reads — the monitor calls
 * this once per agent per sweep and persists the returned state for the next sweep. See
 * docs/plans/2026-09-12-006-feat-token-burn-monitor-plan.md.
 *
 * The monitor's sweep cadence is a fixed 60s (agent-token-burn-monitor.ts), so
 * `sustainedMinutes` consecutive breaching sweeps is exactly `sustainedMinutes` minutes of
 * sustained burn. On its own that filters nothing: the rate is a trailing-window average that
 * stays flat for up to five sweeps after one heavy request. What keeps a single burst from
 * firing is upstream — deltas are cost-weighted (cache reads at 0.1x) and only running agents
 * are evaluated on the rate leg (agent-token-burn-monitor.ts). See docs/token-burn.md.
 */

export interface TokenBurnMonitorConfig {
  ratePerMinute: number;
  sustainedMinutes: number;
  /**
   * Cumulative weighted tokens that fire the total leg, or null to disable it. Null is the
   * shipped default: a flat global total cannot tell a costly-but-worthwhile agent from a
   * runaway — measured healthy agents straddle any line you pick — so every threshold low
   * enough to catch a runaway also fires on ordinary work. The spend governor's budget-relative
   * `notify` is the leg that discriminates. See docs/token-burn.md.
   */
  totalTokens: number | null;
}

export interface TokenBurnMonitorState {
  /** Consecutive sweeps at or above ratePerMinute. Resets to 0 on any sweep below it. */
  consecutiveAboveRate: number;
  /** Consecutive sweeps below ratePerMinute since the rate leg last fired. Used only to re-arm. */
  consecutiveBelowRate: number;
  /** True from the sweep the rate leg fires until a below-threshold run re-arms it. */
  rateFired: boolean;
  /** Next cumulative-tokens value that fires the total leg — a multiple of config.totalTokens. */
  nextTotalThreshold: number;
}

export function createInitialTokenBurnMonitorState(
  config: Pick<TokenBurnMonitorConfig, "totalTokens">,
): TokenBurnMonitorState {
  return {
    consecutiveAboveRate: 0,
    consecutiveBelowRate: 0,
    rateFired: false,
    nextTotalThreshold: config.totalTokens ?? Number.POSITIVE_INFINITY,
  };
}

export interface EvaluateTokenBurnInput {
  /** Current trailing-window tokens/min, or undefined for providers/agents with no rate signal
   * (OMP, Pi, an idle agent) — the rate leg never breaches on undefined. */
  tokenRate: number | undefined;
  /**
   * Cumulative weighted tokens, or undefined when the total leg must not fire for this agent —
   * which now includes every agent that is not running. The money an idle agent spent is spent;
   * telling someone about it after the turn ended is a receipt, not an alert.
   */
  totalTokens: number | undefined;
  config: TokenBurnMonitorConfig;
  previousState: TokenBurnMonitorState | undefined;
}

export interface EvaluateTokenBurnResult {
  trigger: "rate" | "total" | null;
  nextState: TokenBurnMonitorState;
}

export function evaluateTokenBurn(input: EvaluateTokenBurnInput): EvaluateTokenBurnResult {
  const { tokenRate, totalTokens, config } = input;
  const previous = input.previousState ?? createInitialTokenBurnMonitorState(config);
  const state: TokenBurnMonitorState = { ...previous };

  let rateTriggered = false;
  if (tokenRate !== undefined && tokenRate >= config.ratePerMinute) {
    state.consecutiveAboveRate += 1;
    state.consecutiveBelowRate = 0;
    if (!state.rateFired && state.consecutiveAboveRate >= config.sustainedMinutes) {
      state.rateFired = true;
      rateTriggered = true;
    }
  } else {
    state.consecutiveAboveRate = 0;
    if (state.rateFired) {
      state.consecutiveBelowRate += 1;
      if (state.consecutiveBelowRate >= config.sustainedMinutes) {
        state.rateFired = false;
        state.consecutiveBelowRate = 0;
      }
    } else {
      state.consecutiveBelowRate = 0;
    }
  }

  // Ratchet: only evaluated when the rate leg didn't already fire this sweep, so a tick that
  // hits both never gets silently swallowed — a suppressed total breach reports on the next
  // sweep instead, since totalTokens only grows and the threshold multiple hasn't advanced.
  let totalTriggered = false;
  const totalThreshold = config.totalTokens;
  if (
    !rateTriggered &&
    totalThreshold !== null &&
    totalTokens !== undefined &&
    totalTokens >= state.nextTotalThreshold
  ) {
    totalTriggered = true;
    const stepsCleared = Math.floor(totalTokens / totalThreshold);
    state.nextTotalThreshold = (stepsCleared + 1) * totalThreshold;
  }

  let trigger: "rate" | "total" | null = null;
  if (rateTriggered) {
    trigger = "rate";
  } else if (totalTriggered) {
    trigger = "total";
  }

  return { trigger, nextState: state };
}
