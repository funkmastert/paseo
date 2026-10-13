import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";
import type {
  AccountAuthReading,
  AccountAuthTracker,
} from "../../server/agent/account-auth-health.js";
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
  /** Standing sign-in state, attached to each pool row at read time (docs/account-failover.md). */
  accountAuth?: AccountAuthTracker;
  /** Whether a `claude` binary resolves on this host, for a signed-out row's `canSignIn`. */
  isClaudeBinaryAvailable?: () => Promise<boolean>;
}

/** A fetcher's auth reading and the instant it was taken. */
export interface AccountAuthReadingAt {
  reading: AccountAuthReading;
  atMs: number;
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
  private readonly accountAuth: AccountAuthTracker | undefined;
  private readonly isClaudeBinaryAvailable: () => Promise<boolean>;
  /** Each fetcher's newest auth reading, from whichever real `fetchUsage()` call produced it. */
  private lastAuthReadings = new Map<string, AccountAuthReadingAt>();

  constructor(options: ProviderUsageServiceOptions) {
    this.logger = options.logger.child({ module: "provider-usage-service" });
    this.accountIdentity = options.accountIdentity;
    this.accountAuth = options.accountAuth;
    this.isClaudeBinaryAvailable = options.isClaudeBinaryAvailable ?? (async () => false);
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
    return this.withAccountAuth(this.withAccountIdentity(await this.readUsage(options)));
  }

  /**
   * The newest auth reading of every fetcher that reports one, dated when it was read rather than
   * when it is asked for: a reading served from the cache is as old as the row it rode in on.
   */
  getAuthReadings(): ReadonlyMap<string, AccountAuthReadingAt> {
    return new Map(this.lastAuthReadings);
  }

  private recordAuthReading(fetcher: ProviderUsageFetcher, atMs: number): void {
    const reading = fetcher.describeAuthReading?.();
    if (reading) this.lastAuthReadings.set(fetcher.providerId, { reading, atMs });
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

  /**
   * Auth state is read per call too, same reasoning as identity above. In-app sign-in needs an
   * email to pre-fill (the bare `claude /login` only works in a terminal) and a `claude` binary to
   * run, and must not re-sign a last-known login while an identity problem stands on the entry
   * (`blocksInAppSignIn`), so `canSignIn` says whether all three hold; the RPC checks them again.
   */
  private async withAccountAuth(result: ProviderUsageListResult): Promise<ProviderUsageListResult> {
    const tracker = this.accountAuth;
    if (!tracker) return result;
    const signedOut = new Map(
      result.providers.flatMap((row) => {
        const record = tracker.stateFor(row.providerId);
        return record?.state === "signed_out" ? [[row.providerId, record] as const] : [];
      }),
    );
    if (signedOut.size === 0) return result;
    const binaryAvailable = await this.isClaudeBinaryAvailable();
    return {
      ...result,
      providers: result.providers.map((row) => {
        const record = signedOut.get(row.providerId);
        if (!record) return row;
        return {
          ...row,
          accountAuth: {
            state: "signed_out" as const,
            since: new Date(record.since).toISOString(),
            summary: record.summary,
            fixCommand: record.fixCommand,
            canSignIn:
              record.email !== null &&
              binaryAvailable &&
              !this.accountIdentity?.blocksInAppSignIn(row.providerId),
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
    const cached = this.cached;
    if (!options?.forceRefresh && cached && nowMs - cached.fetchedAtMs < this.cacheTtlMs) {
      const forced = options?.forceRefreshProviderIds;
      const result = await this.refreshSelectedRows(
        cached.result,
        (fetcher) => fetcher.live === true || forced?.has(fetcher.providerId) === true,
      );
      // Keep what was just read, so the next caller is served it rather than the older row. The
      // cache keeps its age: a forced read refreshes named rows, not the whole list.
      if (this.cached === cached) this.cached = { fetchedAtMs: cached.fetchedAtMs, result };
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
   * Backs both the always-live refresh and a caller's named forced refresh, in one pass. */
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
          const readAtMs = this.now();
          fresh.set(fetcher.providerId, row && withFetchedAt(row, readAtMs));
          this.recordAuthReading(fetcher, readAtMs);
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
        this.recordAuthReading(fetcher, nowMs);
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
