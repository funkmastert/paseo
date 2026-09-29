import { describe, expect, test } from "vitest";
import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

const questions = {
  task_class: {
    type: "choice",
    instructions: "Which class of work does `prompt` hand to the new agent?",
    criteria: { mechanical: "Rote and fully specified", other: "None of these" },
  },
};

const answers = {
  task_class: {
    type: "choice",
    choice: "mechanical",
    probabilities: { mechanical: 0.91, other: 0.09 },
    confidence: 0.91,
  },
};

describe("jev.decide", () => {
  test("routes a request through the session inbound union", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "jev.decide.request",
      requestId: "req-1",
      feature: "spawnHint",
      callSite: "classifier.spawn-hint",
      state: { title: "Fix the parser", prompt: "Rename the field", spawned_by: "a person" },
      questions,
      scope: { cwd: "/repo" },
    });

    expect(parsed.type).toBe("jev.decide.request");
  });

  test("routes an answered outcome through the session outbound union", () => {
    const message = {
      type: "jev.decide.response",
      payload: {
        requestId: "req-1",
        callId: "call-1",
        outcome: "answered",
        reason: null,
        answers,
        model: "typesafe/jev-1.13",
        elapsedMs: 312,
      },
    };

    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  test("accepts an outcome this client does not know, with unknown extra fields", () => {
    const message = {
      type: "jev.decide.response",
      payload: {
        requestId: "req-1",
        callId: "call-1",
        outcome: "some_future_outcome",
        reason: null,
        answers: null,
        model: null,
        elapsedMs: 4,
        futureField: "ignored",
      },
    };

    expect(SessionOutboundMessageSchema.safeParse(message).success).toBe(true);
  });
});

describe("jev.status", () => {
  const status = {
    available: true,
    reason: null,
    keyPresent: true,
    provider: "openrouter",
    model: "~typesafe/jev-latest",
    features: { spawnHint: { enabled: true, shadow: true } },
    lanes: {
      control: {
        today: {
          calls: 1,
          answered: 1,
          failed: 0,
          unavailable: 0,
          inputTokens: 2000,
          usd: 0.0001,
          usdSource: "estimated",
        },
        maxUsdPerDay: 1,
        exhausted: false,
        circuit: "closed",
        resetsAt: "2026-09-29T07:00:00.000Z",
      },
    },
    spawnHint: { applyHard: false, applyRole: false },
    agentTools: { assignShare: 0.5 },
    todayByFeature: {},
    last7Days: [{ day: "2026-09-28", calls: 1, usd: 0.0001 }],
  };

  test("routes a request through the session inbound union", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "jev.status.request",
      requestId: "req-1",
    });

    expect(parsed.type).toBe("jev.status.request");
  });

  test("routes the status through the session outbound union", () => {
    const message = { type: "jev.status.response", payload: { requestId: "req-1", status } };

    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  test("accepts a lane and a circuit state this client does not know", () => {
    const message = {
      type: "jev.status.response",
      payload: {
        requestId: "req-1",
        status: {
          ...status,
          lanes: {
            ...status.lanes,
            someFutureLane: { ...status.lanes.control, circuit: "some_future_circuit" },
          },
        },
      },
    };

    expect(SessionOutboundMessageSchema.safeParse(message).success).toBe(true);
  });
});

describe("jev.scope.check", () => {
  test("routes a request with an optional parent through the session inbound union", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "jev.scope.check.request",
      requestId: "req-1",
      cwd: "/repo",
      parentAgentId: "agent-1",
    });

    expect(parsed.type).toBe("jev.scope.check.request");
  });

  test("routes the scope through the session outbound union", () => {
    const message = {
      type: "jev.scope.check.response",
      payload: { requestId: "req-1", scope: "excluded" },
    };

    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });
});

describe("jev.decisions.list", () => {
  test("routes a request through the session inbound union", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "jev.decisions.list.request",
      requestId: "req-1",
      agentId: "agent-1",
    });

    expect(parsed.type).toBe("jev.decisions.list.request");
  });

  test("routes decisions, including a null agentId, through the session outbound union", () => {
    const message = {
      type: "jev.decisions.list.response",
      payload: {
        requestId: "req-1",
        agentId: "agent-1",
        decisions: [
          {
            agentId: null,
            callId: "call-1",
            feature: "spawnHint",
            question: "What class of work is this create?",
            verdict: "mechanical (0.91)",
            confidence: 0.91,
            action: "classifier input at create",
            applied: false,
            at: "2026-09-28T12:00:00.000Z",
            costUsd: 0.0001,
          },
        ],
      },
    };

    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });
});

test("an older daemon's server_info parses without the jev capability", () => {
  const parsed = ServerInfoStatusPayloadSchema.parse({
    status: "server_info",
    serverId: "srv",
    features: { usageHistory: true },
  });

  expect(parsed.features?.jev).toBeUndefined();
});
