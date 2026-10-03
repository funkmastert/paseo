import path from "node:path";
import type { Logger } from "pino";

import { resolveAwayReplyConfig, type ResolvedAwayReplyConfig } from "../away-reply/config.js";
import { AgentJevSchema } from "../persisted-config.js";
import { readRawConfig } from "../session/doctor/facts.js";
import {
  resolveWorkspaceTitleRefreshConfig,
  type ResolvedWorkspaceTitleRefreshConfig,
} from "../workspace-title-refresh-config.js";

/**
 * `agents.jev` (docs/jev.md, "Config"). Read through a 5-second cache over `readRawConfig`, and a
 * lenient resolver shaped like `resolveTokenAuditConfig` (`token-audit/config.ts`): a malformed
 * value falls back to its default, and a `config.json` that cannot be read answers
 * `config-unreadable`.
 */

export interface ResolvedJevFeatureConfig {
  enabled: boolean;
  shadow: boolean;
  timeoutMs: number;
}

export interface ResolvedJevConfig {
  enabled: boolean;
  provider: "openrouter" | "typesafe";
  /** True when `provider` came from the key's prefix, not from `agents.jev.provider`. */
  providerInferred: boolean;
  model: string;
  endpointUrl: string;
  /** Absolute, `~` expanded against `homeDir`. */
  envFile: string;
  maxConcurrent: number;
  maxRequestsPerSecond: number;
  maxUsdPerDay: number;
  inputUsdPerMillion: number;
  excludeCwds: string[];
  excludeRemotes: string[];
  excludeTextMarkers: string[];
  audit: { enabled: boolean; maxBytes: number; retainDays: number };
  spawnHint: ResolvedJevFeatureConfig & { applyHard: boolean; applyRole: boolean };
  remediationTriage: ResolvedJevFeatureConfig;
  notificationTriage: ResolvedJevFeatureConfig;
  agentTools: {
    enabled: boolean;
    /** No shadow mode: an agent asked, so it gets the answer (docs/jev.md, "Config"). */
    shadow: false;
    timeoutMs: number;
    maxConcurrent: number;
    maxConcurrentPerCall: number;
    maxUsdPerDay: number;
    maxUsdPerAgentPerHour: number;
    assignShare: number;
  };
  compactionTiming: ResolvedJevFeatureConfig & {
    considerAtTokens: number;
    ceilingTokens: number;
    maxDeferrals: number;
    cutPoint: boolean;
  };
  stallJudgment: ResolvedJevFeatureConfig & { loopWatch: boolean };
  /** Feature 14. Dry run by default (D6); `dryRun` is its `shadow`. */
  awayReply: ResolvedAwayReplyConfig;
  /** Feature 17. No shadow mode: see `workspace-title-refresh-config.ts`. */
  titleRefresh: ResolvedWorkspaceTitleRefreshConfig;
  /** Feature 15, the `interactive` lane. No shadow mode: a person asked, so they get the answer. */
  askJev: {
    enabled: boolean;
    shadow: false;
    timeoutMs: number;
    maxConcurrent: number;
    maxUsdPerDay: number;
  };
  /** Feature 16, the `reads` lane. Shadow by default (D6); `shadow: false` is live mode (D11). */
  readCheck: ResolvedJevFeatureConfig & {
    /** Reads estimated below this are counted, never judged. */
    minTokens: number;
    /** Live mode holds only reads this large. */
    liveMinTokens: number;
    /** How long a live read waits for its verdict, clamped to 300–2,000 ms. */
    liveTimeoutMs: number;
    /** Share of agents live mode applies to; the rest stay in shadow as its control. */
    liveShare: number;
    maxDeniesPerAgentPerHour: number;
    maxConcurrent: number;
    maxUsdPerDay: number;
  };
}

export const JEV_PROVIDER_DEFAULTS: Record<
  "openrouter" | "typesafe",
  { url: string; model: string }
> = {
  openrouter: { url: "https://openrouter.ai/api/alpha/decisions", model: "~typesafe/jev-latest" },
  typesafe: { url: "https://api.typesafe.ai/v1/systemone", model: "jev-latest" },
};

/**
 * docs/jev.md, "The D7 exclusion". A configured value replaces its default; `[]` turns it off.
 *
 * Empty since 2026-10-02, when Tyler answered the question D7 was waiting on: company code may go
 * to JEV. The mechanism stays — configure any of the three to exclude a tree, a remote or a
 * string again, and `decide` enforces it for every feature, fail-closed. Nothing is excluded until
 * someone asks for it, so a fresh `PASEO_HOME` or a config that loses its `agents.jev` section
 * behaves like his does.
 */
export const JEV_DEFAULT_EXCLUDE_CWDS: string[] = [];
export const JEV_DEFAULT_EXCLUDE_REMOTES: string[] = [];
export const JEV_DEFAULT_EXCLUDE_TEXT_MARKERS: string[] = [];

