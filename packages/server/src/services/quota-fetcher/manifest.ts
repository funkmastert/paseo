import { z } from "zod";
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
  const baseFetchers = PROVIDER_USAGE_FETCHERS.map((entry) => entry.create(options));
  const derivedFetchers = claudeDerivedEntries.map(
    (entry) =>
      new ClaudeQuotaProvider({
        logger: options.logger,
        fetch: options.fetch,
        providerId: entry.providerId,
        displayName: entry.displayName,
        claudeHome: entry.claudeHome,
        keychainService: entry.keychainService ?? claudeConfigDirKeychainService(entry.claudeHome),
      }),
  );
  return [...baseFetchers, ...derivedFetchers];
}

// Only the fields needed to identify a claude-derived account-pool entry and locate its
// credentials. `.passthrough()` because the daemon config's mutable provider schema is
// intentionally permissive (see MutableDaemonProviderConfigSchema) — this reads whatever
// shape a persisted `agents.providers.<id>` entry with `extends: "claude"` actually has.
const ClaudeDerivedProviderConfigSchema = z
  .object({
    extends: z.string().optional(),
    label: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    params: z
      .object({
        accountPool: z
          .object({
            keychainService: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * Derive one entry per claude-derived custom provider (`extends: "claude"` with its own
 * `env.CLAUDE_CONFIG_DIR`) from the daemon's provider config, for use with
 * `createProviderUsageFetchers`. An entry missing `CLAUDE_CONFIG_DIR` is skipped — it has
 * no distinct account to fetch usage for.
 */
export function deriveClaudeProviderEntries(
  providers: Record<string, unknown> | undefined,
): ClaudeDerivedProviderEntry[] {
  if (!providers) return [];

  const entries: ClaudeDerivedProviderEntry[] = [];
  for (const [providerId, rawConfig] of Object.entries(providers)) {
    const result = ClaudeDerivedProviderConfigSchema.safeParse(rawConfig);
    if (!result.success || result.data.extends !== "claude") continue;

    const claudeHome = result.data.env?.["CLAUDE_CONFIG_DIR"];
    if (!claudeHome) continue;

    entries.push({
      providerId,
      displayName: result.data.label ?? providerId,
      claudeHome,
      keychainService: result.data.params?.accountPool?.keychainService,
    });
  }
  return entries;
}
