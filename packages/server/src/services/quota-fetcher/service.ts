import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";
import type { AccountAuthReading } from "../../server/agent/account-auth-health.js";
import type { PoolAccountIdentityTracker } from "../../server/agent/pool-account-identity.js";
import type { ClaudeDerivedProviderEntry } from "./manifest.js";
import { createProviderUsageFetchers } from "./manifest.js";
import type {
  ProviderApiFetch,
  ProviderUsageFetcher,
  ProviderUsageFetcherFactoryOptions,
} from "./provider.js";
import type { OpenAiApiUsageConfig } from "./providers/openai-api.js";
import { unavailableUsage } from "./usage.js";

export interface ProviderUsageServiceOptions {
  logger: Logger;
  fetchers?: ProviderUsageFetcher[];
  fetch?: ProviderApiFetch;
  cacheTtlMs?: number;
  now?: () => number;
  /** Claude-derived custom provider entries, e.g. from `deriveClaudeProviderEntries`. */
  claudeDerivedProviders?: readonly ClaudeDerivedProviderEntry[];
  /** `agents.providerUsage.openaiApi`, read on every fetch. */
  readOpenAiApiConfig?: () => OpenAiApiUsageConfig | undefined;
  readJevStatus?: ProviderUsageFetcherFactoryOptions["readJevStatus"];
  /** Standing account-identity problems, attached to each pool row at read time. */
  accountIdentity?: PoolAccountIdentityTracker;
}

export interface ProviderUsageListResult {
  fetchedAt: string;
  providers: ProviderUsage[];
}

const DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Stamps a row with the instant it was read, unless its fetcher already did. The usage history
 * sampler can only place a reading in time from this field, and a row without it is dropped. It is
 * stamped here, not on read, so a row served from the five-minute cache keeps its real age.
 */
function withFetchedAt(row: ProviderUsage, atMs: number): ProviderUsage {
  if (row.fetchedAt) return row;
  return { ...row, fetchedAt: new Date(atMs).toISOString() };
}

export class ProviderUsageService {
  private readonly logger: Logger;
  private readonly fetchers: ProviderUsageFetcher[];
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cached: { fetchedAtMs: number; result: ProviderUsageListResult } | null = null;
  private inFlight: Promise<ProviderUsageListResult> | null = null;
  private readonly accountIdentity: PoolAccountIdentityTracker | undefined;
  /** Auth reading from each fetcher's most recent real `fetchUsage()` call, for the account-auth
   * sweep (account-auth-health.ts). Not cleared on a cache hit: a reading is only as fresh as the
   * last real fetch, same as the row it rode in on. */
  private lastAuthReadings = new Map<string, AccountAuthReading>();

