import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCachedCliPathResolver,
  createForgeCliRunner,
  probeHostViaCliAuthStatus,
} from "./forge-cli-command.js";
import { isForgePollPidLive } from "../server/agent/daemon-forge-poll-pids.js";
import { isPlatform } from "../test-utils/platform.js";

describe.skipIf(isPlatform("win32"))("probeHostViaCliAuthStatus", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "forge-cli-command-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeFakeCli(script: string): string {
    const cliPath = join(tempDir, "forge-cli");
    writeFileSync(cliPath, script);
    chmodSync(cliPath, 0o755);
    return cliPath;
  }

  it("recognizes a host when the CLI auth status succeeds", async () => {
    const cli = writeFakeCli(`#!/bin/sh
if [ "$1" = "--version" ]; then
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "$3" = "--hostname" ] && [ "$4" = "git.acme.internal" ]; then
  exit 0
fi
exit 1
`);

    await expect(
      probeHostViaCliAuthStatus({
        cli,
        host: "git.acme.internal",
      }),
    ).resolves.toBe(true);
  });

  it("rejects a host when the CLI auth status fails", async () => {
    const cli = writeFakeCli(`#!/bin/sh
if [ "$1" = "--version" ]; then
  exit 0
fi
exit 1
`);

    await expect(
      probeHostViaCliAuthStatus({
        cli,
        host: "git.acme.internal",
      }),
    ).resolves.toBe(false);
  });

  it("rejects a host when the CLI is missing", async () => {
    await expect(
      probeHostViaCliAuthStatus({
        cli: join(tempDir, "missing-cli"),
        host: "git.acme.internal",
      }),
    ).resolves.toBe(false);
  });
});

describe.skipIf(isPlatform("win32"))("createForgeCliRunner", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "forge-cli-runner-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Polls until the CLI script has written its own pid, up to a few seconds. */
  async function readPidOnceWritten(pidFile: string): Promise<number> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (existsSync(pidFile)) {
        const content = readFileSync(pidFile, "utf8").trim();
        if (content.length > 0) return Number.parseInt(content, 10);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    throw new Error(`${pidFile} was never written`);
  }

  function writeSlowCli(): string {
    const cliPath = join(tempDir, "slow-cli");
    writeFileSync(cliPath, "#!/bin/sh\nsleep 5\n");
    chmodSync(cliPath, 0o755);
    return cliPath;
  }

  class FakeCommandError extends Error {
    readonly stderr: string;
    constructor(params: { stderr: string }) {
      super("command failed");
      this.stderr = params.stderr;
    }
  }

  it("kills a hung CLI invocation after the configured timeout", async () => {
    const cli = writeSlowCli();
    const runner = createForgeCliRunner({
      binary: cli,
      envOverlay: {},
      timeoutMs: 100,
      isAuthFailureText: () => false,
      errorClasses: {
        isAlreadyClassified: () => false,
        isCommandError: (error): error is FakeCommandError => error instanceof FakeCommandError,
        createAuthError: (stderr) => new Error(`auth: ${stderr}`),
        createMissingError: () => new Error("missing"),
        createCommandError: (params) => new FakeCommandError(params),
      },
    });

    await expect(runner.run(["arg"], { cwd: tempDir })).rejects.toThrow();
  });

  it("registers the child pid as a live forge poll while it runs, and clears it once it exits", async () => {
    const pidFile = join(tempDir, "pid");
    const cli = join(tempDir, "pid-report-cli");
    writeFileSync(cli, `#!/bin/sh\necho $$ > "${pidFile}"\nsleep 0.3\n`);
    chmodSync(cli, 0o755);
    const runner = createForgeCliRunner({
      binary: cli,
      envOverlay: {},
      timeoutMs: 5_000,
      isAuthFailureText: () => false,
      errorClasses: {
        isAlreadyClassified: () => false,
        isCommandError: (error): error is FakeCommandError => error instanceof FakeCommandError,
        createAuthError: (stderr) => new Error(`auth: ${stderr}`),
        createMissingError: () => new Error("missing"),
        createCommandError: (params) => new FakeCommandError(params),
      },
    });

    const run = runner.run(["arg"], { cwd: tempDir });
    const pid = await readPidOnceWritten(pidFile);
    expect(isForgePollPidLive(pid)).toBe(true);
    await run;
    expect(isForgePollPidLive(pid)).toBe(false);
  });

  it("classifies a timed-out invocation through normalizeError", async () => {
    const cli = writeSlowCli();
    const runner = createForgeCliRunner({
      binary: cli,
      envOverlay: {},
      timeoutMs: 100,
      isAuthFailureText: () => false,
      errorClasses: {
        isAlreadyClassified: () => false,
        isCommandError: (error): error is FakeCommandError => error instanceof FakeCommandError,
        createAuthError: (stderr) => new Error(`auth: ${stderr}`),
        createMissingError: () => new Error("missing"),
        createCommandError: (params) => new FakeCommandError(params),
      },
    });

    const rawError = await runner.run(["arg"], { cwd: tempDir }).catch((error: unknown) => error);
    const normalized = runner.normalizeError(rawError, { args: ["arg"], cwd: tempDir });
    expect(normalized).toBeInstanceOf(FakeCommandError);
    expect((normalized as FakeCommandError).stderr).toMatch(/timed out after 100ms/);
  });
});

describe("createCachedCliPathResolver", () => {
  it("resolves once and reuses the cached path on later calls", async () => {
    let calls = 0;
    const resolveCliPath = createCachedCliPathResolver(async () => {
      calls += 1;
      return "/usr/bin/forge-cli";
    });

    await expect(resolveCliPath()).resolves.toBe("/usr/bin/forge-cli");
    await expect(resolveCliPath()).resolves.toBe("/usr/bin/forge-cli");
    expect(calls).toBe(1);
  });

  it("retries on the next call after a miss instead of caching null forever", async () => {
    let calls = 0;
    const resolveCliPath = createCachedCliPathResolver(async () => {
      calls += 1;
      return calls === 1 ? null : "/usr/bin/forge-cli";
    });

    await expect(resolveCliPath()).resolves.toBeNull();
    await expect(resolveCliPath()).resolves.toBe("/usr/bin/forge-cli");
    expect(calls).toBe(2);
  });

  it("coalesces concurrent callers onto a single in-flight resolution", async () => {
    let calls = 0;
    const resolveCliPath = createCachedCliPathResolver(async () => {
      calls += 1;
      return "/usr/bin/forge-cli";
    });

    await Promise.all([resolveCliPath(), resolveCliPath(), resolveCliPath()]);
    expect(calls).toBe(1);
  });
});