/** The list price. `inputUsdPerMillion` cannot go below it, so config cannot zero the estimate. */
export const JEV_MIN_INPUT_USD_PER_MILLION = 0.042;
/** TypeSafe publishes 1,200/minute; this is the daemon-wide ceiling regardless of config. */
export const JEV_MAX_REQUESTS_PER_SECOND = 15;
const MIN_REQUESTS_PER_SECOND = 1;
const DEFAULT_REQUESTS_PER_SECOND = 10;
const ALLOWED_ENDPOINT_HOSTS = new Set(["openrouter.ai", "api.typesafe.ai"]);
const DEFAULT_ENV_FILE = "~/.config/paseo/jev.env";
/** A person is waiting on the answer, and a slow call holds an `interactive` slot. */
export const JEV_ASK_MAX_TIMEOUT_MS = 30_000;
const JEV_ASK_MIN_TIMEOUT_MS = 1_000;
/** A live read check holds the agent's read; past this it goes through unchecked. */
const JEV_READ_LIVE_MIN_TIMEOUT_MS = 300;
const JEV_READ_LIVE_MAX_TIMEOUT_MS = 2_000;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** A finite number greater than zero, else `fallback`. Never clamps. */
function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A finite number, clamped to `[min, max]`; an invalid value falls back instead of clamping. */
function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function stringArray(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.every((entry): entry is string => typeof entry === "string")
    ? [...value]
    : [...fallback];
}

function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return path.resolve(value);
}

/** A key prefix that identifies its provider unambiguously, when `agents.jev.provider` is unset. */
const JEV_KEY_PREFIX_PROVIDERS: ReadonlyArray<{
  prefix: string;
  provider: "typesafe" | "openrouter";
}> = [
  { prefix: "apikey_", provider: "typesafe" },
  { prefix: "sk-or-", provider: "openrouter" },
];

/**
 * `agents.jev.provider` always wins. Unset, the provider is read off the key's prefix
 * (docs/jev.md, "Key"); no key, or a prefix that names neither provider, keeps today's default.
 */
export function resolveJevProvider(
  explicitValue: unknown,
  key: string | null,
): { provider: "openrouter" | "typesafe"; inferred: boolean } {
  if (explicitValue === "typesafe" || explicitValue === "openrouter") {
    return { provider: explicitValue, inferred: false };
  }
  if (typeof key === "string") {
    const match = JEV_KEY_PREFIX_PROVIDERS.find(({ prefix }) => key.startsWith(prefix));
    if (match) return { provider: match.provider, inferred: true };
  }
  return { provider: "openrouter", inferred: false };
}

function resolveEnvFile(section: Record<string, unknown>, homeDir: string): string {
  return expandHome(nonEmptyString(section["envFile"], DEFAULT_ENV_FILE), homeDir);
}

/**
 * `https:` on an allowed host only (docs/jev.md, "Transport"); any other value is ignored and
 * `onRejectedEndpoint` is called so the caller can log once, without this function ever handling
 * a logger or the raw value itself.
 */
function resolveEndpointUrl(
  value: unknown,
  provider: "openrouter" | "typesafe",
  onRejectedEndpoint?: () => void,
): string {
  const fallback = JEV_PROVIDER_DEFAULTS[provider].url;
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:" && ALLOWED_ENDPOINT_HOSTS.has(url.hostname)) {
      return trimmed;
    }
  } catch {
    // Falls through to the rejection below.
  }
  onRejectedEndpoint?.();
  return fallback;
}

function resolveFeature(
  value: unknown,
  defaults: ResolvedJevFeatureConfig,
): ResolvedJevFeatureConfig {
  const section = record(value);
  return {
    enabled: bool(section["enabled"], defaults.enabled),
    shadow: bool(section["shadow"], defaults.shadow),
    timeoutMs: Math.floor(positiveNumber(section["timeoutMs"], defaults.timeoutMs)),
  };
}

/**
 * Where `agents.jev` breaks `AgentJevSchema`, as `agents.jev.<path>: <message>` lines. Messages
 * name what was expected, never the value. Empty when the section is absent or valid.
 */
export function jevConfigIssues(section: unknown): string[] {
  if (section === undefined) return [];
  const result = AgentJevSchema.safeParse(section);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const where = ["agents", "jev", ...issue.path.map(String)].join(".");
    return issue.code === "unrecognized_keys"
      ? `${where}: unknown key(s) ${issue.keys.join(", ")}`
      : `${where}: ${issue.message}`;
  });
}

/** `agents.jev` out of a parsed `config.json`. */
export function jevConfigSection(rawConfig: Record<string, unknown> | null): unknown {
  return record(rawConfig?.["agents"])["jev"];
}

