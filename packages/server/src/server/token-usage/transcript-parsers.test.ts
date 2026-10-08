import { describe, expect, it } from "vitest";
import {
  createCodexParseState,
  parseClaudeTranscriptLine,
  parseCodexTranscriptLine,
} from "./transcript-parsers.js";
import {
  FAKE_CLAUDE_SESSION,
  FAKE_CODEX_SESSION,
  claudeAssistantLine,
  claudeSyntheticLine,
  claudeUserLine,
  codexSessionMetaLine,
  codexThreadSettingsLine,
  codexTokenCountLine,
  codexTurnContextLine,
  codexUsageLine,
} from "./test-utils/fixtures.js";

describe("parseClaudeTranscriptLine", () => {
  it("reads the model, ids, time and four categories of an assistant response", () => {
    const record = parseClaudeTranscriptLine(
      claudeAssistantLine({
        messageId: "msg_fake_1",
        model: "claude-sonnet-5",
        timestamp: "2026-10-01T12:34:56.000Z",
        input: 3,
        cacheWrite: 1_000,
        cacheRead: 20_000,
        output: 400,
      }),
    );

    expect(record).toEqual({
      messageId: "msg_fake_1",
      sessionId: FAKE_CLAUDE_SESSION,
      timestampMs: Date.parse("2026-10-01T12:34:56.000Z"),
      model: "claude-sonnet-5",
      isSidechain: false,
      input: 3,
      cacheWrite: 1_000,
      cacheRead: 20_000,
      output: 400,
    });
  });

  it("gives two lines of one streamed response the same id, so the caller can dedupe", () => {
    const first = parseClaudeTranscriptLine(claudeAssistantLine({ messageId: "msg_fake_2" }));
    const second = parseClaudeTranscriptLine(claudeAssistantLine({ messageId: "msg_fake_2" }));

    expect(first?.messageId).toBe("msg_fake_2");
    expect(second?.messageId).toBe(first?.messageId);
  });

  it("returns nothing for a synthetic placeholder, a user line, a malformed line or a blank", () => {
    expect(parseClaudeTranscriptLine(claudeSyntheticLine("fake-synthetic-id"))).toBeNull();
    expect(parseClaudeTranscriptLine(claudeUserLine())).toBeNull();
    expect(parseClaudeTranscriptLine('{"type":"assistant","message":{"usage":')).toBeNull();
    expect(parseClaudeTranscriptLine("")).toBeNull();
    expect(parseClaudeTranscriptLine('"assistant" "usage" not json')).toBeNull();
  });

  it("returns nothing when the usage block or timestamp is unusable", () => {
    const noUsage = JSON.parse(claudeAssistantLine({ messageId: "msg_fake_3" }));
    noUsage.message.usage = "usage";
    expect(parseClaudeTranscriptLine(JSON.stringify(noUsage))).toBeNull();

    const noTime = JSON.parse(claudeAssistantLine({ messageId: "msg_fake_4" }));
    noTime.timestamp = "not a time";
    expect(parseClaudeTranscriptLine(JSON.stringify(noTime))).toBeNull();
  });

  it("flags a sidechain response", () => {
    const record = parseClaudeTranscriptLine(
      claudeAssistantLine({ messageId: "msg_fake_5", isSidechain: true }),
    );

    expect(record?.isSidechain).toBe(true);
  });

  it("falls back to the request id, then to no id, when the message has none", () => {
    const withRequest = JSON.parse(claudeAssistantLine({ messageId: "msg_fake_6" }));
    delete withRequest.message.id;
    expect(parseClaudeTranscriptLine(JSON.stringify(withRequest))?.messageId).toBe(
      "req_fake_msg_fake_6",
    );

    delete withRequest.requestId;
    expect(parseClaudeTranscriptLine(JSON.stringify(withRequest))?.messageId).toBeNull();
  });

  it("books a response with no model as unknown and treats bad counts as zero", () => {
    const line = JSON.parse(claudeAssistantLine({ messageId: "msg_fake_7" }));
    delete line.message.model;
    line.message.usage.output_tokens = -4;
    line.message.usage.cache_read_input_tokens = null;

    const record = parseClaudeTranscriptLine(JSON.stringify(line));

    expect(record?.model).toBe("unknown");
    expect(record?.output).toBe(0);
    expect(record?.cacheRead).toBe(0);
  });
});

