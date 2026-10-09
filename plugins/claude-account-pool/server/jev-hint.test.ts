import { afterEach, describe, expect, it, vi } from "vitest";
import type { JevAnswers, JevDecideResponse } from "@getpaseo/protocol/jev/rpc-schemas";
import { DEFAULT_THINKING_POLICY, type RoleModelPolicy } from "../shared/role-policy-schema";
import { classifyAgent, type ClassifierInput, type ClassifierWorld } from "./classifier";
import type { ModelThinkingOptions, ThinkingCatalog } from "./model-catalog";
import {
  SPAWN_HINT_DEADLINE_MS,
  SPAWN_HINT_DECLARED_AUDIT_DEADLINE_MS,
  SPAWN_HINT_DECLARED_AUDIT_PLUGIN_TIMEOUT_MS,
  SPAWN_HINT_DECLARED_AUDIT_RPC_TIMEOUT_MS,
  SPAWN_HINT_PLUGIN_TIMEOUT_MS,
  SPAWN_HINT_PROMPT_CHARS,
  SPAWN_HINT_RPC_TIMEOUT_MS,
  buildSpawnHintQuestions,
  fetchSpawnHint,
  planSpawnHint,
  readSpawnHintAnswers,
  spawnHintPreview,
  type SpawnHint,
  type SpawnHintAvailability,
  type SpawnHintPaseo,
} from "./jev-hint";

/** Tyler's live policy shape: a worker's three pools differ, the leader's do not. */
const POLICY: RoleModelPolicy = {
  schemaVersion: 4,
  roles: [
    {
      id: "worker",
      name: "Worker",
      standard: true,
      aliases: [],
      models: ["claude-sonnet-5", "claude-haiku-4-5-20251001"],
      mechanicalModels: ["claude-haiku-4-5-20251001"],
      hardModels: ["claude-opus-5-5", "claude-opus-5"],
      toolProfile: { kind: "unrestricted" },
    },
    {
      id: "reviewer",
      name: "Reviewer",
      standard: true,
      aliases: [],
      models: ["claude-sonnet-5"],
      mechanicalModels: [],
      hardModels: ["claude-opus-5-5"],
      toolProfile: { kind: "read-only" },
    },
    {
      id: "advisor",
      name: "Advisor",
      standard: true,
      aliases: ["oracle"],
      models: ["claude-opus-5-5", "claude-sonnet-5"],
      mechanicalModels: [],
      hardModels: [],
      toolProfile: { kind: "unrestricted" },
    },
    {
      id: "leader",
      name: "leader",
      standard: true,
      aliases: [],
      models: ["claude-opus-5-5"],
      mechanicalModels: [],
      hardModels: ["claude-opus-5-5"],
      toolProfile: { kind: "unrestricted" },
    },
    {
      // Haiku only, so no class changes its model or thinking.
      id: "scribe",
      name: "Scribe",
      standard: false,
      aliases: ["notetaker"],
      models: ["claude-haiku-4-5-20251001"],
      mechanicalModels: [],
      hardModels: [],
      toolProfile: { kind: "unrestricted" },
    },
  ],
  agentTypeMappings: { worker: "worker" },
  modelBudgetThresholdPct: 80,
  enforceToolsOnClassifiedRoles: false,
  thinking: DEFAULT_THINKING_POLICY,
  childOutputStyle: null,
} as unknown as RoleModelPolicy;

const MODELS = ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"];

function thinkingCatalog(): ThinkingCatalog {
  const levels: ModelThinkingOptions = { optionIds: ["low", "medium", "high", "xhigh", "max"], defaultOptionId: "high" };
  return new Map([
    [
      "claude",
      new Map<string, ModelThinkingOptions>([
        ["claude-opus-5-5", levels],
        ["claude-opus-5", levels],
        ["claude-sonnet-5", levels],
        ["claude-haiku-4-5-20251001", { optionIds: [] }],
      ]),
    ],
  ]);
}

function world(policy: RoleModelPolicy = POLICY): ClassifierWorld {
  return {
    policy,
    catalog: new Map([["claude", new Set(MODELS)]]),
    thinkingCatalog: thinkingCatalog(),
    pool: { workers: [{ providerId: "claude-work", priority: 1 }], leader: { providerId: "claude" } },
    health: {
      isHealthyFor: () => true,
      isLastResortEligible: () => true,
      windowUtilization: () => undefined,
    },
  } as unknown as ClassifierWorld;
}

/** An unlabelled child whose prompt matches no seed keyword. */
function child(overrides: Partial<ClassifierInput> = {}): ClassifierInput {
  return {
    callerAgentId: "parent-1",
    requestedProvider: "claude",
    title: "retry helper",
    initialPrompt: "Implement the retry helper in src/net.ts and add a unit test.",
    ...overrides,
  };
}

