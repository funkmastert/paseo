import { z } from "zod";

// Grep an agent's own provider transcript (Claude JSONL, Codex rollout), optionally across its
// whole parentAgentId tree, without loading the agent's full timeline. See
// docs/agent-lifecycle.md#transcript-search. Server:
// packages/server/src/server/agent/transcript-search/.
// COMPAT(agentTranscriptSearch): added in v0.8.x, remove gate after 2027-09-30. Gated on
// `server_info.features.agentTranscriptSearch`.
//
// Coverage is plain strings, not an enum, so a daemon can report a new reason without an older
// client failing to parse it: "searched" (completed), "not_found" (no transcript file for this
// agent), "unsupported" (this agent's provider has no known transcript location), "truncated"
// (cut short by a per-agent or total-output cap), "timed_out" (a regex search on the Node fallback
// backend ran past its deadline and was killed).

export const AgentTranscriptSearchExcerptSchema = z.object({
  lineNumber: z.number().int().nonnegative(),
  role: z.string().nullable(),
  text: z.string(),
});

export const AgentTranscriptSearchAgentResultSchema = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  provider: z.string(),
  coverage: z.string(),
  matchCount: z.number().int().nonnegative(),
  excerpts: z.array(AgentTranscriptSearchExcerptSchema),
});

export const AgentTranscriptSearchRequestSchema = z.object({
  type: z.literal("agent.transcript_search.search.request"),
  requestId: z.string(),
  agentId: z.string().min(1),
  pattern: z.string().min(1).max(500),
  /** Regular expression instead of a literal substring. Defaults to false. */
  regex: z.boolean().optional(),
  caseInsensitive: z.boolean().optional(),
  /** Also search every descendant of `agentId`. Defaults to false. */
  tree: z.boolean().optional(),
  /** More matches per agent, longer excerpts, a larger total output cap. Defaults to false. */
  full: z.boolean().optional(),
});

export const AgentTranscriptSearchResponseSchema = z.object({
  type: z.literal("agent.transcript_search.search.response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    /** "ripgrep", "ripgrep (claude)", or "node"; null when the request failed before a backend was chosen. */
    backend: z.string().nullable(),
    agents: z.array(AgentTranscriptSearchAgentResultSchema),
    /** True when the searched tree had more agents than the daemon will search in one request. */
    targetSetTruncated: z.boolean(),
    error: z.string().nullable(),
  }),
});

export type AgentTranscriptSearchExcerpt = z.infer<typeof AgentTranscriptSearchExcerptSchema>;
export type AgentTranscriptSearchAgentResult = z.infer<
  typeof AgentTranscriptSearchAgentResultSchema
>;
export type AgentTranscriptSearchRequest = z.infer<typeof AgentTranscriptSearchRequestSchema>;
export type AgentTranscriptSearchResponse = z.infer<typeof AgentTranscriptSearchResponseSchema>;
