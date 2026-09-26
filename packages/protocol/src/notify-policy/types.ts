import { z } from "zod";

/**
 * How urgent a push is. Every push caller declares one; the daemon's notify policy
 * (server notify-policy/) decides from it what actually reaches the phone.
 *
 * - `record`: written to the delivery ledger and never pushed.
 * - `notice`: worth knowing, not worth interrupting for. Held and sent as one digest.
 * - `alert`: needs a person soon. Pushed immediately.
 * - `urgent`: something is about to be lost. Pushed immediately and gets through focus.
 */
export const NOTIFY_LEVELS = ["record", "notice", "alert", "urgent"] as const;
export const NotifyLevelSchema = z.enum(NOTIFY_LEVELS);
export type NotifyLevel = z.infer<typeof NotifyLevelSchema>;

/**
 * What the human said about their own availability. Each mode has a concrete delivery effect,
 * so this is not a label:
 * - `available`: the dials decide.
 * - `focus`: nothing makes a sound short of `urgent`; notices digest every two hours.
 * - `away`: alerts still interrupt (the phone is the only channel); notices wait until the
 *   mode ends.
 * - `off`: nothing interrupts, urgent included. Everything is still delivered, silently, and
 *   notices wait until the mode ends.
 */
export const NOTIFY_AVAILABILITY_MODES = ["available", "focus", "away", "off"] as const;
export const NotifyAvailabilityModeSchema = z.enum(NOTIFY_AVAILABILITY_MODES);
export type NotifyAvailabilityMode = z.infer<typeof NotifyAvailabilityModeSchema>;

export const NotifyAvailabilitySchema = z.object({
  mode: NotifyAvailabilityModeSchema,
  /** ISO time the mode ends and the daemon reverts to `available`. Absent means until changed. */
  until: z.string().nullable().optional(),
});
export type NotifyAvailability = z.infer<typeof NotifyAvailabilitySchema>;

export const NotifyPolicySettingsSchema = z.object({
  /** Lowest level that is pushed at all. Below it, a notification is only written to the ledger. */
  minPostLevel: NotifyLevelSchema,
  /** Lowest level that interrupts immediately. Between the two dials, notifications digest. */
  minInterruptLevel: NotifyLevelSchema,
  /** How long a notice waits before the digest goes out while available. */
  digestIntervalMinutes: z.number().int().positive(),
  availability: NotifyAvailabilitySchema,
});
export type NotifyPolicySettings = z.infer<typeof NotifyPolicySettingsSchema>;

/** What the policy decided to do with one notification. */
export const NOTIFY_OUTCOMES = ["interrupt", "notify", "digest", "log", "suppressed"] as const;
export const NotifyOutcomeSchema = z.enum(NOTIFY_OUTCOMES);
export type NotifyOutcome = z.infer<typeof NotifyOutcomeSchema>;

/**
 * Where a notification stands. `delivered` means the push provider accepted it for the device,
 * not that anyone read it.
 * - `recorded`: nothing was meant to be pushed (`log`, `suppressed`).
 * - `held`: waiting in the digest buffer.
 * - `digested`: rolled into a digest; the digest entry carries the delivery state.
 * - `sent`: handed to the push provider, receipt not back yet.
 * - `delivered`: the provider's receipt was ok.
 * - `failed`: the provider refused it.
 * - `no-device`: no phone was registered to receive it.
 */
export const NOTIFY_DELIVERY_STATES = [
  "recorded",
  "held",
  "digested",
  "sent",
  "delivered",
  "failed",
  "no-device",
] as const;
export const NotifyDeliveryStateSchema = z.enum(NOTIFY_DELIVERY_STATES);
export type NotifyDeliveryState = z.infer<typeof NotifyDeliveryStateSchema>;

export const NotifyLedgerEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  level: NotifyLevelSchema,
  /** False when the caller sent no level and the policy defaulted it. */
  levelDeclared: z.boolean(),
  reason: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  agentId: z.string().nullable(),
  outcome: NotifyOutcomeSchema,
  state: NotifyDeliveryStateSchema,
  /** Times the same notification was folded into this entry instead of being sent again. */
  repeatCount: z.number().int(),
  /** The digest entry this one was rolled into. */
  digestId: z.string().nullable(),
  /** On a digest entry, the notifications it carried. */
  memberIds: z.array(z.string()),
  error: z.string().nullable(),
  settledAt: z.string().nullable(),
});
export type NotifyLedgerEntry = z.infer<typeof NotifyLedgerEntrySchema>;
