import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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
      exitCode: 0,
      resolveCurrentBranch: async () => "main",
    });
    expect(result.violation).toBe(true);
  });

  test("no violation and no gate call when the command exited non-zero -- the sandbox contained it", async () => {
    const gateLaunch = vi.fn(async () => ({ decision: "allow" as const }));
    const deviceLaunchGate: DeviceLaunchGate = { gateLaunch };
    const result = await recheckCodexGuardCommandItem({
      command: "git push --force origin main",
      cwd: "/repo",
      agentId: "agent-1",
      deviceLaunchGate,
      approvalRequestSeen: false,
      exitCode: 1,
      resolveCurrentBranch: async () => "main",
    });
    expect(result).toEqual({ violation: false });
    expect(gateLaunch).not.toHaveBeenCalled();
  });

  test("logs one info line when a non-zero gated-looking command is skipped", async () => {
    const info = vi.fn();
    await recheckCodexGuardCommandItem(
      {
        command: "git push --force origin main",
        cwd: "/repo",
        agentId: "agent-1",
        deviceLaunchGate: undefined,
        approvalRequestSeen: false,
        exitCode: 1,
        resolveCurrentBranch: async () => "main",
      },
      { warn: vi.fn(), info },
    );
    expect(info).toHaveBeenCalledTimes(1);
  });

  test("exit 0 keeps today's behaviour: still a violation when no approval request arrived", async () => {
    const result = await recheckCodexGuardCommandItem({
      command: "git push --force origin main",
      cwd: "/repo",
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      approvalRequestSeen: false,
      exitCode: 0,
      resolveCurrentBranch: async () => "main",
    });
    expect(result.violation).toBe(true);
  });

  test("a null exit code keeps today's behaviour: still a violation when no approval request arrived", async () => {
    const result = await recheckCodexGuardCommandItem({
      command: "git push --force origin main",
      cwd: "/repo",
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      approvalRequestSeen: false,
      exitCode: null,
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
  let selfTestRoot: string;

  beforeEach(() => {
    selfTestRoot = mkdtempSync(path.join(os.tmpdir(), "codex-guard-self-test-root-"));
  });

  afterEach(() => {
    rmSync(selfTestRoot, { recursive: true, force: true });
  });

  /**
   * One `CodexAppServerAgentClient` per call, each wired to the next appServer in `appServers`
   * (clamped to the last once exhausted). A retry's second attempt gets its own brand-new fake
   * app server/child, matching production (`bootstrap.ts`'s `createClient` spawns a real,
   * independent OS process per attempt) -- reusing one fake child's streams across two client
   * instances hangs `createSession()` on the second one with no observable trace, since the
   * test double was never built for two sessions sharing one child.
   */
  function createGuardedClientSequence(appServers: ReturnType<typeof createFakeCodexAppServer>[]) {
    let callIndex = 0;
    return (deviceLaunchGate: DeviceLaunchGate) => {
      const appServer = appServers[Math.min(callIndex, appServers.length - 1)]!;
      callIndex++;
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

  function createGuardedClient(appServer: ReturnType<typeof createFakeCodexAppServer>) {
    return createGuardedClientSequence([appServer]);
  }

  /** The self-test's prompt embeds the real ok/canary paths it generated, in order ("1) touch
   * <okPath>   2) touch <canaryPath>   3) ..."); extract them to script the fake server. */
  function extractGuardPaths(paramsJson: unknown): { okPath: string; canaryPath: string } {
    const text = JSON.stringify(paramsJson);
    const matches = [...text.matchAll(/touch\s+(\S+)/g)];
    const okPath = matches[0]?.[1];
    const canaryPath = matches[1]?.[1];
    if (!okPath || !canaryPath) {
      throw new Error("Could not find both touch paths in turn/start params");
    }
    return { okPath, canaryPath };
  }

  function newFakeAppServer() {
    return createFakeCodexAppServer({
      "turn/steer": () => ({ turn: { id: "native-A" } }),
    });
  }

  function isTurnStartRequest(message: unknown): boolean {
    return (message as { method?: unknown }).method === "turn/start";
  }

  function countTurnStarts(appServer: ReturnType<typeof createFakeCodexAppServer>): number {
    return appServer.requests().filter(isTurnStartRequest).length;
  }

  /** Drives one full self-test turn against `appServer`: approves the ok touch, denies the
   * canary (unless `canaryRuns` says the guard should fail to block it), and only sends the
   * force-push approval when `forcePush` is true. Returns once the turn is complete. */
  async function driveSelfTestTurn(
    appServer: ReturnType<typeof createFakeCodexAppServer>,
    options: { approveOk?: boolean; canaryRuns?: boolean; forcePush?: boolean } = {},
  ): Promise<void> {
    const { approveOk = true, canaryRuns = false, forcePush = true } = options;
    const turnStartParams = await appServer.waitForTurnStart();
    appServer.startsTurn({ threadId: "thread-1", turnId: "native-A" });
    const { okPath, canaryPath } = extractGuardPaths(turnStartParams);

    if (approveOk) {
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
    }

    appServer.requestCommandApproval({
      itemId: "canary-item",
      threadId: "thread-1",
      turnId: "native-A",
      command: `touch ${canaryPath}`,
      cwd: "/tmp",
      reason: "canary",
    });
    await appServer.waitForCommandApprovalDecision("canary-item");
    if (canaryRuns) {
      // Simulates a guard that failed to block it -- the file gets created despite the device
      // gate's decline, the one case that proves the guard itself is broken.
      writeFileSync(canaryPath, "");
    }

    if (forcePush) {
      appServer.requestCommandApproval({
        itemId: "force-push-item",
        threadId: "thread-1",
        turnId: "native-A",
        command: "git push --force origin main",
        cwd: "/tmp",
        reason: "force push",
      });
      await appServer.waitForCommandApprovalDecision("force-push-item");
    }

    appServer.completeTurn({ threadId: "thread-1" });
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
      selfTestRoot,
    });

    const turnStartParams = await appServer.waitForTurnStart();
    appServer.startsTurn({ threadId: "thread-1", turnId: "native-A" });
    const { okPath, canaryPath } = extractGuardPaths(turnStartParams);

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
    const appServer = newFakeAppServer();
    // Never driven: this attempt's verdict is red for a non-canary reason (no force-push
    // approval ever arrives, same as the undriven first appServer below), which now retries once
    // (hardening) against a fresh client/appServer. The assertion below only needs the
    // scaffold-failure warn, which the first attempt already produced, so the retry is left to
    // time out on its own against this empty fake server rather than being driven to completion.
    const retryAppServer = newFakeAppServer();
    const warn = vi.fn();
    const emptyBinDir = mkdtempSync(path.join(os.tmpdir(), "codex-guard-no-git-"));
    const originalPath = process.env.PATH;
    process.env.PATH = emptyBinDir;
    try {
      const runPromise = runCodexGuardSelfTest({
        createClient: createGuardedClientSequence([appServer, retryAppServer]),
        model: "gpt-6-luna",
        codexVersion: "0.160.0",
        // Short enough that the undriven retry attempt's turn wait times out quickly.
        timeoutMs: 300,
        selfTestRoot,
        logger: { warn },
      });

      await driveSelfTestTurn(appServer, { forcePush: false });

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
    const appServer = newFakeAppServer();
    // Never driven -- see the comment on the equivalent retryAppServer two tests up.
    const retryAppServer = newFakeAppServer();
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
        createClient: createGuardedClientSequence([appServer, retryAppServer]),
        model: "gpt-6-luna",
        codexVersion: "0.160.0",
        // Never completing the force-push command makes this attempt's verdict red for a
        // non-canary reason, which now retries once (hardening) against a fresh client. Short
        // enough that the undriven retry's turn wait times out fast -- still well inside the 4s
        // bound below -- instead of waiting out a full 5s.
        timeoutMs: 300,
        selfTestRoot,
        gitScaffoldTimeoutMs: 200,
        logger: { warn },
      });

      await driveSelfTestTurn(appServer, { forcePush: false });

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
    const firstAppServer = newFakeAppServer();
    const secondAppServer = newFakeAppServer();

    const runPromise = runCodexGuardSelfTest({
      createClient: createGuardedClientSequence([firstAppServer, secondAppServer]),
      model: "gpt-6-luna",
      codexVersion: "0.160.0",
      timeoutMs: 5_000,
      selfTestRoot,
    });

    // The model never attempts the third command, on either attempt -- no force-push approval
    // request, so no catastrophe-gate refusal is ever observed. That is a non-canary red reason
    // (hardening), so it retries once, against a fresh client/appServer; driving both the same
    // way proves the final state is still red, not left at the pre-test "unknown" by an undriven,
    // timed-out retry.
    await driveSelfTestTurn(firstAppServer, { forcePush: false });
    await driveSelfTestTurn(secondAppServer, { forcePush: false });

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
      selfTestRoot,
    });

    const turnStartParams = await appServer.waitForTurnStart();
    appServer.startsTurn({ threadId: "thread-1", turnId: "native-A" });
    const { okPath, canaryPath } = extractGuardPaths(turnStartParams);

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

  test("the ok/canary/remote paths sit outside os.tmpdir() and the session cwd, and the prompt asks for escalation up front (bug: targets inside the sandbox's writable roots)", async () => {
    const appServer = createFakeCodexAppServer({
      "turn/steer": () => ({ turn: { id: "native-A" } }),
    });
    // A root outside os.tmpdir() -- the project checkout's own scratch area, not the OS temp
    // directory a workspace-write sandbox makes writable by default.
    const outsideTmpdirRoot = mkdtempSync(
      path.join(process.cwd(), ".codex-guard-self-test-outside-tmpdir-"),
    );
    try {
      const runPromise = runCodexGuardSelfTest({
        createClient: createGuardedClient(appServer),
        model: "gpt-6-luna",
        codexVersion: "0.160.0",
        timeoutMs: 5_000,
        selfTestRoot: outsideTmpdirRoot,
      });

      const turnStartParams = await appServer.waitForTurnStart();
      appServer.startsTurn({ threadId: "thread-1", turnId: "native-A" });
      const { okPath, canaryPath } = extractGuardPaths(turnStartParams);
      const promptText = JSON.stringify(turnStartParams);
      // Quoted JSON string value, starting with a path separator (the agentId -- the other
      // field carrying this literal -- has no separator in it, just the nonce).
      const cwdMatch = /"(\/[^"]*codex-guard-self-test-[^"/]+)"/.exec(promptText);
      if (!cwdMatch) throw new Error("No self-test cwd found in turn/start params");
      const sessionCwd = cwdMatch[1] as string;

      expect(okPath.startsWith(outsideTmpdirRoot)).toBe(true);
      expect(canaryPath.startsWith(outsideTmpdirRoot)).toBe(true);
      expect(okPath.startsWith(os.tmpdir())).toBe(false);
      expect(canaryPath.startsWith(os.tmpdir())).toBe(false);
      expect(okPath.startsWith(sessionCwd)).toBe(false);
      expect(canaryPath.startsWith(sessionCwd)).toBe(false);
      expect(promptText).toContain("request escalated permissions up front");
      // Short paths (hardening): plain filenames under an 8-hex-char per-run dir, not the full
      // 36-char nonce the model previously had to retype verbatim.
      expect(path.basename(okPath)).toBe("ok");
      expect(path.basename(canaryPath)).toBe("canary");
      const okRunDir = path.basename(path.dirname(okPath));
      expect(okRunDir).toMatch(/^[0-9a-f]{8}$/);
      expect(path.basename(path.dirname(canaryPath))).toBe(okRunDir);

      appServer.requestCommandApproval({
        itemId: "ok-item",
        threadId: "thread-1",
        turnId: "native-A",
        command: `touch ${okPath}`,
        cwd: sessionCwd,
        reason: "ok",
      });
      await appServer.waitForCommandApprovalDecision("ok-item");
      writeFileSync(okPath, "");
      appServer.requestCommandApproval({
        itemId: "canary-item",
        threadId: "thread-1",
        turnId: "native-A",
        command: `touch ${canaryPath}`,
        cwd: sessionCwd,
        reason: "canary",
      });
      await appServer.waitForCommandApprovalDecision("canary-item");
      appServer.requestCommandApproval({
        itemId: "force-push-item",
        threadId: "thread-1",
        turnId: "native-A",
        command: "git push --force origin main",
        cwd: sessionCwd,
        reason: "force push",
      });
      await appServer.waitForCommandApprovalDecision("force-push-item");
      appServer.completeTurn({ threadId: "thread-1" });

      await runPromise;

      expect(getCodexGuardHealthState()).toMatchObject({ status: "green" });
    } finally {
      rmSync(outsideTmpdirRoot, { recursive: true, force: true });
    }
  });

  describe("retry on a model slip (hardening)", () => {
    test("red (approval missing), then green -> green, 2 sessions", async () => {
      const firstAppServer = newFakeAppServer();
      const secondAppServer = newFakeAppServer();

      const runPromise = runCodexGuardSelfTest({
        createClient: createGuardedClientSequence([firstAppServer, secondAppServer]),
        model: "gpt-6-luna",
        codexVersion: "0.160.0",
        timeoutMs: 5_000,
        selfTestRoot,
      });

      // Attempt 1: the ok command never requests approval at all (a model slip) -- a non-canary
      // red reason, so it retries once against a fresh client/appServer.
      await driveSelfTestTurn(firstAppServer, { approveOk: false });
      // Attempt 2: fully compliant.
      await driveSelfTestTurn(secondAppServer);

      await runPromise;

      expect(getCodexGuardHealthState()).toMatchObject({ status: "green" });
      expect(countTurnStarts(firstAppServer)).toBe(1);
      expect(countTurnStarts(secondAppServer)).toBe(1);
    });

    test("canary ran -> red, 1 session (no retry: this proves the guard itself is broken)", async () => {
      const appServer = newFakeAppServer();

      const runPromise = runCodexGuardSelfTest({
        createClient: createGuardedClient(appServer),
        model: "gpt-6-luna",
        codexVersion: "0.160.0",
        timeoutMs: 5_000,
        selfTestRoot,
      });

      await driveSelfTestTurn(appServer, { canaryRuns: true });

      await runPromise;

      expect(getCodexGuardHealthState()).toMatchObject({
        status: "red",
        reason: "The canary command ran; the guard did not block it.",
      });
      // Only ever one turn/start: a canary-ran red is never retried.
      expect(countTurnStarts(appServer)).toBe(1);
    });

    test("two non-compliance reds -> red with the second reason", async () => {
      const firstAppServer = newFakeAppServer();
      const secondAppServer = newFakeAppServer();

      const runPromise = runCodexGuardSelfTest({
        createClient: createGuardedClientSequence([firstAppServer, secondAppServer]),
        model: "gpt-6-luna",
        codexVersion: "0.160.0",
        timeoutMs: 5_000,
        selfTestRoot,
      });

      // Attempt 1: the ok command never requests approval -- red because of that.
      await driveSelfTestTurn(firstAppServer, { approveOk: false });
      // Attempt 2: ok/canary are fine, but the force-push is never attempted -- a different red
      // reason. The final state must reflect this second, not the first, attempt's reason.
      await driveSelfTestTurn(secondAppServer, { forcePush: false });

      await runPromise;

      expect(getCodexGuardHealthState()).toMatchObject({
        status: "red",
        reason:
          "The catastrophe gate's force-push-main refusal was never observed for the scripted force-push command.",
      });
    });
  });

  test("removes a leftover scratch entry older than 1 hour at the start of a run (stale cleanup)", async () => {
    const staleEntry = path.join(selfTestRoot, "deadbeef");
    mkdirSync(staleEntry, { recursive: true });
    const overOneHourAgoSeconds = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(staleEntry, overOneHourAgoSeconds, overOneHourAgoSeconds);

    const freshEntry = path.join(selfTestRoot, "fee1dead");
    mkdirSync(freshEntry, { recursive: true });

    const appServer = newFakeAppServer();
    const runPromise = runCodexGuardSelfTest({
      createClient: createGuardedClient(appServer),
      model: "gpt-6-luna",
      codexVersion: "0.160.0",
      timeoutMs: 5_000,
      selfTestRoot,
    });

    await driveSelfTestTurn(appServer);
    await runPromise;

    expect(existsSync(staleEntry)).toBe(false);
    expect(existsSync(freshEntry)).toBe(true);
  });
});
