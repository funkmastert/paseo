import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountAuthProbe,
  type AccountAuthProbeOptions,
  type AccountAuthProbeRequest,
  type ProbeProcessResult,
  type RunProbeProcess,
} from "./account-auth-probe.js";

const T0 = Date.parse("2026-10-12T18:00:00Z");
const FIFTEEN_MIN = 15 * 60_000;
const silent = pino({ level: "silent" });

function request(overrides: Partial<AccountAuthProbeRequest> = {}): AccountAuthProbeRequest {
  return {
    providerId: "claude-personal",
    configDir: "/tmp/x",
    hasRunningAgent: false,
    nowMs: T0,
    ...overrides,
  };
}

function makeProbe(run: RunProbeProcess, overrides: Partial<AccountAuthProbeOptions> = {}) {
  return new AccountAuthProbe({
    logger: silent,
    runProcess: run,
    resolveBinary: async () => "claude",
    scratchDir: () => "/tmp/probe-scratch",
    ...overrides,
  });
}

function spyLogger() {
  const warn = vi.fn();
  const logger = { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { warn, logger: logger as unknown as AccountAuthProbeOptions["logger"] };
}

const scratchDirs: string[] = [];
function realScratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "account-auth-probe-test-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("AccountAuthProbe", () => {
  it("confirms auth_failure on auth-shaped output", async () => {
    const probe = makeProbe(async () => ({
      stdout: "",
      stderr: "Failed to authenticate: OAuth session expired",
      exitCode: 1,
      timedOut: false,
    }));
    expect(await probe.run(request())).toBe("auth_failure");
  });

  it("clears on a clean exit", async () => {
    const probe = makeProbe(async () => ({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }));
    expect(await probe.run(request())).toBe("success");
  });

  it("is inconclusive on a timeout", async () => {
    const probe = makeProbe(async () => ({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: true,
    }));
    expect(await probe.run(request())).toBe("inconclusive");
  });

  it("is inconclusive on an unrelated non-zero exit, and says so with the account", async () => {
    const { warn, logger } = spyLogger();
    const probe = makeProbe(
      async () => ({ stdout: "", stderr: "network error", exitCode: 1, timedOut: false }),
      { logger },
    );
    expect(await probe.run(request())).toBe("inconclusive");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "claude-personal",
        exitCode: 1,
        stderr: "network error",
      }),
      "Account sign-in probe was inconclusive",
    );
  });

  it("is inconclusive, and says so with the account, when the CLI cannot run", async () => {
    const { warn, logger } = spyLogger();
    const probe = makeProbe(
      async () => {
        throw new Error("spawn EACCES");
      },
      { logger },
    );
    expect(await probe.run(request())).toBe("inconclusive");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "claude-personal", err: expect.any(Error) }),
      "Account sign-in probe could not run the CLI",
    );
  });

  it("never runs while an agent on the account is running", async () => {
    const run = vi.fn();
    const probe = makeProbe(run);
    expect(await probe.run(request({ hasRunningAgent: true }))).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not run twice inside 15 minutes for the same account", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false });
    const probe = makeProbe(run);
    const first = await probe.run(request());
    const second = await probe.run(request({ nowMs: T0 + FIFTEEN_MIN - 1 }));
    expect(first).toBe("success");
    expect(second).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs again once 15 minutes have passed", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false });
    const probe = makeProbe(run);
    await probe.run(request());
    expect(await probe.run(request({ nowMs: T0 + FIFTEEN_MIN }))).toBe("success");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs one Haiku turn with the resolved binary, overlaying only the entry's CLAUDE_CONFIG_DIR", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false });
    const probe = makeProbe(run, { resolveBinary: async () => "/opt/claude/bin/claude" });
    await probe.run(request());
    expect(run).toHaveBeenCalledWith(
      "/opt/claude/bin/claude",
      ["-p", "reply ok", "--model", "haiku", "--max-turns", "1", "--no-session-persistence"],
      { envOverlay: { CLAUDE_CONFIG_DIR: "/tmp/x" }, cwd: "/tmp/probe-scratch", timeoutMs: 60_000 },
    );
  });

  it("is inconclusive, spawns nothing, and says so with the account when no claude binary resolves", async () => {
    const run = vi.fn();
    const { warn, logger } = spyLogger();
    const probe = makeProbe(run, {
      logger,
      resolveBinary: async () => {
        throw new Error("Claude binary not found");
      },
    });
    expect(await probe.run(request())).toBe("inconclusive");
    expect(run).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "claude-personal" }),
      "Account sign-in probe found no claude binary",
    );
  });

  it("reuses one scratch directory across runs", async () => {
    const scratchDir = vi.fn(realScratchDir);
    const probe = makeProbe(
      async () => ({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false }),
      { scratchDir },
    );
    for (const providerId of ["claude-personal", "claude-backup"]) {
      await probe.run(request({ providerId }));
    }
    expect(scratchDir).toHaveBeenCalledTimes(1);
  });

  it("makes the scratch directory again when the OS purged it", async () => {
    const cwds: string[] = [];
    const probe = makeProbe(
      async (_command, _args, options) => {
        cwds.push(options.cwd);
        return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false };
      },
      { scratchDir: realScratchDir },
    );
    await probe.run(request({ providerId: "claude-personal" }));
    rmSync(cwds[0] ?? "", { recursive: true, force: true });
    await probe.run(request({ providerId: "claude-backup" }));

    expect(cwds).toHaveLength(2);
    expect(cwds[1]).not.toBe(cwds[0]);
    expect(existsSync(cwds[1] ?? "")).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "reads a real CLI's failing exit: its output and exit code",
    async () => {
      const binDir = realScratchDir();
      const fakeClaude = join(binDir, "claude");
      writeFileSync(
        fakeClaude,
        '#!/bin/sh\necho "Not logged in · Please run /login" >&2\nexit 1\n',
      );
      chmodSync(fakeClaude, 0o755);
      const probe = new AccountAuthProbe({
        logger: silent,
        resolveBinary: async () => fakeClaude,
        scratchDir: realScratchDir,
      });
      expect(await probe.run(request())).toBe("auth_failure");
    },
  );

  it("start() returns before the CLI finishes, and the result is collected afterwards", async () => {
    let finish: (result: ProbeProcessResult) => void = () => {};
    const probe = makeProbe(
      () =>
        new Promise<ProbeProcessResult>((resolve) => {
          finish = resolve;
        }),
      { now: () => T0 },
    );

    expect(probe.start(request())).toBe(true);
    expect(probe.takeFinished()).toEqual([]);

    await vi.waitFor(() => expect(probe.takeFinished()).toEqual([]));
    finish({ stdout: "", stderr: "Not logged in", exitCode: 1, timedOut: false });
    await vi.waitFor(() =>
      expect(probe.takeFinished()).toEqual([
        { providerId: "claude-personal", result: "auth_failure", atMs: T0 },
      ]),
    );
    expect(probe.takeFinished()).toEqual([]);
  });

  it("dates a finished probe when the CLI answered, not when it was started", async () => {
    let finish: (result: ProbeProcessResult) => void = () => {};
    let clock = T0;
    const probe = makeProbe(
      () =>
        new Promise<ProbeProcessResult>((resolve) => {
          finish = resolve;
        }),
      { now: () => clock },
    );

    probe.start(request());
    await vi.waitFor(() => expect(probe.takeFinished()).toEqual([]));
    clock = T0 + 40_000;
    finish({ stdout: "", stderr: "Not logged in", exitCode: 1, timedOut: false });

    await vi.waitFor(() =>
      expect(probe.takeFinished()).toEqual([
        { providerId: "claude-personal", result: "auth_failure", atMs: T0 + 40_000 },
      ]),
    );
  });
});
