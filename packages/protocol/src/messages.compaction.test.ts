import { describe, expect, test } from "vitest";
import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";

const episode = {
  id: "leader-1:1000",
  agentId: "leader-1",
  agentTitle: "Ship the thing",
  source: "monitor",
  trigger: "line",
  triggerReason: null,
  startedAtMs: 1000,
  endedAtMs: 1700,
  steps: [
    {
      step: "prepare",
      startedAtMs: 1000,
      endedAtMs: 1100,
      outcome: "completed",
      costWeightedTokens: 50,
    },
    {
      step: "compact",
      startedAtMs: 1200,
      endedAtMs: 1500,
      outcome: "completed",
      costWeightedTokens: 100,
    },
    {
      step: "restore",
      startedAtMs: 1600,
      endedAtMs: 1700,
      outcome: "completed",
      costWeightedTokens: 25,
    },
  ],
  contextBeforeTokens: 612_000,
  contextAfterTokens: 31_000,
  outcome: "done",
  noteLength: 120,
  promptsCarried: null,
  quietGate: null,
  costWeightedTokens: 175,
  costBasis: "measured",
  estimatedSavedWeightedTokens: 38_000,
};

describe("compaction.episodes.list", () => {
  test("routes the request through the session inbound union", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "compaction.episodes.list.request",
      requestId: "req-1",
      range: "7d",
    });

    expect(parsed.type).toBe("compaction.episodes.list.request");
  });

  test("accepts the optional agentId, cursor and limit", () => {
    const result = SessionInboundMessageSchema.safeParse({
      type: "compaction.episodes.list.request",
      requestId: "req-1",
      range: "today",
      agentId: "leader-1",
      cursor: "1000",
      limit: 25,
    });

    expect(result.success).toBe(true);
  });

  test("routes a response with one episode through the session outbound union", () => {
    const message = {
      type: "compaction.episodes.list.response",
      payload: { requestId: "req-1", episodes: [episode], nextCursor: null },
    };

    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  test("the generated client validator accepts the response", () => {
    const message = {
      type: "compaction.episodes.list.response",
      payload: { requestId: "req-1", episodes: [episode], nextCursor: null },
    };

    expect(validateWSOutboundMessage({ type: "session", message }).success).toBe(true);
  });

  test("a row with no promptsCarried or quietGate (an older or pre-quiet-gate episode) parses", () => {
    const { promptsCarried: _promptsCarried, quietGate: _quietGate, ...rest } = episode;
    const message = {
      type: "compaction.episodes.list.response",
      payload: { requestId: "req-1", episodes: [rest], nextCursor: null },
    };

    expect(SessionOutboundMessageSchema.safeParse(message).success).toBe(true);
  });

  test("a quiet-gate hold, carried prompts and a shared step parse, generated validator included", () => {
    const held = {
      ...episode,
      quietGate: { heldFromMs: 400, heldUntilMs: 1000, heldMs: 600 },
      promptsCarried: [{ atMs: 900, text: "also fix the login bug" }],
      steps: [{ ...episode.steps[0], costWeightedTokens: null, steeredIn: 1 }],
    };
    const message = {
      type: "compaction.episodes.list.response",
      payload: { requestId: "req-1", episodes: [held], nextCursor: null },
    };

    const parsed = SessionOutboundMessageSchema.parse(message);
    expect(parsed).toEqual(message);
    expect(validateWSOutboundMessage({ type: "session", message }).success).toBe(true);
  });

  test("accepts a trigger, source or outcome an older client doesn't know yet", () => {
    // Open strings, not closed enums (docs/protocol-compatibility.md -- never narrow): a daemon
    // that adds a new trigger kind, episode source, or outcome must not fail validation on an
    // app that predates it.
    const message = {
      type: "compaction.episodes.list.response",
      payload: {
        requestId: "req-1",
        episodes: [{ ...episode, source: "future-source", trigger: "future-trigger" }],
        nextCursor: null,
      },
    };

    expect(SessionOutboundMessageSchema.safeParse(message).success).toBe(true);
  });

  test("an unmeasured episode's null cost and costBasis round-trip", () => {
    const message = {
      type: "compaction.episodes.list.response",
      payload: {
        requestId: "req-1",
        episodes: [
          {
            ...episode,
            source: "backfill",
            costWeightedTokens: null,
            costBasis: "unmeasured",
            steps: episode.steps.map((step) =>
              Object.assign({}, step, { costWeightedTokens: null }),
            ),
          },
        ],
        nextCursor: null,
      },
    };

    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });
});

describe("compaction.episodes.summary", () => {
  test("routes the request and response through the session unions", () => {
    const request = SessionInboundMessageSchema.parse({
      type: "compaction.episodes.summary.request",
      requestId: "req-1",
      range: "all",
    });
    expect(request.type).toBe("compaction.episodes.summary.request");

    const response = {
      type: "compaction.episodes.summary.response",
      payload: {
        requestId: "req-1",
        summary: {
          count: 3,
          totalCostWeightedTokens: 525,
          averageCostWeightedTokens: 175,
          totalEstimatedSavedWeightedTokens: 114_000,
          measuredCount: 3,
          unmeasuredCount: 0,
        },
      },
    };
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  });
});

describe("server_info compactionLedger capability", () => {
  test("carries the compactionLedger capability, and an older daemon's omits it", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv",
      features: { compactionLedger: true },
    });
    const older = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv",
      features: { usageHistory: true },
    });

    expect(parsed.features?.compactionLedger).toBe(true);
    expect(older.features?.compactionLedger).toBeUndefined();
  });
});
