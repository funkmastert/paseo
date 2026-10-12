import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeAccountSignIn, type SpawnLoginProcess } from "./claude-account-sign-in.js";

class FakeLogin extends EventEmitter {
  readonly unref = vi.fn();
  readonly kill = vi.fn(() => true);
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
};

function createSignIn(
  overrides: {
    child?: FakeLogin;
    resolveBinary?: () => Promise<string>;
  } = {},
) {
  const children: FakeLogin[] = [];
  const exited: string[] = [];
  const spawnLogin = vi.fn((..._args: Parameters<SpawnLoginProcess>) => {
    const child = overrides.child ?? new FakeLogin();
    children.push(child);
    return child;
  });
  const signIn = new ClaudeAccountSignIn({
    readDaemonConfig: () => ({ providers: PROVIDERS }),
    logger: createLogger(),
    onLoginExited: (providerId) => exited.push(providerId),
    spawnLogin,
    resolveBinary: overrides.resolveBinary ?? (async () => "/opt/claude/bin/claude"),
  });
  return { signIn, spawnLogin, children, exited };
}

afterEach(() => {
  vi.useRealTimers();
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
      ["auth", "login", "--email", "someone@example.com"],
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

  it("does not keep the daemon alive, and kills a login abandoned for five minutes", async () => {
    vi.useFakeTimers();
    const { signIn, children } = createSignIn();
    await signIn.start("claude-personal");
    const child = children[0];
    expect(child?.unref).toHaveBeenCalled();

    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(child?.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(child?.kill).toHaveBeenCalled();
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
