import type { SystemLoadReading } from "./system-load.js";
import { evaluateSustainedBreach, type SustainedBreachState } from "./sustained-breach-detector.js";

/**
 * Machine-wide CPU saturation: detection only. What to do about it belongs to the remediation
 * rung built on this (docs/resource-monitor.md); this file decides when an episode opens, holds
 * and clears, and remembers its peak. Pure, no I/O, no clock reads.
 */
export interface SaturationConfig {
  enabled: boolean;
  /** macOS/Linux: saturated at a 1-minute load average of this many runnable tasks per core. */
  loadPerCore: number;
  /**
   * Windows: saturated at this share of CPU time busy. Windows has no load average, and a busy
   * share cannot exceed 1, so `loadPerCore` has nothing to compare against there.
   */
  busyFraction: number;
  /** Sweeps over threshold to open, and sweeps back under to clear. One sweep a minute. */
  sustainedMinutes: number;
}

export interface SaturationEpisode {
  openedAtMs: number;
  peakLoad1: number;
  peakAtMs: number;
}

export interface SaturationState {
  breach: SustainedBreachState | undefined;
  episode: SaturationEpisode | undefined;
}

/**
 * `opened`: the sweep the episode started. `held`: every sweep it stays open, including sweeps
 * with no reading. `cleared`: the sweep it closed, with the episode that closed. `quiet`: none.
 */
export type SaturationTransition = "quiet" | "opened" | "held" | "cleared";

export interface SaturationEvaluation {
  transition: SaturationTransition;
  /** The open episode, or on `cleared` the one that just closed. */
  episode: SaturationEpisode | undefined;
  /** Whether this sweep's reading was over threshold; undefined with no reading. */
  over: boolean | undefined;
  nextState: SaturationState;
}

export const INITIAL_SATURATION_STATE: SaturationState = { breach: undefined, episode: undefined };

export function isSaturated(load: SystemLoadReading, config: SaturationConfig): boolean {
  return load.kind === "loadavg"
    ? load.load1 >= config.loadPerCore * load.cores
    : load.busyFraction >= config.busyFraction;
}

export function evaluateSaturation(input: {
  load: SystemLoadReading | undefined;
  config: SaturationConfig;
  previousState: SaturationState | undefined;
  nowMs: number;
}): SaturationEvaluation {
  const previous = input.previousState ?? INITIAL_SATURATION_STATE;
  if (!input.load) {
    // No reading (Windows' first sample) is not evidence either way: counting it as "under"
    // would clear an episode the machine is still in.
    const transition = previous.episode ? "held" : "quiet";
    return { transition, episode: previous.episode, over: undefined, nextState: previous };
  }

  const over = isSaturated(input.load, input.config);
  const { nextState: breach } = evaluateSustainedBreach({
    value: over ? 1 : 0,
    threshold: 1,
    sustainedSweeps: input.config.sustainedMinutes,
    previousState: previous.breach,
  });

  if (breach.fired && !previous.episode) {
    const episode = { openedAtMs: input.nowMs, peakLoad1: input.load.load1, peakAtMs: input.nowMs };
    return { transition: "opened", episode, over, nextState: { breach, episode } };
  }
  if (!breach.fired && previous.episode) {
    return {
      transition: "cleared",
      episode: previous.episode,
      over,
      nextState: { breach, episode: undefined },
    };
  }
  if (!previous.episode) {
    return {
      transition: "quiet",
      episode: undefined,
      over,
      nextState: { breach, episode: undefined },
    };
  }
  const episode =
    input.load.load1 > previous.episode.peakLoad1
      ? { ...previous.episode, peakLoad1: input.load.load1, peakAtMs: input.nowMs }
      : previous.episode;
  return { transition: "held", episode, over, nextState: { breach, episode } };
}
