import { WINDOW_ACCOUNT, WINDOW_FIVE_HOUR, WINDOW_SEVEN_DAY, detectModelFamily, weeklyModelWindow } from "./windows";

export interface ClassifyResult {
  isLimit: boolean;
  resetsAt?: Date;
  window?: string;
  /** True when this is an auth/credential failure rather than a usage cap — see AUTH_FAILURE_PATTERN. */
  isAuthFailure?: boolean;
  /**
   * True when only the CLI's per-window refusal text recognised this ("You've hit your session
   * limit"), not REFUSAL_LIMIT_PATTERN. The cap ranks the account last but never counts toward
   * refusing a spawn; see health.ts's isExhaustedFor.
   */
  placementOnly?: boolean;
}

/**
 * The one pattern recognizing limit-shaped failure text across this plugin. Every reactive
 * classification decision flows through here so there's a single place to tune it.
 *
 * A copy of the daemon's `LIMIT_TEXT_PATTERN`
 * (packages/server/src/server/agent/account-failover-detector.ts). The plugin compiles on its own
 * and cannot import daemon code, and the two must agree: the daemon moves an agent off an account
 * whose refusal this plugin didn't recognise, and the plugin keeps placing new ones there.
 * classify.test.ts fails when they drift. `hit your <words> limit` is what catches the CLI's
 * per-window messages ("You've hit your session limit · resets 2:50pm"); none of them contains
 * "hit your limit".
 */
export const LIMIT_PATTERN =
  /hit your (?:[\w-]+ ){0,3}limit|spend limit|session limit|usage limit|rate limit|quota|credits/i;

/**
 * The Claude CLI's per-window refusal, `You've hit your ${name}${suffix}`, with the window's name
 * captured. The names, from the CLI binary's window map: five_hour "session", seven_day
 * "weekly", seven_day_opus "Opus", seven_day_sonnet "Sonnet", seven_day_overage_included
 * "Fable 5", overage "usage credit".
 */
const CLI_WINDOW_LIMIT_PATTERN = /hit your ((?:[\w-]+ ){1,3})limit/i;

/**
 * The limit text a cap may refuse a spawn on: LIMIT_PATTERN as it stood before it learned the
 * CLI's per-window messages. Learning them must not refuse more creates. A refused create is
 * lost, while one placed on a refusing account fails its first turn and account failover moves it
 * with its prompt intact; whether the pool should refuse at all is still an open question, so the
 * refusal stays as wide as it was until that is decided.
 */
const REFUSAL_LIMIT_PATTERN = /hit your limit|rate limit|quota|credits|spend limit|usage limit/i;

/**
 * Auth/credential failure text — an account in this state cannot serve ANY
 * request (not just one window), so it must be treated at least as
 * severely as a usage cap, but classified separately since it carries no
 * reset time and must not auto-heal on trust alone (see health.ts).
 *
 * These are the exact strings the Claude CLI binary emits for each case,
 * verified with `strings` against the compiled
 * `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` (the binary Paseo's
 * daemon actually spawns for a claude-family agent) rather than assumed:
 *   - "Not logged in · Please run /login"   (no OAuth session / logged out)
 *   - "Invalid API key · Fix external API key"
 *   - "Invalid auth token · Fix external auth token"
 *   - "OAuth login failed: "
 *   - "Cloud authentication failed"
 * Deliberately NOT matching bare "401"/"403": those codes only showed up
 * internally (admin-API tool errors), never in the CLI's user-facing
 * turn-failure text, and matching them bare would risk false-positiving on
 * unrelated numbers in an error message.
 */
const AUTH_FAILURE_PATTERN =
  /not logged in|please run\s*\/login|invalid api key|invalid auth token|oauth login failed|cloud authentication failed/i;

const ISO_TIMESTAMP_PATTERN =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/;
const CLOCK_TIME_PATTERN = /resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
/**
 * A reset more than a day out, as the CLI prints it: "resets Sep 25 at 11pm", with ", 2027" after
 * the day when the year isn't this one. That is Bun's ICU; Node's spells the same options
 * "Sep 25, 11pm", so both separators are read.
 */
