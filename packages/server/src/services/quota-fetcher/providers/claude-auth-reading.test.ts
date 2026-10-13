import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeCredentialsUnreadableError,
  ClaudeQuotaProvider,
  readClaudeConfigDirKeychainCredentials,
  runSecurityCommand,
} from "./claude.js";

function createLogger() {
  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger as never;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function writeGlobalConfig(dir: string, oauthAccount: Record<string, unknown> | null): void {
  writeFileSync(join(dir, ".claude.json"), JSON.stringify(oauthAccount ? { oauthAccount } : {}));
}

function writeCredentials(dir: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken: "at_test", refreshToken: "rt_test", ...extra },
    }),
  );
}

describe("ClaudeQuotaProvider auth reading", () => {
  let claudeHome: string;

  beforeEach(() => {
    claudeHome = mkdtempSync(join(tmpdir(), "paseo-claude-auth-reading-"));
  });

  afterEach(() => {
    rmSync(claudeHome, { recursive: true, force: true });
  });

  it("reads null auth when no account is configured at all", async () => {
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome,
      platform: "linux",
    });
    await provider.fetchUsage();
    expect(provider.describeAuthReading()).toBeNull();
  });

  it("reads credentials_missing when .claude.json names an account but no credentials exist", async () => {
    writeGlobalConfig(claudeHome, { emailAddress: "tyler@example.com" });
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome,
      platform: "linux",
    });
    const usage = await provider.fetchUsage();
    expect(usage.status).toBe("unavailable");
    expect(provider.describeAuthReading()).toBe("credentials_missing");
  });

  it("reads rejected_unexpired on a 401 with expiresAt in the future", async () => {
    writeCredentials(claudeHome, { expiresAt: Date.now() + 60_000 });
    const fetchApi = (async () => jsonResponse({}, 401)) as unknown as typeof fetch;
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome,
      fetch: fetchApi,
    });
    await provider.fetchUsage();
    expect(provider.describeAuthReading()).toBe("rejected_unexpired");
  });

  it("reads rejected_expired on a 401 with expiresAt in the past", async () => {
    writeCredentials(claudeHome, { expiresAt: Date.now() - 60_000 });
    const fetchApi = (async () => jsonResponse({}, 401)) as unknown as typeof fetch;
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome,
      fetch: fetchApi,
    });
    await provider.fetchUsage();
    expect(provider.describeAuthReading()).toBe("rejected_expired");
  });

  it("reads rejected_forbidden on a 403, even for a token that has not expired", async () => {
    writeCredentials(claudeHome, { expiresAt: Date.now() + 60_000 });
    const fetchApi = (async () => jsonResponse({}, 403)) as unknown as typeof fetch;
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome,
      fetch: fetchApi,
    });
    await provider.fetchUsage();
    expect(provider.describeAuthReading()).toBe("rejected_forbidden");
  });

  it("reads no sign-in answer when the credentials file does not parse", async () => {
    writeGlobalConfig(claudeHome, { emailAddress: "tyler@example.com" });
    writeFileSync(join(claudeHome, ".credentials.json"), '{"claudeAiOauth": {"accessTo');
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome,
      platform: "linux",
    });
    const usage = await provider.fetchUsage();
    expect(usage.status).toBe("unavailable");
    expect(provider.describeAuthReading()).toBeNull();
  });

  it("reads no sign-in answer when the Keychain read fails, and drops the previous reading", async () => {
    writeGlobalConfig(claudeHome, { emailAddress: "tyler@example.com" });
    let keychain: () => Promise<unknown> = async () => ({
      claudeAiOauth: { accessToken: "at_test", expiresAt: Date.now() + 60_000 },
    });
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome,
      platform: "darwin",
      keychainService: "Claude Code-credentials-a30b61cd",
      claudeConfigDirKeychainReader: () => keychain(),
      fetch: (async () =>
        jsonResponse({
          seven_day: { utilization: 5, resets_at: null },
        })) as unknown as typeof fetch,
    });
    await provider.fetchUsage();
    expect(provider.describeAuthReading()).toBe("ok");

    keychain = async () => {
      throw new ClaudeCredentialsUnreadableError("security timed out");
    };
    const usage = await provider.fetchUsage();
    expect(usage.status).toBe("unavailable");
    expect(provider.describeAuthReading()).toBeNull();
  });

  it("still reads credentials_missing when the Keychain says it holds no such item", async () => {
    writeGlobalConfig(claudeHome, { emailAddress: "tyler@example.com" });
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome,
      platform: "darwin",
      keychainService: "Claude Code-credentials-a30b61cd",
      claudeConfigDirKeychainReader: async () => null,
    });
    await provider.fetchUsage();
    expect(provider.describeAuthReading()).toBe("credentials_missing");
  });

  it("reads rejected_expired on a 401 when the credentials carry no expiresAt", async () => {
    writeCredentials(claudeHome);
    const fetchApi = (async () => jsonResponse({}, 401)) as unknown as typeof fetch;
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome,
      fetch: fetchApi,
    });
    await provider.fetchUsage();
    expect(provider.describeAuthReading()).toBe("rejected_expired");
  });

  it("reads ok on a successful usage read", async () => {
    writeCredentials(claudeHome, { expiresAt: Date.now() + 60_000 });
    const fetchApi = (async () =>
      jsonResponse({ seven_day: { utilization: 5, resets_at: null } })) as unknown as typeof fetch;
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome,
      fetch: fetchApi,
    });
    await provider.fetchUsage();
    expect(provider.describeAuthReading()).toBe("ok");
  });

  it("never writes credentials back during a fetch (reading unchanged on disk)", async () => {
    writeCredentials(claudeHome, { expiresAt: Date.now() - 60_000 });
    const before = readFileSync(join(claudeHome, ".credentials.json"), "utf8");
    const fetchApi = (async () => jsonResponse({}, 401)) as unknown as typeof fetch;
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome,
      fetch: fetchApi,
    });
    await provider.fetchUsage();
    expect(readFileSync(join(claudeHome, ".credentials.json"), "utf8")).toBe(before);
  });

  it("the module imports no fs write capability", () => {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(moduleDir, "claude.ts"), "utf8");
    expect(source).not.toMatch(/writeFile|unlink|rm\(/);
  });
});

