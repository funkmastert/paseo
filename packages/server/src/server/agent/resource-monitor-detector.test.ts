import { describe, expect, test } from "vitest";
import {
  evaluateAgentResourceBreach,
  evaluateMachineResourceBreach,
  type AgentResourceMonitorState,
  type MachineResourceMonitorState,
  type ResourceMonitorDetectorConfig,
} from "./resource-monitor-detector.js";

const CONFIG: ResourceMonitorDetectorConfig = {
  memoryBytesPerAgent: 6_442_450_944,
  cpuPercentPerAgent: 400,
  sustainedMinutes: 3,
  systemSwapUsedRatio: 0.9,
  orphanBuildDaemonBytes: 2_147_483_648,
};

describe("evaluateAgentResourceBreach", () => {
  test("requires sustainedMinutes consecutive sweeps before the memory leg triggers", () => {
    let state: AgentResourceMonitorState | undefined;
    for (let i = 0; i < 2; i += 1) {
      const result = evaluateAgentResourceBreach({
        rssBytes: 7_000_000_000,
        cpuPercent: 0,
        config: CONFIG,
        previousState: state,
      });
      expect(result.triggers).toEqual([]);
      state = result.nextState;
    }
    const result = evaluateAgentResourceBreach({
      rssBytes: 7_000_000_000,
      cpuPercent: 0,
      config: CONFIG,
      previousState: state,
    });
    expect(result.triggers).toEqual(["memory"]);
  });

  test("memory and cpu triggering in the same sweep both appear, memory first", () => {
    let state: AgentResourceMonitorState | undefined;
    for (let i = 0; i < 2; i += 1) {
      state = evaluateAgentResourceBreach({
        rssBytes: 7_000_000_000,
        cpuPercent: 500,
        config: CONFIG,
        previousState: state,
      }).nextState;
    }
    const result = evaluateAgentResourceBreach({
      rssBytes: 7_000_000_000,
      cpuPercent: 500,
      config: CONFIG,
      previousState: state,
    });
    expect(result.triggers).toEqual(["memory", "cpu"]);
  });

  test("an undefined reading (no attributable process) never triggers", () => {
    let state: AgentResourceMonitorState | undefined;
    for (let i = 0; i < 5; i += 1) {
      const result = evaluateAgentResourceBreach({
        rssBytes: undefined,
        cpuPercent: undefined,
        config: CONFIG,
        previousState: state,
      });
      expect(result.triggers).toEqual([]);
      state = result.nextState;
    }
  });

  test("rearmed flips true only on the sweep every fired leg clears", () => {
    let state: AgentResourceMonitorState | undefined;
    for (let i = 0; i < 3; i += 1) {
      state = evaluateAgentResourceBreach({
        rssBytes: 7_000_000_000,
        cpuPercent: 500,
        config: CONFIG,
        previousState: state,
      }).nextState;
    }

    // Memory re-arms first (3 low sweeps) while cpu is still high — not yet rearmed overall.
    let result: ReturnType<typeof evaluateAgentResourceBreach> | undefined;
    for (let i = 0; i < 3; i += 1) {
      result = evaluateAgentResourceBreach({
        rssBytes: 0,
        cpuPercent: 500,
        config: CONFIG,
        previousState: state,
      });
      expect(result.rearmed).toBe(false);
      state = result.nextState;
    }

    // Now cpu re-arms too — the whole agent rearms on that sweep.
    for (let i = 0; i < 2; i += 1) {
      state = evaluateAgentResourceBreach({
        rssBytes: 0,
        cpuPercent: 0,
        config: CONFIG,
        previousState: state,
      }).nextState;
    }
    result = evaluateAgentResourceBreach({
      rssBytes: 0,
      cpuPercent: 0,
      config: CONFIG,
      previousState: state,
    });
    expect(result.rearmed).toBe(true);
  });
});

describe("evaluateMachineResourceBreach", () => {
  test("requires sustainedMinutes consecutive sweeps before the swap leg triggers", () => {
    let state: MachineResourceMonitorState | undefined;
    for (let i = 0; i < 2; i += 1) {
      state = evaluateMachineResourceBreach({
        swapUsedRatio: 0.95,
        orphanBuildDaemonBytes: 0,
        config: CONFIG,
        previousState: state,
      }).nextState;
    }
    const result = evaluateMachineResourceBreach({
      swapUsedRatio: 0.95,
      orphanBuildDaemonBytes: 0,
      config: CONFIG,
      previousState: state,
    });
    expect(result.triggers).toEqual(["systemMemory"]);
  });

  test("orphan build daemon bytes trigger independently of swap", () => {
    let state: MachineResourceMonitorState | undefined;
    for (let i = 0; i < 2; i += 1) {
      state = evaluateMachineResourceBreach({
        swapUsedRatio: 0,
        orphanBuildDaemonBytes: 3_000_000_000,
        config: CONFIG,
        previousState: state,
      }).nextState;
    }
    const result = evaluateMachineResourceBreach({
      swapUsedRatio: 0,
      orphanBuildDaemonBytes: 3_000_000_000,
      config: CONFIG,
      previousState: state,
    });
    expect(result.triggers).toEqual(["orphanBuildDaemons"]);
  });
});
