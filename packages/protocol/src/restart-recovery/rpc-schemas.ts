import { z } from "zod";
import type { LiteralUnion } from "../literal-union.js";

// Restart recovery: the agents a daemon stop cut off mid-turn, and resuming them.
// Server: packages/server/src/server/agent/restart-recovery/. Doc: docs/restart-recovery.md.
// COMPAT(restartRecovery): added in v0.8.x; gate on server_info.features.restartRecovery,
// remove the gate after 2027-09-23.
//
// Vocabulary fields are plain strings on the wire so a later daemon can add a state without an
// older client failing to parse the plan. The TypeScript types name the known values.

export type RestartRecoveryMode = LiteralUnion<"off" | "plan" | "resume", string>;
export type RestartRecoveryReadiness = LiteralUnion<
  "restorable" | "restorable_with_caveats" | "not_restorable" | "unknown",
  string
>;
export type RestartRecoveryCheckStatus = LiteralUnion<
  "green" | "yellow" | "red" | "unknown",
  string
>;
export type RestartRecoveryState = LiteralUnion<
  "pending" | "resuming" | "resumed" | "failed" | "not_attempted" | "dismissed",
  string
>;

export const RestartRecoveryCheckSchema = z.object({
  /** `session`, `workspace`, `provider`, `transcript`, `account` or `live`. */
  id: z.string(),
  status: z.string(),
  detail: z.string(),
});

export const RestartRecoveryEntrySchema = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  provider: z.string(),
  cwd: z.string(),
  workspaceId: z.string().nullable(),
  parentAgentId: z.string().nullable(),
  /** Ancestors that are also in this plan. Depth 0 resumes first. */
  depth: z.number().int().nonnegative(),
  /** When the interrupted run started. */
  runStartedAt: z.string(),
  readiness: z.string(),
  checks: z.array(RestartRecoveryCheckSchema),
  state: z.string(),
  /** Why the entry is in its state: the resume error, why it was not attempted, and so on. */
  detail: z.string().nullable(),
  resolvedAt: z.string().nullable(),
});

export const RestartRecoveryPlanSchema = z.object({
  mode: z.string(),
  /** When this daemon started and read the markers. */
  capturedAt: z.string(),
  /** `crash`, `clean` or `unknown`, from the previous daemon's shutdown receipt when there is one. */
  previousShutdown: z.string(),
  applying: z.boolean(),
  entries: z.array(RestartRecoveryEntrySchema),
});

export const RestartRecoveryGetPlanRequestSchema = z.object({
  type: z.literal("agent.restart_recovery.get_plan.request"),
  requestId: z.string(),
});

export const RestartRecoveryApplyRequestSchema = z.object({
  type: z.literal("agent.restart_recovery.apply.request"),
  requestId: z.string(),
  /** Omit to resume every resumable entry. */
  agentIds: z.array(z.string()).optional(),
});

export const RestartRecoveryDismissRequestSchema = z.object({
  type: z.literal("agent.restart_recovery.dismiss.request"),
  requestId: z.string(),
  /** Omit to dismiss every entry still pending. */
  agentIds: z.array(z.string()).optional(),
});

const RestartRecoveryResponsePayloadSchema = z.object({
  requestId: z.string(),
  plan: RestartRecoveryPlanSchema.nullable(),
  error: z.string().nullable(),
});

export const RestartRecoveryGetPlanResponseSchema = z.object({
  type: z.literal("agent.restart_recovery.get_plan.response"),
  payload: RestartRecoveryResponsePayloadSchema,
});

export const RestartRecoveryApplyResponseSchema = z.object({
  type: z.literal("agent.restart_recovery.apply.response"),
  payload: RestartRecoveryResponsePayloadSchema,
});

export const RestartRecoveryDismissResponseSchema = z.object({
  type: z.literal("agent.restart_recovery.dismiss.response"),
  payload: RestartRecoveryResponsePayloadSchema,
});

export type RestartRecoveryCheck = z.infer<typeof RestartRecoveryCheckSchema> & {
  status: RestartRecoveryCheckStatus;
};
export type RestartRecoveryEntry = Omit<
  z.infer<typeof RestartRecoveryEntrySchema>,
  "readiness" | "checks" | "state"
> & {
  readiness: RestartRecoveryReadiness;
  checks: RestartRecoveryCheck[];
  state: RestartRecoveryState;
};
export type RestartRecoveryPlan = Omit<
  z.infer<typeof RestartRecoveryPlanSchema>,
  "mode" | "entries"
> & {
  mode: RestartRecoveryMode;
  entries: RestartRecoveryEntry[];
};
export type RestartRecoveryGetPlanRequest = z.infer<typeof RestartRecoveryGetPlanRequestSchema>;
export type RestartRecoveryApplyRequest = z.infer<typeof RestartRecoveryApplyRequestSchema>;
export type RestartRecoveryDismissRequest = z.infer<typeof RestartRecoveryDismissRequestSchema>;