export interface ResolveJevConfigOptions {
  homeDir: string;
  /** The resolved key, if any — read only to infer `provider` when it is unset. Never logged. */
  key?: string | null;
  /** Called, with no argument, whenever `endpointUrl` is set but rejected. */
  onRejectedEndpoint?: () => void;
}

export function resolveJevConfig(
  raw: unknown,
  options: ResolveJevConfigOptions,
): ResolvedJevConfig {
  const section = record(raw);
  const { provider, inferred: providerInferred } = resolveJevProvider(
    section["provider"],
    options.key ?? null,
  );
  const providerDefaults = JEV_PROVIDER_DEFAULTS[provider];
  const audit = record(section["audit"]);
  const spawnHint = record(section["spawnHint"]);
  const agentTools = record(section["agentTools"]);
  const compactionTiming = record(section["compactionTiming"]);
  const stallJudgment = record(section["stallJudgment"]);
  const askJev = record(section["askJev"]);
  const readCheck = record(section["readCheck"]);

  return {
    enabled: bool(section["enabled"], true),
    provider,
    providerInferred,
    model: nonEmptyString(section["model"], providerDefaults.model),
    endpointUrl: resolveEndpointUrl(section["endpointUrl"], provider, options.onRejectedEndpoint),
    envFile: resolveEnvFile(section, options.homeDir),
    maxConcurrent: Math.floor(positiveNumber(section["maxConcurrent"], 4)),
    maxRequestsPerSecond: Math.floor(
      numberInRange(
        section["maxRequestsPerSecond"],
        DEFAULT_REQUESTS_PER_SECOND,
        MIN_REQUESTS_PER_SECOND,
        JEV_MAX_REQUESTS_PER_SECOND,
      ),
    ),
    maxUsdPerDay: positiveNumber(section["maxUsdPerDay"], 1),
    inputUsdPerMillion: Math.max(
      JEV_MIN_INPUT_USD_PER_MILLION,
      positiveNumber(section["inputUsdPerMillion"], JEV_MIN_INPUT_USD_PER_MILLION),
    ),
    excludeCwds: stringArray(section["excludeCwds"], JEV_DEFAULT_EXCLUDE_CWDS),
    excludeRemotes: stringArray(section["excludeRemotes"], JEV_DEFAULT_EXCLUDE_REMOTES),
    excludeTextMarkers: stringArray(
      section["excludeTextMarkers"],
      JEV_DEFAULT_EXCLUDE_TEXT_MARKERS,
    ),
    audit: {
      enabled: bool(audit["enabled"], true),
      maxBytes: Math.floor(positiveNumber(audit["maxBytes"], 4_000_000)),
      retainDays: Math.floor(positiveNumber(audit["retainDays"], 3)),
    },
    spawnHint: {
      ...resolveFeature(spawnHint, { enabled: true, shadow: true, timeoutMs: 1500 }),
      applyHard: bool(spawnHint["applyHard"], false),
      applyRole: bool(spawnHint["applyRole"], false),
    },
    remediationTriage: resolveFeature(section["remediationTriage"], {
      enabled: true,
      shadow: true,
      timeoutMs: 5000,
    }),
    notificationTriage: resolveFeature(section["notificationTriage"], {
      enabled: true,
      shadow: true,
      timeoutMs: 3000,
    }),
    agentTools: {
      enabled: bool(agentTools["enabled"], true),
      shadow: false,
      timeoutMs: Math.floor(positiveNumber(agentTools["timeoutMs"], 8000)),
      maxConcurrent: Math.floor(positiveNumber(agentTools["maxConcurrent"], 4)),
      maxConcurrentPerCall: Math.floor(positiveNumber(agentTools["maxConcurrentPerCall"], 2)),
      maxUsdPerDay: positiveNumber(agentTools["maxUsdPerDay"], 0.5),
      maxUsdPerAgentPerHour: positiveNumber(agentTools["maxUsdPerAgentPerHour"], 0.05),
      assignShare: numberInRange(agentTools["assignShare"], 0.5, 0, 1),
    },
    compactionTiming: {
      ...resolveFeature(compactionTiming, { enabled: true, shadow: true, timeoutMs: 5000 }),
      considerAtTokens: Math.floor(positiveNumber(compactionTiming["considerAtTokens"], 200_000)),
      ceilingTokens: Math.floor(positiveNumber(compactionTiming["ceilingTokens"], 500_000)),
      maxDeferrals: Math.floor(positiveNumber(compactionTiming["maxDeferrals"], 3)),
      cutPoint: bool(compactionTiming["cutPoint"], true),
    },
    stallJudgment: {
      ...resolveFeature(stallJudgment, { enabled: true, shadow: true, timeoutMs: 5000 }),
      loopWatch: bool(stallJudgment["loopWatch"], true),
    },
    awayReply: resolveAwayReplyConfig(section["awayReply"]),
    titleRefresh: resolveWorkspaceTitleRefreshConfig(section["titleRefresh"]),
    askJev: {
      enabled: bool(askJev["enabled"], true),
      shadow: false,
      timeoutMs: Math.floor(
        numberInRange(askJev["timeoutMs"], 15_000, JEV_ASK_MIN_TIMEOUT_MS, JEV_ASK_MAX_TIMEOUT_MS),
      ),
      maxConcurrent: Math.floor(positiveNumber(askJev["maxConcurrent"], 2)),
      maxUsdPerDay: positiveNumber(askJev["maxUsdPerDay"], 0.25),
    },
    readCheck: {
      ...resolveFeature(readCheck, { enabled: true, shadow: true, timeoutMs: 5000 }),
      minTokens: Math.floor(positiveNumber(readCheck["minTokens"], 2000)),
      liveMinTokens: Math.floor(positiveNumber(readCheck["liveMinTokens"], 8000)),
      liveTimeoutMs: Math.floor(
        numberInRange(
          readCheck["liveTimeoutMs"],
          1000,
          JEV_READ_LIVE_MIN_TIMEOUT_MS,
          JEV_READ_LIVE_MAX_TIMEOUT_MS,
        ),
      ),
      liveShare: numberInRange(readCheck["liveShare"], 0.5, 0, 1),
      maxDeniesPerAgentPerHour: Math.floor(
        positiveNumber(readCheck["maxDeniesPerAgentPerHour"], 5),
      ),
      maxConcurrent: Math.floor(positiveNumber(readCheck["maxConcurrent"], 2)),
      maxUsdPerDay: positiveNumber(readCheck["maxUsdPerDay"], 0.25),
    },
  };
}

