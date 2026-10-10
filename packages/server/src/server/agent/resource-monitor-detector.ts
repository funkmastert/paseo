/**
 * Pure breach detector for AgentResourceMonitor, mirroring token-burn-detector.ts's shape. No
 * I/O, no clock reads — the monitor calls this once per agent (and once for the machine-level
 * legs) per sweep and persists the returned state for the next sweep. Each leg is an
 * independent sustained-threshold state machine (sustained-breach-detector.ts); this module's
 * job is composing the legs that share an owner (an agent's memory+CPU, or the machine's
 * swap+orphan-daemons) into one evaluation. See docs/resource-monitor.md.
 */

import {
  createInitialSustainedBreachState,
  evaluateSustainedBreach,
  type SustainedBreachState,
} from "./sustained-breach-detector.js";

export interface ResourceMonitorDetectorConfig {
  memoryBytesPerAgent: number;
  cpuPercentPerAgent: number;
  sustainedMinutes: number;
  systemSwapUsedRatio: number;
  orphanBuildDaemonBytes: number;
}

export type AgentResourceTrigger = "memory" | "cpu";

export interface AgentResourceMonitorState {
  memory: SustainedBreachState;
  cpu: SustainedBreachState;
}

export function createInitialAgentResourceMonitorState(): AgentResourceMonitorState {
  return {
    memory: createInitialSustainedBreachState(),
    cpu: createInitialSustainedBreachState(),
  };
}

export interface EvaluateAgentResourceBreachInput {
  rssBytes: number | undefined;
  cpuPercent: number | undefined;
  config: ResourceMonitorDetectorConfig;
  previousState: AgentResourceMonitorState | undefined;
}

export interface EvaluateAgentResourceBreachResult {
  /** Legs that newly fired this sweep — empty on a sweep that raises nothing new, even if a
   * leg is still breached from a previous sweep. Ordered memory-then-cpu; callers that need a
   * single primary trigger for copy/reason purposes take the first entry. */
  triggers: AgentResourceTrigger[];
  /** True the moment every leg that was fired is no longer fired — the sweep to clear the
   * agent's live alert badge. */
  rearmed: boolean;
  nextState: AgentResourceMonitorState;
}

export function evaluateAgentResourceBreach(
  input: EvaluateAgentResourceBreachInput,
): EvaluateAgentResourceBreachResult {
  const previous = input.previousState ?? createInitialAgentResourceMonitorState();
  const memoryResult = evaluateSustainedBreach({
    value: input.rssBytes,
    threshold: input.config.memoryBytesPerAgent,
    sustainedSweeps: input.config.sustainedMinutes,
    previousState: previous.memory,
  });
  const cpuResult = evaluateSustainedBreach({
    value: input.cpuPercent,
    threshold: input.config.cpuPercentPerAgent,
    sustainedSweeps: input.config.sustainedMinutes,
    previousState: previous.cpu,
  });

  const triggers: AgentResourceTrigger[] = [];
  if (memoryResult.triggered) triggers.push("memory");
  if (cpuResult.triggered) triggers.push("cpu");

  const wasActive = previous.memory.fired || previous.cpu.fired;
  const isActive = memoryResult.nextState.fired || cpuResult.nextState.fired;

  return {
    triggers,
    rearmed: wasActive && !isActive,
    nextState: { memory: memoryResult.nextState, cpu: cpuResult.nextState },
  };
}

export type MachineResourceTrigger = "systemMemory" | "orphanBuildDaemons";

export interface MachineResourceMonitorState {
  systemMemory: SustainedBreachState;
  orphanBuildDaemons: SustainedBreachState;
}

export function createInitialMachineResourceMonitorState(): MachineResourceMonitorState {
  return {
    systemMemory: createInitialSustainedBreachState(),
    orphanBuildDaemons: createInitialSustainedBreachState(),
  };
}

export interface EvaluateMachineResourceBreachInput {
  swapUsedRatio: number | undefined;
  orphanBuildDaemonBytes: number | undefined;
  config: ResourceMonitorDetectorConfig;
  previousState: MachineResourceMonitorState | undefined;
}

export interface EvaluateMachineResourceBreachResult {
  triggers: MachineResourceTrigger[];
  nextState: MachineResourceMonitorState;
}

export function evaluateMachineResourceBreach(
  input: EvaluateMachineResourceBreachInput,
): EvaluateMachineResourceBreachResult {
  const previous = input.previousState ?? createInitialMachineResourceMonitorState();
  const systemMemoryResult = evaluateSustainedBreach({
    value: input.swapUsedRatio,
    threshold: input.config.systemSwapUsedRatio,
    sustainedSweeps: input.config.sustainedMinutes,
    previousState: previous.systemMemory,
  });
  const orphanResult = evaluateSustainedBreach({
    value: input.orphanBuildDaemonBytes,
    threshold: input.config.orphanBuildDaemonBytes,
    sustainedSweeps: input.config.sustainedMinutes,
    previousState: previous.orphanBuildDaemons,
  });

  const triggers: MachineResourceTrigger[] = [];
  if (systemMemoryResult.triggered) triggers.push("systemMemory");
  if (orphanResult.triggered) triggers.push("orphanBuildDaemons");

  return {
    triggers,
    nextState: {
      systemMemory: systemMemoryResult.nextState,
      orphanBuildDaemons: orphanResult.nextState,
    },
  };
}
