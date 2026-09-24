import type {
  NotifyAvailability,
  NotifyAvailabilityMode,
  NotifyPolicySettings,
} from "@getpaseo/protocol/notify-policy/types";

/** Where the interrupt dial sits, in the words the settings row uses. */
export type InterruptChoice = "urgent" | "alert" | "notice";
export type NoticesChoice = "digest" | "off";
export type DurationChoice = "oneHour" | "fourHours" | "untilChanged";
export type DigestIntervalChoice = "15" | "30" | "60" | "180";

export const AVAILABILITY_MODES: readonly NotifyAvailabilityMode[] = [
  "available",
  "focus",
  "away",
  "off",
];
export const INTERRUPT_CHOICES: readonly InterruptChoice[] = ["urgent", "alert", "notice"];
export const NOTICES_CHOICES: readonly NoticesChoice[] = ["digest", "off"];
export const DURATION_CHOICES: readonly DurationChoice[] = ["oneHour", "fourHours", "untilChanged"];
export const DIGEST_INTERVAL_CHOICES: readonly DigestIntervalChoice[] = ["15", "30", "60", "180"];

const HOUR_MS = 60 * 60 * 1000;

export function interruptChoice(settings: NotifyPolicySettings): InterruptChoice {
  if (settings.minInterruptLevel === "urgent") return "urgent";
  if (settings.minInterruptLevel === "alert") return "alert";
  return "notice";
}

export function interruptPatch(
  choice: InterruptChoice,
): Pick<NotifyPolicySettings, "minInterruptLevel"> {
  return { minInterruptLevel: choice };
}

/** Notices are digested unless the post dial has been raised above them. */
export function noticesChoice(settings: NotifyPolicySettings): NoticesChoice {
  return settings.minPostLevel === "record" || settings.minPostLevel === "notice"
    ? "digest"
    : "off";
}

export function noticesPatch(choice: NoticesChoice): Pick<NotifyPolicySettings, "minPostLevel"> {
  return { minPostLevel: choice === "digest" ? "notice" : "alert" };
}

export function digestIntervalChoice(settings: NotifyPolicySettings): DigestIntervalChoice {
  const minutes = settings.digestIntervalMinutes;
  if (minutes <= 15) return "15";
  if (minutes <= 30) return "30";
  if (minutes <= 60) return "60";
  return "180";
}

export function untilForDuration(choice: DurationChoice, nowMs: number): string | null {
  if (choice === "untilChanged") return null;
  return new Date(nowMs + (choice === "oneHour" ? HOUR_MS : 4 * HOUR_MS)).toISOString();
}

/** The duration segment that best describes an end time already set on the daemon. */
export function durationChoiceForAvailability(
  availability: NotifyAvailability,
  nowMs: number,
): DurationChoice {
  if (!availability.until) return "untilChanged";
  const remaining = Date.parse(availability.until) - nowMs;
  return remaining <= 1.5 * HOUR_MS ? "oneHour" : "fourHours";
}

/** What to send when the person picks a mode: `available` has no end, the others get the chosen one. */
export function availabilityForMode(
  mode: NotifyAvailabilityMode,
  duration: DurationChoice,
  nowMs: number,
): NotifyAvailability {
  if (mode === "available") return { mode, until: null };
  return { mode, until: untilForDuration(duration, nowMs) };
}
