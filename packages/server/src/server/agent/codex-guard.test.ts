import { describe, expect, test } from "vitest";

import {
  decideCodexGuardedCommand,
  describeGuardedSensitiveFileChangePath,
  describeGuardedSensitiveGitConfigCommand,
  describeGuardedSensitiveGitInvocation,
} from "./codex-guard.js";
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

  test("declines a git alias setup, closing the alias blind spot (review finding #2)", async () => {
    const result = await decideCodexGuardedCommand({
      command: "git config alias.pf 'push --force origin main'",
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      resolveCurrentBranch: fakeBranchResolver("main"),
    });
    expect(result.decision).toBe("decline");
    expect(result.reason).toContain("git-alias-setup");
  });

  test("skips the git-alias check too when the catastrophe kill switch is off", async () => {
    const result = await decideCodexGuardedCommand({
      command: "git config alias.pf 'push --force origin main'",
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      isCatastropheGateEnabled: () => false,
      resolveCurrentBranch: fakeBranchResolver("main"),
    });
    expect(result).toEqual({ decision: "accept" });
  });
});

describe("describeGuardedSensitiveFileChangePath", () => {
  test.each([
    ["/workspace/project/.git/config", "a path inside a .git directory"],
    ["/workspace/project/.git/hooks/pre-commit", "a path inside a .git directory"],
    ["/workspace/project/.gitconfig", "a git config file"],
    ["/workspace/project/.config/git/config", "a git config file"],
    [
      "/workspace/project/.gitattributes",
      "a .gitattributes file (can declare a filter driver that runs arbitrary commands)",
    ],
    ["/workspace/project/.zshrc", "a shell startup file"],
    ["/workspace/project/.bashrc", "a shell startup file"],
  ])("flags %s", (path, expectedReason) => {
    expect(describeGuardedSensitiveFileChangePath(path)).toBe(expectedReason);
  });

  test.each([
    "/workspace/project/src/index.ts",
    "/workspace/project/README.md",
    "/workspace/project/gitattributes-notes.md",
  ])("clears an ordinary path: %s", (path) => {
    expect(describeGuardedSensitiveFileChangePath(path)).toBeNull();
  });
});

describe("describeGuardedSensitiveGitConfigCommand", () => {
  test.each([
    "git config alias.pf 'push --force origin main'",
    "git config --global alias.pf 'push --force origin main'",
    "git config core.hooksPath /tmp/evil-hooks",
    "git config core.sshCommand 'ssh -i /tmp/evil-key'",
    "git config credential.helper '!/tmp/evil-helper'",
    "git config diff.helper /tmp/evil-diff-helper",
  ])("flags: %s", (command) => {
    expect(describeGuardedSensitiveGitConfigCommand(command)).not.toBeNull();
  });

  test.each([
    "git status",
    "git config user.name test",
    "git config --get remote.origin.url",
    "npm config set registry https://example.com",
  ])("clears: %s", (command) => {
    expect(describeGuardedSensitiveGitConfigCommand(command)).toBeNull();
  });
});

describe("describeGuardedSensitiveGitInvocation (re-review finding #1)", () => {
  test.each([
    `git -c alias.pf="push --force origin main" pf`,
    `git -c alias.pf='push --force origin main' pf`,
    "git -c core.hooksPath=/tmp/evil-hooks status",
    "git -c core.sshCommand='ssh -i /tmp/evil-key' fetch",
    "git -c credential.helper=!/tmp/evil-helper fetch",
    "git --config-env=alias.pf=SOME_VAR pf",
    "git --config-env alias.pf=SOME_VAR pf",
  ])("flags the atomic set-and-invoke bypass: %s", (command) => {
    expect(describeGuardedSensitiveGitInvocation(command, REPO)).not.toBeNull();
  });

  test.each([
    "git status",
    "git -c user.name=test commit -m x",
    "git -c core.pager=cat log",
    "git --config-env=user.name=SOME_VAR commit -m x",
    "npm -c alias.pf=x run build",
  ])("clears an ordinary invocation: %s", (command) => {
    expect(describeGuardedSensitiveGitInvocation(command, REPO)).toBeNull();
  });

  test("the atomic bypass is declined end-to-end by decideCodexGuardedCommand", async () => {
    const result = await decideCodexGuardedCommand({
      command: `git -c alias.pf="push --force origin main" pf`,
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      resolveCurrentBranch: fakeBranchResolver("main"),
    });
    expect(result.decision).toBe("decline");
  });

  test("a GIT_CONFIG_KEY_* env-var alias setup is declined end-to-end", async () => {
    const result = await decideCodexGuardedCommand({
      command:
        'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.pf GIT_CONFIG_VALUE_0="push --force origin main" git pf',
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      resolveCurrentBranch: fakeBranchResolver("main"),
    });
    expect(result.decision).toBe("decline");
  });
});