/** A child with a declared role, so only the class is asked. */
function worker(overrides: Partial<ClassifierInput> = {}): ClassifierInput {
  return child({ labels: { "paseo.agent-role": "worker" }, ...overrides });
}

const LIVE: SpawnHintAvailability = {
  active: true,
  reason: null,
  shadow: false,
  applyHard: false,
  applyRole: false,
  auditDeclared: false,
};

type DecidePayload = JevDecideResponse["payload"];

/** Scripted answers, shaped like the daemon's validated `JevAnswers`. */
function answers(script: {
  taskClass?: [string, number];
  reasoning?: [number, number?];
  role?: [string, number];
}): JevAnswers {
  const out: JevAnswers = {};
  if (script.taskClass) {
    out.task_class = { type: "choice", choice: script.taskClass[0], probabilities: {}, confidence: script.taskClass[1] };
  }
  if (script.reasoning) {
    out.reasoning = {
      type: "score",
      score: script.reasoning[0],
      legend: {},
      probabilities: {},
      confidence: script.reasoning[1] ?? 0.8,
    };
  }
  if (script.role) {
    out.role = { type: "choice", choice: script.role[0], probabilities: {}, confidence: script.role[1] };
  }
  return out;
}

function payload(overrides: Partial<DecidePayload> = {}): DecidePayload {
  return {
    requestId: "r1",
    callId: "jev-call-1",
    outcome: "answered",
    reason: null,
    answers: null,
    model: "jev-fake",
    elapsedMs: 12,
    ...overrides,
  };
}

/** `paseo.jev` with a scripted `decide`, typed by the protocol's RPC schemas. */
function stubPaseo(respond: () => Promise<DecidePayload>) {
  const decide = vi.fn(respond);
  const paseo = { jev: { decide } } as unknown as SpawnHintPaseo;
  return { paseo, decide };
}

async function hintFor(
  input: ClassifierInput,
  response: Partial<DecidePayload>,
  availability: SpawnHintAvailability = LIVE,
  policy: RoleModelPolicy = POLICY,
): Promise<SpawnHint> {
  const { paseo } = stubPaseo(async () => payload(response));
  return fetchSpawnHint({ input, cwd: "/Users/t/code/app", world: world(policy), availability, paseo });
}

