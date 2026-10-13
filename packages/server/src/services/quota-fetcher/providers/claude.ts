import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "pino";
import { z } from "zod";
import type { AccountAuthReading } from "../../../server/agent/account-auth-health.js";
import { readClaudeAccountAuth } from "../../../server/agent/providers/claude/account-auth.js";
import type {
  ProviderUsage,
  ProviderUsageDetail,
  ProviderUsageWindow,
} from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNumberSchema,
  fetchProviderApi,
  toneFromUsedPct,
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";

const execFileAsync = promisify(execFile);
const CLAUDE_KEYCHAIN_TIMEOUT_MS = 2_000;
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

const ClaudeCredentialsSchema = z.object({
  claudeAiOauth: z
    .object({
      accessToken: z.string().optional(),
      refreshToken: z.string().optional(),
      subscriptionType: z.string().optional(),
      rateLimitTier: z.string().optional(),
      /**
       * Read-only, like the rest of this file (docs/providers.md): the CLI owns refresh, this
       * only tells a 401 apart as "the token expired" (suspect, needs a confirming probe) vs
       * "the token was rejected before it should have been" (revoked, strong signal on its own).
       */
      expiresAt: z.number().optional(),
    })
    .optional(),
});

const ClaudeUsageWindowSchema = z.object({
  utilization: ApiNumberSchema,
  resets_at: z.string().nullish(),
});

// Model- and surface-scoped weekly limits live in a `limits[]` array rather than a
// top-level `seven_day_<model>` key. Entries are validated one at a time (see
// scopedLimitsFromResponse) so a single malformed or newly-shaped entry cannot take down
// the windows that already parsed from the top-level keys.
const ClaudeScopeLabelSchema = z
  .object({ id: z.string().nullish(), display_name: z.string().nullish() })
  .nullish();

const ClaudeLimitSchema = z.object({
  kind: z.string(),
  percent: ApiNumberSchema.nullish(),
  resets_at: z.string().nullish(),
  scope: z.object({ model: ClaudeScopeLabelSchema, surface: ClaudeScopeLabelSchema }).nullish(),
});

const ClaudeUsageResponseSchema = z.object({
  five_hour: ClaudeUsageWindowSchema.nullish(),
  seven_day: ClaudeUsageWindowSchema.nullish(),
  seven_day_opus: ClaudeUsageWindowSchema.nullish(),
  seven_day_omelette: ClaudeUsageWindowSchema.nullish(),
  // Deliberately permissive: an additive section must never regress the top-level
  // windows, so shape validation happens per entry rather than here.
  limits: z.array(z.unknown()).nullish(),
  extra_usage: z
    .object({
      is_enabled: z.boolean().optional(),
    })
    .nullish(),
});

type ClaudeCredentials = z.infer<typeof ClaudeCredentialsSchema>;
type ClaudeUsageResponse = z.infer<typeof ClaudeUsageResponseSchema>;
type ClaudeLimit = z.infer<typeof ClaudeLimitSchema>;

const SCOPED_WEEKLY_KIND = "weekly_scoped";

interface ClaudeCredentialRecord {
  oauth: { accessToken: string } & NonNullable<ClaudeCredentials["claudeAiOauth"]>;
}

interface ClaudeQuotaProviderOptions {
  logger: Logger;
  providerId?: string;
  displayName?: string;
  claudeHome?: string;
  /**
   * Keychain service name for a per-account-pool-entry item (see
   * `claudeConfigDirKeychainService`). When set, the darwin Keychain fallback reads only
   * this service, keyed by the OS username — it never falls back to the legacy
   * account-less `Claude Code-credentials` item, which belongs to a different account.
   * Leave unset for the daemon's own default Claude account.
   */
  keychainService?: string;
  claudeKeychainReader?: () => Promise<unknown | null>;
  claudeConfigDirKeychainReader?: (service: string) => Promise<unknown | null>;
  platform?: typeof process.platform;
  fetch?: ProviderApiFetch;
  now?: () => number;
}

function buildClaudePlan(
  subscriptionType: string | undefined,
  rateLimitTier: string | undefined,
): string | null {
  if (!subscriptionType) return null;
  const label = subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
  const tier = rateLimitTier?.split("_").pop();
  return tier ? `${label} ${tier}` : label;
}

