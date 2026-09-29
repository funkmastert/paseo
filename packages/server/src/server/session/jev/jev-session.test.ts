import { describe, expect, it, vi } from "vitest";
import { createJevSession, JevSession } from "./jev-session.js";
import type {
  JevDecideInput,
  JevDecisionNote,
  JevDecisionRecord,
  JevEgressScope,
  JevOutcome,
  JevService,
  JevStatus,
} from "../../jev/contract.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";

const FEATURE_STATUS = { enabled: true, shadow: true };
const SPEND_TOTALS = {
  calls: 0,
  answered: 0,
  failed: 0,
  unavailable: 0,
  inputTokens: 0,
  usd: 0,
  usdSource: "none" as const,
};
const LANE_STATUS = {
  today: SPEND_TOTALS,
  maxUsdPerDay: 1,
  exhausted: false,
  circuit: "closed" as const,
  resetsAt: "2026-09-29T07:00:00.000Z",
};

const BASE_STATUS: JevStatus = {
  available: true,
  reason: null,
  keyPresent: true,
  provider: "fake",
  model: "jev-fake",
  features: {
    spawnHint: FEATURE_STATUS,
    remediationTriage: FEATURE_STATUS,
    notificationTriage: FEATURE_STATUS,
    agentTools: { enabled: true, shadow: false },
    compactionTiming: FEATURE_STATUS,
    stallJudgment: FEATURE_STATUS,
  },
  lanes: { control: LANE_STATUS, agentTools: LANE_STATUS },
  spawnHint: { applyHard: false, applyRole: false },
  agentTools: { assignShare: 0.5 },
  todayByFeature: {
    spawnHint: SPEND_TOTALS,
    remediationTriage: SPEND_TOTALS,
    notificationTriage: SPEND_TOTALS,
    agentTools: SPEND_TOTALS,
    compactionTiming: SPEND_TOTALS,
    stallJudgment: SPEND_TOTALS,
  },
  last7Days: [],
};

interface FakeJevServiceOptions {
  decide?: (input: JevDecideInput) => Promise<JevOutcome> | JevOutcome;
  checkScope?: (scope: JevEgressScope) => Promise<"ok" | "excluded">;
  status?: () => JevStatus;
  listDecisions?: (agentId: string) => JevDecisionRecord[];
}

function createFakeJevService(options: FakeJevServiceOptions = {}) {
  const recorded: JevDecisionNote[] = [];
  const service: JevService = {
    decide: async (input) => {
      if (!options.decide) throw new Error("decide not scripted");
      return options.decide(input);
    },
    isActive: () => true,
    checkScope: async (scope) => (options.checkScope ? options.checkScope(scope) : "ok"),
    status: () => (options.status ? options.status() : BASE_STATUS),
    decisions: { record: (note) => recorded.push(note) },
    listDecisions: (agentId) => (options.listDecisions ? options.listDecisions(agentId) : []),
  };
  return { service, recorded };
}

function createFakeHost() {
  const emitted: SessionOutboundMessage[] = [];
  return { host: { emit: (msg: SessionOutboundMessage) => emitted.push(msg) }, emitted };
}

const answeredOutcome: Extract<JevOutcome, { kind: "answered" }> = {
  kind: "answered",
  callId: "call-1",
  answers: {
    task_class: {
      type: "choice",
      choice: "mechanical",
      probabilities: { mechanical: 0.91, other: 0.09 },
      confidence: 0.91,
    },
    reasoning: {
      type: "score",
      score: 0.6,
      legend: { "0": "None", "1": "Some", "2": "Deep" },
      probabilities: { "0": 0.7, "1": 0.2, "2": 0.1 },
      confidence: 0.7,
    },
  },
  meta: {
    model: "typesafe/jev-1.13",
    elapsedMs: 312,
    attempts: 1,
    inputTokens: 1500,
    outputTokens: 20,
    stateBytes: 100,
    bodyBytes: 300,
    redactions: 0,
    cost: { usd: 0.0001, source: "reported" },
  },
};

