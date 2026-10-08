/**
 * One transcript line in, zero or one usage record out. Pure: no I/O, no throwing. The scanner
 * (token-usage-scanner.ts) owns offsets, dedupe and attribution; see docs/token-usage.md for the
 * transcript facts these parsers rely on.
 */

export const UNKNOWN_MODEL = "unknown";

/** The four categories every provider's usage is split into before weighing. */
export interface TokenCounts {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface ClaudeUsageRecord extends TokenCounts {
  /** `message.id`, else the line's `requestId`, else null (counted, never deduped). */
  messageId: string | null;
  sessionId: string | null;
  timestampMs: number;
  model: string;
  isSidechain: boolean;
}

export interface CodexUsageRecord extends TokenCounts {
  responseId: string | null;
  /** The root session: a subagent's rollout file reports its parent session here. */
  sessionId: string | null;
  timestampMs: number;
  model: string;
}

/** What a Codex parse carries from one line to the next: the model the turn runs on. */
export interface CodexParseState {
  model: string | null;
}

const SYNTHETIC_MODEL = "<synthetic>";
const MAX_MODEL_LENGTH = 128;

export function parseClaudeTranscriptLine(line: string): ClaudeUsageRecord | null {
  // Cheap prefilter: most lines (tool results, attachments, user turns) cannot carry usage.
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null;
  const parsed = parseObject(line);
  if (!parsed || parsed["type"] !== "assistant") return null;
  const message = asRecord(parsed["message"]);
  const usage = asRecord(message?.["usage"]);
  if (!message || !usage) return null;
  const model = readModel(message["model"]);
  // Placeholder frames for slash commands and API errors: not an inference, all-zero usage.
  if (model === SYNTHETIC_MODEL) return null;
  const timestampMs = readTimestamp(parsed["timestamp"]);
  if (timestampMs === null) return null;
  return {
    messageId: readId(message["id"]) ?? readId(parsed["requestId"]),
    sessionId: readId(parsed["sessionId"]),
    timestampMs,
    model: model ?? UNKNOWN_MODEL,
    isSidechain: parsed["isSidechain"] === true,
    input: count(usage["input_tokens"]),
    cacheWrite: count(usage["cache_creation_input_tokens"]),
    cacheRead: count(usage["cache_read_input_tokens"]),
    output: count(usage["output_tokens"]),
  };
}

export function createCodexParseState(model: string | null = null): CodexParseState {
  return { model };
}

/**
 * Reads one Codex rollout line. The model lives on `turn_context` (and on the
 * `thread_settings_applied` event when it changes mid-thread), never on the usage line, so the
 * state carries it forward. Only a `token_usage_record`'s own `usage` is counted: its
 * `turn_token_usage` and `thread_token_usage` are running totals of the same responses.
 */
export function parseCodexTranscriptLine(
  line: string,
  state: CodexParseState,
): CodexUsageRecord | null {
  if (line.includes('"turn_context"') || line.includes('"thread_settings_applied"')) {
    readCodexModel(line, state);
    return null;
  }
  if (!line.includes('"token_usage_record"')) return null;
  const parsed = parseObject(line);
  if (!parsed || parsed["type"] !== "token_usage_record") return null;
  const payload = asRecord(parsed["payload"]);
  const usage = asRecord(payload?.["usage"]);
  if (!payload || !usage) return null;
  const timestampMs = readTimestamp(parsed["timestamp"]);
  if (timestampMs === null) return null;
  // Codex counts cached input inside `input_tokens` (total_tokens = input + output), unlike
  // Anthropic, which reports cache reads beside it. Cache writes are reported the same way.
  const input = count(usage["input_tokens"]);
  const cacheRead = Math.min(count(usage["cached_input_tokens"]), input);
  const cacheWrite = Math.min(count(usage["cache_write_input_tokens"]), input - cacheRead);
  return {
    responseId: readId(payload["response_id"]),
    sessionId: readId(payload["session_id"]) ?? readId(payload["thread_id"]),
    timestampMs,
    model: state.model ?? UNKNOWN_MODEL,
    input: input - cacheRead - cacheWrite,
    cacheWrite,
    cacheRead,
    output: count(usage["output_tokens"]),
  };
}

function readCodexModel(line: string, state: CodexParseState): void {
  const parsed = parseObject(line);
  const payload = asRecord(parsed?.["payload"]);
  if (!parsed || !payload) return;
  if (parsed["type"] === "turn_context") {
    state.model = readModel(payload["model"]) ?? state.model;
    return;
  }
  if (parsed["type"] === "event_msg" && payload["type"] === "thread_settings_applied") {
    state.model = readModel(asRecord(payload["thread_settings"])?.["model"]) ?? state.model;
  }
}

function parseObject(line: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, MAX_MODEL_LENGTH) : null;
}

function readTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
