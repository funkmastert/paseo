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

  test("accepts the optional shadow flag", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "jev.decide.request",
      requestId: "req-1",
      feature: "spawnHint",
      callSite: "classifier.spawn-hint",
      state: { title: "Fix the parser", prompt: "Rename the field", spawned_by: "a person" },
      questions,
      scope: { cwd: "/repo" },
      shadow: true,
    }) as { shadow?: true };

    expect(parsed.shadow).toBe(true);
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

describe("jev.ask", () => {
  test("routes a request with each question type through the session inbound union", () => {
    for (const question of [
      { type: "noul", instructions: "Is the build broken?" },
      { type: "choice", instructions: "Which area?", criteria: { parser: "Parsing", other: null } },
      { type: "score", instructions: "How risky?", criteria: ["Low", "Medium", "High"] },
    ]) {
      const parsed = SessionInboundMessageSchema.parse({
        type: "jev.ask.request",
        requestId: "req-1",
        context: "npm run build exits 2",
        question,
        agentId: "agent-1",
        deadlineMs: 15_000,
      });
      expect(parsed.type).toBe("jev.ask.request");
    }
  });

  test("routes an answered outcome and a refusal through the session outbound union", () => {
    const answered = {
      type: "jev.ask.response",
      payload: {
        requestId: "req-1",
        callId: "call-1",
        outcome: "answered",
        reason: null,
        answer: { type: "noul", noul: 0.82 },
        model: "typesafe/jev-1.13",
        elapsedMs: 312,
        cost: { usd: 0.0001, source: "reported" },
        redactions: 1,
      },
    };
    const refused = {
      type: "jev.ask.response",
      payload: {
        requestId: "req-2",
        callId: "call-2",
        outcome: "unavailable",
        reason: "excluded",
        answer: null,
        model: null,
        elapsedMs: 3,
        cost: null,
        redactions: 0,
      },
    };

    expect(SessionOutboundMessageSchema.parse(answered)).toEqual(answered);
    expect(SessionOutboundMessageSchema.parse(refused)).toEqual(refused);
  });

  test("advertises the capability on server_info", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv",
      features: { jev: true, jevAsk: true },
    });
    expect(parsed.features?.jevAsk).toBe(true);
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

  test("carries agentTools.served from a daemon with the tools, and parses one without it", () => {
    const served = { ...status, agentTools: { assignShare: 0.5, served: true } };
    const message = {
      type: "jev.status.response",
      payload: { requestId: "req-1", status: served },
    };
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
    const parsed = SessionOutboundMessageSchema.parse({
      type: "jev.status.response",
      payload: { requestId: "req-1", status },
    });
    expect(parsed.type === "jev.status.response" && parsed.payload.status.agentTools).toEqual({
      assignShare: 0.5,
    });
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

describe("jev.decisions.list savings fields", () => {
  test("carries mode, wouldBe and savingsId, and parses a record without them", () => {
    const base = {
      agentId: "agent-1",
      callId: "call-1",
      feature: "remediationTriage",
      question: "Should a fixer start?",
      verdict: "person (0.88)",
      confidence: 0.88,
      action: "started the fixer",
      applied: false,
      at: "2026-09-30T12:00:00.000Z",
      costUsd: null,
    };
    const message = {
      type: "jev.decisions.list.response",
      payload: {
        requestId: "req-1",
        agentId: "agent-1",
        decisions: [{ ...base, mode: "shadow", wouldBe: "skip-fixer", savingsId: "sv_1" }, base],
      },
    };

    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });
});

const modeTotals = { involvements: 3, changed: 1, tokens: 1200, otherBenefit: null, pending: 1 };

const savingsSummary = {
  range: "7d",
  from: "2026-09-24T07:00:00.000Z",
  to: "2026-09-30T19:00:00.000Z",
  unit: "opus-equivalent-weighted-tokens",
  live: { involvements: 3, tokensSaved: 1200 },
  shadow: { involvements: 5, tokensWouldSave: 9000 },
  jevSpend: { calls: 8, usd: 0.0008, tokensEquivalent: 200 },
  net: { live: 1000, ifLive: 10000 },
  features: [
    {
      feature: "notificationTriage",
      state: "shadow",
      benefit: "attention",
      asked: 4,
      notAsked: { inactive: 2 },
      live: modeTotals,
      shadow: { ...modeTotals, tokens: 0, otherBenefit: { unit: "pushes-held", value: 3 } },
      validation: { checked: 2, held: 2, wrong: 0 },
      jevUsd: 0.0004,
      evidence: { rule: "50 would-be notices, 80% held", observed: "2 of 50", met: null },
    },
  ],
  topAgents: [
    { id: "agent-1", label: "Fix the parser", involvements: 2, liveTokens: 0, shadowTokens: 4000 },
  ],
  topWorkspaces: [],
  days: [
    { day: "2026-09-30", involvements: 8, liveTokens: 1200, shadowTokens: 9000, jevUsd: 0.0008 },
  ],
};

describe("jev.savings.summary", () => {
  test("routes a request through the session inbound union", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "jev.savings.summary.request",
      requestId: "req-1",
      range: "7d",
    });

    expect(parsed.type).toBe("jev.savings.summary.request");
  });

  test("routes a summary through the session outbound union", () => {
    const message = {
      type: "jev.savings.summary.response",
      payload: { requestId: "req-1", summary: savingsSummary },
    };

    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });
});

describe("jev.savings.events", () => {
  test("routes a filtered, paged request through the session inbound union", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "jev.savings.events.request",
      requestId: "req-1",
      range: "all",
      feature: "readCheck",
      agentId: "agent-1",
      cursor: "sv_2",
      limit: 50,
    });

    expect(parsed.type).toBe("jev.savings.events.request");
  });

  test("routes events, pending and validated, through the session outbound union", () => {
    const event = {
      id: "sv_1",
      at: "2026-09-30T12:00:00.000Z",
      feature: "remediationTriage",
      agentId: "agent-1",
      agentTitle: null,
      workspaceId: null,
      mode: "shadow",
      outcome: "shadow",
      involvement: "Should a fixer start for this stalled agent?",
      decision: {
        did: "start-agent",
        wouldBe: "person",
        changed: false,
        detail: { episode: "ep-1", agentTotalTokens: 52000, fixed: false, model: null },
      },
      benefit: "tokens",
      tokensSavedEstimate: 52000,
      otherBenefit: null,
      basis: { formula: "A x w(m)", inputs: { A: 52000, "w(m)": 1, model: "claude-opus-5-5" } },
      pending: false,
      validation: { outcome: "held", signal: null, afterMinutes: 42 },
      jevCostUsd: 0.0001,
    };
    const message = {
      type: "jev.savings.events.response",
      payload: {
        requestId: "req-1",
        events: [
          event,
          {
            ...event,
            id: "sv_0",
            tokensSavedEstimate: null,
            basis: null,
            pending: true,
            validation: null,
          },
        ],
        nextCursor: "sv_0",
      },
    };

    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  test("server_info carries the jevSavings capability, and an older daemon's omits it", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv",
      features: { jev: true, jevAsk: true, jevSavings: true },
    });
    const older = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv",
      features: { jev: true, jevAsk: true },
    });

    expect(parsed.features?.jevSavings).toBe(true);
    expect(older.features?.jevSavings).toBeUndefined();
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
