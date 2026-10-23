import { z } from "zod";

// The wire shape for Codex guard health plus the running-children count (docs/codex-workers.md,
// "Guard health"; KTD-6, KTD-9). `status` travels as a plain string with the known values listed
// in a comment, so a new one never narrows the schema -- mirrors jev/rpc-schemas.ts's own
// "status" fields.

export const CodexGuardStatusSchema = z.object({
  // "unknown" | "green" | "red" (packages/server/.../agent/codex-guard-health.ts's
  // CodexGuardHealthStatus). Both "unknown" and "red" make every `codex/` ref unusable.
  status: z.string(),
  reason: z.string(),
  // ISO timestamp of the last self-test verdict (or the never-run default).
  checkedAt: z.string(),
  codexVersion: z.string().nullable(),
  /** Currently-running Codex child agents, for `agentModelPolicy.codex.maxChildren` (KTD-9). */
  runningChildren: z.number(),
});

// COMPAT(codexGuardStatus): added in v0.9.x, remove gate after 2027-10-10. Gated on
// `server_info.features.codexGuardStatus`.
export const CodexGuardStatusRequestSchema = z.object({
  type: z.literal("codex.guard.status.request"),
  requestId: z.string(),
});

export const CodexGuardStatusResponseSchema = z.object({
  type: z.literal("codex.guard.status.response"),
  payload: z.object({
    requestId: z.string(),
    status: CodexGuardStatusSchema,
  }),
});