  constructor(options: ProviderUsageServiceOptions) {
    this.logger = options.logger.child({ module: "provider-usage-service" });
    this.accountIdentity = options.accountIdentity;
    this.fetchers =
      options.fetchers ??
      createProviderUsageFetchers(
        {
          logger: this.logger,
          fetch: options.fetch,
          readOpenAiApiConfig: options.readOpenAiApiConfig,
          readJevStatus: options.readJevStatus,
        },
        options.claudeDerivedProviders,
      );
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async listUsage(options?: {
    forceRefresh?: boolean;
    /** Bypass the cache for exactly these providers; every other row may still be cache-served. */
    forceRefreshProviderIds?: ReadonlySet<string>;
  }): Promise<ProviderUsageListResult> {
    return this.withAccountIdentity(await this.readUsage(options));
  }

  /** Readings collected from whichever of `providerIds` were actually (re)fetched by the most
   * recent `listUsage()` call. A provider absent here was cache-served that call, or its fetcher
   * does not implement `describeAuthReading`. */
  getAuthReadings(providerIds: ReadonlySet<string>): ReadonlyMap<string, AccountAuthReading> {
    const result = new Map<string, AccountAuthReading>();
    for (const providerId of providerIds) {
      const reading = this.lastAuthReadings.get(providerId);
      if (reading) result.set(providerId, reading);
    }
    return result;
  }

  /**
   * Identity is read per call, not cached with the rows: a login fixed in the last minute must not
   * keep showing for five.
   */
  private withAccountIdentity(result: ProviderUsageListResult): ProviderUsageListResult {
    if (!this.accountIdentity) return result;
    const tracker = this.accountIdentity;
    return {
      ...result,
      providers: result.providers.map((row) => {
        const problem = tracker.problemFor(row.providerId);
        if (!problem) return row;
        return {
          ...row,
          accountIdentity: {
            kind: problem.kind,
            summary: problem.summary,
            fixCommand: problem.fixCommand,
          },
        };
      }),
    };
  }

  private async readUsage(options?: {
    forceRefresh?: boolean;
    forceRefreshProviderIds?: ReadonlySet<string>;
  }): Promise<ProviderUsageListResult> {
    const nowMs = this.now();
    if (
      !options?.forceRefresh &&
      this.cached &&
      nowMs - this.cached.fetchedAtMs < this.cacheTtlMs
    ) {
      let result = await this.refreshSelectedRows(
        this.cached.result,
        (fetcher) => fetcher.live === true,
      );
      if (options?.forceRefreshProviderIds?.size) {
        const forced = options.forceRefreshProviderIds;
        result = await this.refreshSelectedRows(result, (fetcher) =>
          forced.has(fetcher.providerId),
        );
      }
      return result;
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    const request = this.fetchFreshUsage(nowMs);
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) {
        this.inFlight = null;
      }
    }
  }

  /** The given result with every fetcher matching `shouldRefresh` read again, in the same place.
   * Backs both the always-live refresh and a caller's named forced refresh. */
  private async refreshSelectedRows(
    result: ProviderUsageListResult,
    shouldRefresh: (fetcher: ProviderUsageFetcher) => boolean,
  ): Promise<ProviderUsageListResult> {
    const toRefresh = this.fetchers.filter(shouldRefresh);
    if (toRefresh.length === 0) return result;
    const fresh = new Map<string, ProviderUsage | null>();
    await Promise.all(
      toRefresh.map(async (fetcher) => {
        try {
          const row = await fetcher.fetchUsage();
          fresh.set(fetcher.providerId, row && withFetchedAt(row, Date.now()));
          const reading = fetcher.describeAuthReading?.();
          if (reading) this.lastAuthReadings.set(fetcher.providerId, reading);
        } catch (err) {
          this.logger.debug({ err, providerId: fetcher.providerId }, "Usage refresh failed");
        }
      }),
    );
    const providers = result.providers.flatMap((provider): ProviderUsage[] => {
      if (!fresh.has(provider.providerId)) return [provider];
      const row = fresh.get(provider.providerId);
      fresh.delete(provider.providerId);
      return row ? [row] : [];
    });
    for (const row of fresh.values()) if (row) providers.push(row);
    return { ...result, providers };
  }

  private async fetchFreshUsage(nowMs: number): Promise<ProviderUsageListResult> {
    const settled = await Promise.allSettled(this.fetchers.map((fetcher) => fetcher.fetchUsage()));
    const providers = settled.flatMap((result, index): ProviderUsage[] => {
      const fetcher = this.fetchers[index];
      if (result.status === "fulfilled") {
        const reading = fetcher.describeAuthReading?.();
        if (reading) this.lastAuthReadings.set(fetcher.providerId, reading);
        return result.value ? [withFetchedAt(result.value, nowMs)] : [];
      }
      this.logger.debug(
        { err: result.reason, providerId: fetcher.providerId },
        "Provider usage fetch failed",
      );
      return [
        unavailableUsage({
          providerId: fetcher.providerId,
          displayName: fetcher.displayName,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }),
      ];
    });

    const result = { fetchedAt: new Date(nowMs).toISOString(), providers };
    this.cached = { fetchedAtMs: nowMs, result };
    return result;
  }
}
