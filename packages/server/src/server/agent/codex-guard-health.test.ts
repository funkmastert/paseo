import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  evaluateCodexGuardSelfTest,
  getCodexGuardHealthState,
  isCodexGuardHealthy,
  recheckCodexGuardCommandItem,
  resetCodexGuardHealthStateForTests,
  runCodexGuardSelfTest,
  setCodexGuardHealthState,
  shouldRunCodexGuardSelfTest,
  type CodexGuardHealthState,
} from "./codex-guard-health.js";
import { CodexAppServerAgentClient } from "./providers/codex-app-server-agent.js";
import { createFakeCodexAppServer } from "./providers/codex/test-utils/fake-app-server.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { asInternals as castInternals } from "../test-utils/class-mocks.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { DeviceLaunchGate } from "./device-lease-manager.js";

beforeEach(() => {
  resetCodexGuardHealthStateForTests();
});

describe("codex guard health state", () => {
  test("starts unknown and unhealthy", () => {
    expect(getCodexGuardHealthState().status).toBe("unknown");
    expect(isCodexGuardHealthy()).toBe(false);
  });

  test("green makes the guard healthy; red and unknown do not", () => {
    setCodexGuardHealthState({ status: "green", reason: "ok", codexVersion: "0.160.0" });
    expect(isCodexGuardHealthy()).toBe(true);

    setCodexGuardHealthState({ status: "red", reason: "broken", codexVersion: "0.160.0" });
    expect(isCodexGuardHealthy()).toBe(false);
  });
});

describe("evaluateCodexGuardSelfTest", () => {
  const passing = {
    okApprovalSeen: true,
    okDecision: "accept" as const,
    okFileExists: true,
    canaryApprovalSeen: true,
    canaryDecision: "decline" as const,
    canaryDeclinedByCanaryRule: true,
    canaryFileExists: false,
    catastropheRuleSeen: true,
  };

  test("green when the ok command ran and the canary was declined by the canary rule", () => {
    expect(evaluateCodexGuardSelfTest(passing)).toMatchObject({ status: "green" });
  });

  test("red when no approval request arrived for the ok command", () => {
    expect(evaluateCodexGuardSelfTest({ ...passing, okApprovalSeen: false }).status).toBe("red");
  });

  test("red when the ok command was declined", () => {
    expect(evaluateCodexGuardSelfTest({ ...passing, okDecision: "decline" }).status).toBe("red");
  });

  test("red when no approval request arrived for the canary", () => {
    expect(evaluateCodexGuardSelfTest({ ...passing, canaryApprovalSeen: false }).status).toBe(
      "red",
    );
  });

  test("red when the canary command ran (its file exists)", () => {
    expect(evaluateCodexGuardSelfTest({ ...passing, canaryFileExists: true }).status).toBe("red");
  });

  test("red when the canary was declined for a reason other than the canary rule", () => {
    expect(
      evaluateCodexGuardSelfTest({ ...passing, canaryDeclinedByCanaryRule: false }).status,
    ).toBe("red");
  });

  test("red when the canary was accepted instead of declined", () => {
    expect(evaluateCodexGuardSelfTest({ ...passing, canaryDecision: "accept" }).status).toBe("red");
  });

  test("red when the catastrophe gate's force-push-main refusal was never observed (review finding #5)", () => {
    expect(evaluateCodexGuardSelfTest({ ...passing, catastropheRuleSeen: false }).status).toBe(
      "red",
    );
  });
});

describe("shouldRunCodexGuardSelfTest", () => {
  const baseState: CodexGuardHealthState = {
    status: "green",
    reason: "ok",
    timestamp: new Date("2026-01-01T00:00:00Z").toISOString(),
    codexVersion: "0.160.0",
  };

  test("is due when the binary version changed", () => {
    expect(
      shouldRunCodexGuardSelfTest(baseState, new Date("2026-01-01T00:01:00Z").getTime(), "0.161.0"),
    ).toBe(true);
  });

  test("is due after a day has passed", () => {
    const oneDayLater = new Date("2026-01-02T00:00:01Z").getTime();
    expect(shouldRunCodexGuardSelfTest(baseState, oneDayLater, "0.160.0")).toBe(true);
  });

  test("is not due within a day on the same version", () => {
    const soon = new Date("2026-01-01T01:00:00Z").getTime();
    expect(shouldRunCodexGuardSelfTest(baseState, soon, "0.160.0")).toBe(false);
  });

  test("is due at daemon start, before any self-test has ever run", () => {
    const freshState: CodexGuardHealthState = {
      status: "unknown",
      reason: "No self-test has run yet.",
      timestamp: new Date(0).toISOString(),
      codexVersion: null,
    };
    expect(shouldRunCodexGuardSelfTest(freshState, Date.now(), "0.160.0")).toBe(true);
  });
});

