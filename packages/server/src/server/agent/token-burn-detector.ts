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
  totalTokens: number;
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
    nextTotalThreshold: config.totalTokens,
  };
}

export interface EvaluateTokenBurnInput {
  /** Current trailing-window tokens/min, or undefined for providers/agents with no rate signal
   * (OMP, Pi, an idle agent) — the rate leg never breaches on undefined, the total leg still can. */
  tokenRate: number | undefined;
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
  if (!rateTriggered && totalTokens !== undefined && totalTokens >= state.nextTotalThreshold) {
    totalTriggered = true;
    const stepsCleared = Math.floor(totalTokens / config.totalTokens);
    state.nextTotalThreshold = (stepsCleared + 1) * config.totalTokens;
  }

  let trigger: "rate" | "total" | null = null;
  if (rateTriggered) {
    trigger = "rate";
  } else if (totalTriggered) {
    trigger = "total";
  }

  return { trigger, nextState: state };
}
