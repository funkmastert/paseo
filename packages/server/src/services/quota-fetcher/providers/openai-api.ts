import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage, ProviderUsageWindow } from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNumberSchema,
  fetchProviderApi,
  toneFromUsedPct,
  unavailableUsage,
  usedPctOf,
  windowFromUsedPct,
} from "../usage.js";

/**
 * `agents.providerUsage.openaiApi` in config.json. Names where the key lives, never the key
 * itself. See docs/provider-usage.md.
 */
export interface OpenAiApiUsageConfig {
  enabled?: boolean;
  label?: string;
  /** The key read for costs; needs the Usage: Read (`api.usage.read`) permission. */
  keyEnv?: string;
  /** Tried before `keyEnv` when it is set, for a separate key that only reads usage. */
  adminKeyEnv?: string;
  envFile?: string;
  monthlyBudgetUsd?: number;
  refreshMinutes?: number;
}

const DEFAULT_LABEL = "OpenAI API (image gen)";
const DEFAULT_KEY_ENV = "OPENAI_API_KEY";
const DEFAULT_ADMIN_KEY_ENV = "OPENAI_ADMIN_KEY";
const DEFAULT_ENV_FILE = "~/.config/openai/env";
const DEFAULT_REFRESH_MINUTES = 30;
const COSTS_URL = "https://api.openai.com/v1/organization/costs";
// A month has at most 31 daily buckets and the API allows up to 180 per page, so one page
// covers it; the loop still follows `next_page` in case that ever changes.
const BUCKETS_PER_PAGE = 31;
const MAX_PAGES = 10;

// `next_page` and `has_more` are read leniently: only the amounts matter for the total.
const CostsPageSchema = z.object({
  data: z.array(
    z.object({
      results: z.array(
        z.object({
          amount: z
            .object({
              value: ApiNumberSchema,
              currency: z.string().optional(),
            })
            .optional(),
        }),
      ),
    }),
  ),
  next_page: z.string().nullish(),
});

class OpenAiApiUsageError extends Error {}

const USAGE_READ_HINT =
  "Give this OpenAI key Usage: Read (platform.openai.com → API keys → Permissions)";

// The scope name is the one thing read from an error body; nothing else in it is kept, because
// OpenAI's messages can quote the key.
async function mentionsUsageReadScope(res: Response): Promise<boolean> {
  try {
    return (await res.text()).includes("api.usage.read");
  } catch {
    return false;
  }
}

/**
 * The last `[export] NAME=value` assignment in an env file, the way a shell would read it.
 * Quoted values keep everything inside the quotes; an unquoted value ends at ` #`. Returns
 * null when the name is absent or empty. The value is returned to the caller and nowhere else.
 */
export function parseEnvFileValue(text: string, name: string): string | null {
  let found: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || match[1] !== name) continue;
    found = unquoteEnvValue(match[2]);
  }
  return found === "" ? null : found;
}

function unquoteEnvValue(raw: string): string {
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const end = raw.indexOf(quote, 1);
    if (end !== -1) return raw.slice(1, end);
    return raw.slice(1).trim();
  }
  const comment = raw.search(/\s#/);
  return (comment === -1 ? raw : raw.slice(0, comment)).trim();
}

