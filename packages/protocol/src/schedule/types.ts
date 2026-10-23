import { z } from "zod";
import { AgentProviderSchema } from "../provider-manifest.js";
import { AGENT_CREATE_ORIGINS, type AgentCreateOrigin } from "../agent-labels.js";
import { ScheduleConditionSchema, type ScheduleCondition } from "./condition.js";

export const ScheduleCreatedByOriginSchema = z.enum(AGENT_CREATE_ORIGINS);

export const ScheduleStatusSchema = z.enum(["active", "paused", "completed"]);
export type ScheduleStatus = z.infer<typeof ScheduleStatusSchema>;

export const ScheduleCadenceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("every"),
    everyMs: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("cron"),
    expression: z.string().trim().min(1),
    timezone: z.string().trim().min(1).optional(),
  }),
]);
export type ScheduleCadence = z.infer<typeof ScheduleCadenceSchema>;

export const ScheduleTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent"),
    agentId: z.guid(),
  }),
  z.object({
    type: z.literal("new-agent"),
    config: z.object({
      provider: AgentProviderSchema,
      cwd: z.string().trim().min(1),
      modeId: z.string().trim().min(1).optional(),
      model: z.string().trim().min(1).optional(),
      thinkingOptionId: z.string().trim().min(1).optional(),
      archiveOnFinish: z.boolean().optional(),
      isolation: z.enum(["local", "worktree"]).optional(),
      title: z.string().trim().min(1).nullable().optional(),
      providerOptions: z.record(z.string(), z.json()).optional(),
      featureValues: z.record(z.string(), z.unknown()).optional(),
      systemPrompt: z.string().optional(),
      mcpServers: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
]);
export type ScheduleTarget = z.infer<typeof ScheduleTargetSchema>;

export const ScheduleRunSchema = z.object({
  id: z.string(),
  scheduledFor: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: z.enum(["running", "succeeded", "failed"]),
  agentId: z.guid().nullable(),
  workspaceId: z.string().nullable().optional(),
  output: z.string().nullable(),
  error: z.string().nullable(),
});
export type ScheduleRun = z.infer<typeof ScheduleRunSchema>;

export const StoredScheduleSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  prompt: z.string().min(1),
  cadence: ScheduleCadenceSchema,
  target: ScheduleTargetSchema,
  status: ScheduleStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  pausedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  maxRuns: z.number().int().positive().nullable(),
  condition: ScheduleConditionSchema.optional(),
  runs: z.array(ScheduleRunSchema),
  /**
   * The agent that created (or last agent-edited) this schedule, or null for a human client
   * session (the app, desktop, or a CLI run with no agent identity). Informational only --
   * `createdByOrigin` is what the Codex child guard reads to decide whether a `new-agent` run is
   * agent-made. Optional for backward compatibility with records written before this field
   * existed.
   */
  createdByAgentId: z.string().nullable().optional(),
  /**
   * Who created (or last agent-edited) this schedule, mirroring `createAgent`'s origin model.
   * Every `new-agent` run passes this straight through as the run's own create origin
   * (`ScheduleService.executeSchedule`), instead of stamping the run with a `paseo.parent-agent-id`
   * label -- a schedule run is a root for every other purpose (archiving, attention, failover).
   * Optional for backward compatibility: a schedule written before this field existed has none,
   * and is treated as agent-made for Codex purposes -- fail closed, since there is no way to
   * recover who actually created it.
   */
  createdByOrigin: ScheduleCreatedByOriginSchema.optional(),
});
export type StoredSchedule = z.infer<typeof StoredScheduleSchema>;

export const ScheduleSummarySchema = StoredScheduleSchema.omit({
  runs: true,
});
export type ScheduleSummary = z.infer<typeof ScheduleSummarySchema>;

export interface CreateScheduleInput {
  name?: string | null;
  prompt: string;
  cadence: ScheduleCadence;
  target: ScheduleTarget;
  maxRuns?: number | null;
  expiresAt?: string | null;
  runOnCreate?: boolean | null;
  condition?: ScheduleCondition | null;
  /** The creating agent, or null/undefined for a human client session. See `StoredSchedule`. */
  createdByAgentId?: string | null;
  /**
   * Who created this schedule. Every entry point sets this explicitly: the `schedule/create` RPC
   * (app/desktop/CLI) decides "human" vs "agent" from whether `callerAgentId` is present, same as
   * `createAgent`'s own session-kind rule; the MCP endpoint (`create_schedule`/`create_heartbeat`)
   * is agent-only and always "agent". Defaults to "agent" when omitted -- fail closed.
   */
  createdByOrigin?: AgentCreateOrigin;
}

export interface UpdateScheduleNewAgentConfig {
  provider?: string;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  archiveOnFinish?: boolean;
  isolation?: "local" | "worktree";
  cwd?: string;
}

export interface UpdateScheduleInput {
  id: string;
  name?: string | null;
  prompt?: string;
  cadence?: ScheduleCadence;
  newAgentConfig?: UpdateScheduleNewAgentConfig;
  maxRuns?: number | null;
  expiresAt?: string | null;
  /** Null clears the condition. */
  condition?: ScheduleCondition | null;
  /**
   * Who is making this edit, mirroring `createAgent`'s origin model. Only consulted when
   * `newAgentConfig` is also present: an agent or daemon edit marks the schedule agent-made
   * (`createdByAgentId`/`createdByOrigin`) so a later run can't dodge the Codex guard by
   * retargeting a human schedule to a codex-family provider. Never used to move a schedule back
   * toward "human" -- a human edit (or an edit that omits this) leaves the schedule's existing
   * attribution untouched.
   */
  editorOrigin?: AgentCreateOrigin;
  /** The editing agent's id, when `editorOrigin` is `"agent"`. Stored as the schedule's
   * `createdByAgentId` going forward. */
  editorAgentId?: string | null;
}

export interface ScheduleExecutionResult {
  agentId: string | null;
  output: string | null;
}
