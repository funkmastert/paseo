import { z } from "zod";

// Work queue wire shapes. The daemon validates the closure contract (which reasons need a
// target, which states need a closure); these schemas only describe the shape, so they stay pure.
// See docs/work-queue.md.

export const WORK_ITEM_STATES = [
  "pending",
  "in-progress",
  "done",
  "blocked",
  "failed",
  "denied",
  "canceled",
  "handed-off",
] as const;

export const WorkItemStateSchema = z.enum(WORK_ITEM_STATES);
export type WorkItemState = z.infer<typeof WorkItemStateSchema>;

// An item in one of these states still needs someone. Every other state is terminal.
export const OPEN_WORK_ITEM_STATES: readonly WorkItemState[] = ["pending", "in-progress", "blocked"];

export const WORK_ITEM_CLOSURE_REASONS = [
  "handed_off_to",
  "blocked_on",
  "denied",
  "canceled",
  "no-follow-on",
  "escalation",
] as const;

export const WorkItemClosureReasonSchema = z.enum(WORK_ITEM_CLOSURE_REASONS);
export type WorkItemClosureReason = z.infer<typeof WorkItemClosureReasonSchema>;

// These reasons name where the work went, so the closure must carry that target.
export const CLOSURE_REASONS_REQUIRING_TARGET: readonly WorkItemClosureReason[] = [
  "handed_off_to",
  "blocked_on",
  "escalation",
];

// The owner value for an item a person, not an agent, holds.
export const HUMAN_WORK_ITEM_OWNER = "human";

export const WorkItemClosureSchema = z.object({
  reason: WorkItemClosureReasonSchema,
  // An agent id, `human`, an item id or free text, depending on the reason.
  target: z.string().optional(),
  note: z.string().optional(),
});
export type WorkItemClosure = z.infer<typeof WorkItemClosureSchema>;

// Whether the daemon reached the owner with the item. W2.1b's delivery fills it.
export const WorkItemDeliveryStateSchema = z.object({
  state: z.enum(["not_attempted", "delivered", "failed"]),
  reason: z.string().optional(),
  at: z.string().optional(),
});
export type WorkItemDeliveryState = z.infer<typeof WorkItemDeliveryStateSchema>;

export const WorkItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string().optional(),
  // An agent id or `human`.
  owner: z.string(),
  createdBy: z.string().optional(),
  state: WorkItemStateSchema,
  closure: WorkItemClosureSchema.optional(),
  tags: z.array(z.string()).optional(),
  // Handoff links: the item this one was handed off from, and the one it was handed off to.
  handedOffFrom: z.string().optional(),
  handedOffTo: z.string().optional(),
  delivery: WorkItemDeliveryStateSchema.optional(),
  // Bumped on every write; lets a caller detect a lost update.
  revision: z.number().int().nonnegative().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  claimedAt: z.string().optional(),
  closedAt: z.string().optional(),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

export const WorkItemTransitionSchema = z.object({
  // Position in the daemon's transition journal. Increases across all items.
  seq: z.number().int().nonnegative(),
  itemId: z.string(),
  // Absent on the row that created the item.
  from: WorkItemStateSchema.optional(),
  to: WorkItemStateSchema,
  at: z.string(),
  actor: z.string().optional(),
  owner: z.string().optional(),
  closure: WorkItemClosureSchema.optional(),
  note: z.string().optional(),
  // Set on both rows of a handoff: the successor's id.
  successorId: z.string().optional(),
});
export type WorkItemTransition = z.infer<typeof WorkItemTransitionSchema>;

export const WorkItemWithTransitionsSchema = z.object({
  item: WorkItemSchema,
  transitions: z.array(WorkItemTransitionSchema),
});
export type WorkItemWithTransitions = z.infer<typeof WorkItemWithTransitionsSchema>;

export const WorkItemListFilterSchema = z.object({
  owner: z.string().optional(),
  states: z.array(WorkItemStateSchema).optional(),
  openOnly: z.boolean().optional(),
  // Opaque; pass back `nextCursor` from the previous page.
  cursor: z.string().optional(),
  limit: z.number().int().positive().optional(),
});
export type WorkItemListFilter = z.infer<typeof WorkItemListFilterSchema>;

export const WorkItemPageSchema = z.object({
  items: z.array(WorkItemSchema),
  // Absent on the last page.
  nextCursor: z.string().optional(),
});
export type WorkItemPage = z.infer<typeof WorkItemPageSchema>;