function monthStartUtc(nowMs: number): Date {
  const now = new Date(nowMs);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function nextMonthStartUtc(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

interface CachedSpend {
  monthStartMs: number;
  fetchedAtMs: number;
  spendUsd: number;
}

interface OpenAiApiUsageProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  /** Read on every call, so a config edit applies without a restart. */
  readConfig: () => OpenAiApiUsageConfig | undefined;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/**
 * Month-to-date spend of an OpenAI platform org, for the account strip. Any key with the Usage:
 * Read (`api.usage.read`) permission can read org costs; one without it gets a 403 naming the
 * scope. The key is read from the environment or an env file at fetch time: it is never stored in
 * config, sent to the app, logged, or put in an error message.
 */
export class OpenAiApiUsageProvider implements ProviderUsageFetcher {
  readonly providerId = "openai-api";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly readConfig: () => OpenAiApiUsageConfig | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private cached: CachedSpend | null = null;

  constructor(options: OpenAiApiUsageProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.readConfig = options.readConfig;
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
  }

  get displayName(): string {
    return this.readConfig()?.label?.trim() || DEFAULT_LABEL;
  }

  async fetchUsage(): Promise<ProviderUsage | null> {
    const config = this.readConfig();
    if (!config?.enabled) {
      this.cached = null;
      return null;
    }
    const displayName = config.label?.trim() || DEFAULT_LABEL;
    const keyEnv = config.keyEnv?.trim() || DEFAULT_KEY_ENV;
    const adminKeyEnv = config.adminKeyEnv?.trim() || DEFAULT_ADMIN_KEY_ENV;
    const envFile = config.envFile?.trim() || DEFAULT_ENV_FILE;
    const fail = (error: string) =>
      unavailableUsage({ providerId: this.providerId, displayName, error });

    const key = this.resolveKey([adminKeyEnv, keyEnv], envFile);
    if (!key) {
      this.cached = null;
      return fail(`Add ${keyEnv} to ${envFile}`);
    }

    const nowMs = this.now();
    const monthStartMs = monthStartUtc(nowMs).getTime();
    const refreshMs = (config.refreshMinutes ?? DEFAULT_REFRESH_MINUTES) * 60_000;
    let spend = this.cached;
    if (!spend || spend.monthStartMs !== monthStartMs || nowMs - spend.fetchedAtMs >= refreshMs) {
      try {
        const spendUsd = await this.fetchMonthSpend(key, monthStartMs / 1000);
        spend = { monthStartMs, fetchedAtMs: nowMs, spendUsd };
        this.cached = spend;
      } catch (err) {
        this.cached = null;
        const message =
          err instanceof OpenAiApiUsageError ? err.message : "Could not reach the OpenAI costs API";
        this.logger.debug({ reason: message }, "OpenAI API usage fetch failed");
        return fail(message);
      }
    }
    return this.toUsage(displayName, config, spend, refreshMs);
  }

  private toUsage(
    displayName: string,
    config: OpenAiApiUsageConfig,
    spend: CachedSpend,
    refreshMs: number,
  ): ProviderUsage {
    const budget = config.monthlyBudgetUsd;
    const usedPct = usedPctOf(spend.spendUsd, budget);
    const windows: ProviderUsageWindow[] =
      usedPct === null
        ? []
        : [
            windowFromUsedPct({
              id: "month",
              label: "Month",
              utilizationPct: usedPct,
              resetsAt: nextMonthStartUtc(new Date(spend.monthStartMs)),
              tone: toneFromUsedPct(usedPct),
            }),
          ];
    return {
      providerId: this.providerId,
      displayName,
      status: "available",
      planLabel: null,
      sourceLabel: "Costs API",
      fetchedAt: new Date(spend.fetchedAtMs).toISOString(),
      nextRefreshAt: new Date(spend.fetchedAtMs + refreshMs).toISOString(),
      windows,
      balances: [
        {
          id: "spend",
          label: "Spent this month",
          used: roundCents(spend.spendUsd),
          ...(budget !== undefined && budget > 0 ? { limit: budget } : {}),
          unit: "usd",
        },
      ],
      details: [],
      error: null,
    };
  }

  /** The first of `names` that is set, checking the environment before the env file for each. */
  private resolveKey(names: string[], envFile: string): string | null {
    let fileText: string | null | undefined;
    for (const name of names) {
      const fromEnv = this.env[name]?.trim();
      if (fromEnv) return fromEnv;
      if (fileText === undefined) fileText = this.readEnvFile(envFile);
      const fromFile = fileText === null ? null : parseEnvFileValue(fileText, name);
      if (fromFile) return fromFile;
    }
    return null;
  }

  private readEnvFile(envFile: string): string | null {
    try {
      return readFileSync(expandHome(envFile), "utf8");
    } catch {
      return null;
    }
  }

  private async fetchMonthSpend(key: string, startTimeSec: number): Promise<number> {
    let total = 0;
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
      const url = new URL(COSTS_URL);
      url.searchParams.set("start_time", String(startTimeSec));
      url.searchParams.set("bucket_width", "1d");
      url.searchParams.set("limit", String(BUCKETS_PER_PAGE));
      if (cursor) url.searchParams.set("page", cursor);

      const res = await fetchProviderApi(this.fetchApi, url, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      });
      if (res.status === 401) {
        throw new OpenAiApiUsageError("OpenAI rejected the key (HTTP 401): invalid or revoked");
      }
      if (res.status === 403) {
        throw new OpenAiApiUsageError(
          (await mentionsUsageReadScope(res))
            ? USAGE_READ_HINT
            : "OpenAI denied the request (HTTP 403): the key's role or permissions cannot read org costs",
        );
      }
      if (!res.ok) {
        throw new OpenAiApiUsageError(`OpenAI costs API returned HTTP ${res.status}`);
      }
      const parsed = CostsPageSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new OpenAiApiUsageError("OpenAI costs API returned an unexpected response");
      }
      for (const bucket of parsed.data.data) {
        for (const result of bucket.results) {
          const amount = result.amount;
          if (amount && (amount.currency ?? "usd").toLowerCase() === "usd") total += amount.value;
        }
      }
      cursor = parsed.data.next_page ?? null;
      if (!cursor) return total;
    }
    return total;
  }
}
