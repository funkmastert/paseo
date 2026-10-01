import { z } from "zod";
import {
  WorkItemClosureSchema,
  WorkItemListFilterSchema,
  WorkItemSchema,
  WorkItemStateSchema,
  WorkItemTransitionSchema,
} from "./queue-schemas.js";
import { StreamEntrySchema, StreamListFilterSchema } from "./stream-schemas.js";

// Work queue and fleet stream RPCs. COMPAT(coordinationQueue): added in v0.8.x, remove gate after
// 2027-09-30. Gated on `server_info.features.coordinationQueue`; a daemon with coordination off
// leaves the flag unset and answers each request with `errorCode: "disabled"`. See
// docs/work-queue.md.

// `actor` is who is acting: an agent id or `human`. The daemon defaults it to `human`.

export const CoordinationQueueCreateRequestSchema = z.object({
  type: z.literal("coordination.queue.create.request"),
  requestId: z.string(),
  // Caller-minted id; a repeat with the same content returns the existing item.
  id: z.string().optional(),
  title: z.string(),
  body: z.string().optional(),
  // An agent id or `human`.
  owner: z.string(),
  tags: z.array(z.string()).optional(),
  actor: z.string().optional(),
});

export const CoordinationQueueClaimRequestSchema = z.object({
  type: z.literal("coordination.queue.claim.request"),
  requestId: z.string(),
  id: z.string(),
  actor: z.string().optional(),
  note: z.string().optional(),
});

export const CoordinationQueueTransitionRequestSchema = z.object({
  type: z.literal("coordination.queue.transition.request"),
  requestId: z.string(),
  id: z.string(),
  to: WorkItemStateSchema,
  closure: WorkItemClosureSchema.optional(),
  note: z.string().optional(),
  actor: z.string().optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
});

export const CoordinationQueueUpdateRequestSchema = z.object({
  type: z.literal("coordination.queue.update.request"),
  requestId: z.string(),
  id: z.string(),
  title: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
});

export const CoordinationQueueHandoffRequestSchema = z.object({
  type: z.literal("coordination.queue.handoff.request"),
  requestId: z.string(),
  id: z.string(),
  // The successor's owner: an agent id or `human`.
  to: z.string(),
  actor: z.string().optional(),
  note: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
});

export const CoordinationQueueListRequestSchema = z.object({
  type: z.literal("coordination.queue.list.request"),
  requestId: z.string(),
  filter: WorkItemListFilterSchema.optional(),
});

export const CoordinationQueueShowRequestSchema = z.object({
  type: z.literal("coordination.queue.show.request"),
  requestId: z.string(),
  id: z.string(),
});

export const CoordinationStreamListRequestSchema = z.object({
  type: z.literal("coordination.stream.list.request"),
  requestId: z.string(),
  filter: StreamListFilterSchema.optional(),
});

// "disabled"  - coordination is off on this daemon, or its store failed to open
// "not_found" - no item with that id
// "conflict"  - a repeat create with different content, or a stale expectedRevision
// "invalid"   - the request broke the state machine or the closure contract; `error` says what
//               to send instead
// "internal"  - anything else
// A plain string so a daemon can add a code without breaking an older client.
const CoordinationErrorFields = {
  error: z.string().optional(),
  errorCode: z.string().optional(),
};

// Shared by create, claim, transition, update and handoff. `changed` is false when the call was
// a no-op repeat (an idempotent create, a re-claim by the owner).
const CoordinationQueueMutationPayloadSchema = z.object({
  requestId: z.string(),
  item: WorkItemSchema.optional(),
  // Handoff only: `item` is the closed source, `successor` the new open item.
  successor: WorkItemSchema.optional(),
  changed: z.boolean().optional(),
  ...CoordinationErrorFields,
});

export const CoordinationQueueCreateResponseSchema = z.object({
  type: z.literal("coordination.queue.create.response"),
  payload: CoordinationQueueMutationPayloadSchema,
});

export const CoordinationQueueClaimResponseSchema = z.object({
  type: z.literal("coordination.queue.claim.response"),
  payload: CoordinationQueueMutationPayloadSchema,
});

export const CoordinationQueueTransitionResponseSchema = z.object({
  type: z.literal("coordination.queue.transition.response"),
  payload: CoordinationQueueMutationPayloadSchema,
});

export const CoordinationQueueUpdateResponseSchema = z.object({
  type: z.literal("coordination.queue.update.response"),
  payload: CoordinationQueueMutationPayloadSchema,
});

export const CoordinationQueueHandoffResponseSchema = z.object({
  type: z.literal("coordination.queue.handoff.response"),
  payload: CoordinationQueueMutationPayloadSchema,
});

export const CoordinationQueueListResponseSchema = z.object({
  type: z.literal("coordination.queue.list.response"),
  payload: z.object({
    requestId: z.string(),
    items: z.array(WorkItemSchema).optional(),
    nextCursor: z.string().optional(),
    ...CoordinationErrorFields,
  }),
});

export const CoordinationQueueShowResponseSchema = z.object({
  type: z.literal("coordination.queue.show.response"),
  payload: z.object({
    requestId: z.string(),
    item: WorkItemSchema.optional(),
    transitions: z.array(WorkItemTransitionSchema).optional(),
    ...CoordinationErrorFields,
  }),
});

export const CoordinationStreamListResponseSchema = z.object({
  type: z.literal("coordination.stream.list.response"),
  payload: z.object({
    requestId: z.string(),
    entries: z.array(StreamEntrySchema).optional(),
    nextCursor: z.string().optional(),
    ...CoordinationErrorFields,
  }),
});

export type CoordinationQueueMutationPayload = z.infer<
  typeof CoordinationQueueMutationPayloadSchema
>;
export type CoordinationQueueListPayload = z.infer<
  typeof CoordinationQueueListResponseSchema
>["payload"];
export type CoordinationQueueShowPayload = z.infer<
  typeof CoordinationQueueShowResponseSchema
>["payload"];
export type CoordinationStreamListPayload = z.infer<
  typeof CoordinationStreamListResponseSchema
>["payload"];
