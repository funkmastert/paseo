import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  findPoolAccountIdentityProblems,
  PoolAccountIdentityTracker,
} from "../../agent/pool-account-identity.js";
import type { ProcessTerminator } from "../../../utils/tree-kill.js";
import {
  ClaudeAccountSignIn,
  type ClaudeAccountSignInOptions,
  type SpawnLoginProcess,
} from "./claude-account-sign-in.js";

class FakeLogin extends EventEmitter {
  readonly exitCode = null;
  readonly signalCode = null;
  readonly unref = vi.fn();
  readonly kill = vi.fn(() => true);
  constructor(readonly pid?: number) {
    super();
  }
}

function createLogger() {
  const logger = {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger as never;
}

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A config dir whose `.claude.json` last held `leader@example.com`, and declares nothing. */
const DRIFTED_DIR = tempDir("paseo-sign-in-drifted-");
writeFileSync(
  join(DRIFTED_DIR, ".claude.json"),
  JSON.stringify({ oauthAccount: { emailAddress: "leader@example.com", accountUuid: "uuid-1" } }),
);

const PROVIDERS = {
  "claude-personal": {
    extends: "claude",
    env: { CLAUDE_CONFIG_DIR: "/accounts/personal" },
    params: { accountPool: { role: "worker", priority: 1, email: "someone@example.com" } },
  },
  "claude-disabled": {
    extends: "claude",
    enabled: false,
    env: { CLAUDE_CONFIG_DIR: "/accounts/disabled" },
    params: { accountPool: { role: "worker", priority: 2, email: "other@example.com" } },
  },
  "claude-no-email": {
    extends: "claude",
    env: { CLAUDE_CONFIG_DIR: "/tmp/does-not-exist-claude-account-sign-in" },
    params: { accountPool: { role: "worker", priority: 3 } },
  },
  "claude-drifted": {
    extends: "claude",
    env: { CLAUDE_CONFIG_DIR: DRIFTED_DIR },
    params: { accountPool: { role: "worker", priority: 4 } },
  },
};

const TIMEOUT_MS = 5 * 60_000;

function createSignIn(overrides: Partial<ClaudeAccountSignInOptions> & { child?: FakeLogin } = {}) {
  const { child, ...options } = overrides;
  const children: FakeLogin[] = [];
  const exited: string[] = [];
  const markerDir = options.markerDir ?? tempDir("paseo-sign-in-markers-");
  const spawnLogin = vi.fn((..._args: Parameters<SpawnLoginProcess>) => {
    const login = child ?? new FakeLogin();
    children.push(login);
    return login;
  });
  const stopped: unknown[] = [];
  const terminateProcess = vi.fn<ProcessTerminator>(async (target) => {
    stopped.push(target);
    return "terminated";
  });
  const signIn = new ClaudeAccountSignIn({
    readDaemonConfig: () => ({ providers: PROVIDERS }),
    logger: createLogger(),
    onLoginExited: (providerId) => exited.push(providerId),
    spawnLogin,
    terminateProcess,
    resolveBinary: async () => "/opt/claude/bin/claude",
    ...options,
    markerDir,
  });
  return { signIn, spawnLogin, children, exited, markerDir, terminateProcess, stopped };
}

/** A real process whose command line reads like the login a previous daemon started. */
const standIns: ChildProcess[] = [];

function spawnStandIn(args: string[]): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...args], {
    stdio: "ignore",
  });
  standIns.push(child);
  return child;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function writeMarker(markerDir: string, marker: Record<string, unknown>): string {
  const file = join(markerDir, `claude-personal.${String(marker.pid)}.json`);
  writeFileSync(file, JSON.stringify(marker));
  return file;
}

const LOGIN_ARGS = ["auth", "login", "--email", "someone@example.com"];

