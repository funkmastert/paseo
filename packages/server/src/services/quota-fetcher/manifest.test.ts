import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProviderUsageFetchers,
  deriveClaudeProviderEntries,
  PROVIDER_USAGE_FETCHERS,
} from "./manifest.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function providerIds(fetchers: { providerId: string }[]): string[] {
  return fetchers.map((f) => f.providerId);
}

function findFetcher<T extends { providerId: string }>(fetchers: T[], providerId: string): T {
  const fetcher = fetchers.find((f) => f.providerId === providerId);
  if (!fetcher) throw new Error(`Missing derived fetcher ${providerId}`);
  return fetcher;
}

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

describe("deriveClaudeProviderEntries", () => {
  it("is empty when there are no providers", () => {
    expect(deriveClaudeProviderEntries(undefined)).toEqual([]);
    expect(deriveClaudeProviderEntries({})).toEqual([]);
  });

  it("skips non-claude-derived entries and entries missing CLAUDE_CONFIG_DIR", () => {
    const entries = deriveClaudeProviderEntries({
      codex: { extends: "codex", label: "Codex", env: { CLAUDE_CONFIG_DIR: "/tmp/x" } },
      "claude-no-dir": { extends: "claude", label: "No dir" },
      claude: { enabled: true },
    });

    expect(entries).toEqual([]);
  });

  it("derives one entry per claude-derived provider with its own CLAUDE_CONFIG_DIR", () => {
    const entries = deriveClaudeProviderEntries({
      "claude-work": {
        extends: "claude",
        label: "Claude (work)",
        env: { CLAUDE_CONFIG_DIR: "/tmp/claude-work" },
      },
      "claude-personal": {
        extends: "claude",
        env: { CLAUDE_CONFIG_DIR: "/tmp/claude-personal" },
      },
    });

    expect(entries).toEqual(
      expect.arrayContaining([
        {
          providerId: "claude-work",
          displayName: "Claude (work)",
          claudeHome: "/tmp/claude-work",
          keychainService: undefined,
        },
        {
          providerId: "claude-personal",
          displayName: "claude-personal",
          claudeHome: "/tmp/claude-personal",
          keychainService: undefined,
        },
      ]),
    );
  });

  it("derives the bare claude entry when it overrides its own CLAUDE_CONFIG_DIR", () => {
    const entries = deriveClaudeProviderEntries({
      claude: {
        env: { CLAUDE_CONFIG_DIR: "/tmp/claude-leader" },
        params: { accountPool: { role: "leader", priority: 1 } },
      },
    });

    expect(entries).toEqual([
      {
        providerId: "claude",
        displayName: "Claude",
        claudeHome: "/tmp/claude-leader",
        keychainService: undefined,
      },
    ]);
  });

  it("falls back to the provider id as displayName when no label is set", () => {
    const entries = deriveClaudeProviderEntries({
      "claude-work": { extends: "claude", env: { CLAUDE_CONFIG_DIR: "/tmp/claude-work" } },
    });

    expect(entries[0]?.displayName).toBe("claude-work");
  });

  it("reads an explicit keychainService override from params.accountPool", () => {
    const entries = deriveClaudeProviderEntries({
      "claude-work": {
        extends: "claude",
        label: "Claude (work)",
        env: { CLAUDE_CONFIG_DIR: "/tmp/claude-work" },
        params: { accountPool: { keychainService: "Claude Code-credentials-custom" } },
      },
    });

    expect(entries[0]?.keychainService).toBe("Claude Code-credentials-custom");
  });
});

describe("createProviderUsageFetchers", () => {
  const baseProviderIds = providerIds(PROVIDER_USAGE_FETCHERS);

  it("is identical to the base manifest when no derived entries are passed", () => {
    const fetchers = createProviderUsageFetchers({ logger: createLogger() });
    expect(providerIds(fetchers)).toEqual(baseProviderIds);
  });

  it("is identical to the base manifest when an empty derived list is passed", () => {
    const fetchers = createProviderUsageFetchers({ logger: createLogger() }, []);
    expect(providerIds(fetchers)).toEqual(baseProviderIds);
  });

  let workHome: string;
  let personalHome: string;

  beforeEach(() => {
    workHome = mkdtempSync(join(tmpdir(), "paseo-claude-work-"));
    personalHome = mkdtempSync(join(tmpdir(), "paseo-claude-personal-"));
  });

  afterEach(() => {
    rmSync(workHome, { recursive: true, force: true });
    rmSync(personalHome, { recursive: true, force: true });
  });

  function derivedEntries() {
    return [
      { providerId: "claude-work", displayName: "Claude (work)", claudeHome: workHome },
      { providerId: "claude-personal", displayName: "Claude (personal)", claudeHome: personalHome },
    ];
  }

  it("adds one fetcher per derived entry, in addition to the base list", () => {
    const fetchers = createProviderUsageFetchers({ logger: createLogger() }, derivedEntries());

    expect(providerIds(fetchers)).toEqual([...baseProviderIds, "claude-work", "claude-personal"]);
  });

  it("replaces the base claude fetcher in place when the claude entry has its own config dir", async () => {
    writeFileSync(
      join(workHome, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "at_leader", subscriptionType: "max" } }),
    );
    const fetchApi = vi.fn(async () =>
      jsonResponse({ seven_day: { utilization: 5, resets_at: null } }),
    ) as unknown as typeof fetch;

    const fetchers = createProviderUsageFetchers({ logger: createLogger(), fetch: fetchApi }, [
      { providerId: "claude", displayName: "Claude", claudeHome: workHome },
    ]);

    expect(providerIds(fetchers)).toEqual(baseProviderIds);
    expect(await findFetcher(fetchers, "claude").fetchUsage()).toMatchObject({
      providerId: "claude",
      status: "available",
      planLabel: "Max",
    });
  });

  it("produces two independent ProviderUsage rows keyed by their own provider ids", async () => {
    writeFileSync(
      join(workHome, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "at_work", subscriptionType: "team" } }),
    );
    writeFileSync(
      join(personalHome, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "at_personal", subscriptionType: "pro" } }),
    );
    const fetchApi = vi.fn(async () =>
      jsonResponse({ seven_day: { utilization: 5, resets_at: null } }),
    ) as unknown as typeof fetch;

    const fetchers = createProviderUsageFetchers(
      { logger: createLogger(), fetch: fetchApi },
      derivedEntries(),
    );
    const work = findFetcher(fetchers, "claude-work");
    const personal = findFetcher(fetchers, "claude-personal");

    const [workUsage, personalUsage] = await Promise.all([
      work.fetchUsage(),
      personal.fetchUsage(),
    ]);

    expect(workUsage).toMatchObject({
      providerId: "claude-work",
      displayName: "Claude (work)",
      status: "available",
      planLabel: "Team",
    });
    expect(personalUsage).toMatchObject({
      providerId: "claude-personal",
      displayName: "Claude (personal)",
      status: "available",
      planLabel: "Pro",
    });
  });
});