describe("JevSession.handleDecide", () => {
  it("rejects a feature other than spawnHint without calling the service", async () => {
    const decide = vi.fn();
    const { service } = createFakeJevService({ decide });
    const { host, emitted } = createFakeHost();
    const session = new JevSession({ host, service, logger: { warn: vi.fn() } });

    await session.handleDecide({
      type: "jev.decide.request",
      requestId: "req-1",
      feature: "agentTools",
      callSite: "tools.ask_jev",
      state: {},
      questions: {},
    } as Extract<SessionInboundMessage, { type: "jev.decide.request" }>);

    expect(decide).not.toHaveBeenCalled();
    expect(emitted).toEqual([
      {
        type: "jev.decide.response",
        payload: {
          requestId: "req-1",
          callId: "rejected:req-1",
          outcome: "failed",
          reason: "invalid-request",
          answers: null,
          model: null,
          elapsedMs: expect.any(Number),
        },
      },
    ]);
  });

  it("sends a missing scope when the request carries none", async () => {
    let seenScope: JevEgressScope | undefined;
    const { service } = createFakeJevService({
      decide: (input) => {
        seenScope = input.scope;
        return { kind: "unavailable", callId: "call-2", reason: "excluded" };
      },
    });
    const { host } = createFakeHost();
    const session = new JevSession({ host, service, logger: { warn: vi.fn() } });

    await session.handleDecide({
      type: "jev.decide.request",
      requestId: "req-1",
      feature: "spawnHint",
      callSite: "classifier.spawn-hint",
      state: {},
      questions: {},
    } as Extract<SessionInboundMessage, { type: "jev.decide.request" }>);

    expect(seenScope).toEqual({ cwds: [], missing: true });
  });

  it("maps the wire scope to cwds and agentIds, and sets the caller subject", async () => {
    let seenInput: JevDecideInput | undefined;
    const { service } = createFakeJevService({
      decide: (input) => {
        seenInput = input;
        return { kind: "unavailable", callId: "call-3", reason: "excluded" };
      },
    });
    const { host } = createFakeHost();
    const session = new JevSession({ host, service, logger: { warn: vi.fn() } });

    await session.handleDecide({
      type: "jev.decide.request",
      requestId: "req-1",
      feature: "spawnHint",
      callSite: "classifier.spawn-hint",
      state: {},
      questions: {},
      scope: { cwd: "/repo", parentAgentId: "agent-parent" },
    } as Extract<SessionInboundMessage, { type: "jev.decide.request" }>);

    expect(seenInput?.scope).toEqual({ cwds: ["/repo"], agentIds: ["agent-parent"] });
    expect(seenInput?.subject).toEqual({ callerAgentId: "agent-parent" });
  });

  it("records a decision note and responds with the answers on an answered outcome", async () => {
    const { service, recorded } = createFakeJevService({ decide: () => answeredOutcome });
    const { host, emitted } = createFakeHost();
    const session = new JevSession({ host, service, logger: { warn: vi.fn() } });

    await session.handleDecide({
      type: "jev.decide.request",
      requestId: "req-1",
      feature: "spawnHint",
      callSite: "classifier.spawn-hint",
      state: {},
      questions: {},
      scope: { cwd: "/repo" },
    } as Extract<SessionInboundMessage, { type: "jev.decide.request" }>);

    expect(recorded).toEqual([
      {
        agentId: null,
        callId: "call-1",
        feature: "spawnHint",
        question: "What class of work is this create?",
        verdict: "task_class mechanical 0.91, reasoning 0.6",
        confidence: 0.91,
        action: "classifier input at create",
        applied: false,
      },
    ]);
    expect(emitted).toEqual([
      {
        type: "jev.decide.response",
        payload: {
          requestId: "req-1",
          callId: "call-1",
          outcome: "answered",
          reason: null,
          answers: answeredOutcome.answers,
          model: "typesafe/jev-1.13",
          elapsedMs: 312,
        },
      },
    ]);
  });

  it("also records a decision note on a shadow outcome", async () => {
    const shadowOutcome: JevOutcome = { ...answeredOutcome, kind: "shadow" };
    const { service, recorded } = createFakeJevService({ decide: () => shadowOutcome });
    const { host } = createFakeHost();
    const session = new JevSession({ host, service, logger: { warn: vi.fn() } });

    await session.handleDecide({
      type: "jev.decide.request",
      requestId: "req-1",
      feature: "spawnHint",
      callSite: "classifier.spawn-hint",
      state: {},
      questions: {},
    } as Extract<SessionInboundMessage, { type: "jev.decide.request" }>);

    expect(recorded).toHaveLength(1);
  });

  it("does not record a decision and reports the reason on an unavailable outcome", async () => {
    const { service, recorded } = createFakeJevService({
      decide: () => ({ kind: "unavailable", callId: "call-4", reason: "no-key" }),
    });
    const { host, emitted } = createFakeHost();
    const session = new JevSession({ host, service, logger: { warn: vi.fn() } });

    await session.handleDecide({
      type: "jev.decide.request",
      requestId: "req-1",
      feature: "spawnHint",
      callSite: "classifier.spawn-hint",
      state: {},
      questions: {},
    } as Extract<SessionInboundMessage, { type: "jev.decide.request" }>);

    expect(recorded).toEqual([]);
    expect(emitted[0]).toEqual({
      type: "jev.decide.response",
      payload: {
        requestId: "req-1",
        callId: "call-4",
        outcome: "unavailable",
        reason: "no-key",
        answers: null,
        model: null,
        elapsedMs: expect.any(Number),
      },
    });
  });

  it("reports the failure's own meta model and elapsed time", async () => {
    const { service } = createFakeJevService({
      decide: () => ({
        kind: "failed",
        callId: "call-5",
        reason: "contract",
        meta: { ...answeredOutcome.meta, model: "typesafe/jev-1.13", elapsedMs: 999 },
      }),
    });
    const { host, emitted } = createFakeHost();
    const session = new JevSession({ host, service, logger: { warn: vi.fn() } });

    await session.handleDecide({
      type: "jev.decide.request",
      requestId: "req-1",
      feature: "spawnHint",
      callSite: "classifier.spawn-hint",
      state: {},
      questions: {},
    } as Extract<SessionInboundMessage, { type: "jev.decide.request" }>);

    expect(emitted[0]).toEqual({
      type: "jev.decide.response",
      payload: {
        requestId: "req-1",
        callId: "call-5",
        outcome: "failed",
        reason: "contract",
        answers: null,
        model: "typesafe/jev-1.13",
        elapsedMs: 999,
      },
    });
  });

  it("answers failed/invalid-request when the service throws, never letting the throw escape", async () => {
    const { service } = createFakeJevService({
      decide: () => {
        throw new Error("state contained something secret-shaped");
      },
    });
    const { host, emitted } = createFakeHost();
    const session = new JevSession({ host, service, logger: { warn: vi.fn() } });

    await expect(
      session.handleDecide({
        type: "jev.decide.request",
        requestId: "req-1",
        feature: "spawnHint",
        callSite: "classifier.spawn-hint",
        state: {},
        questions: {},
      } as Extract<SessionInboundMessage, { type: "jev.decide.request" }>),
    ).resolves.toBeUndefined();

    expect(emitted[0]).toMatchObject({
      type: "jev.decide.response",
      payload: { outcome: "failed", reason: "invalid-request", answers: null, model: null },
    });
  });
});

