import { z } from "zod";

// The fleet event log: append-only entries of things that happened, with hints for whoever reads
// them. See docs/work-queue.md#stream.

export const StreamUrgencySchema = z.enum(["low", "normal", "high"]);
export type StreamUrgency = z.infer<typeof StreamUrgencySchema>;

export const StreamEntrySchema = z.object({
  id: z.string(),
  // Position in the log. Increases with every append.
  seq: z.number().int().nonnegative(),
  at: z.string(),
  // Dotted kind, e.g. `queue.transition`. A plain string so a new kind never breaks a reader.
  type: z.string(),
  urgency: StreamUrgencySchema.optional(),
  tags: z.array(z.string()).optional(),
  // Who reported it: an agent id, `human`, or a daemon subsystem such as `queue`.
  source: z.string(),
  summary: z.string(),
  // The thing the entry is about, e.g. a work item id.
  subject: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  // Soft archive: hidden from default reads, never removed by the archive itself.
  archivedAt: z.string().optional(),
});
export type StreamEntry = z.infer<typeof StreamEntrySchema>;

export const StreamListFilterSchema = z.object({
  types: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  subject: z.string().optional(),
  includeArchived: z.boolean().optional(),
  // Opaque; pass back `nextCursor` from the previous page.
  cursor: z.string().optional(),
  limit: z.number().int().positive().optional(),
});
export type StreamListFilter = z.infer<typeof StreamListFilterSchema>;

// Newest first.
export const StreamEntryPageSchema = z.object({
  entries: z.array(StreamEntrySchema),
  // Absent on the last page.
  nextCursor: z.string().optional(),
});
export type StreamEntryPage = z.infer<typeof StreamEntryPageSchema>;
