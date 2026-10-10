import type {
  NotifyAvailabilityMode,
  NotifyPolicySettings,
} from "@getpaseo/protocol/notify-policy/types";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** How long notices wait in focus mode. Longer than the dial so heads-down time stays unbroken. */
export const FOCUS_DIGEST_MS = 2 * HOUR_MS;
/** How long notices wait while away or off before the digest goes anyway. */
export const HOLD_DIGEST_CAP_MS = 8 * HOUR_MS;

export interface EffectiveAvailability {
  mode: NotifyAvailabilityMode;
  until: string | null;
}

/** The mode in force at `nowMs`. A mode whose `until` has passed no longer applies. */
export function resolveAvailability(
  settings: NotifyPolicySettings,
  nowMs: number,
): EffectiveAvailability {
  const { mode, until } = settings.availability;
  if (mode === "available") return { mode, until: null };
  if (until) {
    const untilMs = Date.parse(until);
    if (Number.isFinite(untilMs) && untilMs <= nowMs) return { mode: "available", until: null };
  }
  return { mode, until: until ?? null };
}

/** How long the oldest held notice may wait before the digest is due, in the current mode. */
export function digestWindowMs(
  settings: NotifyPolicySettings,
  availability: EffectiveAvailability,
): number {
  switch (availability.mode) {
    case "available":
      return settings.digestIntervalMinutes * MINUTE_MS;
    case "focus":
      return FOCUS_DIGEST_MS;
    case "away":
    case "off":
      return HOLD_DIGEST_CAP_MS;
  }
}