describe("JevSession.handleStatus", () => {
  it("emits the service's status", async () => {
    const { service } = createFakeJevService({ status: () => BASE_STATUS });
    const { host, emitted } = createFakeHost();
    const session = new JevSession({ host, service, logger: { warn: vi.fn() } });

    await session.handleStatus({
      type: "jev.status.request",
      requestId: "req-1",
    } as Extract<SessionInboundMessage, { type: "jev.status.request" }>);

    expect(emitted).toEqual([
      { type: "jev.status.response", payload: { requestId: "req-1", status: BASE_STATUS } },
    ]);
  });

  it("logs and reports unavailable when status() throws", async () => {
    const warn = vi.fn();
    const { service } = createFakeJevService({
      status: () => {
        throw new Error("boom");
      },
    });
    const { host, emitted } = createFakeHost();
    const session = new JevSession({ host, service, logger: { warn } });

    await session.handleStatus({
      type: "jev.status.request",
      requestId: "req-1",
    } as Extract<SessionInboundMessage, { type: "jev.status.request" }>);

    expect(warn).toHaveBeenCalled();
    const message = emitted[0] as Extract<SessionOutboundMessage, { type: "jev.status.response" }>;
    expect(message.payload.status.available).toBe(false);
  });
});

describe("JevSession.handleScopeCheck", () => {
  it("passes the cwd and optional parent through to checkScope", async () => {
    let seenScope: JevEgressScope | undefined;
    const { service } = createFakeJevService({
      checkScope: (scope) => {
        seenScope = scope;
        return Promise.resolve("ok");
      },
    });
    const { host, emitted } = createFakeHost();
    const session = new JevSession({ host, service, logger: { warn: vi.fn() } });

    await session.handleScopeCheck({
      type: "jev.scope.check.request",
      requestId: "req-1",
      cwd: "/repo",
      parentAgentId: "agent-parent",
    } as Extract<SessionInboundMessage, { type: "jev.scope.check.request" }>);

    expect(seenScope).toEqual({ cwds: ["/repo"], agentIds: ["agent-parent"] });
    expect(emitted).toEqual([
      { type: "jev.scope.check.response", payload: { requestId: "req-1", scope: "ok" } },
    ]);
  });

  it("answers excluded when checkScope throws", async () => {
    const { service } = createFakeJevService({
      checkScope: () => {
        throw new Error("git error");
      },
    });
    const { host, emitted } = createFakeHost();
    const session = new JevSession({ host, service, logger: { warn: vi.fn() } });

    await session.handleScopeCheck({
      type: "jev.scope.check.request",
      requestId: "req-1",
      cwd: "/repo",
    } as Extract<SessionInboundMessage, { type: "jev.scope.check.request" }>);

    expect(emitted).toEqual([
      { type: "jev.scope.check.response", payload: { requestId: "req-1", scope: "excluded" } },
    ]);
  });
});