const DATE_TIME_PATTERN =
  /resets?\s+([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?(?:,|\s+at)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function hour24(hour12: string, meridiem: string): number {
  return (Number(hour12) % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
}

const SESSION_WINDOW_PATTERN = /\b5[\s-]?hour\b|\bfive[\s-]?hour\b|\bsession\b/i;
const WEEKLY_WINDOW_PATTERN = /\bweek(?:ly)?\b|\b7[\s-]?day\b|\bseven[\s-]?day\b/i;

function parseResetsAt(message: string, now: Date): Date | undefined {
  const isoMatch = message.match(ISO_TIMESTAMP_PATTERN);
  if (isoMatch) {
    const parsed = new Date(isoMatch[0]);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const dateMatch = message.match(DATE_TIME_PATTERN);
  const month = dateMatch ? MONTHS.indexOf(dateMatch[1].toLowerCase()) : -1;
  if (dateMatch && month >= 0) {
    // The CLI names the year only when it isn't the current one.
    const year = dateMatch[3] ? Number(dateMatch[3]) : now.getFullYear();
    const minute = dateMatch[5] ? Number(dateMatch[5]) : 0;
    return new Date(year, month, Number(dateMatch[2]), hour24(dateMatch[4], dateMatch[6]), minute, 0, 0);
  }

  const clockMatch = message.match(CLOCK_TIME_PATTERN);
  if (clockMatch) {
    const minute = clockMatch[2] ? Number(clockMatch[2]) : 0;

    const candidate = new Date(now);
    candidate.setHours(hour24(clockMatch[1], clockMatch[3]), minute, 0, 0);
    if (candidate.getTime() <= now.getTime()) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  }

  return undefined;
}

/**
 * The window a CLI refusal names, when it names one. A model-scoped name maps to that model's
 * weekly window and never to the whole account: an Opus cap read as an account cap would stop
 * Sonnet work too, and count toward refusing every spawn.
 */
function cliLimitWindow(message: string): string | undefined {
  const name = CLI_WINDOW_LIMIT_PATTERN.exec(message)?.[1]?.trim().toLowerCase();
  if (!name) {
    return undefined;
  }
  if (name === "session") {
    return WINDOW_FIVE_HOUR;
  }
  if (name === "weekly") {
    return WINDOW_SEVEN_DAY;
  }
  if (name === "usage credit") {
    return WINDOW_ACCOUNT;
  }
  const family = detectModelFamily(name);
  return family ? weeklyModelWindow(family) : undefined;
}

function detectWindow(message: string): string | undefined {
  const named = cliLimitWindow(message);
  if (named) {
    return named;
  }
  if (SESSION_WINDOW_PATTERN.test(message)) {
    return WINDOW_FIVE_HOUR;
  }
  const family = detectModelFamily(message);
  if (family && WEEKLY_WINDOW_PATTERN.test(message)) {
    return weeklyModelWindow(family);
  }
  if (WEEKLY_WINDOW_PATTERN.test(message)) {
    return WINDOW_SEVEN_DAY;
  }
  return undefined;
}

/**
 * Classifies a turn-failure message as limit-shaped or not, and extracts
 * whatever window/reset-time attribution the text offers. `now` is
 * injectable so relative clock-time parsing ("resets 3am") is
 * deterministic under fake timers.
 */
export function classify(message: string, now: Date = new Date()): ClassifyResult {
  // Checked first and returned early: an auth failure carries no reset time
  // and no per-window attribution — it takes down the whole account, not one
  // window — so window/resetsAt detection (tuned for cap text) doesn't apply.
  if (AUTH_FAILURE_PATTERN.test(message)) {
    return { isLimit: true, isAuthFailure: true };
  }

  const isLimit = LIMIT_PATTERN.test(message);
  if (!isLimit) {
    return { isLimit };
  }

  return {
    isLimit,
    resetsAt: parseResetsAt(message, now),
    window: detectWindow(message),
    ...(REFUSAL_LIMIT_PATTERN.test(message) ? {} : { placementOnly: true }),
  };
}