afterEach(() => {
  vi.useRealTimers();
  for (const child of standIns.splice(0)) {
    if (!hasExited(child)) child.kill("SIGKILL");
  }
});

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("ClaudeAccountSignIn", () => {
  it("refuses an unknown provider id", async () => {
    const { signIn, spawnLogin } = createSignIn();
    expect(await signIn.start("does-not-exist")).toMatchObject({ outcome: "failed" });
    expect(spawnLogin).not.toHaveBeenCalled();
  });

  it("refuses a disabled provider id", async () => {
    const { signIn, spawnLogin } = createSignIn();
    expect(await signIn.start("claude-disabled")).toMatchObject({ outcome: "failed" });
    expect(spawnLogin).not.toHaveBeenCalled();
  });

  it("spawns the resolved binary once, with the entry's config dir and email", async () => {
    const { signIn, spawnLogin } = createSignIn();

    expect(await signIn.start("claude-personal")).toEqual({ outcome: "started", error: null });
    expect(spawnLogin).toHaveBeenCalledTimes(1);
    expect(spawnLogin).toHaveBeenCalledWith(
      "/opt/claude/bin/claude",
      LOGIN_ARGS,
      "/accounts/personal",
    );
  });

  it("refuses an account with no known email instead of spawning the terminal-only /login", async () => {
    const { signIn, spawnLogin } = createSignIn();

    const result = await signIn.start("claude-no-email");

    expect(spawnLogin).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "failed", error: expect.stringContaining("email") });
  });

  it("answers already_running, and spawns nothing, while that account's login is in flight", async () => {
    const { signIn, spawnLogin } = createSignIn();

    const [first, second] = await Promise.all([
      signIn.start("claude-personal"),
      signIn.start("claude-personal"),
    ]);

    expect([first.outcome, second.outcome]).toEqual(["started", "already_running"]);
    expect(spawnLogin).toHaveBeenCalledTimes(1);
  });

  it("frees the account and rechecks its usage when the login exits", async () => {
    const { signIn, spawnLogin, children, exited } = createSignIn();
    await signIn.start("claude-personal");

    children[0]?.emit("exit", 0);

    expect(exited).toEqual(["claude-personal"]);
    expect(await signIn.start("claude-personal")).toMatchObject({ outcome: "started" });
    expect(spawnLogin).toHaveBeenCalledTimes(2);
  });

  it("survives a spawn error and frees the account for another try", async () => {
    const { signIn, spawnLogin, children } = createSignIn();
    await signIn.start("claude-personal");

    expect(() => children[0]?.emit("error", new Error("spawn claude ENOENT"))).not.toThrow();
    expect(await signIn.start("claude-personal")).toMatchObject({ outcome: "started" });
    expect(spawnLogin).toHaveBeenCalledTimes(2);
  });

  it("does not keep the daemon alive, and stops a login abandoned for five minutes", async () => {
    vi.useFakeTimers();
    const { signIn, children, stopped } = createSignIn();
    await signIn.start("claude-personal");
    const child = children[0];
    expect(child?.unref).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(stopped).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toEqual([child]);
  });

  it("escalates past SIGTERM, and frees the account once the stop ends even with no exit event", async () => {
    vi.useFakeTimers();
    const terminateProcess = vi.fn<ProcessTerminator>(async () => "kill-timeout");
    const { signIn, spawnLogin } = createSignIn({ terminateProcess });
    await signIn.start("claude-personal");

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(terminateProcess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ gracefulTimeoutMs: expect.any(Number), forceSignal: "SIGKILL" }),
    );
    expect(await signIn.start("claude-personal")).toMatchObject({ outcome: "started" });
    expect(spawnLogin).toHaveBeenCalledTimes(2);
  });

  it("reports failed when no claude binary resolves", async () => {
    const { signIn, spawnLogin } = createSignIn({
      resolveBinary: async () => {
        throw new Error("Claude binary not found");
      },
    });

    expect(await signIn.start("claude-personal")).toMatchObject({ outcome: "failed" });
    expect(await signIn.isBinaryAvailable()).toBe(false);
    expect(spawnLogin).not.toHaveBeenCalled();
  });
});

