import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeQuotaProvider } from "./claude.js";

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
