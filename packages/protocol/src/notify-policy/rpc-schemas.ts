import { z } from "zod";
import {
  NotifyAvailabilitySchema,
  NotifyLedgerEntrySchema,
  NotifyLevelSchema,
  NotifyPolicySettingsSchema,
} from "./types.js";

export const NotificationsPolicyGetRequestSchema = z.object({
  type: z.literal("notifications.policy.get.request"),
  requestId: z.string(),
});

/** Every field is optional so one call can change the dials, the availability, or both. */
export const NotificationsPolicySetRequestSchema = z.object({
  type: z.literal("notifications.policy.set.request"),
  requestId: z.string(),
  minPostLevel: NotifyLevelSchema.optional(),
  minInterruptLevel: NotifyLevelSchema.optional(),
  digestIntervalMinutes: z.number().int().positive().optional(),
  availability: NotifyAvailabilitySchema.optional(),
});

export const NotificationsLedgerListRequestSchema = z.object({
  type: z.literal("notifications.ledger.list.request"),
  requestId: z.string(),
  /** Only notifications that never reached the phone. */
  unreachedOnly: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
});

const NotificationsPolicyPayloadSchema = z.object({
  requestId: z.string(),
  settings: NotifyPolicySettingsSchema,
  /** The mode in force right now: `settings.availability` unless its `until` has passed. */
  effectiveAvailability: NotifyAvailabilitySchema,
  heldCount: z.number().int(),
  unreachedCount: z.number().int(),
});

export const NotificationsPolicyGetResponseSchema = z.object({
  type: z.literal("notifications.policy.get.response"),
  payload: NotificationsPolicyPayloadSchema,
});

export const NotificationsPolicySetResponseSchema = z.object({
  type: z.literal("notifications.policy.set.response"),
  payload: NotificationsPolicyPayloadSchema,
});

export const NotificationsLedgerListResponseSchema = z.object({
  type: z.literal("notifications.ledger.list.response"),
  payload: z.object({
    requestId: z.string(),
    entries: z.array(NotifyLedgerEntrySchema),
    unreachedCount: z.number().int(),
  }),
});

export type NotificationsPolicyPayload = z.infer<typeof NotificationsPolicyPayloadSchema>;