function decideWith(input: ClassifierInput, hint: SpawnHint | undefined, policy: RoleModelPolicy = POLICY) {
  return classifyAgent(hint ? { ...input, jevHint: hint } : input, world(policy));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("when the spawn hint is asked", () => {
  it("asks for an unlabelled child whose class changes its model, with the role when the role is a guess", () => {
    expect(planSpawnHint(child(), world(), { applyRole: false, auditDeclared: false, rankingActive: false })).toEqual({
      ask: true,
      taskClass: true,
      role: true,
      workKind: false,
      declaredAudit: false,
    });
  });

  it("does not ask when a label declares the class", async () => {
    const { paseo, decide } = stubPaseo(async () => payload());
    const input = child({ labels: { "paseo.task-class": "standard" } });

    const hint = await fetchSpawnHint({ input, cwd: "/w", world: world(), availability: LIVE, paseo });

    expect(hint).toEqual({ status: "not-needed", reason: "declared" });
    expect(decide).not.toHaveBeenCalled();
  });

  it("does not ask for a root create: a leader's class cannot change what it runs", async () => {
    const { paseo, decide } = stubPaseo(async () => payload());
    const input = child({ callerAgentId: undefined });

    const hint = await fetchSpawnHint({ input, cwd: "/w", world: world(), availability: LIVE, paseo });

    expect(hint).toEqual({ status: "not-needed", reason: "leader" });
    expect(decide).not.toHaveBeenCalled();
  });

  it("asks for a caller-less create that declares a worker role, which is placed like a child", () => {
    const input = child({ callerAgentId: undefined, labels: { "paseo.agent-type": "worker" } });

    expect(planSpawnHint(input, world(), { applyRole: false, auditDeclared: false, rankingActive: false })).toEqual({
      ask: true,
      taskClass: true,
      role: false,
      workKind: false,
      declaredAudit: false,
    });
  });

  it("does not ask when a risk keyword already made it hard, which JEV cannot lower", () => {
    const input = child({ initialPrompt: "Plan the database migration for the orders table." });

    expect(planSpawnHint(input, world(), { applyRole: false, auditDeclared: false, rankingActive: false })).toEqual({
      ask: false,
      skip: "hard-seed",
    });
  });

  it("does not ask with no title or prompt", () => {
    expect(
      planSpawnHint(child({ title: "", initialPrompt: "" }), world(), { applyRole: false, auditDeclared: false, rankingActive: false }),
    ).toEqual({
      ask: false,
      skip: "no-text",
    });
  });

  it("does not ask when every class runs the same model at the same level for the role", () => {
    const input = child({ labels: { "paseo.agent-role": "Scribe" } });

    expect(planSpawnHint(input, world(), { applyRole: true, auditDeclared: false, rankingActive: false })).toEqual({
      ask: false,
      skip: "no-effect",
    });
  });

  it("asks the role alone only with applyRole on", () => {
    // A declared class, but the role is still a keyword guess.
    const input = child({ labels: { "paseo.task-class": "standard" } });

    expect(planSpawnHint(input, world(), { applyRole: false, auditDeclared: false, rankingActive: false })).toEqual({
      ask: false,
      skip: "declared",
    });
    expect(planSpawnHint(input, world(), { applyRole: true, auditDeclared: false, rankingActive: false })).toEqual({
      ask: true,
      taskClass: false,
      role: true,
      workKind: false,
      declaredAudit: false,
    });
  });

  describe("the declared-label audit", () => {
    it("asks a declared child in shadow when auditDeclared is on, and never a root create", () => {
      // Its role ("worker") is declared too, so no live role ask can compete with the audit.
      const declared = child({ labels: { "paseo.task-class": "hard", "paseo.agent-role": "worker" } });

      expect(planSpawnHint(declared, world(), { applyRole: false, auditDeclared: true, rankingActive: false })).toEqual({
        ask: true,
        taskClass: true,
        role: false,
        workKind: false,
        declaredAudit: true,
        declaredTaskClass: "hard",
      });
      expect(planSpawnHint(declared, world(), { applyRole: true, auditDeclared: true, rankingActive: false })).toEqual({
        ask: true,
        taskClass: true,
        role: false,
        workKind: false,
        declaredAudit: true,
        declaredTaskClass: "hard",
      });

      const scheduleRoot = child({ callerAgentId: undefined, labels: { "paseo.task-class": "hard", "paseo.agent-type": "worker" } });
      expect(planSpawnHint(scheduleRoot, world(), { applyRole: false, auditDeclared: true, rankingActive: false })).toEqual({
        ask: false,
        skip: "declared",
      });
    });

    it("restores today's skip when the switch is off", () => {
      const declared = child({ labels: { "paseo.task-class": "hard" } });

      expect(planSpawnHint(declared, world(), { applyRole: false, auditDeclared: false, rankingActive: false })).toEqual({
        ask: false,
        skip: "declared",
      });
    });

    it("lets today's live role ask win over the audit when both apply: one call cannot serve both", () => {
      // A declared class, but its role ("worker" by default in `child()`) is still a keyword
      // guess, per the sibling "asks the role alone only with applyRole on" test above.
      const declaredClassGuessedRole = child({ labels: { "paseo.task-class": "hard" } });

      expect(
        planSpawnHint(declaredClassGuessedRole, world(), { applyRole: true, auditDeclared: true, rankingActive: false }),
      ).toEqual({ ask: true, taskClass: false, role: true, workKind: false, declaredAudit: false });
      // With applyRole off there is no live role ask to compete with, so the audit runs.
      expect(
        planSpawnHint(declaredClassGuessedRole, world(), { applyRole: false, auditDeclared: true, rankingActive: false }),
      ).toEqual({ ask: true, taskClass: true, role: false, workKind: false, declaredAudit: true, declaredTaskClass: "hard" });
    });
  });
});

describe("work_kind (KTD-12)", () => {
  /** "scribe" with two same-shaped candidates in every pool: no class changes the model (no-effect), but ranking has something to reorder. */
  function policyWithTwoCandidateScribe(): RoleModelPolicy {
    return {
      ...POLICY,
      roles: POLICY.roles.map((role) =>
        role.id === "scribe"
          ? { ...role, models: ["claude-sonnet-5", "claude-haiku-4-5-20251001"], mechanicalModels: [], hardModels: [] }
          : role,
      ),
      // Flatten thinking by class too: otherwise mechanical/hard would still differ from standard
      // on thinking level alone, even with every class resolving to the same model pool above.
      thinking: { leader: null, byTaskClass: { mechanical: "high", standard: "high", hard: "high" } },
    };
  }

  it("asks work_kind alone when ranking is on and the resolved class has two or more candidates, with no other reason to ask", () => {
    const input = child({ labels: { "paseo.agent-role": "Scribe" } });
    const twoCandidatePolicy = policyWithTwoCandidateScribe();

    expect(
      planSpawnHint(input, world(twoCandidatePolicy), { applyRole: false, auditDeclared: false, rankingActive: true }),
    ).toEqual({ ask: true, taskClass: false, role: false, workKind: true, declaredAudit: false });
  });

  it("leaves today's no-effect skip unchanged when ranking is off", () => {
    const input = child({ labels: { "paseo.agent-role": "Scribe" } });
    const twoCandidatePolicy = policyWithTwoCandidateScribe();

    expect(
      planSpawnHint(input, world(twoCandidatePolicy), { applyRole: false, auditDeclared: false, rankingActive: false }),
    ).toEqual({ ask: false, skip: "no-effect" });
  });

  it("still skips no-effect when ranking is on but the resolved class has fewer than two candidates", () => {
    // The default "scribe" role: haiku only, in every pool.
    const input = child({ labels: { "paseo.agent-role": "Scribe" } });

    expect(planSpawnHint(input, world(), { applyRole: false, auditDeclared: false, rankingActive: true })).toEqual({
      ask: false,
      skip: "no-effect",
    });
  });

  it("rides the same call as the task-class question when both matter", () => {
    expect(planSpawnHint(child(), world(), { applyRole: false, auditDeclared: false, rankingActive: true })).toEqual({
      ask: true,
      taskClass: true,
      role: true,
      workKind: true,
      declaredAudit: false,
    });
  });

  it("asks work_kind in shadow on a declared child even with auditDeclared off, when ranking could reorder its fixed class", () => {
    const twoCandidatePolicy = policyWithTwoCandidateScribe();
    const declared = child({ labels: { "paseo.task-class": "standard", "paseo.agent-role": "Scribe" } });

    expect(
      planSpawnHint(declared, world(twoCandidatePolicy), { applyRole: false, auditDeclared: false, rankingActive: true }),
    ).toEqual({ ask: true, taskClass: false, role: false, workKind: true, declaredAudit: true, declaredTaskClass: "standard" });
  });

  it("never asks it for a root create (leader) or with no text, ranking on or not", () => {
    expect(
      planSpawnHint(child({ callerAgentId: undefined }), world(), {
        applyRole: false,
        auditDeclared: false,
        rankingActive: true,
      }),
    ).toEqual({ ask: false, skip: "leader" });
    expect(
      planSpawnHint(child({ title: "", initialPrompt: "" }), world(), {
        applyRole: false,
        auditDeclared: false,
        rankingActive: true,
      }),
    ).toEqual({ ask: false, skip: "no-text" });
  });

  it("adds the work_kind question with the KTD-11 kind options when the plan asks for it", () => {
    const questions = buildSpawnHintQuestions(POLICY, { taskClass: false, role: false, workKind: true });
    expect(Object.keys(questions)).toEqual(["work_kind"]);
    const workKindQuestion = questions.work_kind as { type: string; criteria: Record<string, string> };
    expect(workKindQuestion.type).toBe("choice");
    expect(Object.keys(workKindQuestion.criteria)).toEqual(
      expect.arrayContaining(["coding", "frontend", "research", "review", "writing", "ops", "other"]),
    );
  });

  it("does not add the work_kind question when the plan does not ask for it", () => {
    const questions = buildSpawnHintQuestions(POLICY, { taskClass: true, role: false, workKind: false });
    expect(questions.work_kind).toBeUndefined();
  });

  it("reads the work_kind answer back, and fails the whole batch when it is missing", () => {
    const raw = { work_kind: { type: "choice", choice: "frontend", confidence: 0.8 } };
    expect(readSpawnHintAnswers(raw, { taskClass: false, role: false, workKind: true })).toEqual({
      workKind: { choice: "frontend", confidence: 0.8 },
    });
    expect(readSpawnHintAnswers({}, { taskClass: false, role: false, workKind: true })).toBeNull();
  });
});

describe("the request it sends", () => {
  it("names the D7 scope, the feature and the deadlines, and clips the prompt", async () => {
    const { paseo, decide } = stubPaseo(async () =>
      payload({ answers: answers({ taskClass: ["standard", 0.9], reasoning: [1], role: ["worker", 0.9] }) }),
    );
    const prompt = `Implement the retry helper. ${"x".repeat(SPAWN_HINT_PROMPT_CHARS)}`;

    await fetchSpawnHint({
      input: child({ initialPrompt: prompt }),
      cwd: "/Users/t/code/app",
      world: world(),
      availability: LIVE,
      paseo,
    });

    expect(decide).toHaveBeenCalledTimes(1);
    const [request, options] = decide.mock.calls[0] as unknown as [
      {
        feature: string;
        callSite: string;
        state: Record<string, string>;
        questions: Record<string, { criteria: unknown }>;
        scope: unknown;
        deadlineMs: number;
      },
      { timeout: number },
    ];
    expect(request.feature).toBe("spawnHint");
    expect(request.scope).toEqual({ cwd: "/Users/t/code/app", parentAgentId: "parent-1" });
    expect(request.deadlineMs).toBe(SPAWN_HINT_DEADLINE_MS);
    expect(options.timeout).toBe(SPAWN_HINT_RPC_TIMEOUT_MS);
    expect(request.state.prompt).toHaveLength(SPAWN_HINT_PROMPT_CHARS);
    expect(request.state.spawned_by).toBe("another agent");
    expect(Object.keys(request.questions).sort()).toEqual(["reasoning", "role", "task_class"]);
    // The role's options are the policy's roles minus the leader, then `other`.
    expect(Object.keys(request.questions.role.criteria as object)).toEqual([
      "worker",
      "reviewer",
      "advisor",
      "scribe",
      "other",
    ]);
    expect((request.questions.role.criteria as Record<string, string>).scribe).toBe(
      "An operator-defined role named Scribe, also called notetaker",
    );
  });

  it("sends shadow: true and the declared class in state for the declared-label audit", async () => {
    const { paseo, decide } = stubPaseo(async () =>
      payload({ answers: answers({ taskClass: ["standard", 0.9], reasoning: [1] }) }),
    );
    const input = child({ labels: { "paseo.task-class": "hard" } });

    await fetchSpawnHint({
      input,
      cwd: "/Users/t/code/app",
      world: world(),
      availability: { ...LIVE, auditDeclared: true },
      paseo,
    });

    expect(decide).toHaveBeenCalledTimes(1);
    const [request, options] = decide.mock.calls[0] as unknown as [
      { shadow?: true; state: Record<string, string>; questions: Record<string, unknown>; deadlineMs: number },
      { timeout: number },
    ];
    expect(request.shadow).toBe(true);
    expect(request.state.declared_task_class).toBe("hard");
    expect(Object.keys(request.questions).sort()).toEqual(["reasoning", "task_class"]);
    // Its own tighter bound: the answer is never applied, so a timeout should cost the audit a
    // record, not the create extra latency on top of an ordinary unlabelled ask.
    expect(request.deadlineMs).toBe(SPAWN_HINT_DECLARED_AUDIT_DEADLINE_MS);
    expect(options.timeout).toBe(SPAWN_HINT_DECLARED_AUDIT_RPC_TIMEOUT_MS);
  });

  it("answers within 1 s when the declared-label audit's RPC never resolves", async () => {
    vi.useFakeTimers();
    const { paseo } = stubPaseo(() => new Promise<DecidePayload>(() => {}));
    const input = child({ labels: { "paseo.task-class": "hard" } });
    let settled: SpawnHint | undefined;

    void fetchSpawnHint({
      input,
      cwd: "/w",
      world: world(),
      availability: { ...LIVE, auditDeclared: true },
      paseo,
    }).then((hint) => {
      settled = hint;
    });
    await vi.advanceTimersByTimeAsync(SPAWN_HINT_DECLARED_AUDIT_PLUGIN_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toEqual({ status: "unavailable", reason: "plugin-timeout" });
  });

  it("coerces a declared-label audit's answer back to shadow even if a daemon ignored the flag", async () => {
    const input = child({ labels: { "paseo.task-class": "hard" } });

    const hint = await hintFor(
      input,
      { outcome: "answered", answers: answers({ taskClass: ["standard", 0.9], reasoning: [1] }) },
      { ...LIVE, auditDeclared: true },
    );

    expect(hint.status).toBe("shadow");
  });

  it("never sends shadow for an ordinary unlabelled ask", async () => {
    const { paseo, decide } = stubPaseo(async () =>
      payload({ answers: answers({ taskClass: ["standard", 0.9], reasoning: [1], role: ["worker", 0.9] }) }),
    );

    await fetchSpawnHint({ input: child(), cwd: "/w", world: world(), availability: LIVE, paseo });

    const [request] = decide.mock.calls[0] as unknown as [{ shadow?: true }];
    expect(request.shadow).toBeUndefined();
  });

  it("never sends declared_task_class for a live ask, even one an unrecognized label value fell through to", async () => {
    const { paseo, decide } = stubPaseo(async () =>
      payload({ answers: answers({ taskClass: ["standard", 0.9], reasoning: [1], role: ["worker", 0.9] }) }),
    );
    const input = child({ labels: { "paseo.task-class": "medium" } });

    await fetchSpawnHint({ input, cwd: "/w", world: world(), availability: LIVE, paseo });

    const [request] = decide.mock.calls[0] as unknown as [{ state: Record<string, string> }];
    expect(request.state.declared_task_class).toBeUndefined();
  });

  it("sends no role question for a child whose role is declared", async () => {
    const { paseo, decide } = stubPaseo(async () => payload({ answers: answers({ taskClass: ["standard", 0.9], reasoning: [1] }) }));

    await fetchSpawnHint({
      input: child({ labels: { "paseo.agent-role": "worker" } }),
      cwd: "/w",
      world: world(),
      availability: LIVE,
      paseo,
    });

    const [request] = decide.mock.calls[0] as unknown as [{ questions: Record<string, unknown> }];
    expect(Object.keys(request.questions).sort()).toEqual(["reasoning", "task_class"]);
  });
});

describe("failing open", () => {
  it("makes no call when the daemon has no JEV (`paseo.jev` absent)", async () => {
    const hint = await fetchSpawnHint({ input: child(), cwd: "/w", world: world(), availability: LIVE, paseo: {} });

    expect(hint).toEqual({ status: "unavailable", reason: "no-jev-api" });
  });

  it("makes no call when the last status said the hint is off", async () => {
    const { paseo, decide } = stubPaseo(async () => payload());

    const hint = await fetchSpawnHint({
      input: child(),
      cwd: "/w",
      world: world(),
      availability: { ...LIVE, active: false, reason: "no-key" },
      paseo,
    });

    expect(hint).toEqual({ status: "unavailable", reason: "no-key" });
    expect(decide).not.toHaveBeenCalled();
  });

  it("makes no call before a status poll has answered, or after one failed", async () => {
    const { paseo, decide } = stubPaseo(async () => payload());

    const hint = await fetchSpawnHint({ input: child(), cwd: "/w", world: world(), availability: undefined, paseo });

    expect(hint).toEqual({ status: "unavailable", reason: "no-status" });
    expect(decide).not.toHaveBeenCalled();
  });

  it("reads an answer whose call id is not a short string as a broken contract, with no call id", async () => {
    const mechanical = answers({ taskClass: ["mechanical", 0.9], reasoning: [0.2], role: ["worker", 0.9] });
    for (const callId of [123, null, "", "x".repeat(201)]) {
      const hint = await hintFor(child(), { callId: callId as string, answers: mechanical });

      expect(hint).toEqual({ status: "failed", reason: "contract" });
      expect(decideWith(child(), hint).jev).toEqual({
        status: "failed",
        reason: "contract",
        applied: false,
        declaredAudit: false,
      });
    }
    const failed = await hintFor(child(), { outcome: "failed", reason: "timeout", callId: 7 as unknown as string });
    expect(failed).toEqual({ status: "failed", reason: "timeout" });
  });

  it("reads a response that is not an object as a broken contract", async () => {
    const { paseo } = stubPaseo(async () => null as unknown as DecidePayload);

    const hint = await fetchSpawnHint({ input: child(), cwd: "/w", world: world(), availability: LIVE, paseo });

    expect(hint).toEqual({ status: "failed", reason: "contract" });
  });

  it("is unavailable when the RPC rejects", async () => {
    const { paseo } = stubPaseo(async () => {
      throw new Error("socket closed");
    });

    const hint = await fetchSpawnHint({ input: child(), cwd: "/w", world: world(), availability: LIVE, paseo });

    expect(hint).toEqual({ status: "unavailable", reason: "error" });
  });

  it("answers within 2 s when the RPC never resolves, and the create proceeds as today", async () => {
    vi.useFakeTimers();
    const { paseo } = stubPaseo(() => new Promise<DecidePayload>(() => {}));
    let settled: SpawnHint | undefined;

    void fetchSpawnHint({ input: child(), cwd: "/w", world: world(), availability: LIVE, paseo }).then((hint) => {
      settled = hint;
    });
    await vi.advanceTimersByTimeAsync(SPAWN_HINT_PLUGIN_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toEqual({ status: "unavailable", reason: "plugin-timeout" });
    expect(decideWith(child(), settled)).toMatchObject({
      taskClass: { taskClass: undefined, source: "default" },
      model: { model: "claude-sonnet-5" },
    });
  });

  it("changes nothing when the daemon excludes company code (D7)", async () => {
    const hint = await hintFor(child(), { outcome: "unavailable", reason: "excluded", callId: "c-x" });

    expect(hint).toEqual({ status: "unavailable", reason: "excluded", callId: "c-x" });
    const withHint = decideWith(child(), hint);
    const without = decideWith(child(), undefined);
    expect(withHint.taskClass).toEqual(without.taskClass);
    expect(withHint.model).toEqual(without.model);
    expect(withHint.jev).toEqual({
      status: "unavailable",
      reason: "excluded",
      callId: "c-x",
      applied: false,
      declaredAudit: false,
    });
  });

  it("fails a malformed answer rather than reading it", async () => {
    // No reasoning score, and for the guessed-role child no role either.
    const hint = await hintFor(worker(), { answers: answers({ taskClass: ["mechanical", 0.9] }) });
    const noRole = await hintFor(child(), { answers: answers({ taskClass: ["mechanical", 0.9], reasoning: [0] }) });

    expect(hint).toEqual({ status: "failed", reason: "contract", callId: "jev-call-1" });
    expect(noRole).toEqual({ status: "failed", reason: "contract", callId: "jev-call-1" });
  });

  it("passes a daemon failure through as failed", async () => {
    const hint = await hintFor(child(), { outcome: "failed", reason: "timeout" });

    expect(hint).toEqual({ status: "failed", reason: "timeout", callId: "jev-call-1" });
  });
});

describe("precedence", () => {
  it("1. a declared label outranks JEV", () => {
    const hint: SpawnHint = {
      status: "answered",
      callId: "c",
      answers: {},
      proposal: { taskClass: "mechanical" },
      applyHard: true,
      applyRole: true,
      declaredAudit: false,
    };

    const decision = decideWith(child({ labels: { "paseo.task-class": "standard" } }), hint);

    expect(decision.taskClass).toMatchObject({ taskClass: "standard", source: "declared" });
    expect(decision.jev?.applied).toBe(false);
  });

  it("2. a risk keyword outranks JEV: it cannot lower a hard task", () => {
    const hint: SpawnHint = {
      status: "answered",
      callId: "c",
      answers: {},
      proposal: { taskClass: "mechanical" },
      applyHard: false,
      applyRole: false,
      declaredAudit: false,
    };

    const decision = decideWith(child({ initialPrompt: "Fix the race condition in the queue." }), hint);

    expect(decision.taskClass).toMatchObject({ taskClass: "hard", source: "classified" });
  });

  it("3. JEV mechanical applies when the class and the reasoning score agree past the floors", async () => {
    const hint = await hintFor(worker(), { answers: answers({ taskClass: ["mechanical", 0.7], reasoning: [0.4] }) });

    const decision = decideWith(worker(), hint);

    expect(decision.taskClass).toMatchObject({ taskClass: "mechanical", source: "jev" });
    expect(decision.taskClass.reason).toContain("JEV");
    expect(decision.model.model).toBe("claude-haiku-4-5-20251001");
    expect(decision.jev).toMatchObject({
      status: "answered",
      callId: "jev-call-1",
      applied: true,
      wouldBe: { taskClass: "mechanical", model: "claude-haiku-4-5-20251001", move: "down" },
    });
  });

  it("3. two answers must agree: a mechanical class with a high reasoning score is no move", async () => {
    const hint = await hintFor(worker(), { answers: answers({ taskClass: ["mechanical", 0.95], reasoning: [0.9] }) });

    const decision = decideWith(worker(), hint);

    expect(decision.taskClass).toMatchObject({ taskClass: undefined, source: "default" });
    expect(decision.jev).toMatchObject({ applied: false, wouldBe: { taskClass: null, move: "none" } });
  });

  it("3. a mechanical answer under its confidence floor is no move", async () => {
    const hint = await hintFor(worker(), { answers: answers({ taskClass: ["mechanical", 0.64], reasoning: [0] }) });

    expect(decideWith(worker(), hint).taskClass.source).toBe("default");
  });

  it("4. JEV hard is recorded as wouldBe while applyHard is off", async () => {
    const hint = await hintFor(worker(), { answers: answers({ taskClass: ["hard", 0.9], reasoning: [1.7] }) });

    const decision = decideWith(worker(), hint);

    expect(decision.taskClass).toMatchObject({ taskClass: undefined, source: "default" });
    expect(decision.taskClass.reason).toContain("applyHard is off");
    expect(decision.model.model).toBe("claude-sonnet-5");
    expect(decision.jev).toMatchObject({
      applied: false,
      wouldBe: { taskClass: "hard", model: "claude-opus-5-5", move: "up" },
    });
  });

  it("4. JEV hard applies with applyHard on, past its higher floors", async () => {
    const on = { ...LIVE, applyHard: true };
    const passes = await hintFor(worker(), { answers: answers({ taskClass: ["hard", 0.9], reasoning: [1.7] }) }, on);
    const lowConfidence = await hintFor(worker(), { answers: answers({ taskClass: ["hard", 0.84], reasoning: [2] }) }, on);
    const lowReasoning = await hintFor(worker(), { answers: answers({ taskClass: ["hard", 0.99], reasoning: [1.5] }) }, on);

    expect(decideWith(worker(), passes).taskClass).toMatchObject({ taskClass: "hard", source: "jev" });
    expect(decideWith(worker(), lowConfidence).taskClass.source).toBe("default");
    expect(decideWith(worker(), lowReasoning).taskClass.source).toBe("default");
  });

  it("5. a JEV standard never lifts a task off the mechanical seed", async () => {
    const input = worker({ initialPrompt: "Rename the helper to fetchWithRetry." });
    const hint = await hintFor(input, { answers: answers({ taskClass: ["standard", 0.99], reasoning: [1] }) });

    expect(decideWith(input, hint).taskClass).toMatchObject({ taskClass: "mechanical", source: "classified" });
  });

  it("6. `other` and a low-confidence answer fall through to the default", async () => {
    const other = await hintFor(worker(), { answers: answers({ taskClass: ["other", 0.99], reasoning: [0] }) });
    const unsure = await hintFor(worker(), { answers: answers({ taskClass: ["mechanical", 0.3], reasoning: [0] }) });

    expect(decideWith(worker(), other).taskClass).toMatchObject({ taskClass: undefined, source: "default" });
    expect(decideWith(worker(), unsure).taskClass).toMatchObject({ taskClass: undefined, source: "default" });
  });
});

describe("the role", () => {
  const roleAnswers = (role: [string, number]) =>
    answers({ taskClass: ["standard", 0.9], reasoning: [1], role });

  it("is recorded as wouldBe while applyRole is off", async () => {
    const hint = await hintFor(child(), { answers: roleAnswers(["advisor", 0.9]) });

    const decision = decideWith(child(), hint);

    expect(decision.role.role.id).toBe("worker");
    expect(decision.jev).toMatchObject({ applied: false, wouldBe: { role: "advisor", model: "claude-opus-5-5" } });
  });

  it("replaces the keyword guess with applyRole on, as a guess", async () => {
    const hint = await hintFor(child(), { answers: roleAnswers(["advisor", 0.9]) }, { ...LIVE, applyRole: true });

    const decision = decideWith(child(), hint);

    expect(decision.role).toMatchObject({ source: "classified-jev", tier: 3, evidenceBased: false });
    expect(decision.role.role.id).toBe("advisor");
    expect(decision.jev?.applied).toBe(true);
  });

  it("ignores `other`, the leader and an answer under the floor", async () => {
    const on = { ...LIVE, applyRole: true };
    for (const role of [
      ["other", 0.99],
      ["leader", 0.99],
      ["advisor", 0.69],
    ] as [string, number][]) {
      const hint = await hintFor(child(), { answers: roleAnswers(role) }, on);
      expect(decideWith(child(), hint).role.source).not.toBe("classified-jev");
    }
  });
});

describe("shadow", () => {
  it("records wouldBe and changes nothing", async () => {
    const hint = await hintFor(child(), {
      outcome: "shadow",
      answers: answers({ taskClass: ["mechanical", 0.9], reasoning: [0.2], role: ["reviewer", 0.9] }),
    });

    const withShadow = decideWith(child(), hint);
    const without = decideWith(child(), undefined);

    expect(withShadow.taskClass.taskClass).toBe(without.taskClass.taskClass);
    expect(withShadow.role.role.id).toBe(without.role.role.id);
    expect(withShadow.model).toEqual(without.model);
    expect(withShadow.thinking.optionId).toBe(without.thinking.optionId);
    expect(withShadow.taskClass.reason).toContain("shadow mode");
    expect(withShadow.jev).toMatchObject({
      status: "shadow",
      applied: false,
      wouldBe: { taskClass: "mechanical", role: "reviewer", move: "down" },
    });
  });
});

describe("the preview", () => {
  it("says nothing in shadow mode, when the create would do what it shows", () => {
    expect(spawnHintPreview(child(), world(), { ...LIVE, shadow: true })).toBeUndefined();
    expect(spawnHintPreview(child(), world(), undefined)).toBeUndefined();
  });

  it("says decided at create for an unlabelled child once the hint is live, and never asks", () => {
    const preview = spawnHintPreview(child(), world(), LIVE);

    expect(preview).toEqual({ status: "decided-at-create", role: false });
    expect(decideWith(child(), preview).taskClass.reason).toContain("Decided at create");
    expect(spawnHintPreview(child({ labels: { "paseo.task-class": "hard" } }), world(), LIVE)).toBeUndefined();
  });
});
