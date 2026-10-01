import type { Logger } from "pino";
import type { JevDecisionRecord, JevStatus } from "../../server/jev/contract.js";
import type { ProviderUsage } from "../../server/messages.js";
import type { OpenAiApiUsageConfig } from "./providers/openai-api.js";

export type ProviderApiFetch = typeof fetch;

export interface ProviderUsageFetcher {
  readonly providerId: string;
  readonly displayName: string;
  /**
   * Answers from the daemon's own memory, so it is read on every list rather than served from the
   * service's cache: a cache that holds network reads for five minutes would show a JEV lane that
   * just ran out as still spending.
   */
  readonly live?: boolean;
  /** Null means the provider reports nothing at all (for example, it is switched off in config). */
  fetchUsage(): Promise<ProviderUsage | null>;
}

export interface ProviderUsageFetcherFactoryOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  /** `agents.providerUsage.openaiApi`, read on every fetch so an edit needs no restart. */
  readOpenAiApiConfig?: () => OpenAiApiUsageConfig | undefined;
  /** `JevService.status()`; absent or null on a daemon without JEV, which reports no row. */
  readJevStatus?: () => JevStatus | null;
  /** Every decision the daemon holds for its agents, for the JEV row's shadow summary. */
  readJevDecisions?: () => readonly JevDecisionRecord[];
}

export interface ProviderUsageFetcherManifestEntry {
  readonly providerId: string;
  create(options: ProviderUsageFetcherFactoryOptions): ProviderUsageFetcher;
}