/**
 * A weekly limit scoped to one model or one surface, normalized away from whichever
 * shape of the response described it.
 *
 * The API describes the same limit two ways during the migration: a legacy top-level
 * `seven_day_<model>` key, and an entry in `limits[]`. Everything downstream works on
 * this one representation so the two shapes are reconciled exactly once, in
 * `reconcileScopedLimits`, rather than at each place a window is built.
 */
interface ScopedLimit {
  dimension: "model" | "surface";
  /** The API's own identifier. Null on every response observed so far. */
  id: string | null;
  /** Display name, or the id when the API sends no display name. */
  name: string;
  usedPct: number | null;
  resetsAt: string | null;
}

// Windows that describe no particular model or surface.
const UNSCOPED_WINDOWS: ReadonlyArray<{
  field: "five_hour" | "seven_day";
  id: string;
  label: string;
}> = [
  { field: "five_hour", id: "five_hour", label: "Session" },
  { field: "seven_day", id: "weekly", label: "Weekly" },
];

// Scoped windows from before `limits[]` existed. Declaring the dimension here is what
// stops a *surface* named "Omelette" from being mistaken for the legacy Omelette *model*
// window: these keys are model-scoped by definition.
const LEGACY_SCOPED_WINDOWS: ReadonlyArray<{
  field: "seven_day_opus" | "seven_day_omelette";
  name: string;
}> = [
  { field: "seven_day_opus", name: "Opus" },
  { field: "seven_day_omelette", name: "Omelette" },
];

/** Fold a name down to the characters an id is allowed to carry. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Whether two descriptions denote the same limit. This is the single definition of
 * identity for scoped limits; nothing else may compare them, and in particular nothing
 * may compare display labels, which are presentation rather than identity.
 *
 * - Different dimensions are never the same limit, so a surface and a model sharing a
 *   name stay apart.
 * - When both sides carry the API's own id, that id decides, so `fable-pro` and
 *   `fable_pro` stay apart.
 * - Otherwise fall back to the normalized name, which is the only link available between
 *   a legacy key (never has an id) and its `limits[]` counterpart.
 */
function isSameLimit(a: ScopedLimit, b: ScopedLimit): boolean {
  if (a.dimension !== b.dimension) return false;
  if (a.id && b.id) return a.id === b.id;
  return normalizeName(a.name) === normalizeName(b.name);
}

/**
 * Merge the legacy and `limits[]` descriptions into one limit per identity.
 *
 * A `limits[]` entry wins on identity because that is the representation the API is
 * migrating towards, so a limit keeps the same window id whichever shape carried it.
 * Its values are nullable though, so each field falls back to the legacy twin instead of
 * discarding a number the response did contain.
 */
function reconcileScopedLimits(
  legacy: ScopedLimit[],
  fromLimitsArray: ScopedLimit[],
): ScopedLimit[] {
  const reconciled = [...legacy];
  for (const limit of fromLimitsArray) {
    const index = reconciled.findIndex((candidate) => isSameLimit(candidate, limit));
    if (index === -1) {
      reconciled.push(limit);
      continue;
    }
    const twin = reconciled[index];
    reconciled[index] = {
      ...limit,
      usedPct: limit.usedPct ?? twin?.usedPct ?? null,
      resetsAt: limit.resetsAt ?? twin?.resetsAt ?? null,
    };
  }
  return reconciled;
}

function scopedLimitFromLegacy(
  spec: (typeof LEGACY_SCOPED_WINDOWS)[number],
  window: z.infer<typeof ClaudeUsageWindowSchema>,
): ScopedLimit {
  return {
    dimension: "model",
    id: null,
    name: spec.name,
    usedPct: window.utilization,
    resetsAt: window.resets_at ?? null,
  };
}

/** The scope of a `limits[]` entry, or null when it names nothing renderable. */
function scopedLimitFromEntry(limit: ClaudeLimit): ScopedLimit | null {
  for (const dimension of ["model", "surface"] as const) {
    const entry = limit.scope?.[dimension];
    const id = entry?.id?.trim() || null;
    const name = entry?.display_name?.trim() || id;
    if (name) {
      return {
        dimension,
        id,
        name,
        usedPct: limit.percent ?? null,
        resetsAt: limit.resets_at ?? null,
      };
    }
  }
  return null;
}

