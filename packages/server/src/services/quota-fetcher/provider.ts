import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";
import type { OpenAiApiUsageConfig } from "./providers/openai-api.js";

export type ProviderApiFetch = typeof fetch;

export interface ProviderUsageFetcher {
  readonly providerId: string;
  readonly displayName: string;
  /** Null means the provider reports nothing at all (for example, it is switched off in config). */
  fetchUsage(): Promise<ProviderUsage | null>;
}

export interface ProviderUsageFetcherFactoryOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  /** `agents.providerUsage.openaiApi`, read on every fetch so an edit needs no restart. */
  readOpenAiApiConfig?: () => OpenAiApiUsageConfig | undefined;
}

export interface ProviderUsageFetcherManifestEntry {
  readonly providerId: string;
  create(options: ProviderUsageFetcherFactoryOptions): ProviderUsageFetcher;
}
