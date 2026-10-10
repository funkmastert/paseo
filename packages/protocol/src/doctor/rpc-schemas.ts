import { z } from "zod";

/**
 * `paseo doctor` wire shapes. A finding says what is wrong, why it matters and the exact command
 * that fixes it. The daemon only reports: no field here asks it to change anything.
 */

export const DoctorFindingStatusSchema = z.enum(["ok", "warn", "fail", "skip"]);

export const DoctorFindingSchema = z.object({
  /** Stable machine id, e.g. `account.projects-link`. One check can emit several findings. */
  id: z.string(),
  category: z.string(),
  status: DoctorFindingStatusSchema,
  /** One line: the subject and its state. */
  title: z.string(),
  /** What is wrong, with the concrete paths and values. */
  detail: z.string().optional(),
  /** Why it matters — what breaks, or silently stops working, when this is left alone. */
  why: z.string().optional(),
  /** The exact command(s) that fix it. Doctor never runs these. */
  fix: z.string().optional(),
  /** Set when the check hit its own deadline. It says nothing about the thing it was checking. */
  timedOutAfterMs: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

export const DaemonDoctorRequestSchema = z.object({
  type: z.literal("daemon.doctor.request"),
  requestId: z.string(),
  /** Give the worktree sweep a long budget instead of the quick one. */
  deep: z.boolean().optional(),
});

export const DaemonDoctorResponseSchema = z.object({
  type: z.literal("daemon.doctor.response"),
  payload: z.object({
    requestId: z.string(),
    generatedAt: z.string(),
    daemonVersion: z.string().nullable().optional(),
    findings: z.array(DoctorFindingSchema),
  }),
});

export type DoctorFinding = z.infer<typeof DoctorFindingSchema>;
export type DoctorFindingStatus = z.infer<typeof DoctorFindingStatusSchema>;
