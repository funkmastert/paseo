import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeConfigDirKeychainService, ClaudeQuotaProvider } from "./claude.js";

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

function mockUsageFetch(): typeof fetch {
  return vi.fn(async () =>
    jsonResponse({ seven_day: { utilization: 5, resets_at: "2026-06-04T00:00:00Z" } }),
  ) as unknown as typeof fetch;
}

function writeClaudeCredentials(dir: string, accessToken: string): void {
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken, refreshToken: "rt_test", subscriptionType: "pro" },
    }),
  );
}

describe("claudeConfigDirKeychainService", () => {
  it("matches the hash scheme observed in the real macOS Keychain", () => {
    // Empirically verified against a live item on this machine: sha256 of the absolute
    // path "/Users/tylerthackray/.claude-personal" (no trailing slash), first 8 hex
    // chars, produced service "Claude Code-credentials-a30b61cd".
    expect(claudeConfigDirKeychainService("/Users/tylerthackray/.claude-personal")).toBe(
      "Claude Code-credentials-a30b61cd",
    );
  });

  it("agrees on a path with and without a trailing slash", () => {
    expect(claudeConfigDirKeychainService("/tmp/claude-work/")).toBe(
      claudeConfigDirKeychainService("/tmp/claude-work"),
    );
  });

  it("expands a leading ~ to the home directory before hashing", () => {
    expect(claudeConfigDirKeychainService("~/.claude-personal")).toBe(
      claudeConfigDirKeychainService(join(homedir(), ".claude-personal")),
    );
  });
});

describe("ClaudeQuotaProvider constructor overrides", () => {
  let claudeHome: string;

  beforeEach(() => {
    claudeHome = mkdtempSync(join(tmpdir(), "paseo-claude-account-pool-"));
  });

  afterEach(() => {
    rmSync(claudeHome, { recursive: true, force: true });
  });

  it("defaults providerId and displayName to claude/Claude when omitted", async () => {
    writeClaudeCredentials(claudeHome, "at_valid");
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome,
      fetch: mockUsageFetch(),
    });

    expect(provider.providerId).toBe("claude");
    expect(provider.displayName).toBe("Claude");
    const usage = await provider.fetchUsage();
    expect(usage.providerId).toBe("claude");
    expect(usage.displayName).toBe("Claude");
  });

  it("flows providerId, displayName, and claudeHome overrides into fetchUsage output and credential path", async () => {
    writeClaudeCredentials(claudeHome, "at_valid");
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      providerId: "claude-work",
      displayName: "Claude (work)",
      claudeHome,
      fetch: mockUsageFetch(),
    });

    expect(provider.providerId).toBe("claude-work");
    expect(provider.displayName).toBe("Claude (work)");
    const usage = await provider.fetchUsage();
    expect(usage).toMatchObject({
      providerId: "claude-work",
      displayName: "Claude (work)",
      status: "available",
    });
  });

  it("prefers the file-based credential under the entry's own claudeHome over any Keychain reader", async () => {
    writeClaudeCredentials(claudeHome, "at_from_file");
    let authorization: string | null = null;
    const fetchApi = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({ seven_day: { utilization: 5, resets_at: "2026-06-04T00:00:00Z" } });
    }) as unknown as typeof fetch;
    const keychainReader = vi.fn(async () => {
      throw new Error("Keychain must not be consulted when a credentials file exists");
    });

    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome,
      fetch: fetchApi,
      claudeConfigDirKeychainReader: keychainReader,
      platform: "darwin",
      keychainService: "Claude Code-credentials-deadbeef",
    });

    const usage = await provider.fetchUsage();

    expect(usage.status).toBe("available");
    expect(authorization).toBe("Bearer at_from_file");
    expect(keychainReader).not.toHaveBeenCalled();
  });

  it("reads the per-config-dir Keychain item when no credentials file exists", async () => {
    const keychainReader = vi.fn(async (service: string) =>
      service === "Claude Code-credentials-a30b61cd"
        ? { claudeAiOauth: { accessToken: "at_from_keychain", subscriptionType: "pro" } }
        : null,
    );
    let authorization: string | null = null;
    const fetchApi = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({ seven_day: { utilization: 5, resets_at: "2026-06-04T00:00:00Z" } });
    }) as unknown as typeof fetch;

    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome, // empty dir, no .credentials.json
      fetch: fetchApi,
      platform: "darwin",
      keychainService: "Claude Code-credentials-a30b61cd",
      claudeConfigDirKeychainReader: keychainReader,
    });

    const usage = await provider.fetchUsage();

    expect(usage.status).toBe("available");
    expect(authorization).toBe("Bearer at_from_keychain");
    expect(keychainReader).toHaveBeenCalledWith("Claude Code-credentials-a30b61cd");
  });

  it("explicit keychainService override is respected over the computed hash", async () => {
    const keychainReader = vi.fn(async (service: string) =>
      service === "Claude Code-credentials-custom-override"
        ? { claudeAiOauth: { accessToken: "at_override" } }
        : null,
    );

    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome,
      fetch: mockUsageFetch(),
      platform: "darwin",
      keychainService: "Claude Code-credentials-custom-override",
      claudeConfigDirKeychainReader: keychainReader,
    });

    await provider.fetchUsage();

    expect(keychainReader).toHaveBeenCalledWith("Claude Code-credentials-custom-override");
  });

  it("never falls back to the username-keyed legacy Keychain item for a non-default config dir", async () => {
    const legacyReader = vi.fn(async () => ({
      claudeAiOauth: { accessToken: "at_wrong_account" },
    }));
    const configDirReader = vi.fn(async () => null);

    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome, // no .credentials.json
      fetch: mockUsageFetch(),
      platform: "darwin",
      keychainService: "Claude Code-credentials-a30b61cd",
      claudeKeychainReader: legacyReader,
      claudeConfigDirKeychainReader: configDirReader,
    });

    const usage = await provider.fetchUsage();

    expect(legacyReader).not.toHaveBeenCalled();
    expect(configDirReader).toHaveBeenCalledTimes(1);
    expect(usage.status).toBe("unavailable");
  });

  it("returns the unavailable row rather than throwing when an account is unaddressable", async () => {
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      providerId: "claude-orphan",
      displayName: "Claude (orphan)",
      claudeHome, // no credentials file
      fetch: mockUsageFetch(),
      platform: "darwin",
      keychainService: "Claude Code-credentials-ffffffff",
      claudeConfigDirKeychainReader: async () => null,
    });

    const usage = await provider.fetchUsage();

    expect(usage).toMatchObject({
      providerId: "claude-orphan",
      displayName: "Claude (orphan)",
      status: "unavailable",
    });
  });
});
