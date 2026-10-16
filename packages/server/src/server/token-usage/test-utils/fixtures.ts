// Transcript lines shaped after real Claude Code and Codex transcripts from a dev machine, with
// every identifier, path and piece of content replaced by fake values.

export const FAKE_CLAUDE_SESSION = "00000000-fake-4000-8000-000000000001";
export const FAKE_CODEX_SESSION = "00000000-fake-7000-8000-00000000c0de";

export interface ClaudeLineInput {
  messageId: string;
  sessionId?: string;
  timestamp?: string;
  model?: string;
  isSidechain?: boolean;
  input?: number;
  cacheWrite?: number;
  cacheRead?: number;
  output?: number;
}

export function claudeAssistantLine(input: ClaudeLineInput): string {
  return JSON.stringify({
    parentUuid: "fake-parent-uuid",
    isSidechain: input.isSidechain ?? false,
    ...(input.isSidechain ? { agentId: "fake-subagent-id" } : {}),
    message: {
      model: input.model ?? "claude-opus-5-5",
      id: input.messageId,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "fake reply" }],
      container: null,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: input.input ?? 2,
        cache_creation_input_tokens: input.cacheWrite ?? 40_000,
        cache_read_input_tokens: input.cacheRead ?? 11_000,
        cache_creation: {
          ephemeral_5m_input_tokens: input.cacheWrite ?? 40_000,
          ephemeral_1h_input_tokens: 0,
        },
        output_tokens: input.output ?? 500,
        service_tier: "standard",
        inference_geo: "not_available",
      },
    },
    requestId: `req_fake_${input.messageId}`,
    type: "assistant",
    uuid: "fake-uuid",
    timestamp: input.timestamp ?? "2026-10-01T12:00:00.000Z",
    userType: "external",
    entrypoint: "sdk-cli",
    cwd: "/fake/project",
    sessionId: input.sessionId ?? FAKE_CLAUDE_SESSION,
    version: "2.1.288",
    gitBranch: "fake-branch",
  });
}

export function claudeSyntheticLine(messageId: string): string {
  return JSON.stringify({
    parentUuid: "fake-parent-uuid",
    isSidechain: false,
    type: "assistant",
    uuid: "fake-uuid",
    timestamp: "2026-10-01T12:00:00.000Z",
    message: {
      id: messageId,
      model: "<synthetic>",
      role: "assistant",
      stop_reason: "stop_sequence",
      type: "message",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: [{ type: "text", text: "No response requested." }],
    },
    isApiErrorMessage: false,
    sessionId: FAKE_CLAUDE_SESSION,
  });
}

export function claudeUserLine(): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: "user",
    message: { role: "user", content: "fake prompt that mentions usage and assistant" },
    uuid: "fake-uuid",
    timestamp: "2026-10-01T11:59:00.000Z",
    sessionId: FAKE_CLAUDE_SESSION,
  });
}

export function codexSessionMetaLine(input?: { sessionId?: string; threadId?: string }): string {
  const threadId = input?.threadId ?? FAKE_CODEX_SESSION;
  return JSON.stringify({
    timestamp: "2026-10-01T12:00:00.000Z",
    ordinal: 0,
    type: "session_meta",
    payload: {
      session_id: input?.sessionId ?? threadId,
      id: threadId,
      timestamp: "2026-10-01T12:00:00.000Z",
      cwd: "/fake/project",
      originator: "Codex Desktop",
      cli_version: "0.153.4",
      source: "vscode",
      thread_source: "user",
      model_provider: "openai",
    },
  });
}

export function codexTurnContextLine(model: string): string {
  return JSON.stringify({
    timestamp: "2026-10-01T12:00:01.000Z",
    ordinal: 7,
    type: "turn_context",
    payload: {
      turn_id: "fake-turn",
      root_turn_id: "fake-turn",
      cwd: "/fake/project",
      current_date: "2026-10-01",
      timezone: "UTC",
      approval_policy: "never",
      model,
      effort: "high",
    },
  });
}

export function codexThreadSettingsLine(model: string): string {
  return JSON.stringify({
    timestamp: "2026-10-01T12:00:01.500Z",
    ordinal: 8,
    type: "event_msg",
    payload: {
      type: "thread_settings_applied",
      thread_id: FAKE_CODEX_SESSION,
      thread_settings: { model, model_provider_id: "openai", reasoning_effort: "high" },
    },
  });
}

export interface CodexUsageLineInput {
  responseId: string;
  sessionId?: string;
  threadId?: string;
  timestamp?: string;
  input?: number;
  cached?: number;
  cacheWrite?: number;
  output?: number;
}

function codexUsageObject(input: number, cached: number, cacheWrite: number, output: number) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: Math.floor(output / 2),
    total_tokens: input + output,
  };
}

export function codexUsageLine(input: CodexUsageLineInput): string {
  const fresh = input.input ?? 29_694;
  const cached = input.cached ?? 20_000;
  const cacheWrite = input.cacheWrite ?? 0;
  const output = input.output ?? 243;
  const sessionId = input.sessionId ?? FAKE_CODEX_SESSION;
  return JSON.stringify({
    timestamp: input.timestamp ?? "2026-10-01T12:00:10.000Z",
    ordinal: 13,
    type: "token_usage_record",
    payload: {
      thread_id: input.threadId ?? sessionId,
      turn_id: "fake-turn",
      session_id: sessionId,
      response_id: input.responseId,
      usage: codexUsageObject(fresh, cached, cacheWrite, output),
      // Cumulative totals: much larger on purpose, so a parser that reads them is caught.
      turn_token_usage: codexUsageObject(fresh * 3, cached * 3, cacheWrite * 3, output * 3),
      thread_token_usage: codexUsageObject(fresh * 50, cached * 50, cacheWrite * 50, output * 50),
    },
  });
}

export function codexTokenCountLine(): string {
  return JSON.stringify({
    timestamp: "2026-10-01T12:00:10.000Z",
    ordinal: 16,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: codexUsageObject(900_000, 800_000, 0, 9_000),
        last_token_usage: codexUsageObject(29_694, 20_000, 0, 243),
      },
    },
  });
}