describe("JevSession.handleDecisionsList", () => {
  it("returns the service's decisions for the agent", async () => {
    const record: JevDecisionRecord = {
      agentId: "agent-1",
      callId: "call-1",
      feature: "spawnHint",
      question: "What class of work is this create?",
      verdict: "mechanical (0.91)",
      confidence: 0.91,
      action: "classifier input at create",
      applied: true,
      at: "2026-09-28T12:00:00.000Z",
      costUsd: 0.0001,
    };
    const { service } = createFakeJevService({ listDecisions: () => [record] });
    const { host, emitted } = createFakeHost();
    const session = new JevSession({ host, service, logger: { warn: vi.fn() } });

    await session.handleDecisionsList({
      type: "jev.decisions.list.request",
      requestId: "req-1",
      agentId: "agent-1",
    } as Extract<SessionInboundMessage, { type: "jev.decisions.list.request" }>);

    expect(emitted).toEqual([
      {
        type: "jev.decisions.list.response",
        payload: { requestId: "req-1", agentId: "agent-1", decisions: [record] },
      },
    ]);
  });

  it("answers an empty list when listDecisions throws", async () => {
    const warn = vi.fn();
    const { service } = createFakeJevService({
      listDecisions: () => {
        throw new Error("boom");
      },
    });
    const { host, emitted } = createFakeHost();
    const session = new JevSession({ host, service, logger: { warn } });

    await session.handleDecisionsList({
      type: "jev.decisions.list.request",
      requestId: "req-1",
      agentId: "agent-1",
    } as Extract<SessionInboundMessage, { type: "jev.decisions.list.request" }>);

    expect(warn).toHaveBeenCalled();
    expect(emitted).toEqual([
      {
        type: "jev.decisions.list.response",
        payload: { requestId: "req-1", agentId: "agent-1", decisions: [] },
      },
    ]);
  });
});

describe("createJevSession", () => {
  it("is null when the host has no service", () => {
    expect(
      createJevSession({
        host: createFakeHost().host,
        service: undefined,
        logger: { warn: vi.fn() },
      }),
    ).toBeNull();
    expect(
      createJevSession({ host: createFakeHost().host, service: null, logger: { warn: vi.fn() } }),
    ).toBeNull();
  });

  it("is a JevSession when a service is given", () => {
    const { service } = createFakeJevService();
    expect(
      createJevSession({ host: createFakeHost().host, service, logger: { warn: vi.fn() } }),
    ).toBeInstanceOf(JevSession);
  });
});
