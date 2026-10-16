/**
 * Generic sustained-threshold state machine, factored out of token-burn-detector.ts's rate leg
 * so AgentResourceMonitor can reuse the same "N consecutive sweeps above/below, fire once,
 * re-arm after N consecutive sweeps back down" shape for its four independent legs (per-agent
 * memory, per-agent CPU, system swap ratio, orphan build daemon bytes) instead of four copies
 * of the same logic. Pure, no I/O, no clock reads. See resource-monitor-detector.ts.
 */

export interface SustainedBreachState {
  /** Consecutive sweeps at or above the threshold. Resets to 0 on any sweep below it. */
  consecutiveAboveThreshold: number;
  /** Consecutive sweeps below the threshold since this leg last fired. Used only to re-arm. */
  consecutiveBelowThreshold: number;
  /** True from the sweep the leg fires until a below-threshold run re-arms it. */
  fired: boolean;
}

export function createInitialSustainedBreachState(): SustainedBreachState {
  return { consecutiveAboveThreshold: 0, consecutiveBelowThreshold: 0, fired: false };
}

export interface EvaluateSustainedBreachInput {
  /** Current reading, or undefined when there's nothing to attribute this sweep (e.g. an
   * agent's process tree wasn't found). Treated the same as a below-threshold reading — no
   * signal can't sustain a breach, and clears an existing one on the normal re-arm schedule. */
  value: number | undefined;
  threshold: number;
  sustainedSweeps: number;
  previousState: SustainedBreachState | undefined;
}

export interface EvaluateSustainedBreachResult {
  /** True only on the sweep this leg transitions from armed to fired — never on every sweep
   * it stays breached. Callers use this to decide whether to raise a new episode. */
  triggered: boolean;
  nextState: SustainedBreachState;
}

export function evaluateSustainedBreach(
  input: EvaluateSustainedBreachInput,
): EvaluateSustainedBreachResult {
  const previous = input.previousState ?? createInitialSustainedBreachState();
  const state: SustainedBreachState = { ...previous };
  let triggered = false;

  if (input.value !== undefined && input.value >= input.threshold) {
    state.consecutiveAboveThreshold += 1;
    state.consecutiveBelowThreshold = 0;
    if (!state.fired && state.consecutiveAboveThreshold >= input.sustainedSweeps) {
      state.fired = true;
      triggered = true;
    }
  } else {
    state.consecutiveAboveThreshold = 0;
    if (state.fired) {
      state.consecutiveBelowThreshold += 1;
      if (state.consecutiveBelowThreshold >= input.sustainedSweeps) {
        state.fired = false;
        state.consecutiveBelowThreshold = 0;
      }
    } else {
      state.consecutiveBelowThreshold = 0;
    }
  }

  return { triggered, nextState: state };
}
