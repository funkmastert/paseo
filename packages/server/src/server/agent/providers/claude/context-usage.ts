import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentContextUsage,
  AgentContextUsageCategory,
} from "@getpaseo/protocol/context-usage/rpc-schemas";

const FREE_SPACE_ID = "free_space";
const AUTOCOMPACT_BUFFER_ID = "autocompact_buffer";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function classifyRow(
  id: string,
  isDeferred: boolean | undefined,
): AgentContextUsageCategory["kind"] {
  if (isDeferred) return "deferred";
  if (id === FREE_SPACE_ID) return "free";
  if (id.endsWith("buffer")) return "buffer";
  return "used";
}

/**
 * The CLI stopped listing the autocompact reserve as a row, but it still reports the threshold.
 * Put the reserve back the way `/context` used to show it — the window above the threshold — and
 * take it out of free space, so "free" means room left before compaction. When the session is
 * already past the threshold, the reserve left is whatever free space remains.
 */
function withAutocompactBuffer(
  raw: SDKControlGetContextUsageResponse,
  categories: AgentContextUsageCategory[],
): AgentContextUsageCategory[] {
  const threshold = raw.autoCompactThreshold;
  if (!raw.isAutoCompactEnabled || threshold === undefined || threshold >= raw.maxTokens) {
    return categories;
  }
  if (categories.some((row) => row.kind === "buffer")) return categories;
  const freeIndex = categories.findIndex((row) => row.kind === "free");
  if (freeIndex === -1) return categories;
  const free = categories[freeIndex];
  const buffer = Math.min(raw.maxTokens - threshold, free.tokens);
  return [
    ...categories.slice(0, freeIndex),
    { id: AUTOCOMPACT_BUFFER_ID, label: "Autocompact buffer", tokens: buffer, kind: "buffer" },
    { ...free, tokens: free.tokens - buffer },
    ...categories.slice(freeIndex + 1),
  ];
}

/**
 * Map the Claude SDK's `get_context_usage` control response — the data behind `/context` — onto
 * the provider-neutral wire shape. Token counts pass through unrounded; the CLI's per-row figures
 * are its own estimates, so they need not sum to `totalTokens`.
 */
export function normalizeClaudeContextUsage(
  raw: SDKControlGetContextUsageResponse,
  capturedAt: string,
): AgentContextUsage {
  const categories = raw.categories.map((row) => {
    const id = slugify(row.name);
    return { id, label: row.name, tokens: row.tokens, kind: classifyRow(id, row.isDeferred) };
  });
  const breakdown = raw.messageBreakdown;
  return {
    provider: "claude",
    model: raw.model || null,
    capturedAt,
    source: "session",
    totalTokens: raw.totalTokens,
    maxTokens: raw.maxTokens,
    categories: withAutocompactBuffer(raw, categories),
    memoryFiles: raw.memoryFiles.map((file) => ({
      path: file.path,
      type: file.type,
      tokens: file.tokens,
    })),
    ...(breakdown
      ? {
          messageBreakdown: {
            toolCallTokens: breakdown.toolCallTokens,
            toolResultTokens: breakdown.toolResultTokens,
            attachmentTokens: breakdown.attachmentTokens,
            assistantMessageTokens: breakdown.assistantMessageTokens,
            userMessageTokens: breakdown.userMessageTokens,
          },
        }
      : {}),
  };
}