describe("recheckCodexGuardCommandItem", () => {
  test("no violation when an approval request already covered the command", async () => {
    const result = await recheckCodexGuardCommandItem({
      command: "git push --force origin main",
      cwd: "/repo",
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      approvalRequestSeen: true,
    });
    expect(result).toEqual({ violation: false });
  });

  test("violation when a gate would refuse the command and no approval request arrived", async () => {
    const result = await recheckCodexGuardCommandItem({
      command: "git push --force origin main",
      cwd: "/repo",
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      approvalRequestSeen: false,
      resolveCurrentBranch: async () => "main",
    });
    expect(result.violation).toBe(true);
  });

  test("no violation for a safe-list command that ran without a request", async () => {
    const result = await recheckCodexGuardCommandItem({
      command: "ls",
      cwd: "/repo",
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      approvalRequestSeen: false,
      resolveCurrentBranch: async () => "main",
    });
    expect(result).toEqual({ violation: false });
  });

  test("violation when the device gate would deny and no approval request arrived", async () => {
    const deviceLaunchGate: DeviceLaunchGate = {
      gateLaunch: async () => ({ decision: "deny", message: "no slot" }),
    };
    const result = await recheckCodexGuardCommandItem({
      command: "npm test",
      cwd: "/repo",
      agentId: "agent-1",
      deviceLaunchGate,
      approvalRequestSeen: false,
    });
    expect(result).toEqual({ violation: true, reason: "no slot" });
  });
});

