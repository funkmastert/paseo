import type { NotifyOutcome, NotifyPolicySettings } from "@getpaseo/protocol/notify-policy/types";

import type { EffectiveAvailability } from "./availability.js";
import { levelAtLeast, type NotifyLevel } from "./levels.js";

export interface DeliveryDecision {
  outcome: Exclude<NotifyOutcome, "suppressed">;
  /** The interruption level on the push itself: urgent asks iOS for time-sensitive delivery. */
  timeSensitive: boolean;
}

/**
 * One notification, one outcome.
 *
 * - below `minPostLevel`: `log`. The ledger keeps it; nothing is pushed.
 * - at or above `minInterruptLevel`: `interrupt`. Between the two dials: `digest`.
 * - then availability modulates an interrupt: focus quiets everything but urgent, and off quiets
 *   even urgent. A quieted interrupt is `notify`: still pushed now, without a sound.
 *
 * Availability never drops a notification. The two dials are the only way to stop a push.
 */
export function decideDelivery(input: {
  level: NotifyLevel;
  settings: NotifyPolicySettings;
  availability: EffectiveAvailability;
}): DeliveryDecision {
  const { level, settings, availability } = input;
  if (!levelAtLeast(level, settings.minPostLevel)) {
    return { outcome: "log", timeSensitive: false };
  }
  if (!levelAtLeast(level, settings.minInterruptLevel)) {
    return { outcome: "digest", timeSensitive: false };
  }
  const quieted =
    availability.mode === "off" || (availability.mode === "focus" && level !== "urgent");
  return quieted
    ? { outcome: "notify", timeSensitive: false }
    : { outcome: "interrupt", timeSensitive: level === "urgent" };
}