describe("runSecurityCommand", () => {
  function execFailure(fields: Record<string, unknown>) {
    return async () => {
      throw Object.assign(new Error("Command failed: security find-generic-password"), fields);
    };
  }

  it("is null only when security says no item matches (exit 44)", async () => {
    expect(await runSecurityCommand(["find-generic-password"], execFailure({ code: 44 }))).toBe(
      null,
    );
  });

  it.each([
    ["a timeout", { killed: true, signal: "SIGTERM", code: null }],
    ["a locked Keychain", { code: 36 }],
    ["a missing security binary", { code: "ENOENT" }],
  ])("throws an unreadable error on %s", async (_label, fields) => {
    await expect(
      runSecurityCommand(["find-generic-password"], execFailure(fields)),
    ).rejects.toThrow(ClaudeCredentialsUnreadableError);
  });

  it("returns the item's text when it exists", async () => {
    expect(
      await runSecurityCommand(["find-generic-password"], async () => ({ stdout: '{"a":1}\n' })),
    ).toBe('{"a":1}');
  });
});

describe("readClaudeConfigDirKeychainCredentials", () => {
  it("is null when the item does not exist, and throws when the item does not parse", async () => {
    expect(await readClaudeConfigDirKeychainCredentials("svc", async () => null)).toBeNull();
    await expect(
      readClaudeConfigDirKeychainCredentials("svc", async () => "not-json"),
    ).rejects.toThrow(ClaudeCredentialsUnreadableError);
  });
});
