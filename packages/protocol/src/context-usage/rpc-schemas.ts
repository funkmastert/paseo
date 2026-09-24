import { z } from "zod";

// What an agent's context window is made of, as the provider's own `/context` reports it. See
// docs/context-usage.md. Kinds and statuses are plain strings so a daemon can name a new one
// without breaking an older client; the known values are listed next to each field.

export const AgentContextUsageCategorySchema = z.object({
  // Slug of the provider's row name: "system_prompt", "system_tools", "mcp_tools",
  // "custom_agents", "memory_files", "skills", "messages", "autocompact_buffer", "free_space".
  id: z.string(),
  // The provider's display name for the row, e.g. "MCP tools (deferred)".
  label: z.string(),
  tokens: z.number().nonnegative(),
  // "used"     - occupies the window
  // "deferred" - tool schemas listed for awareness but loaded on demand, outside the window
  // "buffer"   - held back for autocompact
  // "free"     - the rest of the window
  // A client treats a kind it does not know as "used".
  kind: z.string(),
});

export const AgentContextUsageMemoryFileSchema = z.object({
  path: z.string(),
  // The provider's source label, e.g. "User", "Project", "AutoMem".
  type: z.string(),
  tokens: z.number().nonnegative(),
});

// What the "messages" row is made of.
export const AgentContextUsageMessageBreakdownSchema = z.object({
  toolCallTokens: z.number().nonnegative(),
  toolResultTokens: z.number().nonnegative(),
  attachmentTokens: z.number().nonnegative(),
  assistantMessageTokens: z.number().nonnegative(),
  userMessageTokens: z.number().nonnegative(),
});

export const AgentContextUsageSchema = z.object({
  provider: z.string(),
  model: z.string().nullable(),
  // When the provider computed the breakdown. It is a snapshot: it does not move mid-turn.
  capturedAt: z.string(),
  // "session" - asked the agent's own live session, out of band of its turns.
  source: z.string(),
  // Tokens in the window at the last request. The category rows are the provider's per-row
  // estimates and need not sum to this exactly.
  totalTokens: z.number().nonnegative(),
  maxTokens: z.number().nonnegative(),
  categories: z.array(AgentContextUsageCategorySchema),
  memoryFiles: z.array(AgentContextUsageMemoryFileSchema),
  messageBreakdown: AgentContextUsageMessageBreakdownSchema.optional(),
});

// COMPAT(agentContextUsage): added in v0.8.2, remove gating after 2027-09-24. Gated on
// `server_info.features.agentContextUsage`.
export const AgentContextUsageReadRequestSchema = z.object({
  type: z.literal("agent.context_usage.read.request"),
  requestId: z.string(),
  agentId: z.string().min(1),
});

export const AgentContextUsageReadResponseSchema = z.object({
  type: z.literal("agent.context_usage.read.response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    // "captured"    - read from the session just now
    // "cached"      - the last capture; the agent is mid-turn, or nothing changed since
    // "pending"     - mid-turn with nothing captured yet; the daemon captures when the turn ends
    // "unsupported" - the agent's provider cannot report a breakdown
    // "error"       - the capture failed; `error` says why
    status: z.string(),
    usage: AgentContextUsageSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export type AgentContextUsageCategory = z.infer<typeof AgentContextUsageCategorySchema>;
export type AgentContextUsageMemoryFile = z.infer<typeof AgentContextUsageMemoryFileSchema>;
export type AgentContextUsageMessageBreakdown = z.infer<
  typeof AgentContextUsageMessageBreakdownSchema
>;
export type AgentContextUsage = z.infer<typeof AgentContextUsageSchema>;
export type AgentContextUsageReadRequest = z.infer<typeof AgentContextUsageReadRequestSchema>;
export type AgentContextUsageReadResponse = z.infer<typeof AgentContextUsageReadResponseSchema>;