describe("ClaudeAccountSignIn — a login that outlives the daemon", () => {
  it("records each running login under the marker dir and removes it when the login exits", async () => {
    const { signIn, children, markerDir } = createSignIn({ child: new FakeLogin(4242) });
    await signIn.start("claude-personal");

    const files = readdirSync(markerDir);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(markerDir, files[0] ?? ""), "utf8"))).toMatchObject({
      providerId: "claude-personal",
      pid: 4242,
      startedAt: expect.any(Number),
    });

    children[0]?.emit("exit", 0);
    await vi.waitFor(() => expect(readdirSync(markerDir)).toEqual([]));
  });

  it("stops a previous daemon's login once it is past the timeout, and deletes its marker", async () => {
    const markerDir = tempDir("paseo-sign-in-markers-");
    const orphan = spawnStandIn(LOGIN_ARGS);
    const orphanExited = new Promise((resolve) => orphan.once("exit", resolve));
    const file = writeMarker(markerDir, {
      providerId: "claude-personal",
      pid: orphan.pid,
      startedAt: Date.now() - TIMEOUT_MS - 1_000,
      email: "someone@example.com",
    });

    const { signIn, spawnLogin } = createSignIn({
      markerDir,
      terminateProcess: undefined,
      child: new FakeLogin(),
    });

    expect(await signIn.start("claude-personal")).toMatchObject({ outcome: "started" });
    await orphanExited;
    expect(existsSync(file)).toBe(false);
    expect(spawnLogin).toHaveBeenCalledTimes(1);
  });

  it("answers already_running while a previous daemon's login is fresh, and stops it at its deadline", async () => {
    const markerDir = tempDir("paseo-sign-in-markers-");
    const orphan = spawnStandIn(LOGIN_ARGS);
    const orphanExited = new Promise((resolve) => orphan.once("exit", resolve));
    const file = writeMarker(markerDir, {
      providerId: "claude-personal",
      pid: orphan.pid,
      startedAt: Date.now(),
      email: "someone@example.com",
    });

    const { signIn, spawnLogin, exited } = createSignIn({
      markerDir,
      terminateProcess: undefined,
      loginTimeoutMs: 1_500,
    });

    expect(await signIn.start("claude-personal")).toMatchObject({ outcome: "already_running" });
    expect(spawnLogin).not.toHaveBeenCalled();
    await orphanExited;
    await vi.waitFor(() => expect(exited).toEqual(["claude-personal"]));
    expect(existsSync(file)).toBe(false);
    expect(await signIn.start("claude-personal")).toMatchObject({ outcome: "started" });
  });

  it("forgets a marker whose process is gone", async () => {
    const markerDir = tempDir("paseo-sign-in-markers-");
    const gone = spawnStandIn(LOGIN_ARGS);
    gone.kill("SIGKILL");
    await new Promise((resolve) => gone.once("exit", resolve));
    const file = writeMarker(markerDir, {
      providerId: "claude-personal",
      pid: gone.pid,
      startedAt: Date.now() - TIMEOUT_MS - 1_000,
      email: "someone@example.com",
    });

    const { signIn } = createSignIn({ markerDir, terminateProcess: undefined });

    expect(await signIn.start("claude-personal")).toMatchObject({ outcome: "started" });
    expect(existsSync(file)).toBe(false);
  });

  it("never stops a process that only reuses the marker's pid", async () => {
    const markerDir = tempDir("paseo-sign-in-markers-");
    const stranger = spawnStandIn(["some-other-tool", "serve"]);
    const file = writeMarker(markerDir, {
      providerId: "claude-personal",
      pid: stranger.pid,
      startedAt: Date.now() - TIMEOUT_MS - 1_000,
      email: "someone@example.com",
    });

    const { signIn } = createSignIn({ markerDir, terminateProcess: undefined });

    expect(await signIn.start("claude-personal")).toMatchObject({ outcome: "started" });
    expect(existsSync(file)).toBe(false);
    expect(hasExited(stranger)).toBe(false);
  });
});