describe("runCodexGuardSelfTest", () => {
  function createGuardedClient(appServer: ReturnType<typeof createFakeCodexAppServer>) {
    return (deviceLaunchGate: DeviceLaunchGate) => {
      const client = new CodexAppServerAgentClient(createTestLogger(), undefined, {
        deviceLaunchGate,
      });
      castInternals<{
        goalsEnabledPromise: Promise<boolean> | null;
        autoReviewEnabledPromise: Promise<boolean> | null;
        spawnAppServer: () => Promise<ChildProcessWithoutNullStreams>;
      }>(client).goalsEnabledPromise = Promise.resolve(false);
      castInternals<{ autoReviewEnabledPromise: Promise<boolean> | null }>(
        client,
      ).autoReviewEnabledPromise = Promise.resolve(false);
      castInternals<{ spawnAppServer: () => Promise<ChildProcessWithoutNullStreams> }>(
        client,
      ).spawnAppServer = async () => appServer.child;
      return client;
    };
  }

  /** The self-test's prompt embeds the real paths it generated; extract them to script the fake server. */
  function extractGuardPath(paramsJson: unknown, prefix: string): string {
    const text = JSON.stringify(paramsJson);
    const match = new RegExp(`\\S*${prefix}-[0-9a-f-]{36}`).exec(text);
    if (!match) throw new Error(`No ${prefix} path found in turn/start params`);
    return match[0];
  }

  test("sets health green when the fake app server approves the ok touch and denies the canary", async () => {
    const appServer = createFakeCodexAppServer({
      "turn/steer": () => ({ turn: { id: "native-A" } }),
    });

    const runPromise = runCodexGuardSelfTest({
      createClient: createGuardedClient(appServer),
      model: "gpt-6-luna",
      codexVersion: "0.160.0",
      timeoutMs: 5_000,
    });

    const turnStartParams = await appServer.waitForTurnStart();
    appServer.startsTurn({ threadId: "thread-1", turnId: "native-A" });
    const okPath = extractGuardPath(turnStartParams, "paseo-guard-ok");
    const canaryPath = extractGuardPath(turnStartParams, "paseo-guard-canary");

    appServer.requestCommandApproval({
      itemId: "ok-item",
      threadId: "thread-1",
      turnId: "native-A",
      command: `touch ${okPath}`,
      cwd: "/tmp",
      reason: "ok",
    });
    await appServer.waitForCommandApprovalDecision("ok-item");
    // The fake app server never really runs the shell command; simulate what an approved
    // `touch` would have done, the same way a real guarded Codex child's would.
    writeFileSync(okPath, "");

    appServer.requestCommandApproval({
      itemId: "canary-item",
      threadId: "thread-1",
      turnId: "native-A",
      command: `touch ${canaryPath}`,
      cwd: "/tmp",
      reason: "canary",
    });
    await appServer.waitForCommandApprovalDecision("canary-item");

    // The force-push command (review finding #5) is declined by the real catastrophe gate --
    // reached via the same guarded-mode approval handler as a production Codex child -- before
    // the fake device gate above is ever consulted.
    appServer.requestCommandApproval({
      itemId: "force-push-item",
      threadId: "thread-1",
      turnId: "native-A",
      command: "git push --force origin main",
      cwd: "/tmp",
      reason: "force push",
    });
    await appServer.waitForCommandApprovalDecision("force-push-item");

    appServer.completeTurn({ threadId: "thread-1" });

    await runPromise;

    expect(getCodexGuardHealthState()).toMatchObject({ status: "green" });
  });

  test("logs the git scaffold's own failure, distinguishable from a guard regression (re-review finding #8)", async () => {
    const appServer = createFakeCodexAppServer({
      "turn/steer": () => ({ turn: { id: "native-A" } }),
    });
    const warn = vi.fn();
    const emptyBinDir = mkdtempSync(path.join(os.tmpdir(), "codex-guard-no-git-"));
    const originalPath = process.env.PATH;
    process.env.PATH = emptyBinDir;
    try {
      const runPromise = runCodexGuardSelfTest({
        createClient: createGuardedClient(appServer),
        model: "gpt-6-luna",
        codexVersion: "0.160.0",
        timeoutMs: 5_000,
        logger: { warn },
      });

      const turnStartParams = await appServer.waitForTurnStart();
      appServer.startsTurn({ threadId: "thread-1", turnId: "native-A" });
      const okPath = extractGuardPath(turnStartParams, "paseo-guard-ok");
      const canaryPath = extractGuardPath(turnStartParams, "paseo-guard-canary");

      appServer.requestCommandApproval({
        itemId: "ok-item",
        threadId: "thread-1",
        turnId: "native-A",
        command: `touch ${okPath}`,
        cwd: "/tmp",
        reason: "ok",
      });
      await appServer.waitForCommandApprovalDecision("ok-item");
      writeFileSync(okPath, "");
      appServer.requestCommandApproval({
        itemId: "canary-item",
        threadId: "thread-1",
        turnId: "native-A",
        command: `touch ${canaryPath}`,
        cwd: "/tmp",
        reason: "canary",
      });
      await appServer.waitForCommandApprovalDecision("canary-item");
      appServer.completeTurn({ threadId: "thread-1" });

      await runPromise;

      expect(warn).toHaveBeenCalledWith(
        expect.anything(),
        "Codex guard self-test git scaffold setup failed",
      );
    } finally {
      process.env.PATH = originalPath;
      rmSync(emptyBinDir, { recursive: true, force: true });
    }
  });

  test("the git scaffold's own timeout keeps a hanging git from blocking the self-test (re-review finding #5)", async () => {
    const appServer = createFakeCodexAppServer({
      "turn/steer": () => ({ turn: { id: "native-A" } }),
    });
    const warn = vi.fn();
    const slowBinDir = mkdtempSync(path.join(os.tmpdir(), "codex-guard-slow-git-"));
    const fakeGitPath = path.join(slowBinDir, "git");
    // Sleeps far longer than the 200ms scaffold timeout below; if the timeout did not kill it,
    // this test would itself hang for 5s instead of completing almost immediately.
    writeFileSync(fakeGitPath, "#!/bin/sh\nsleep 5\n");
    chmodSync(fakeGitPath, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${slowBinDir}:${originalPath ?? ""}`;
    try {
      const startedAt = Date.now();
      const runPromise = runCodexGuardSelfTest({
        createClient: createGuardedClient(appServer),
        model: "gpt-6-luna",
        codexVersion: "0.160.0",
        timeoutMs: 5_000,
        gitScaffoldTimeoutMs: 200,
        logger: { warn },
      });

      const turnStartParams = await appServer.waitForTurnStart();
      appServer.startsTurn({ threadId: "thread-1", turnId: "native-A" });
      const okPath = extractGuardPath(turnStartParams, "paseo-guard-ok");
      const canaryPath = extractGuardPath(turnStartParams, "paseo-guard-canary");

      appServer.requestCommandApproval({
        itemId: "ok-item",
        threadId: "thread-1",
        turnId: "native-A",
        command: `touch ${okPath}`,
        cwd: "/tmp",
        reason: "ok",
      });
      await appServer.waitForCommandApprovalDecision("ok-item");
      writeFileSync(okPath, "");
      appServer.requestCommandApproval({
        itemId: "canary-item",
        threadId: "thread-1",
        turnId: "native-A",
        command: `touch ${canaryPath}`,
        cwd: "/tmp",
        reason: "canary",
      });
      await appServer.waitForCommandApprovalDecision("canary-item");
      appServer.completeTurn({ threadId: "thread-1" });

      await runPromise;
      const elapsedMs = Date.now() - startedAt;

      // Well under the fake git's 5s sleep: the 200ms scaffold timeout, not the real exit, is
      // what ended the wait.
      expect(elapsedMs).toBeLessThan(4_000);
      expect(warn).toHaveBeenCalledWith(
        expect.anything(),
        "Codex guard self-test git scaffold setup failed",
      );
    } finally {
      process.env.PATH = originalPath;
      rmSync(slowBinDir, { recursive: true, force: true });
    }
  });

  test("sets health red when the force-push command's catastrophe-gate refusal is never observed (review finding #5)", async () => {
    const appServer = createFakeCodexAppServer({
      "turn/steer": () => ({ turn: { id: "native-A" } }),
    });

    const runPromise = runCodexGuardSelfTest({
      createClient: createGuardedClient(appServer),
      model: "gpt-6-luna",
      codexVersion: "0.160.0",
      timeoutMs: 5_000,
    });

    const turnStartParams = await appServer.waitForTurnStart();
    appServer.startsTurn({ threadId: "thread-1", turnId: "native-A" });
    const okPath = extractGuardPath(turnStartParams, "paseo-guard-ok");
    const canaryPath = extractGuardPath(turnStartParams, "paseo-guard-canary");

    appServer.requestCommandApproval({
      itemId: "ok-item",
      threadId: "thread-1",
      turnId: "native-A",
      command: `touch ${okPath}`,
      cwd: "/tmp",
      reason: "ok",
    });
    await appServer.waitForCommandApprovalDecision("ok-item");
    writeFileSync(okPath, "");

    appServer.requestCommandApproval({
      itemId: "canary-item",
      threadId: "thread-1",
      turnId: "native-A",
      command: `touch ${canaryPath}`,
      cwd: "/tmp",
      reason: "canary",
    });
    await appServer.waitForCommandApprovalDecision("canary-item");

    // The model never attempts the third command at all -- no force-push approval request, so no
    // catastrophe-gate refusal was ever observed.
    appServer.completeTurn({ threadId: "thread-1" });

    await runPromise;

    expect(getCodexGuardHealthState()).toMatchObject({ status: "red" });
  });

  test("a live-detection red that lands mid-run stays sticky against this self-test's own green verdict (review finding #6)", async () => {
    const appServer = createFakeCodexAppServer({
      "turn/steer": () => ({ turn: { id: "native-A" } }),
    });

    const runPromise = runCodexGuardSelfTest({
      createClient: createGuardedClient(appServer),
      model: "gpt-6-luna",
      codexVersion: "0.160.0",
      timeoutMs: 5_000,
    });

    const turnStartParams = await appServer.waitForTurnStart();
    appServer.startsTurn({ threadId: "thread-1", turnId: "native-A" });
    const okPath = extractGuardPath(turnStartParams, "paseo-guard-ok");
    const canaryPath = extractGuardPath(turnStartParams, "paseo-guard-canary");

    // A different, concurrently-running guarded child's live detection turns health red while
    // this self-test is still in flight.
    setCodexGuardHealthState({
      status: "red",
      reason: "live detection landed mid-run",
      codexVersion: "0.160.0",
    });

    appServer.requestCommandApproval({
      itemId: "ok-item",
      threadId: "thread-1",
      turnId: "native-A",
      command: `touch ${okPath}`,
      cwd: "/tmp",
      reason: "ok",
    });
    await appServer.waitForCommandApprovalDecision("ok-item");
    writeFileSync(okPath, "");

    appServer.requestCommandApproval({
      itemId: "canary-item",
      threadId: "thread-1",
      turnId: "native-A",
      command: `touch ${canaryPath}`,
      cwd: "/tmp",
      reason: "canary",
    });
    await appServer.waitForCommandApprovalDecision("canary-item");

    appServer.requestCommandApproval({
      itemId: "force-push-item",
      threadId: "thread-1",
      turnId: "native-A",
      command: "git push --force origin main",
      cwd: "/tmp",
      reason: "force push",
    });
    await appServer.waitForCommandApprovalDecision("force-push-item");

    appServer.completeTurn({ threadId: "thread-1" });

    // This self-test's own observations would otherwise compute a green verdict here.
    await runPromise;

    expect(getCodexGuardHealthState()).toMatchObject({
      status: "red",
      reason: "live detection landed mid-run",
    });
  });
});
