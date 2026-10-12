import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";
import type { SessionOutboundMessage } from "../../messages.js";
import { AccountSignInSession, type SpawnLoginProcess } from "./account-sign-in-session.js";

interface FakeChild {
  on(event: "exit", callback: (code: number | null) => void): void;
}

function createFakeChild(): { child: FakeChild; fireExit: (code: number | null) => void } {
  let exitCallback: ((code: number | null) => void) | undefined;
  const child: FakeChild = {
    on: (event, callback) => {
      if (event === "exit") exitCallback = callback;
    },
  };
  return { child, fireExit: (code) => exitCallback?.(code) };
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
    env: { CLAUDE_CONFIG_DIR: "/home/tyler/.claude-personal" },
    params: { accountPool: { role: "worker", priority: 1, email: "tyler.personal@example.com" } },
  },
  "claude-disabled": {
    extends: "claude",
    enabled: false,
    env: { CLAUDE_CONFIG_DIR: "/home/tyler/.claude-disabled" },
    params: { accountPool: { role: "worker", priority: 2 } },
  },
};

describe("AccountSignInSession", () => {
  function createSession(overrides: { spawnLogin?: Mock<SpawnLoginProcess> } = {}) {
    const emitted: SessionOutboundMessage[] = [];
    const exited: string[] = [];
    const spawnLogin: Mock<SpawnLoginProcess> =
      overrides.spawnLogin ?? vi.fn((..._args) => createFakeChild().child);
    const session = new AccountSignInSession({
      readDaemonConfig: () => ({ providers: PROVIDERS }),
      host: { emit: (message) => emitted.push(message) },
      logger: createLogger(),
      onLoginExited: (providerId) => exited.push(providerId),
      spawnLogin,
      resolveLaunch: async () => ({ available: true, command: "claude" }),
    });
    return { session, emitted, exited, spawnLogin };
  }

  it("refuses an unknown provider id", async () => {
    const { session, emitted } = createSession();
    await session.handleAccountClaudeSignInRequest({
      type: "account.claude.sign_in.request",
      providerId: "does-not-exist",
      requestId: "req_1",
    });
    expect(emitted[0]).toMatchObject({
      type: "account.claude.sign_in.response",
      payload: { outcome: "failed", providerId: "does-not-exist" },
    });
  });

  it("refuses a disabled provider id", async () => {
    const { session, emitted } = createSession();
    await session.handleAccountClaudeSignInRequest({
      type: "account.claude.sign_in.request",
      providerId: "claude-disabled",
      requestId: "req_1",
    });
    expect(emitted[0]).toMatchObject({ payload: { outcome: "failed" } });
  });

  it("spawns once with the entry's CLAUDE_CONFIG_DIR and resolved email", async () => {
    const { session, emitted, spawnLogin } = createSession();
    await session.handleAccountClaudeSignInRequest({
      type: "account.claude.sign_in.request",
      providerId: "claude-personal",
      requestId: "req_1",
    });

    expect(spawnLogin).toHaveBeenCalledTimes(1);
    const [command, args, env] = spawnLogin.mock.calls[0] as [string, string[], NodeJS.ProcessEnv];
    expect(command).toBe("claude");
    expect(args).toEqual(["auth", "login", "--email", "tyler.personal@example.com"]);
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/tyler/.claude-personal");
    expect(emitted[0]).toMatchObject({
      payload: { outcome: "started", providerId: "claude-personal" },
    });
  });

  it("returns already_running and spawns nothing on a second request while the login is in flight", async () => {
    const { session, emitted, spawnLogin } = createSession();
    const request = {
      type: "account.claude.sign_in.request" as const,
      providerId: "claude-personal",
      requestId: "req_1",
    };
    await session.handleAccountClaudeSignInRequest(request);
    await session.handleAccountClaudeSignInRequest({ ...request, requestId: "req_2" });

    expect(spawnLogin).toHaveBeenCalledTimes(1);
    expect(emitted[1]).toMatchObject({ payload: { outcome: "already_running" } });
  });

  it("forces a usage recheck when the login process exits", async () => {
    const { child, fireExit } = createFakeChild();
    const spawnLogin: Mock<SpawnLoginProcess> = vi.fn((..._args) => child);
    const { session, exited } = createSession({ spawnLogin });

    await session.handleAccountClaudeSignInRequest({
      type: "account.claude.sign_in.request",
      providerId: "claude-personal",
      requestId: "req_1",
    });
    fireExit(0);

    expect(exited).toEqual(["claude-personal"]);
  });

  it("allows a new login once the previous one has exited", async () => {
    const { child, fireExit } = createFakeChild();
    const spawnLogin: Mock<SpawnLoginProcess> = vi.fn((..._args) => child);
    const { session, spawnLogin: injectedSpawn } = createSession({ spawnLogin });
    const request = {
      type: "account.claude.sign_in.request" as const,
      providerId: "claude-personal",
      requestId: "req_1",
    };

    await session.handleAccountClaudeSignInRequest(request);
    fireExit(0);
    await session.handleAccountClaudeSignInRequest({ ...request, requestId: "req_2" });

    expect(injectedSpawn).toHaveBeenCalledTimes(2);
  });

  it("reports failed when no claude binary resolves", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const spawnLogin = vi.fn();
    const session = new AccountSignInSession({
      readDaemonConfig: () => ({ providers: PROVIDERS }),
      host: { emit: (message) => emitted.push(message) },
      logger: createLogger(),
      spawnLogin,
      resolveLaunch: async () => ({ available: false, command: "claude" }),
    });

    await session.handleAccountClaudeSignInRequest({
      type: "account.claude.sign_in.request",
      providerId: "claude-personal",
      requestId: "req_1",
    });

    expect(spawnLogin).not.toHaveBeenCalled();
    expect(emitted[0]).toMatchObject({ payload: { outcome: "failed" } });
  });
});