describe("ClaudeAccountSignIn — the login process", () => {
  // The manual recipe is `tail -f /dev/null | claude auth login --email …`: the CLI waits for the
  // browser callback with stdin held open. A stand-in `claude` records which it saw.
  it.skipIf(process.platform === "win32")(
    "keeps the login's stdin open, the way the manual recipe does",
    async () => {
      const configDir = tempDir("paseo-sign-in-config-");
      const binDir = tempDir("paseo-sign-in-bin-");
      const binary = join(binDir, "claude");
      writeFileSync(
        binary,
        [
          `#!${process.execPath}`,
          `const out = require("node:path").join(process.env.CLAUDE_CONFIG_DIR, "stdin.txt");`,
          `const write = (state) => { require("node:fs").writeFileSync(out, state); process.exit(0); };`,
          `process.stdin.on("data", () => {});`,
          `process.stdin.on("end", () => write("eof"));`,
          `setTimeout(() => write("open"), 500);`,
        ].join("\n"),
      );
      chmodSync(binary, 0o755);
      const providers = {
        "claude-real": {
          extends: "claude",
          env: { CLAUDE_CONFIG_DIR: configDir },
          params: { accountPool: { role: "worker", priority: 1, email: "someone@example.com" } },
        },
      };
      const exited: string[] = [];
      const signIn = new ClaudeAccountSignIn({
        readDaemonConfig: () => ({ providers }),
        logger: createLogger(),
        markerDir: tempDir("paseo-sign-in-markers-"),
        onLoginExited: (providerId) => exited.push(providerId),
        resolveBinary: async () => binary,
      });

      expect(await signIn.start("claude-real")).toMatchObject({ outcome: "started" });
      await vi.waitFor(() => expect(exited).toEqual(["claude-real"]), { timeout: 5_000 });
      expect(readFileSync(join(configDir, "stdin.txt"), "utf8")).toBe("open");
    },
  );
});

describe("ClaudeAccountSignIn — identity problems", () => {
  function trackerWith(readings: Parameters<typeof findPoolAccountIdentityProblems>[0]) {
    const tracker = new PoolAccountIdentityTracker();
    tracker.observe(findPoolAccountIdentityProblems(readings));
    return tracker;
  }

  const LEADER = {
    state: "signed-in" as const,
    accountLabel: "leader@example.com",
    accountUuid: "uuid-1",
  };

  it("refuses to sign in again a login that drifted onto another account's", async () => {
    const accountIdentity = trackerWith([
      { providerId: "claude", role: "leader", configDir: null, expectedEmail: null, auth: LEADER },
      {
        providerId: "claude-drifted",
        configDir: DRIFTED_DIR,
        expectedEmail: null,
        auth: LEADER,
      },
    ]);
    const { signIn, spawnLogin } = createSignIn({ accountIdentity });

    const result = await signIn.start("claude-drifted");

    expect(spawnLogin).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("claude-drifted is signed into leader@example.com"),
    });
  });

  it("still signs in the declared email while an identity problem stands", async () => {
    const accountIdentity = trackerWith([
      {
        providerId: "claude-personal",
        configDir: "/accounts/personal",
        expectedEmail: "someone@example.com",
        auth: LEADER,
      },
    ]);
    const { signIn, spawnLogin } = createSignIn({ accountIdentity });

    expect(await signIn.start("claude-personal")).toMatchObject({ outcome: "started" });
    expect(spawnLogin).toHaveBeenCalledWith(
      "/opt/claude/bin/claude",
      LOGIN_ARGS,
      "/accounts/personal",
    );
  });

  it("signs in the last-known login when no identity problem stands", async () => {
    const { signIn, spawnLogin } = createSignIn({
      accountIdentity: new PoolAccountIdentityTracker(),
    });

    expect(await signIn.start("claude-drifted")).toMatchObject({ outcome: "started" });
    expect(spawnLogin).toHaveBeenCalledWith(
      "/opt/claude/bin/claude",
      ["auth", "login", "--email", "leader@example.com"],
      DRIFTED_DIR,
    );
  });
});
