import { WINDOW_FIVE_HOUR, WINDOW_SEVEN_DAY, detectModelFamily, weeklyModelWindow } from "./windows";

export interface ClassifyResult {
  isLimit: boolean;
  resetsAt?: Date;
  window?: string;
}

/**
 * The one pattern recognizing limit-shaped failure text across this
 * plugin. Every reactive classification decision flows through here so
 * there's a single place to tune it.
 */
const LIMIT_PATTERN = /hit your limit|rate limit|quota|credits/i;

const ISO_TIMESTAMP_PATTERN =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/;
const CLOCK_TIME_PATTERN = /resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;

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

  const clockMatch = message.match(CLOCK_TIME_PATTERN);
  if (clockMatch) {
    const hour12 = Number(clockMatch[1]);
    const minute = clockMatch[2] ? Number(clockMatch[2]) : 0;
    const isPm = clockMatch[3].toLowerCase() === "pm";
    const hour24 = (hour12 % 12) + (isPm ? 12 : 0);

    const candidate = new Date(now);
    candidate.setHours(hour24, minute, 0, 0);
    if (candidate.getTime() <= now.getTime()) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  }

  return undefined;
}

function detectWindow(message: string): string | undefined {
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
  const isLimit = LIMIT_PATTERN.test(message);
  if (!isLimit) {
    return { isLimit };
  }

  return {
    isLimit,
    resetsAt: parseResetsAt(message, now),
    window: detectWindow(message),
  };
}