// The client uses window ids as React keys, so they must be stable across refreshes and
// unique within a response. An API-supplied id is already an identifier and is used
// verbatim (ids elsewhere carry punctuation too, e.g. MiniMax's `interval_MiniMax-M2.7`);
// only a name fallback is normalized. Normalizing an id would collapse `fable-pro` and
// `fable_pro` into one window.
function scopedWindowId(limit: ScopedLimit): string {
  return `weekly_${limit.dimension}_${limit.id ?? normalizeName(limit.name)}`;
}

// Backstop for the one residual case identity cannot rule out: an entry whose verbatim id
// equals another entry's normalized name. Suffix rather than drop, because a missing bar
// is the bug this change exists to fix.
function uniqueWindowId(candidate: string, taken: Set<string>): string {
  if (!taken.has(candidate)) return candidate;
  for (let suffix = 2; ; suffix += 1) {
    const next = `${candidate}_${suffix}`;
    if (!taken.has(next)) return next;
  }
}

function legacyScopedLimits(resp: ClaudeUsageResponse): ScopedLimit[] {
  const limits: ScopedLimit[] = [];
  for (const spec of LEGACY_SCOPED_WINDOWS) {
    const window = resp[spec.field];
    if (window) limits.push(scopedLimitFromLegacy(spec, window));
  }
  return limits;
}

function unscopedWindows(resp: ClaudeUsageResponse): ProviderUsageWindow[] {
  const windows: ProviderUsageWindow[] = [];
  for (const spec of UNSCOPED_WINDOWS) {
    const window = resp[spec.field];
    if (!window) continue;
    windows.push(
      windowFromUsedPct({
        id: spec.id,
        label: spec.label,
        utilizationPct: window.utilization,
        resetsAt: window.resets_at ?? null,
        tone: toneFromUsedPct(window.utilization),
      }),
    );
  }
  return windows;
}

function scopedWindows(limits: ScopedLimit[]): ProviderUsageWindow[] {
  const taken = new Set<string>();
  return limits.map((limit) => {
    const id = uniqueWindowId(scopedWindowId(limit), taken);
    taken.add(id);
    // Emitted even at 0% and inactive: a zero bar answers "how much of this model have I
    // used", and the bar must not come and go between refreshes.
    return windowFromUsedPct({
      id,
      label: `Weekly \u00b7 ${limit.name}`,
      utilizationPct: limit.usedPct,
      resetsAt: limit.resetsAt,
      tone: toneFromUsedPct(limit.usedPct),
    });
  });
}

/**
 * A credential store that could not be read, as opposed to one that holds nothing: a `security`
 * call that timed out or met a locked Keychain, or a credentials file that does not parse. It says
 * nothing about whether the account is signed in, so the fetcher gives no sign-in reading for it.
 */
export class ClaudeCredentialsUnreadableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClaudeCredentialsUnreadableError";
  }
}

function asUnreadable(error: unknown, message: string): ClaudeCredentialsUnreadableError {
  return error instanceof ClaudeCredentialsUnreadableError
    ? error
    : new ClaudeCredentialsUnreadableError(message, { cause: error });
}

/** Resolves to the item's text; null only when the Keychain holds no such item. */
type ClaudeKeychainCommandRunner = (args: string[]) => Promise<string | null>;
type ExecSecurity = (args: string[]) => Promise<{ stdout: string }>;

// `security find-generic-password` exits 44 (errSecItemNotFound) when no item matches. That is the
// one failure that means "nothing stored"; a timeout or a locked Keychain is a read that failed.
const SECURITY_ITEM_NOT_FOUND = 44;
const ExecExitSchema = z.object({ code: z.number() });
const ErrnoSchema = z.object({ code: z.string() });

function execSecurity(args: string[]): Promise<{ stdout: string }> {
  return execFileAsync("security", args, { timeout: CLAUDE_KEYCHAIN_TIMEOUT_MS });
}