export interface JevConfigReader {
  read(): { ok: true; config: ResolvedJevConfig } | { ok: false; reason: "config-unreadable" };
}

export interface JevConfigReaderOptions {
  paseoHome: string;
  homeDir: string;
  logger: Logger;
  /** Default 5000. */
  ttlMs?: number;
  now?: () => number;
  readRaw?: typeof readRawConfig;
  /** Looks up the key for a resolved `envFile`, so `provider` can be inferred from it. Default: no key. */
  resolveKey?: (envFile: string) => string | null;
}

const DEFAULT_TTL_MS = 5_000;

/** A safe description for a log line: origin only, never the value's path, query or userinfo. */
function describeRejectedEndpoint(value: unknown): string {
  if (typeof value !== "string") return "not a string";
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "unparsable value";
  }
}

export function createJevConfigReader(options: JevConfigReaderOptions): JevConfigReader {
  const logger = options.logger.child({ module: "jev-config" });
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const readRaw = options.readRaw ?? readRawConfig;
  const loggedRejectedEndpoints = new Set<string>();
  let loggedIssues: string | null = null;
  let cached: { at: number; result: ReturnType<JevConfigReader["read"]> } | null = null;

  function logRejectedEndpointOnce(rawValue: unknown): void {
    const key = typeof rawValue === "string" ? rawValue : String(rawValue);
    if (loggedRejectedEndpoints.has(key)) return;
    loggedRejectedEndpoints.add(key);
    logger.warn(
      { endpointUrl: describeRejectedEndpoint(rawValue) },
      "jev: agents.jev.endpointUrl rejected (must be https: to openrouter.ai or api.typesafe.ai); using the provider default",
    );
  }

  function compute(): ReturnType<JevConfigReader["read"]> {
    const { rawConfig, rawConfigError } = readRaw(options.paseoHome);
    if (rawConfigError) return { ok: false, reason: "config-unreadable" };
    const section = jevConfigSection(rawConfig);
    // A section that does not match is off, not guessed at: `enabled: "false"` must not read as on.
    const issues = jevConfigIssues(section);
    if (issues.length > 0) {
      const summary = issues.join("; ");
      if (loggedIssues !== summary) {
        loggedIssues = summary;
        logger.warn(
          { issues },
          `jev: agents.jev does not match the schema; JEV is off (${summary})`,
        );
      }
      return { ok: false, reason: "config-unreadable" };
    }
    loggedIssues = null;
    const sectionRecord = record(section);
    const envFile = resolveEnvFile(sectionRecord, options.homeDir);
    const key = options.resolveKey ? options.resolveKey(envFile) : null;
    const rawEndpoint = sectionRecord["endpointUrl"];
    const config = resolveJevConfig(section, {
      homeDir: options.homeDir,
      key,
      onRejectedEndpoint: () => logRejectedEndpointOnce(rawEndpoint),
    });
    return { ok: true, config };
  }

  return {
    read() {
      const at = now();
      if (!cached || at - cached.at >= ttlMs) {
        cached = { at, result: compute() };
      }
      return cached.result;
    },
  };
}