describe("parseCodexTranscriptLine", () => {
  it("takes the model from turn_context and splits cached input out of each response", () => {
    const state = createCodexParseState();
    expect(parseCodexTranscriptLine(codexSessionMetaLine(), state)).toBeNull();
    expect(parseCodexTranscriptLine(codexTurnContextLine("gpt-fake-5"), state)).toBeNull();

    const record = parseCodexTranscriptLine(
      codexUsageLine({
        responseId: "resp_fake_1",
        input: 30_000,
        cached: 20_000,
        output: 250,
        timestamp: "2026-10-01T12:00:10.000Z",
      }),
      state,
    );

    expect(record).toEqual({
      responseId: "resp_fake_1",
      sessionId: FAKE_CODEX_SESSION,
      timestampMs: Date.parse("2026-10-01T12:00:10.000Z"),
      model: "gpt-fake-5",
      input: 10_000,
      cacheWrite: 0,
      cacheRead: 20_000,
      output: 250,
    });
  });

  it("never reads the cumulative turn or thread totals", () => {
    const state = createCodexParseState();
    parseCodexTranscriptLine(codexTurnContextLine("gpt-fake-5"), state);
    const records = [
      parseCodexTranscriptLine(codexUsageLine({ responseId: "r1", input: 100, cached: 0 }), state),
      parseCodexTranscriptLine(codexUsageLine({ responseId: "r2", input: 100, cached: 0 }), state),
    ];

    expect(records.map((record) => record?.input)).toEqual([100, 100]);
    expect(parseCodexTranscriptLine(codexTokenCountLine(), state)).toBeNull();
  });

  it("keeps cache writes out of fresh input, since Codex counts both inside input", () => {
    const state = createCodexParseState();
    const record = parseCodexTranscriptLine(
      codexUsageLine({ responseId: "r3", input: 1_000, cached: 600, cacheWrite: 100 }),
      state,
    );

    expect(record).toMatchObject({ input: 300, cacheRead: 600, cacheWrite: 100 });
  });

  it("books a response before any model line as unknown", () => {
    const state = createCodexParseState();

    expect(parseCodexTranscriptLine(codexUsageLine({ responseId: "r4" }), state)?.model).toBe(
      "unknown",
    );
  });

  it("follows a model change from thread settings or a later turn", () => {
    const state = createCodexParseState("gpt-fake-5");
    parseCodexTranscriptLine(codexThreadSettingsLine("gpt-fake-6"), state);
    expect(parseCodexTranscriptLine(codexUsageLine({ responseId: "r5" }), state)?.model).toBe(
      "gpt-fake-6",
    );

    parseCodexTranscriptLine(codexTurnContextLine("gpt-fake-7"), state);
    expect(state.model).toBe("gpt-fake-7");
  });

  it("returns nothing for a malformed line and leaves the model alone", () => {
    const state = createCodexParseState("gpt-fake-5");

    expect(parseCodexTranscriptLine('{"type":"token_usage_record","payload":', state)).toBeNull();
    expect(parseCodexTranscriptLine('{"type":"turn_context","payload":{"model":5}}', state)).toBe(
      null,
    );
    expect(state.model).toBe("gpt-fake-5");
  });

  it("attributes a subagent's response to the root session it reports", () => {
    const state = createCodexParseState("gpt-fake-5");
    const record = parseCodexTranscriptLine(
      codexUsageLine({ responseId: "r6", sessionId: "fake-root", threadId: "fake-child" }),
      state,
    );

    expect(record?.sessionId).toBe("fake-root");
  });
});