// Keep this in sync with Claude Code's Keychain account derivation.
const CLAUDE_KEYCHAIN_ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/;
const CLAUDE_KEYCHAIN_FALLBACK_ACCOUNT = "claude-code-user";

export function claudeKeychainAccount(
  user: string = process.env["USER"] || userInfo().username,
): string {
  return CLAUDE_KEYCHAIN_ACCOUNT_PATTERN.test(user) ? user : CLAUDE_KEYCHAIN_FALLBACK_ACCOUNT;
}

/** Runs `security`. Null when no item matches; throws ClaudeCredentialsUnreadableError otherwise. */
export async function runSecurityCommand(
  args: string[],
  exec: ExecSecurity = execSecurity,
): Promise<string | null> {
  try {
    const { stdout } = await exec(args);
    return stdout.trim() || null;
  } catch (error) {
    if (ExecExitSchema.safeParse(error).data?.code === SECURITY_ITEM_NOT_FOUND) return null;
    throw new ClaudeCredentialsUnreadableError("The Keychain could not be read", { cause: error });
  }
}

/** The item when it carries an access token, else null. Throws when it is not credentials. */
function parseClaudeKeychainRaw(raw: string): unknown | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ClaudeCredentialsUnreadableError("The Keychain item does not parse", {
      cause: error,
    });
  }
  const creds = ClaudeCredentialsSchema.safeParse(parsed);
  if (!creds.success) {
    throw new ClaudeCredentialsUnreadableError("The Keychain item is not Claude credentials", {
      cause: creds.error,
    });
  }
  return creds.data.claudeAiOauth?.accessToken ? parsed : null;
}

async function readKeychainItem(
  run: ClaudeKeychainCommandRunner,
  args: string[],
): Promise<unknown | null> {
  const raw = await run(args);
  return raw === null ? null : parseClaudeKeychainRaw(raw);
}

/**
 * Read Claude Code's account-specific Keychain item, then try the legacy lookup. Null when neither
 * holds credentials; throws ClaudeCredentialsUnreadableError when neither did and one failed.
 */
