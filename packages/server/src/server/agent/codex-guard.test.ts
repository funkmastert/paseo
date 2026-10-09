import { describe, expect, test } from "vitest";

import { decideCodexGuardedCommand } from "./codex-guard.js";
import type { DeviceLaunchGate, DeviceLaunchGateDecision } from "./device-lease-manager.js";

const REPO = "/Users/tester/code/app";

function fakeBranchResolver(branch = "main") {
  return async () => branch;
}

function fakeDeviceGate(decision: DeviceLaunchGateDecision): DeviceLaunchGate {
  return {
    gateLaunch: async () => decision,
  };
}

function throwingDeviceGate(): DeviceLaunchGate {
  return {
    gateLaunch: async () => {
      throw new Error("device gate exploded");
    },
  };
}

describe("decideCodexGuardedCommand", () => {
  test("declines a catastrophic command with the catastrophe reason", async () => {
    const result = await decideCodexGuardedCommand({
      command: "git push --force origin main",
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      resolveCurrentBranch: fakeBranchResolver("main"),
    });
    expect(result.decision).toBe("decline");
    expect(result.reason).toContain("force-push-main");
  });

  test("declines when the device gate denies, with the device-gate reason", async () => {
    const result = await decideCodexGuardedCommand({
      command: "npm test",
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: fakeDeviceGate({ decision: "deny", message: "no device slot" }),
      resolveCurrentBranch: fakeBranchResolver("feature/x"),
    });
    expect(result).toEqual({ decision: "decline", reason: "no device slot" });
  });

  test("approves an ordinary command when both gates clear", async () => {
    const result = await decideCodexGuardedCommand({
      command: "npm test",
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: fakeDeviceGate({ decision: "allow" }),
      resolveCurrentBranch: fakeBranchResolver("feature/x"),
    });
    expect(result).toEqual({ decision: "accept" });
  });

  test("approves when there is no device gate wired at all", async () => {
    const result = await decideCodexGuardedCommand({
      command: "npm test",
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      resolveCurrentBranch: fakeBranchResolver("feature/x"),
    });
    expect(result).toEqual({ decision: "accept" });
  });

  test("declines when the catastrophe check throws", async () => {
    const result = await decideCodexGuardedCommand({
      command: "git push --force origin main",
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      resolveCurrentBranch: async () => {
        throw new Error("git exploded");
      },
    });
    expect(result.decision).toBe("decline");
  });

  test("declines when the device gate throws", async () => {
    const result = await decideCodexGuardedCommand({
      command: "npm test",
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: throwingDeviceGate(),
      resolveCurrentBranch: fakeBranchResolver("feature/x"),
    });
    expect(result.decision).toBe("decline");
  });

  test("skips the catastrophe check when the kill switch is off, and still runs the device gate", async () => {
    const result = await decideCodexGuardedCommand({
      command: "git push --force origin main",
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: fakeDeviceGate({ decision: "deny", message: "no device slot" }),
      isCatastropheGateEnabled: () => false,
      resolveCurrentBranch: fakeBranchResolver("main"),
    });
    expect(result).toEqual({ decision: "decline", reason: "no device slot" });
  });

  test("approves when the catastrophe kill switch is off and no device gate is wired", async () => {
    const result = await decideCodexGuardedCommand({
      command: "git push --force origin main",
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      isCatastropheGateEnabled: () => false,
      resolveCurrentBranch: fakeBranchResolver("main"),
    });
    expect(result).toEqual({ decision: "accept" });
  });
});
