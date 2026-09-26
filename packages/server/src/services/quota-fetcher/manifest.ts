import { z } from "zod";
import { ProviderOverrideSchema } from "../../server/agent/provider-launch-config.js";
import type {
  ProviderUsageFetcher,
  ProviderUsageFetcherFactoryOptions,
  ProviderUsageFetcherManifestEntry,
} from "./provider.js";
import { ClaudeQuotaProvider, claudeConfigDirKeychainService } from "./providers/claude.js";
import { CodexQuotaProvider } from "./providers/codex.js";
import { CopilotQuotaProvider } from "./providers/copilot.js";
import { CursorQuotaProvider } from "./providers/cursor.js";
import { GrokQuotaProvider } from "./providers/grok.js";
import { KimiQuotaProvider } from "./providers/kimi.js";
import { MiniMaxQuotaProvider } from "./providers/minimax.js";
import { OpenAiApiUsageProvider } from "./providers/openai-api.js";
import { ZaiQuotaProvider } from "./providers/zai.js";

export const PROVIDER_USAGE_FETCHERS: readonly ProviderUsageFetcherManifestEntry[] = [
  {
    providerId: "claude",
    create: (options) =>
      new ClaudeQuotaProvider({
        logger: options.logger,
        fetch: options.fetch,
      }),
  },
  {
    providerId: "codex",
    create: (options) =>
      new CodexQuotaProvider({
        logger: options.logger,
        fetch: options.fetch,
      }),
  },
  {
    providerId: "copilot",
    create: (options) => new CopilotQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "cursor",
    create: (options) => new CursorQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "zai",
    create: (options) => new ZaiQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "grok",
    create: (options) => new GrokQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "kimi",
    create: (options) => new KimiQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "minimax",
    create: (options) => new MiniMaxQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "openai-api",
    create: (options) =>
      new OpenAiApiUsageProvider({
        logger: options.logger,
        fetch: options.fetch,
        readConfig: options.readOpenAiApiConfig ?? (() => undefined),
      }),
  },
];

export interface ClaudeDerivedProviderEntry {
  providerId: string;
  displayName: string;
  claudeHome: string;
  /** Explicit override for `params.accountPool.keychainService`; see docs/providers.md. */
  keychainService?: string;
}

export function createProviderUsageFetchers(
  options: ProviderUsageFetcherFactoryOptions,
  claudeDerivedEntries: readonly ClaudeDerivedProviderEntry[] = [],
): ProviderUsageFetcher[] {
  const derivedFetchers = new Map<string, ProviderUsageFetcher>(
    claudeDerivedEntries.map((entry) => [
      entry.providerId,
      new ClaudeQuotaProvider({
        logger: options.logger,
        fetch: options.fetch,
        providerId: entry.providerId,
        displayName: entry.displayName,
        claudeHome: entry.claudeHome,
        keychainService: entry.keychainService ?? claudeConfigDirKeychainService(entry.claudeHome),
      }),
    ]),
  );
  // A derived entry for a base id (the bare `claude` entry with its own CLAUDE_CONFIG_DIR)
  // replaces the base fetcher in place: one row per provider id, reading that entry's account.
  const baseFetchers = PROVIDER_USAGE_FETCHERS.map(
    (entry) => derivedFetchers.get(entry.providerId) ?? entry.create(options),
  );
  const baseIds = new Set(PROVIDER_USAGE_FETCHERS.map((entry) => entry.providerId));
  const additionalFetchers = [...derivedFetchers.values()].filter(
    (fetcher) => !baseIds.has(fetcher.providerId),
  );
  return [...baseFetchers, ...additionalFetchers];
}

// ProviderOverrideSchema owns the persisted `agents.providers.<id>` shape (it is what the
// daemon itself validates this map with); only the account-pool keychainService override,
// which lives inside the schema's untyped `params` record, is typed locally on top.
const AccountPoolParamsSchema = z
  .object({
    accountPool: z
      .object({
        keychainService: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * Derive one entry per Claude account entry with its own `env.CLAUDE_CONFIG_DIR` — custom
 * entries with `extends: "claude"`, and the bare `claude` entry itself when it overrides its
 * config dir (an account-pool leader slot does) — for use with `createProviderUsageFetchers`.
 * Without the latter, the `claude` row would keep reading the default `~/.claude` account while
 * `claude` agents run on another one. An entry missing `CLAUDE_CONFIG_DIR` is skipped — the
 * base fetcher already covers the default account.
 */
export function deriveClaudeProviderEntries(
  providers: Record<string, unknown> | undefined,
): ClaudeDerivedProviderEntry[] {
  if (!providers) return [];

  const entries: ClaudeDerivedProviderEntry[] = [];
  for (const [providerId, rawConfig] of Object.entries(providers)) {
    const result = ProviderOverrideSchema.safeParse(rawConfig);
    const isClaudeAccount = providerId === "claude" || result.data?.extends === "claude";
    if (!result.success || !isClaudeAccount) continue;

    const claudeHome = result.data.env?.["CLAUDE_CONFIG_DIR"];
    if (!claudeHome) continue;

    const params = AccountPoolParamsSchema.safeParse(result.data.params ?? {});
    entries.push({
      providerId,
      displayName: result.data.label ?? (providerId === "claude" ? "Claude" : providerId),
      claudeHome,
      keychainService: params.success ? params.data.accountPool?.keychainService : undefined,
    });
  }
  return entries;
}