export async function readClaudeKeychainCredentials(
  run: ClaudeKeychainCommandRunner = runSecurityCommand,
  account: string = claudeKeychainAccount(),
): Promise<unknown | null> {
  const lookups = [
    ["find-generic-password", "-a", account, "-w", "-s", CLAUDE_KEYCHAIN_SERVICE],
    ["find-generic-password", "-w", "-s", CLAUDE_KEYCHAIN_SERVICE],
  ];

  let failure: unknown = null;
  for (const args of lookups) {
    try {
      const parsed = await readKeychainItem(run, args);
      if (parsed) return parsed;
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw asUnreadable(failure, "The Keychain could not be read");
  return null;
}

/**
 * The Keychain service name for a `CLAUDE_CONFIG_DIR` other than Claude Code's own
 * default — e.g. a second account used by an account-pool custom provider entry.
 *
 * Claude Code names these items `Claude Code-credentials-<hash>`, where `<hash>` is the
 * first 8 hex characters of the sha256 digest of the absolute config dir path (no
 * trailing slash). Verified empirically against a real Keychain item on 2026-09-10.
 */
function canonicalizeConfigDir(configDir: string): string {
  const expanded =
    configDir === "~" || configDir.startsWith("~/")
      ? join(homedir(), configDir.slice(1))
      : configDir;
  return resolve(expanded);
}

export function claudeConfigDirKeychainService(configDir: string): string {
  const hash = createHash("sha256")
    .update(canonicalizeConfigDir(configDir))
    .digest("hex")
    .slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${hash}`;
}

/**
 * Read a per-config-dir Keychain item (see `claudeConfigDirKeychainService`). Unlike
 * `readClaudeKeychainCredentials`, this never falls back to the account-less legacy
 * service name — that item belongs to a different account.
 */
export async function readClaudeConfigDirKeychainCredentials(
  service: string,
  run: ClaudeKeychainCommandRunner = runSecurityCommand,
  account: string = claudeKeychainAccount(),
): Promise<unknown | null> {
  return readKeychainItem(run, ["find-generic-password", "-a", account, "-w", "-s", service]);
}

export class ClaudeQuotaProvider implements ProviderUsageFetcher {
  readonly providerId: string;
  readonly displayName: string;

  private readonly logger: Logger;
  private readonly claudeHome: string;
  private readonly keychainService: string | undefined;
  private readonly readKeychainCredentials: () => Promise<unknown | null>;
  private readonly readConfigDirKeychainCredentials: (service: string) => Promise<unknown | null>;
  private readonly platform: typeof process.platform;
  private readonly fetchApi: ProviderApiFetch;
  private readonly now: () => number;
  private authReading: AccountAuthReading | null = null;

  constructor(options: ClaudeQuotaProviderOptions) {
    this.providerId = options.providerId ?? "claude";
    this.displayName = options.displayName ?? "Claude";
    this.logger = options.logger.child({ module: "claude-quota-provider" });
    this.claudeHome =
      options.claudeHome || process.env["CLAUDE_HOME"] || join(homedir(), ".claude");
    this.keychainService = options.keychainService;
    this.readKeychainCredentials = options.claudeKeychainReader ?? readClaudeKeychainCredentials;
    this.readConfigDirKeychainCredentials =
      options.claudeConfigDirKeychainReader ?? readClaudeConfigDirKeychainCredentials;
    this.platform = options.platform ?? process.platform;
    this.fetchApi = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /**
   * The auth reading from the most recent `fetchUsage()` call, for the account-auth sweep
   * (account-auth-health.ts). Read right after `fetchUsage()` on the same instance — it is not
   * cached independently of the usage row it was read alongside.
   */
  describeAuthReading(): AccountAuthReading | null {
    return this.authReading;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    let credentials: ClaudeCredentialRecord | null;
    try {
      credentials = await this.readCredentials();
    } catch (error) {
      if (!(error instanceof ClaudeCredentialsUnreadableError)) throw error;
      // A read that failed is no answer about the sign-in, so it must never read as signed out.
      this.logger.warn(
        { err: error },
        "Claude credentials unreadable; no sign-in reading this time",
      );
      this.authReading = null;
      return unavailableUsage(this);
    }
    if (!credentials) {
      // `.claude.json` keeps naming an account after its OAuth session can no longer refresh, so
      // its presence — not "signed-in" — is what makes a missing credential worth a reading. A config dir nothing ever signed into reports no reading at
      // all: there is no account there to be signed out of.
      this.authReading =
        readClaudeAccountAuth(this.claudeHome).state === "signed-in" ? "credentials_missing" : null;
      return unavailableUsage(this);
    }

    const { oauth } = credentials;
    const plan = buildClaudePlan(oauth.subscriptionType, oauth.rateLimitTier);
    const resp = await this.callClaudeApi(oauth.accessToken);

    if (resp === "FORBIDDEN") {
      // A 403 refuses the request, not necessarily the session: a scope or plan problem looks
      // the same. The confirming probe decides.
      this.authReading = "rejected_forbidden";
      return unavailableUsage(this);
    }
    if (resp === "UNAUTHORIZED") {
      // Read-only on credentials; the Claude CLI owns refresh. See docs/providers.md. An
      // expiresAt this file cannot parse is treated as expired: that routes a 401 through the
      // confirming probe rather than straight to signed_out on an assumption that may be wrong.
      const expired = typeof oauth.expiresAt !== "number" || oauth.expiresAt <= this.now();
      this.authReading = expired ? "rejected_expired" : "rejected_unexpired";
      return unavailableUsage(this);
    }

    this.authReading = "ok";
    const scoped = reconcileScopedLimits(
      legacyScopedLimits(resp),
      this.scopedLimitsFromResponse(resp.limits),
    );
    const windows = [...unscopedWindows(resp), ...scopedWindows(scoped)];

    if (windows.length === 0) {
      // The response parsed but described nothing. That silence is how the previous
      // shape change went unnoticed, so make it greppable. `warn` and not `debug`
      // because file logging defaults to `info`.
      this.logger.warn("Claude usage response parsed but produced no windows");
    }

    const details: ProviderUsageDetail[] = [];
    const extraUsageEnabled = resp.extra_usage?.is_enabled;
    if (extraUsageEnabled !== undefined) {
      details.push({
        id: "extra_usage",
        label: "Extra usage",
        value: extraUsageEnabled ? "Enabled" : "Disabled",
      });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: plan,
      windows,
      balances: [],
      details,
      error: null,
    };
  }

  /**
   * Scoped limits carried by `limits[]`.
   *
   * Entries are validated one at a time so a single malformed or newly-shaped entry
   * cannot fail the whole response and take the windows that already parsed with it.
   */
  private scopedLimitsFromResponse(limits: ClaudeUsageResponse["limits"]): ScopedLimit[] {
    if (!limits) return [];

    const parsed: ScopedLimit[] = [];
    for (const entry of limits) {
      const result = ClaudeLimitSchema.safeParse(entry);
      if (!result.success) {
        this.logger.warn({ err: result.error }, "Skipping unparseable Claude usage limit entry");
        continue;
      }
      if (result.data.kind !== SCOPED_WEEKLY_KIND) continue;

      const limit = scopedLimitFromEntry(result.data);
      if (!limit) {
        this.logger.warn("Skipping scoped Claude usage limit with no resolvable scope name");
        continue;
      }
      parsed.push(limit);
    }
    return parsed;
  }

  /**
   * The credentials file, then (on macOS) the Keychain. Null when neither holds credentials;
   * throws ClaudeCredentialsUnreadableError when neither did and one could not be read.
   */
  private async readCredentials(): Promise<ClaudeCredentialRecord | null> {
    let fileFailure: ClaudeCredentialsUnreadableError | null = null;
    try {
      const fromFile = await this.readCredentialFile(join(this.claudeHome, ".credentials.json"));
      if (fromFile) return fromFile;
    } catch (error) {
      if (!(error instanceof ClaudeCredentialsUnreadableError)) throw error;
      fileFailure = error;
    }
    const fromKeychain = this.platform === "darwin" ? await this.readKeychainCredential() : null;
    if (fromKeychain) return fromKeychain;
    if (fileFailure) throw fileFailure;
    return null;
  }

  /** Null when the file does not exist or carries no access token. */
  private async readCredentialFile(path: string): Promise<ClaudeCredentialRecord | null> {
    let text: string;
    try {
      text = await fs.readFile(path, "utf8");
    } catch (error) {
      if (ErrnoSchema.safeParse(error).data?.code === "ENOENT") return null;
      throw new ClaudeCredentialsUnreadableError(`${path} could not be read`, { cause: error });
    }
    try {
      return this.toCredentialRecord(ClaudeCredentialsSchema.parse(JSON.parse(text)));
    } catch (error) {
      throw new ClaudeCredentialsUnreadableError(`${path} does not parse`, { cause: error });
    }
  }

  private async readKeychainCredential(): Promise<ClaudeCredentialRecord | null> {
    let raw: unknown;
    try {
      raw = this.keychainService
        ? await this.readConfigDirKeychainCredentials(this.keychainService)
        : await this.readKeychainCredentials();
    } catch (error) {
      throw asUnreadable(error, "The Keychain could not be read");
    }
    if (raw === null && this.keychainService) {
      this.logger.warn(
        { keychainService: this.keychainService },
        "No Keychain item found for derived Claude account entry",
      );
    }
    const parsed = ClaudeCredentialsSchema.safeParse(raw);
    return parsed.success ? this.toCredentialRecord(parsed.data) : null;
  }

  private toCredentialRecord(
    credentials: z.infer<typeof ClaudeCredentialsSchema>,
  ): ClaudeCredentialRecord | null {
    const oauth = credentials.claudeAiOauth;
    return oauth?.accessToken ? { oauth: { ...oauth, accessToken: oauth.accessToken } } : null;
  }

  private async callClaudeApi(
    token: string,
  ): Promise<ClaudeUsageResponse | "UNAUTHORIZED" | "FORBIDDEN"> {
    const res = await fetchProviderApi(this.fetchApi, "https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "anthropic-beta": CLAUDE_OAUTH_BETA,
      },
    });
    if (res.status === 401) return "UNAUTHORIZED";
    if (res.status === 403) return "FORBIDDEN";
    if (!res.ok) throw new Error(`Claude usage API returned ${res.status}`);
    return ClaudeUsageResponseSchema.parse(await res.json());
  }
}
