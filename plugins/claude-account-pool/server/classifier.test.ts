import { describe, expect, it } from "vitest";
import type { ArenaRankingRow, ArenaRankingsFile } from "../shared/arena-aliases";
import {
  DEFAULT_POLICY,
  DEFAULT_THINKING_POLICY,
  type ArenaPolicy,
  type RoleModelPolicy,
  type RoleRecord,
  type ThinkingPolicy,
} from "../shared/role-policy-schema";
import { classifyAgent, type ClassifierInput, type ClassifierWorld } from "./classifier";
import { createHealthTracker } from "./health";
import type { SpawnHint } from "./jev-hint";
import type { ModelThinkingOptions, ThinkingCatalog } from "./model-catalog";
import type { ModelCatalog } from "./role-availability";

/**
 * The world every case below starts from: two healthy pooled workers, a
 * leader, and a catalog listing the live model ids. Health is a plain object
 * rather than the real tracker — the classifier takes health as data, which
 * is the point of it being pure.
 */
function healthyHealth(overrides: Partial<ClassifierWorld["health"]> = {}): ClassifierWorld["health"] {
  const health = {
    isHealthyFor: () => true,
    isHealthyForAllWindows: () => true,
    isLastResortEligible: () => true,
    windowUtilization: () => undefined,
    describeWindow: () => undefined,
    windowIds: () => [],
    ...overrides,
  } as ClassifierWorld["health"];
  // Unless a test says otherwise, every cap is refusal-grade, as it is without CLI refusal text.
  return {
    isExhaustedFor: (providerId: string, modelId?: string) => !health.isLastResortEligible(providerId, modelId),
    ...health,
  };
}

const LIVE_MODELS = ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"];

function catalog(models: readonly string[] = LIVE_MODELS): ModelCatalog {
  return new Map([["claude", new Set(models)]]);
}

/**
 * A thinking catalog shaped like the real manifest: Opus 5.5 offers no `off`
 * (thinking can't be disabled); everything else offering `xhigh` also offers
 * `ultracode`; Haiku offers nothing at all. Opus 5.5 defaults to `ultracode`
 * here, as it did in the manifest before Extra High replaced it. That is the
 * harder case: the classifier must never land on a default of Ultra Code.
 */
function thinkingCatalog(
  entries: Record<string, Record<string, ModelThinkingOptions>> = {
    claude: {
      "claude-opus-5-5": { optionIds: ["low", "medium", "high", "xhigh", "max", "ultracode"], defaultOptionId: "ultracode" },
      "claude-opus-5": { optionIds: ["off", "low", "medium", "high", "xhigh", "max", "ultracode"], defaultOptionId: "high" },
      "claude-sonnet-5": { optionIds: ["off", "low", "medium", "high", "xhigh", "max", "ultracode"], defaultOptionId: "high" },
      "claude-haiku-4-5-20251001": { optionIds: [] },
    },
  },
): ThinkingCatalog {
  return new Map(Object.entries(entries).map(([family, models]) => [family, new Map(Object.entries(models))]));
}

function world(overrides: Partial<ClassifierWorld> = {}): ClassifierWorld {
  return {
    policy: DEFAULT_POLICY,
    catalog: catalog(),
    thinkingCatalog: thinkingCatalog(),
    pool: {
      workers: [
        { providerId: "claude-work", priority: 1 },
        { providerId: "claude-spare", priority: 2 },
      ],
      leader: { providerId: "claude-personal" },
    },
    health: healthyHealth(),
    ...overrides,
  } as ClassifierWorld;
}

function child(overrides: Partial<ClassifierInput> = {}): ClassifierInput {
  return { callerAgentId: "caller-1", requestedProvider: "claude", ...overrides };
}

function withRole(policy: RoleModelPolicy, id: string, patch: Partial<RoleRecord>): RoleModelPolicy {
  return { ...policy, roles: policy.roles.map((role) => (role.id === id ? { ...role, ...patch } : role)) };
}

/**
 * Tyler's live policy, as configured on the daemon. Kept here as a fixture so
 * the CURRENT routing policy — Opus 5.5 leads, Fable is retired from every
 * pool — is asserted by the classifier rather than only described in prose
 * somewhere. When the live policy changes, this fixture is what proves the
 * classifier still says what the operator meant.
 */
const LIVE_POLICY: RoleModelPolicy = {
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
      aliases: ["check"],
      models: ["claude-sonnet-5"],
      mechanicalModels: ["claude-haiku-4-5-20251001"],
      hardModels: ["claude-opus-5-5", "claude-opus-5"],
      toolProfile: { kind: "read-only" },
    },
    {
      id: "advisor",
      name: "Advisor",
      standard: true,
      aliases: ["oracle"],
      models: ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5"],
      mechanicalModels: [],
      hardModels: [],
      toolProfile: { kind: "unrestricted" },
    },
    {
      id: "leader",
      name: "leader",
      standard: true,
      aliases: [],
      models: ["claude-opus-5-5", "claude-opus-5"],
      mechanicalModels: [],
      hardModels: ["claude-opus-5-5", "claude-opus-5"],
      toolProfile: { kind: "unrestricted" },
    },
  ],
  agentTypeMappings: {
    worker: "worker",
    scout: "worker",
    researcher: "worker",
    delegate: "worker",
    reviewer: "reviewer",
    oracle: "advisor",
    advisor: "advisor",
  },
  modelBudgetThresholdPct: 80,
  enforceToolsOnClassifiedRoles: false,
  exposeClassifierTool: false,
  // The live value: Claude Code doesn't advertise claude-opus-5-5, and this
  // is what makes the leader's own top entry selectable at all.
  allowUnlistedModels: ["claude-opus-5-5"],
  // No thinking rules configured: DEFAULT_THINKING_POLICY applies — leaders
  // run Ultra Code, subagents take their task class's level.
  thinking: DEFAULT_THINKING_POLICY,
  childOutputStyle: "Concise",
  revision: "live-fixture",
};

describe("classifyAgent — determinism", () => {
  it("returns an identical decision for identical inputs", () => {
    const input = child({ title: "fix the race condition in the reaper", labels: { "paseo.agent-type": "worker" } });
    const w = world({ policy: LIVE_POLICY, nowMs: 1_700_000_000_000 } as Partial<ClassifierWorld>);
    expect(JSON.stringify(classifyAgent(input, w))).toBe(JSON.stringify(classifyAgent(input, w)));
  });

  it("decides no account when no instant was supplied — the create hook's case", () => {
    const decision = classifyAgent(child({ title: "anything" }), world({ policy: LIVE_POLICY }));
    expect(decision.account.kind).toBe("not-evaluated");
  });
});

describe("classifyAgent — explicit beats inferred", () => {
  it("an agent-type mapping outranks text that says otherwise", () => {
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-type": "scout" }, title: "review the diff" }),
      world({ policy: LIVE_POLICY }),
    );
    expect(decision.role.role.id).toBe("worker");
    expect(decision.role.source).toBe("agent-type-mapping");
  });

  it("a declared role label outranks text that says otherwise", () => {
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-role": "advisor" }, title: "review the diff" }),
      world({ policy: LIVE_POLICY }),
    );
    expect(decision.role.role.id).toBe("advisor");
    expect(decision.role.source).toBe("declared-label");
  });

  it("an unknown declared role never blocks — it falls through and says so", () => {
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-role": "wizard" }, title: "review the diff" }),
      world({ policy: LIVE_POLICY }),
    );
    expect(decision.role.role.id).toBe("reviewer");
    expect(decision.role.unknownDeclaredValue).toBe("wizard");
    expect(decision.role.reason).toContain('The declared role "wizard" matched no configured role');
  });

  it("a declared task class outranks the keywords in the prompt", () => {
    const decision = classifyAgent(
      child({ labels: { "paseo.task-class": "mechanical" }, initialPrompt: "fix the race condition" }),
      world({ policy: LIVE_POLICY }),
    );
    expect(decision.taskClass.taskClass).toBe("mechanical");
    expect(decision.taskClass.source).toBe("declared");
  });

  it("separates the operator's own vocabulary from a built-in seed keyword", () => {
    // "check" is an alias Tyler configured on Reviewer AND a built-in seed word.
    expect(classifyAgent(child({ title: "check the output" }), world({ policy: LIVE_POLICY })).role.source).toBe(
      "classified-vocabulary",
    );
    // "audit" is only a seed word.
    expect(classifyAgent(child({ title: "audit the output" }), world({ policy: LIVE_POLICY })).role.source).toBe(
      "classified-seed",
    );
  });
});

describe("classifyAgent — inference may choose a model, never remove capability", () => {
  /**
   * The 1.1M-token incident, in one test: an implementation prompt containing
   * the word "check" classifies as `reviewer`, whose live profile is
   * read-only. The model may change; Edit/Write/Bash may not disappear.
   */
  it("withholds a guessed role's restrictive profile and names what was withheld", () => {
    const decision = classifyAgent(
      child({ title: "implement the retry loop", initialPrompt: "then check it compiles" }),
      world({ policy: LIVE_POLICY }),
    );
    expect(decision.role.role.id).toBe("reviewer");
    expect(decision.role.evidenceBased).toBe(false);
    expect(decision.tools.deniedTools).toEqual([]);
    expect(decision.tools.withheld?.profile.kind).toBe("read-only");
    expect(decision.tools.withheld?.deniedTools).toContain("Write");
    // The model still comes from the guessed role — that part of a guess is allowed.
    expect(decision.model.model).toBe("claude-sonnet-5");
  });

  it("enforces the same profile when the caller DECLARED the role", () => {
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-role": "reviewer" }, title: "implement the retry loop" }),
      world({ policy: LIVE_POLICY }),
    );
    expect(decision.role.evidenceBased).toBe(true);
    expect(decision.tools.withheld).toBeUndefined();
    expect(decision.tools.deniedTools).toContain("Write");
  });

  it("enforces a guessed role's profile only when the operator opted in", () => {
    const opted = { ...LIVE_POLICY, enforceToolsOnClassifiedRoles: true };
    const decision = classifyAgent(child({ title: "check the output" }), world({ policy: opted }));
    expect(decision.tools.withheld).toBeUndefined();
    expect(decision.tools.deniedTools).toContain("Write");
  });

  it("a root agent's leader profile is evidence, not a guess", () => {
    const policy = withRole(LIVE_POLICY, "leader", { toolProfile: { kind: "orchestrator" } });
    const decision = classifyAgent({ title: "anything at all" }, world({ policy }));
    expect(decision.role.source).toBe("leader-tier");
    expect(decision.role.tier).toBeUndefined();
    expect(decision.tools.deniedTools).toContain("Bash");
  });
});

describe("classifyAgent — JEV's spawn hint (D2: it may pick a model, never remove a tool)", () => {
  /** An answered hint that names a role, with every switch on. */
  function jevHint(roleId: string, taskClass?: "mechanical" | "hard"): ClassifierInput["jevHint"] {
    return {
      status: "answered",
      callId: "call-1",
      answers: {
        role: { choice: roleId, confidence: 0.95 },
        ...(taskClass
          ? { taskClass: { choice: taskClass, confidence: 0.95 }, reasoning: { score: taskClass === "hard" ? 2 : 0, confidence: 0.9 } }
          : {}),
      },
      proposal: { roleId, ...(taskClass ? { taskClass } : {}) },
      applyHard: true,
      applyRole: true,
      declaredAudit: false,
    };
  }

  // An implementation prompt with no role or seed keyword: the keyword tier would say worker.
  const implementation = child({ title: "retry loop", initialPrompt: "Implement the retry loop in the fetch helper." });

  for (const enforce of [false, true]) {
    it(`a role JEV named changes no tool, with enforceToolsOnClassifiedRoles ${enforce ? "on" : "off"}`, () => {
      const policy = { ...LIVE_POLICY, enforceToolsOnClassifiedRoles: enforce };

      const decision = classifyAgent({ ...implementation, jevHint: jevHint("reviewer") }, world({ policy }));
      const without = classifyAgent(implementation, world({ policy }));

      expect(decision.role).toMatchObject({ source: "classified-jev", tier: 3, evidenceBased: false });
      expect(decision.role.role.id).toBe("reviewer");
      // Tools and MCP servers are the keyword guess's (a worker); the model is the named role's.
      expect(decision.tools).toEqual(without.tools);
      expect(decision.mcp).toEqual(without.mcp);
      expect(decision.tools.deniedTools).toEqual([]);
      expect(decision.model.model).toBe("claude-sonnet-5");
    });
  }

  it("the same flag on still enforces a keyword-guessed role", () => {
    const policy = { ...LIVE_POLICY, enforceToolsOnClassifiedRoles: true };

    const decision = classifyAgent(child({ title: "review the output" }), world({ policy }));

    expect(decision.role.source).toBe("classified-seed");
    expect(decision.tools.deniedTools).toContain("Write");
  });

  for (const named of ["reviewer", "worker", "advisor"]) {
    it(`a JEV role (${named}) never cancels the flag's enforcement of a keyword-guessed role`, () => {
      const policy = { ...LIVE_POLICY, enforceToolsOnClassifiedRoles: true };
      const review = child({ title: "review the output" });

      const decision = classifyAgent({ ...review, jevHint: jevHint(named) }, world({ policy }));
      const without = classifyAgent(review, world({ policy }));

      expect(decision.role.role.id).toBe(named);
      expect(decision.tools).toEqual(without.tools);
      expect(decision.tools.deniedTools).toContain("Write");
    });
  }

  it("the JEV sources reach the decision and its reasons", () => {
    const decision = classifyAgent(
      { ...implementation, jevHint: jevHint("advisor", "mechanical") },
      world({ policy: LIVE_POLICY }),
    );

    expect(decision.role.source).toBe("classified-jev");
    expect(decision.role.reason).toContain("JEV");
    expect(decision.taskClass).toMatchObject({ taskClass: "mechanical", source: "jev" });
    expect(decision.taskClass.reason).toContain("JEV");
    expect(decision.jev).toMatchObject({ status: "answered", callId: "call-1", applied: true });
  });

  it("records the class and model the create runs without JEV beside what the answer would run", () => {
    const hint = jevHint("advisor", "mechanical");
    if (hint?.status !== "answered") throw new Error("expected an answered hint");
    const shadow: ClassifierInput["jevHint"] = { ...hint, status: "shadow" };
    const without = classifyAgent(implementation, world({ policy: LIVE_POLICY }));

    const decision = classifyAgent({ ...implementation, jevHint: shadow }, world({ policy: LIVE_POLICY }));

    // Shadow applies nothing, so the base is exactly today's decision.
    expect(decision.model).toEqual(without.model);
    expect(decision.jev?.base).toEqual({
      taskClass: without.taskClass.taskClass ?? null,
      model: without.model.model ?? null,
    });
    expect(decision.jev?.wouldBe).toMatchObject({ taskClass: "mechanical", move: "down" });
  });

  it("the base ignores a role JEV applied: it is the jevless role's model", () => {
    const without = classifyAgent(implementation, world({ policy: LIVE_POLICY }));

    const decision = classifyAgent(
      { ...implementation, jevHint: jevHint("reviewer") },
      world({ policy: LIVE_POLICY }),
    );

    expect(decision.role.role.id).toBe("reviewer");
    expect(decision.jev?.base?.model).toBe(without.model.model ?? null);
  });

  it("a hint that is not an answer is today's decision, recorded", () => {
    const without = classifyAgent(implementation, world({ policy: LIVE_POLICY }));
    const withFailure = classifyAgent(
      { ...implementation, jevHint: { status: "failed", reason: "timeout", callId: "call-2" } },
      world({ policy: LIVE_POLICY }),
    );

    const { jev, ...rest } = withFailure;
    expect(rest).toEqual(without);
    expect(jev).toEqual({
      status: "failed",
      reason: "timeout",
      callId: "call-2",
      applied: false,
      declaredAudit: false,
    });
  });

  it("is replayable: the same hint gives the same decision", () => {
    const input = { ...implementation, jevHint: jevHint("advisor", "mechanical") };

    expect(classifyAgent(input, world({ policy: LIVE_POLICY }))).toEqual(classifyAgent(input, world({ policy: LIVE_POLICY })));
  });

  it("the declared-label audit: a declared label always wins, but wouldBe reads JEV's own answer, not the applied decision", () => {
    const declaredHard = child({
      title: "retry loop",
      initialPrompt: "Implement the retry loop in the fetch helper.",
      labels: { "paseo.task-class": "hard" },
    });
    const hint: ClassifierInput["jevHint"] = {
      status: "shadow",
      callId: "call-audit",
      answers: { taskClass: { choice: "mechanical", confidence: 0.95 }, reasoning: { score: 0.2, confidence: 0.9 } },
      proposal: { taskClass: "mechanical" },
      applyHard: true,
      applyRole: true,
      declaredAudit: true,
    };

    const decision = classifyAgent({ ...declaredHard, jevHint: hint }, world({ policy: LIVE_POLICY }));

    // The declared label still decides the real class — `resolveTaskClass` never even looks past it.
    expect(decision.taskClass).toMatchObject({ taskClass: "hard", source: "declared" });
    expect(decision.jev?.applied).toBe(false);
    // `base` is what actually runs (the declared class); `wouldBe` is JEV's own answer, ignoring
    // the label — if it read "hard" too (the declared-label short circuit, unstripped), the audit
    // would have nothing to measure.
    expect(decision.jev?.base?.taskClass).toBe("hard");
    expect(decision.jev?.wouldBe).toMatchObject({ taskClass: "mechanical", move: "down" });
    expect(decision.jev?.declaredAudit).toBe(true);
  });

  it("the declared-label audit's wouldBe never falls back to a hard-seed keyword when JEV's own answer disagrees", () => {
    // The prompt itself matches HARD_SEED_RE; a non-audited unlabelled create would never even
    // reach JEV with this prompt, and a declared one is asked anyway. Stripping the label and
    // re-running the keyword classifier (the old, buggy path) would read "hard" off the prompt
    // whatever JEV answered; `wouldBe` must read JEV's own choice instead.
    const declaredHard = child({
      title: "db migration",
      initialPrompt: "Plan the database migration for the orders table.",
      labels: { "paseo.task-class": "hard" },
    });
    const hint: ClassifierInput["jevHint"] = {
      status: "shadow",
      callId: "call-audit-2",
      answers: { taskClass: { choice: "standard", confidence: 0.9 }, reasoning: { score: 1.0, confidence: 0.8 } },
      proposal: {},
      applyHard: true,
      applyRole: true,
      declaredAudit: true,
    };

    const decision = classifyAgent({ ...declaredHard, jevHint: hint }, world({ policy: LIVE_POLICY }));

    expect(decision.taskClass).toMatchObject({ taskClass: "hard", source: "declared" });
    expect(decision.jev?.wouldBe).toMatchObject({ taskClass: "standard", move: "down" });
  });

  it("the declared-label audit's wouldBe agrees with the declared class when JEV's raw answer matches it, whatever the confidence", () => {
    const declaredHard = child({
      title: "retry loop",
      initialPrompt: "Implement the retry loop in the fetch helper.",
      labels: { "paseo.task-class": "hard" },
    });
    const hint: ClassifierInput["jevHint"] = {
      status: "shadow",
      callId: "call-audit-3",
      // 0.80 is below HARD_CONFIDENCE_FLOOR (0.85): the old floor-gated path would have fallen
      // through to the keyword default here too, but the audit reads the raw choice regardless.
      answers: { taskClass: { choice: "hard", confidence: 0.8 }, reasoning: { score: 1.4, confidence: 0.8 } },
      proposal: {},
      applyHard: true,
      applyRole: true,
      declaredAudit: true,
    };

    const decision = classifyAgent({ ...declaredHard, jevHint: hint }, world({ policy: LIVE_POLICY }));

    expect(decision.jev?.wouldBe).toMatchObject({ taskClass: "hard", move: "none" });
  });

  it("the declared-label audit falls back to the declared class when JEV answers other", () => {
    const declaredHard = child({
      title: "retry loop",
      initialPrompt: "Implement the retry loop in the fetch helper.",
      labels: { "paseo.task-class": "hard" },
    });
    const hint: ClassifierInput["jevHint"] = {
      status: "shadow",
      callId: "call-audit-4",
      answers: { taskClass: { choice: "other", confidence: 0.9 }, reasoning: { score: 0.5, confidence: 0.8 } },
      proposal: {},
      applyHard: true,
      applyRole: true,
      declaredAudit: true,
    };

    const decision = classifyAgent({ ...declaredHard, jevHint: hint }, world({ policy: LIVE_POLICY }));

    expect(decision.jev?.wouldBe).toMatchObject({ taskClass: "hard", move: "none" });
  });

  it("a role-only ask on a declared child reads wouldBe as the declared class: no task_class question was asked", () => {
    const declaredHard = child({
      title: "retry loop",
      initialPrompt: "Implement the retry loop in the fetch helper.",
      labels: { "paseo.task-class": "hard" },
    });
    // No `taskClass`/`reasoning` answers at all: the plan asked only the role question.
    const hint: ClassifierInput["jevHint"] = {
      status: "answered",
      callId: "call-audit-5",
      answers: { role: { choice: "reviewer", confidence: 0.9 } },
      proposal: { roleId: "reviewer" },
      applyHard: true,
      applyRole: true,
      declaredAudit: false,
    };

    const decision = classifyAgent({ ...declaredHard, jevHint: hint }, world({ policy: LIVE_POLICY }));

    expect(decision.jev?.wouldBe).toMatchObject({ taskClass: "hard", move: "none" });
    // A role-only ask is not the declared-label audit, even though this child's class is
    // declared too: the savings track must be able to tell the two apart (finding, 2026-10-08).
    expect(decision.jev?.declaredAudit).toBe(false);
  });
});

describe("classifyAgent — the JEV agent tools' arm", () => {
  const tools = (overrides: Partial<NonNullable<ClassifierWorld["jevToolsAvailable"]>> = {}) => ({
    active: true,
    scope: "ok" as const,
    assignShare: 0.5,
    draw: 0.2,
    ...overrides,
  });

  it("is not evaluated without the world's input", () => {
    expect(classifyAgent(child({ title: "x" }), world()).jevTools).toBeUndefined();
  });

  it("splits eligible creates by the draw against assignShare", () => {
    expect(classifyAgent(child({ title: "x" }), world({ jevToolsAvailable: tools({ draw: 0.49 }) })).jevTools?.arm).toBe("on");
    expect(classifyAgent(child({ title: "x" }), world({ jevToolsAvailable: tools({ draw: 0.5 }) })).jevTools?.arm).toBe(
      "control",
    );
  });

  it("gives no arm when the feature is off, the scope is excluded or unchecked, or Read is denied", () => {
    expect(classifyAgent(child({ title: "x" }), world({ jevToolsAvailable: tools({ active: false }) })).jevTools?.arm).toBeNull();
    expect(
      classifyAgent(child({ title: "x" }), world({ jevToolsAvailable: tools({ scope: "excluded" }) })).jevTools?.arm,
    ).toBeNull();
    expect(
      classifyAgent(child({ title: "x" }), world({ jevToolsAvailable: tools({ scope: "unknown" }) })).jevTools?.arm,
    ).toBeNull();
    const noRead = withRole(LIVE_POLICY, "worker", { toolProfile: { kind: "orchestrator" } });
    const denied = classifyAgent(
      child({ labels: { "paseo.agent-role": "worker" }, title: "x" }),
      world({ policy: noRead, jevToolsAvailable: tools() }),
    );
    expect(denied.tools.deniedTools).toContain("Read");
    expect(denied.jevTools?.arm).toBeNull();
  });

  it("gives no arm to a non-Claude create: the tools and the discovery hint are Claude-only", () => {
    const decision = classifyAgent(
      child({ title: "x", requestedProvider: "codex" }),
      world({ jevToolsAvailable: tools({ draw: 0.1 }) }),
    );

    expect(decision.jevTools?.arm).toBeNull();
    expect(decision.jevTools?.reason).toContain("codex");
  });
});

describe("classifyAgent — inheritance", () => {
  it("a child is never less restricted than its parent", () => {
    const policy = withRole(LIVE_POLICY, "worker", { toolProfile: { kind: "unrestricted" } });
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-type": "worker" } }),
      world({ policy, callerDenials: { status: "known", denied: ["Bash", "Write"] } }),
    );
    expect(decision.tools.deniedTools).toEqual(["Bash", "Write"]);
    expect(decision.tools.inheritedTools).toEqual(["Bash", "Write"]);
    expect(decision.tools.reason).toContain("never less restricted than its parent");
  });

  it("an unknowable parent fails SAFE onto the read-only floor", () => {
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-type": "worker" } }),
      world({ policy: LIVE_POLICY, callerDenials: { status: "unknown" } }),
    );
    expect(decision.tools.deniedTools).toContain("Write");
    expect(decision.tools.inheritanceUnresolved).toEqual({ reason: "not-in-directory", failedSafe: true });
  });

  it("a cold directory fails OPEN", () => {
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-type": "worker" } }),
      world({ policy: LIVE_POLICY, callerDenials: { status: "cold" } }),
    );
    expect(decision.tools.deniedTools).toEqual([]);
    expect(decision.tools.inheritanceUnresolved).toEqual({ reason: "directory-cold", failedSafe: false });
  });
});

describe("classifyAgent — the live policy", () => {
  const live = (overrides: Partial<ClassifierWorld> = {}) =>
    world({ policy: LIVE_POLICY, ...overrides } as Partial<ClassifierWorld>);

  it("leads on Opus 5.5 for a root agent", () => {
    const decision = classifyAgent({ title: "orchestrate the fleet" }, live());
    expect(decision.role.role.id).toBe("leader");
    expect(decision.model.model).toBe("claude-opus-5-5");
  });

  it("routes a mechanical worker to Haiku and a hard worker to Opus 5.5", () => {
    const mech = classifyAgent(
      child({ labels: { "paseo.agent-type": "worker", "paseo.task-class": "mechanical" } }),
      live(),
    );
    expect(mech.model.model).toBe("claude-haiku-4-5-20251001");
    expect(mech.model.poolSlot).toBe("mechanical");

    const hard = classifyAgent(child({ labels: { "paseo.agent-type": "worker", "paseo.task-class": "hard" } }), live());
    expect(hard.model.model).toBe("claude-opus-5-5");
    expect(hard.model.poolSlot).toBe("hard");
  });

  it("gives an unlabelled worker Sonnet 5 — the standard default", () => {
    const decision = classifyAgent(child({ labels: { "paseo.agent-type": "worker" } }), live());
    expect(decision.model.model).toBe("claude-sonnet-5");
    expect(decision.model.poolSlot).toBe("standard");
  });

  it("routes a reviewer to Sonnet 5 and an advisor to Opus 5.5", () => {
    expect(classifyAgent(child({ labels: { "paseo.agent-type": "reviewer" } }), live()).model.model).toBe(
      "claude-sonnet-5",
    );
    expect(classifyAgent(child({ labels: { "paseo.agent-type": "advisor" } }), live()).model.model).toBe(
      "claude-opus-5-5",
    );
  });

  /**
   * Fable is retired: Opus 5.5 supersedes it, so nothing routes there until
   * that changes. This asserts the property (no pool names it) rather than one
   * example, so adding Fable back anywhere fails here first.
   */
  it("never routes to Fable, from any role or task class", () => {
    const everyRef = LIVE_POLICY.roles.flatMap((role) => [
      ...role.models,
      ...role.mechanicalModels,
      ...role.hardModels,
    ]);
    expect(everyRef.filter((ref) => ref.includes("fable"))).toEqual([]);
  });

  it("names which pool decided, including the fallback an operator misreads as 'my Hard pool is ignored'", () => {
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-type": "advisor", "paseo.task-class": "hard" } }),
      live(),
    );
    expect(decision.model.poolSlot).toBe("standard");
    expect(decision.model.fellBackToStandardPool).toBe(true);
    expect(decision.model.reason).toContain("that class's own pool is empty");
  });
});

/**
 * The case that has failed silently in production twice: Claude Code accepts
 * `claude-opus-5-5` but does not advertise it, so the catalog check skipped
 * the leader's own top entry and the whole fleet quietly led on opus-5. The
 * catalog here is the real one — everything EXCEPT opus-5-5 — and the policy
 * is the live document, allowlist included.
 */
describe("classifyAgent — the live config, against a catalog that omits opus-5-5", () => {
  /** What Claude Code actually advertises: no opus-5-5. */
  const advertised = catalog(["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"]);
  const live = (overrides: Partial<ClassifierWorld> = {}) =>
    world({ policy: LIVE_POLICY, catalog: advertised, ...overrides } as Partial<ClassifierWorld>);

  it("leads a root agent on claude-opus-5-5, flagged unverified", () => {
    const decision = classifyAgent({ title: "orchestrate the fleet" }, live());

    expect(decision.role.role.id).toBe("leader");
    expect(decision.model.outcome).toBe("selected");
    expect(decision.model.model).toBe("claude-opus-5-5");
    expect(decision.model.unadvertised).toEqual({ source: "pool", ref: "claude-opus-5-5" });
    expect(decision.model.reason).toContain("UNVERIFIED");
    // Allowlisted means selectable, so it is not among the skipped entries.
    expect(decision.model.unadvertisedPoolEntries).toEqual([]);
  });

  it("does the same for a hard worker, whose hard pool leads with the same id", () => {
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-type": "worker", "paseo.task-class": "hard" } }),
      live(),
    );
    expect(decision.model.model).toBe("claude-opus-5-5");
    expect(decision.model.poolSlot).toBe("hard");
    expect(decision.model.unadvertised?.source).toBe("pool");
  });

  it("WITHOUT the allowlist, the same pool silently falls to opus-5 — the regression itself", () => {
    const decision = classifyAgent(
      { title: "orchestrate the fleet" },
      live({ policy: { ...LIVE_POLICY, allowUnlistedModels: [] } }),
    );
    expect(decision.model.model).toBe("claude-opus-5");
    expect(decision.model.unadvertised).toBeUndefined();
    // Not silent any more: the entry that was skipped is named.
    expect(decision.model.unadvertisedPoolEntries).toEqual(["claude-opus-5-5"]);
  });

  it("honors an explicit request for the unadvertised id, and says it is unverified", () => {
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-type": "worker", "paseo.task-class": "hard" }, requestedModel: "claude-opus-5-5" }),
      live(),
    );
    expect(decision.model.outcome).toBe("honored-request");
    expect(decision.model.unadvertised).toEqual({ source: "explicit", ref: "claude/claude-opus-5-5" });
  });

  it("still refuses a typo the operator never allowlisted, and says how to lift it", () => {
    const policy = {
      ...LIVE_POLICY,
      roles: LIVE_POLICY.roles.map((r) =>
        r.id === "worker" ? { ...r, hardModels: ["claude-opus-5-6", "claude-opus-5"] } : r,
      ),
    };
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-type": "worker", "paseo.task-class": "hard" }, requestedModel: "claude-opus-5-6" }),
      live({ policy }),
    );
    expect(decision.model.outcome).toBe("selected");
    expect(decision.model.model).toBe("claude-opus-5");
    expect(decision.model.override?.missingFromCatalog).toBe(true);
    expect(decision.model.reason).toContain("allowUnlistedModels");
  });

  it("the allowlist waives the catalog check and nothing else: a capped model is still refused", () => {
    const decision = classifyAgent(
      { title: "orchestrate the fleet" },
      live({ health: healthyHealth({ isHealthyFor: () => false, isLastResortEligible: () => false }) }),
    );
    expect(decision.model.outcome).toBe("unavailable");
  });
});

describe("classifyAgent — explicit model requests", () => {
  const live = () => world({ policy: LIVE_POLICY });

  it("honors a request the resolved pool approves and can serve right now", () => {
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-type": "worker" }, requestedModel: "claude-haiku-4-5-20251001" }),
      live(),
    );
    expect(decision.model.outcome).toBe("honored-request");
    expect(decision.model.override).toBeUndefined();
  });

  it("overrides a request the resolved pool never approved, and says which", () => {
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-type": "worker" }, requestedModel: "claude-opus-5" }),
      live(),
    );
    expect(decision.model.outcome).toBe("selected");
    expect(decision.model.override).toEqual({
      requestedRef: "claude/claude-opus-5",
      effectiveRef: "claude-sonnet-5",
      reason: "not-approved",
    });
  });

  it("distinguishes 'approved but capped right now' from 'never approved'", () => {
    const capped = world({
      policy: LIVE_POLICY,
      health: healthyHealth({ isHealthyFor: () => false, isLastResortEligible: () => false }),
    });
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-type": "worker" }, requestedModel: "claude-sonnet-5" }),
      capped,
    );
    expect(decision.model.override?.reason).toBe("not-currently-selectable");
  });

  it("falls back to the pool's first entry rather than dropping the spawn", () => {
    const capped = world({
      policy: LIVE_POLICY,
      health: healthyHealth({ isHealthyFor: () => false, isLastResortEligible: () => false }),
    });
    const decision = classifyAgent(child({ labels: { "paseo.agent-type": "worker" } }), capped);
    expect(decision.model.outcome).toBe("unavailable");
    expect(decision.model.model).toBe("claude-sonnet-5");
    expect(decision.model.reason).toContain("rather than dropping the spawn");
  });
});

describe("classifyAgent — the account", () => {
  const at = (overrides: Partial<ClassifierWorld> = {}) =>
    world({ policy: LIVE_POLICY, nowMs: 1_700_000_000_000, ...overrides } as Partial<ClassifierWorld>);

  it("prefers a pooled worker and reports which accounts could have served it", () => {
    const decision = classifyAgent(child({ labels: { "paseo.agent-type": "worker" } }), at());
    expect(decision.account.kind).toBe("worker");
    expect(decision.account.usableProviderIds).toEqual(["claude-work", "claude-spare", "claude-personal"]);
  });

  it("falls to the leader when no worker can serve it, and says isolation is gone", () => {
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-type": "worker" } }),
      at({
        health: healthyHealth({
          isHealthyFor: (providerId: string) => providerId === "claude-personal",
          isLastResortEligible: (providerId: string) => providerId === "claude-personal",
        }),
      }),
    );
    expect(decision.account.kind).toBe("leader");
    expect(decision.account.reason).toContain("Isolation is gone");
  });

  it("reports an exhausted pool rather than a target", () => {
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-type": "worker" } }),
      at({ health: healthyHealth({ isHealthyFor: () => false, isLastResortEligible: () => false }) }),
    );
    expect(decision.account.kind).toBe("exhausted");
  });

  it("places on an account only the CLI's refusal text caps rather than refusing, and says so", () => {
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-type": "worker" } }),
      at({
        health: healthyHealth({
          isHealthyFor: () => false,
          isLastResortEligible: () => false,
          isExhaustedFor: () => false,
        }),
      }),
    );
    expect(decision.account).toMatchObject({ kind: "worker", providerId: "claude-work" });
    expect(decision.account.reason).toContain("never refuses a spawn");
  });

  it("leaves a root agent and a non-pool-family child alone", () => {
    expect(classifyAgent({ title: "root" }, at()).account.kind).toBe("no-pool");
    const policy = withRole(LIVE_POLICY, "worker", { models: ["codex/gpt-5.1"] });
    const codex = classifyAgent(
      child({ labels: { "paseo.agent-type": "worker" }, requestedProvider: "codex" }),
      at({ policy, catalog: new Map([["codex", new Set(["gpt-5.1"])]]) }),
    );
    expect(codex.account.kind).toBe("no-pool");
  });

  describe("a root agent on a pooled account", () => {
    const NOW = new Date("2026-09-24T22:00:00Z");
    const RESET = new Date("2026-09-26T06:00:00Z");
    const rootOn = (requestedProvider: string) => ({ title: "new chat", requestedProvider });
    const healthWith = (readings: Record<string, { window: string; usedPct: number; resetsAt?: Date }[]>) => {
      const health = createHealthTracker({ now: () => NOW });
      for (const [providerId, windows] of Object.entries(readings)) {
        health.reportUsage(providerId, windows);
      }
      return health;
    };

    it("moves to the leader account when its own account is out of budget, and says why", () => {
      const decision = classifyAgent(
        rootOn("claude-spare"),
        at({ nowMs: NOW.getTime(), health: healthWith({ "claude-spare": [{ window: "weekly", usedPct: 100, resetsAt: RESET }] }) }),
      );
      expect(decision.account.kind).toBe("leader");
      expect(decision.account.providerId).toBe("claude-personal");
      expect(decision.account.reroutedFrom).toBe("claude-spare");
      expect(decision.account.reason).toContain("claude-spare");
      expect(decision.account.reason).toContain(RESET.toISOString());
      expect(decision.account.reason.endsWith(".")).toBe(true);
    });

    it("keeps its own account while that account can serve it", () => {
      const decision = classifyAgent(
        rootOn("claude-spare"),
        at({ nowMs: NOW.getTime(), health: healthWith({ "claude-spare": [{ window: "weekly", usedPct: 42 }] }) }),
      );
      expect(decision.account.kind).toBe("no-pool");
      expect(decision.account.providerId).toBe("claude-spare");
      expect(decision.account.reroutedFrom).toBeUndefined();
      expect(decision.account.reason).toContain("keeps");
    });

    it("is not refused when nothing can serve it", () => {
      const capped = { window: "weekly", usedPct: 100 };
      const decision = classifyAgent(
        rootOn("claude-spare"),
        at({
          nowMs: NOW.getTime(),
          health: healthWith({ "claude-spare": [capped], "claude-work": [capped], "claude-personal": [capped] }),
        }),
      );
      expect(decision.account.kind).toBe("exhausted");
      expect(decision.account.providerId).toBe("claude-spare");
      expect(decision.account.reason).toContain("never refused");
    });
  });
});

/**
 * A create with no calling agent is the leader unless it says otherwise. Daemon jobs (the
 * remediation ladder) start agents with no caller and label them workers; ignoring the label ran
 * every one of them as a leader — Opus 5.5 at Extra High on the leader account — including the
 * ones labelled mechanical.
 */
describe("classifyAgent — a caller-less create that declares its role", () => {
  const live = (overrides: Partial<ClassifierWorld> = {}) =>
    world({ policy: LIVE_POLICY, ...overrides } as Partial<ClassifierWorld>);
  const root = (overrides: Partial<ClassifierInput> = {}): ClassifierInput => ({ requestedProvider: "claude", ...overrides });

  it("honours paseo.agent-type: a mechanical worker runs the worker's mechanical model", () => {
    const decision = classifyAgent(
      root({ labels: { "paseo.agent-type": "worker", "paseo.task-class": "mechanical" } }),
      live(),
    );
    expect(decision.role.role.id).toBe("worker");
    expect(decision.role.source).toBe("agent-type-mapping");
    expect(decision.model.model).toBe("claude-haiku-4-5-20251001");
  });

  it("takes its thinking from the task class, as a subagent does, not the leader rule", () => {
    const decision = classifyAgent(root({ labels: { "paseo.agent-type": "worker" } }), live());
    expect(decision.model.model).toBe("claude-sonnet-5");
    expect(decision.thinking).toMatchObject({ outcome: "task-class-default", optionId: "high" });
  });

  it("never runs Ultra Code, the subagent invariant", () => {
    const decision = classifyAgent(
      root({ labels: { "paseo.agent-type": "worker" }, requestedThinkingOptionId: "ultracode" }),
      live(),
    );
    expect(decision.thinking.optionId).not.toBe("ultracode");
  });

  it("honours paseo.agent-role", () => {
    const decision = classifyAgent(root({ labels: { "paseo.agent-role": "reviewer" } }), live());
    expect(decision.role.role.id).toBe("reviewer");
    expect(decision.role.source).toBe("declared-label");
    expect(decision.tools.deniedTools).toContain("Write");
  });

  it("walks the child ladder for its account, and is never refused", () => {
    const at = (health: ClassifierWorld["health"]) => live({ nowMs: 1_700_000_000_000, health } as Partial<ClassifierWorld>);
    const placed = classifyAgent(root({ labels: { "paseo.agent-type": "worker" } }), at(healthyHealth()));
    expect(placed.account).toMatchObject({ kind: "worker", providerId: "claude-work" });

    const out = classifyAgent(
      root({ labels: { "paseo.agent-type": "worker" } }),
      at(healthyHealth({ isHealthyFor: () => false, isLastResortEligible: () => false })),
    );
    expect(out.account.kind).toBe("exhausted");
    expect(out.account.reason).toContain("never refused");
  });

  it("stays the leader with no label, with a label no mapping or role knows, or when only its title names a role", () => {
    for (const input of [
      root(),
      root({ labels: { "paseo.agent-type": "chat" } }),
      root({ labels: { "paseo.agent-role": "nonsense" } }),
      root({ title: "worker" }),
    ]) {
      const decision = classifyAgent(input, live());
      expect(decision.role.role.id).toBe("leader");
      expect(decision.role.source).toBe("leader-tier");
      expect(decision.thinking.outcome).toBe("leader-rule");
    }
  });

  it("keeps a root's MCP servers and output style: nobody's leader reads it", () => {
    const decision = classifyAgent(root({ labels: { "paseo.agent-type": "worker" } }), live());
    expect(decision.outputStyle.style).toBeNull();
    expect(decision.mcp.reason).toContain("no calling agent");
  });
});

describe("classifyAgent — nothing silent", () => {
  it("every part of every decision carries a reason", () => {
    const cases: ClassifierInput[] = [
      { title: "root agent" },
      child({ labels: { "paseo.agent-type": "worker" } }),
      child({ labels: { "paseo.agent-role": "nonsense", "paseo.task-class": "nonsense" }, title: "check it" }),
      child({ requestedModel: "claude-opus-5", labels: { "paseo.agent-type": "reviewer" } }),
    ];
    for (const input of cases) {
      const decision = classifyAgent(input, world({ policy: LIVE_POLICY, nowMs: 1 } as Partial<ClassifierWorld>));
      for (const part of [decision.role, decision.taskClass, decision.model, decision.tools, decision.account, decision.thinking]) {
        expect(part.reason.length).toBeGreaterThan(20);
        expect(part.reason.endsWith(".")).toBe(true);
      }
    }
  });

  it("never quotes a caller-supplied string whole, so a huge label, model, level, style or provider cannot make a huge reason", () => {
    const huge = (char: string) => char.repeat(2_000_000);
    const labels = {
      "paseo.agent-role": huge("r"),
      "paseo.task-class": huge("c"),
      "paseo.mcp": [huge("s"), ...Array.from({ length: 10_000 }, (_, index) => `server-${index}`)].join(","),
    };
    const asked = { labels, requestedModel: huge("m"), requestedThinkingOptionId: huge("t"), requestedOutputStyle: huge("o") };
    const gateway = { mcpGateway: { servers: [{ name: "github", critical: false }] } };
    const cases: Array<[ClassifierInput, Partial<ClassifierWorld>]> = [
      // The live policy overrides the request, and names what was asked for.
      [child(asked), { policy: LIVE_POLICY, ...gateway }],
      // The default policy configures nothing, so the request's own model stands, with no thinking options known for it.
      [child(asked), { thinkingCatalog: new Map(), ...gateway }],
      // A provider outside the pool, for a child and for a root.
      [child({ ...asked, requestedProvider: huge("p") }), gateway],
      [{ ...asked, requestedProvider: huge("p") }, gateway],
      // A root on a pooled account keeps it, and says which model it can run.
      [{ ...asked, requestedProvider: "claude-work" }, gateway],
    ];
    for (const [input, overrides] of cases) {
      const decision = classifyAgent(input, world({ nowMs: 1, ...overrides } as Partial<ClassifierWorld>));
      const { role, taskClass, model, tools, account, thinking, outputStyle, mcp } = decision;
      for (const part of [role, taskClass, model, tools, account, thinking, outputStyle, mcp]) {
        expect(part.reason.length).toBeLessThan(5_000);
      }
      for (const ref of [model.requestedRef, model.override?.requestedRef, model.unadvertised?.ref, thinking.modelRef]) {
        expect(ref?.length ?? 0).toBeLessThanOrEqual(121);
      }
    }
  });
});


/**
 * Tyler's rule, tested end to end: no agent runs Ultra Code unless the policy
 * or a root's own request names it, leaders run Extra High, and no subagent
 * ever runs Ultra Code. `LIVE_POLICY.thinking` is `DEFAULT_THINKING_POLICY`,
 * so every case here is what an operator who never touches the thinking
 * settings gets.
 */
describe("classifyAgent — thinking", () => {
  const live = (overrides: Partial<ClassifierWorld> = {}) =>
    world({ policy: LIVE_POLICY, ...overrides } as Partial<ClassifierWorld>);
  const thinkingPolicy = (patch: Partial<ThinkingPolicy>): ThinkingPolicy => ({ ...DEFAULT_THINKING_POLICY, ...patch });

  /** Opus 4.6's real option set: Max, but no Extra High and so no Ultra Code. */
  const opus46Thinking = thinkingCatalog({
    claude: { "claude-opus-4-6": { optionIds: ["off", "low", "medium", "high", "max"], defaultOptionId: "high" } },
  });
  const onOpus46 = (policy: RoleModelPolicy = LIVE_POLICY) =>
    live({
      policy: withRole(withRole(policy, "leader", { models: ["claude-opus-4-6"] }), "worker", {
        models: ["claude-opus-4-6"],
        hardModels: [],
      }),
      thinkingCatalog: opus46Thinking,
      catalog: new Map([["claude", new Set(["claude-opus-4-6"])]]),
    });

  describe("leaders run Extra High", () => {
    it("a root agent is the leader tier, and runs Extra High", () => {
      const decision = classifyAgent({ title: "orchestrate the fleet" }, live());
      expect(decision.model.model).toBe("claude-opus-5-5");
      expect(decision.thinking).toMatchObject({ outcome: "leader-rule", optionId: "xhigh", wanted: "xhigh" });
      expect(decision.thinking.reason).toContain("Extra High");
      expect(decision.thinking.override).toBeUndefined();
    });

    it("the leader rule outranks a root agent's own request, and records the override", () => {
      const decision = classifyAgent({ title: "orchestrate", requestedThinkingOptionId: "low" }, live());
      expect(decision.thinking).toMatchObject({
        outcome: "leader-rule",
        optionId: "xhigh",
        requested: "low",
        override: { requested: "low", applied: "xhigh", reason: "leader-rule" },
      });
      expect(decision.thinking.reason).toContain("outranks");
    });

    it("a root agent's request for Ultra Code gives way to the leader rule, so a remembered choice can't bring it back", () => {
      const decision = classifyAgent({ title: "orchestrate", requestedThinkingOptionId: "ultracode" }, live());
      expect(decision.thinking).toMatchObject({
        outcome: "leader-rule",
        optionId: "xhigh",
        override: { requested: "ultracode", applied: "xhigh", reason: "leader-rule" },
      });
    });

    it("a leader on a model without Extra High runs the nearest lower level, and says so", () => {
      const decision = classifyAgent({ title: "orchestrate" }, onOpus46());
      expect(decision.model.model).toBe("claude-opus-4-6");
      expect(decision.thinking).toMatchObject({
        outcome: "leader-rule",
        optionId: "high",
        wanted: "xhigh",
        clamped: { wanted: "xhigh", applied: "high", how: "nearest-lower" },
      });
    });
  });

  describe("Ultra Code runs only when named", () => {
    it("a leader level of Ultra Code, chosen in the settings editor, runs it", () => {
      const policy: RoleModelPolicy = { ...LIVE_POLICY, thinking: thinkingPolicy({ leader: "ultracode" }) };
      const decision = classifyAgent({ title: "orchestrate" }, live({ policy }));
      expect(decision.thinking).toMatchObject({ outcome: "leader-rule", optionId: "ultracode", wanted: "ultracode" });
    });

    it("a leader level of Ultra Code on a model without it runs the highest effort that model offers, and says so", () => {
      const policy: RoleModelPolicy = { ...LIVE_POLICY, thinking: thinkingPolicy({ leader: "ultracode" }) };
      const decision = classifyAgent({ title: "orchestrate" }, onOpus46(policy));
      expect(decision.model.model).toBe("claude-opus-4-6");
      expect(decision.thinking).toMatchObject({
        outcome: "leader-rule",
        optionId: "max",
        wanted: "ultracode",
        clamped: { wanted: "ultracode", applied: "max", how: "highest-effort" },
      });
      expect(decision.thinking.reason).toContain("Max");
    });

    it("with the leader rule off, a root agent's own request for Ultra Code is honored", () => {
      const policy: RoleModelPolicy = { ...LIVE_POLICY, thinking: thinkingPolicy({ leader: null }) };
      const decision = classifyAgent({ title: "orchestrate", requestedThinkingOptionId: "ultracode" }, live({ policy }));
      expect(decision.thinking).toMatchObject({ outcome: "requested", optionId: "ultracode" });
      expect(decision.thinking.override).toBeUndefined();
    });

    it("a root agent never gets Ultra Code from its model's default", () => {
      const policy: RoleModelPolicy = { ...LIVE_POLICY, thinking: thinkingPolicy({ leader: null }) };
      const decision = classifyAgent({ title: "orchestrate", requestedThinkingOptionId: "banana" }, live({ policy }));
      expect(decision.model.model).toBe("claude-opus-5-5");
      expect(decision.thinking).toMatchObject({
        outcome: "requested",
        optionId: "xhigh",
        clamped: { wanted: "banana", applied: "xhigh", how: "model-default" },
      });
      expect(decision.thinking.subagentCapped).toBeUndefined();
      expect(decision.thinking.reason).toContain("only when asked for by name");
    });

    it("under the default policy, no root or subagent create that doesn't name Ultra Code gets it", () => {
      for (const callerAgentId of [undefined, "caller-1"]) {
        for (const role of [undefined, "worker", "reviewer", "advisor", "leader"]) {
          for (const requested of [undefined, "low", "high", "xhigh", "max", "banana"]) {
            const input: ClassifierInput = {
              ...(callerAgentId ? { callerAgentId } : {}),
              ...(role ? { labels: { "paseo.agent-role": role } } : {}),
              ...(requested ? { requestedThinkingOptionId: requested } : {}),
            };
            expect(classifyAgent(input, live()).thinking.optionId, JSON.stringify(input)).not.toBe("ultracode");
          }
        }
      }
    });

    it("with the leader rule switched off, a leader's own request stands", () => {
      const policy: RoleModelPolicy = { ...LIVE_POLICY, thinking: thinkingPolicy({ leader: null }) };
      const decision = classifyAgent({ title: "orchestrate", requestedThinkingOptionId: "high" }, live({ policy }));
      expect(decision.thinking).toMatchObject({ outcome: "requested", optionId: "high" });
      expect(decision.thinking.override).toBeUndefined();
    });
  });

  describe("subagents never run Ultra Code", () => {
    it("a subagent asking for Ultra Code gets Extra High, the effort it implies, and the override is recorded", () => {
      const decision = classifyAgent(
        child({ labels: { "paseo.agent-type": "worker", "paseo.task-class": "hard" }, requestedThinkingOptionId: "ultracode" }),
        live(),
      );
      expect(decision.model.model).toBe("claude-opus-5-5");
      expect(decision.thinking).toMatchObject({
        outcome: "requested",
        optionId: "xhigh",
        wanted: "ultracode",
        subagentCapped: true,
        override: { requested: "ultracode", applied: "xhigh", reason: "subagent-no-ultracode" },
      });
      expect(decision.thinking.reason).toContain("subagent");
    });

    it("the Extra High a capped request becomes is still clamped to what the model offers", () => {
      const decision = classifyAgent(
        child({ labels: { "paseo.agent-type": "worker" }, requestedThinkingOptionId: "ultracode" }),
        onOpus46(),
      );
      expect(decision.thinking).toMatchObject({
        optionId: "high",
        subagentCapped: true,
        clamped: { wanted: "xhigh", applied: "high", how: "nearest-lower" },
        override: { requested: "ultracode", applied: "high", reason: "subagent-no-ultracode" },
      });
    });

    it("a child resolved to the leader role is still a subagent, so a leader level of Ultra Code gives it Extra High", () => {
      const policy: RoleModelPolicy = { ...LIVE_POLICY, thinking: thinkingPolicy({ leader: "ultracode" }) };
      const decision = classifyAgent(child({ labels: { "paseo.agent-role": "leader" } }), live({ policy }));
      expect(decision.role.role.id).toBe("leader");
      expect(decision.model.model).toBe("claude-opus-5-5");
      expect(decision.thinking).toMatchObject({
        outcome: "leader-rule",
        optionId: "xhigh",
        wanted: "ultracode",
        subagentCapped: true,
      });
    });

    it("no policy value and no request can give a subagent Ultra Code", () => {
      const policy: RoleModelPolicy = {
        ...LIVE_POLICY,
        thinking: { leader: "ultracode", byTaskClass: { mechanical: "ultracode", standard: "ultracode", hard: "ultracode" } },
      };
      const inputs: ClassifierInput[] = [];
      for (const role of ["worker", "reviewer", "advisor", "leader"]) {
        for (const taskClass of [undefined, "mechanical", "standard", "hard"]) {
          for (const requested of [undefined, "ultracode", "max"]) {
            inputs.push(
              child({
                labels: { "paseo.agent-role": role, ...(taskClass ? { "paseo.task-class": taskClass } : {}) },
                ...(requested ? { requestedThinkingOptionId: requested } : {}),
              }),
            );
          }
        }
      }
      for (const input of inputs) {
        const decision = classifyAgent(input, live({ policy }));
        expect(decision.thinking.optionId, JSON.stringify(input)).not.toBe("ultracode");
      }
    });

    it("no policy value and no request gives a subagent Ultra Code under the default policy, an empty catalog, or a model without it", () => {
      const worlds = [live({ policy: DEFAULT_POLICY }), live({ thinkingCatalog: new Map() }), onOpus46()];
      for (const w of worlds) {
        for (const role of ["worker", "leader"]) {
          for (const requested of [undefined, "ultracode"]) {
            for (const requestedModel of [undefined, "claude-opus-5-5"]) {
              const input = child({
                labels: { "paseo.agent-role": role },
                ...(requested ? { requestedThinkingOptionId: requested } : {}),
                ...(requestedModel ? { requestedModel } : {}),
              });
              expect(classifyAgent(input, w).thinking.optionId, JSON.stringify(input)).not.toBe("ultracode");
            }
          }
        }
      }
    });

    it("a subagent on a model that offers only Ultra Code gets no level at all, and a requested one is removed", () => {
      const onlyUltracode = thinkingCatalog({ claude: { "claude-sonnet-5": { optionIds: ["ultracode"], defaultOptionId: "ultracode" } } });
      const decision = classifyAgent(
        child({ labels: { "paseo.agent-type": "worker" }, requestedThinkingOptionId: "high" }),
        live({ thinkingCatalog: onlyUltracode }),
      );
      expect(decision.model.model).toBe("claude-sonnet-5");
      expect(decision.thinking).toMatchObject({
        outcome: "no-thinking-options",
        optionId: null,
        override: { requested: "high", applied: null, reason: "no-thinking-options" },
      });
      expect(decision.thinking.reason).toContain("subagent");

      // A root on the same model gets the only option there is: nothing else is offered.
      const root = classifyAgent({ requestedModel: "claude-sonnet-5" }, live({ policy: DEFAULT_POLICY, thinkingCatalog: onlyUltracode }));
      expect(root.thinking.optionId).toBe("ultracode");
    });

    it("a subagent whose create names no model, on a role with no pool, is left alone: no model to verify a level against", () => {
      const decision = classifyAgent(child({ labels: { "paseo.agent-type": "worker" } }), live({ policy: DEFAULT_POLICY }));
      expect(decision.model.outcome).toBe("unconfigured");
      expect(decision.thinking).toMatchObject({ outcome: "model-unknown", optionId: null });
      expect(decision.thinking.override).toBeUndefined();
    });

    it("every subagent whose model offers thinking gets an explicit level, so Opus 5.5's Ultra Code default never reaches one", () => {
      // The fixture gives Opus 5.5 the manifest's own default, Ultra Code — the
      // level a create with no thinkingOptionId would otherwise fall back to.
      expect(thinkingCatalog().get("claude")?.get("claude-opus-5-5")?.defaultOptionId).toBe("ultracode");
      for (const role of ["worker", "reviewer", "advisor"]) {
        for (const taskClass of [undefined, "mechanical", "standard", "hard"]) {
          const decision = classifyAgent(
            child({ labels: { "paseo.agent-role": role, ...(taskClass ? { "paseo.task-class": taskClass } : {}) } }),
            live(),
          );
          if (decision.thinking.outcome === "no-thinking-options") {
            continue; // Haiku: nothing to set.
          }
          const where = `${role}/${taskClass ?? "unresolved"} on ${decision.model.model}`;
          expect(decision.thinking.outcome, where).toBe("task-class-default");
          expect(decision.thinking.optionId, where).not.toBeNull();
          expect(decision.thinking.optionId, where).not.toBe("ultracode");
        }
      }
    });

    it("a subagent asking for Ultra Code on a model the catalog doesn't list has it removed, since nothing lower can be verified", () => {
      const decision = classifyAgent(
        child({ labels: { "paseo.agent-type": "worker" }, requestedThinkingOptionId: "ultracode" }),
        live({ thinkingCatalog: new Map() }),
      );
      expect(decision.thinking).toMatchObject({
        outcome: "model-unknown",
        optionId: null,
        override: { requested: "ultracode", applied: null, reason: "subagent-no-ultracode" },
      });
    });
  });

  describe("subagent thinking comes from the task class", () => {
    it("mechanical defaults to low", () => {
      const policy = withRole(LIVE_POLICY, "worker", { mechanicalModels: ["claude-sonnet-5"] });
      const decision = classifyAgent(
        child({ labels: { "paseo.agent-type": "worker", "paseo.task-class": "mechanical" } }),
        live({ policy }),
      );
      expect(decision.model.model).toBe("claude-sonnet-5");
      expect(decision.thinking).toMatchObject({ outcome: "task-class-default", optionId: "low", wanted: "low" });
    });

    it("standard defaults to high", () => {
      const decision = classifyAgent(child({ labels: { "paseo.agent-type": "worker", "paseo.task-class": "standard" } }), live());
      expect(decision.model.model).toBe("claude-sonnet-5");
      expect(decision.thinking).toMatchObject({ outcome: "task-class-default", optionId: "high", wanted: "high" });
    });

    it("hard defaults to xhigh, on Opus 5.5 too", () => {
      const decision = classifyAgent(child({ labels: { "paseo.agent-type": "worker", "paseo.task-class": "hard" } }), live());
      expect(decision.model.model).toBe("claude-opus-5-5");
      expect(decision.thinking).toMatchObject({ outcome: "task-class-default", optionId: "xhigh", wanted: "xhigh" });
    });

    it("an unresolved task class uses the standard default, and the reason says so", () => {
      const decision = classifyAgent(child({ labels: { "paseo.agent-type": "worker" } }), live());
      expect(decision.taskClass.taskClass).toBeUndefined();
      expect(decision.thinking).toMatchObject({ outcome: "task-class-default", optionId: "high" });
      expect(decision.thinking.reason).toContain("standard");
    });

    it("an explicit request beats the class default, with no override", () => {
      const decision = classifyAgent(
        child({ labels: { "paseo.agent-type": "worker" }, requestedThinkingOptionId: "max" }),
        live(),
      );
      expect(decision.model.model).toBe("claude-sonnet-5");
      expect(decision.thinking).toMatchObject({ outcome: "requested", optionId: "max", requested: "max", wanted: "max" });
      expect(decision.thinking.override).toBeUndefined();
    });

    it("the class defaults are policy: a configured one replaces the shipped one", () => {
      const policy: RoleModelPolicy = {
        ...LIVE_POLICY,
        thinking: thinkingPolicy({ byTaskClass: { mechanical: "low", standard: "medium", hard: "max" } }),
      };
      const decision = classifyAgent(child({ labels: { "paseo.agent-type": "worker" } }), live({ policy }));
      expect(decision.thinking).toMatchObject({ outcome: "task-class-default", optionId: "medium" });
    });
  });

  describe("clamping", () => {
    it("clamps a requested xhigh down to the nearest lower level a model without xhigh offers", () => {
      const decision = classifyAgent(
        child({ labels: { "paseo.agent-type": "worker" }, requestedThinkingOptionId: "xhigh" }),
        onOpus46(),
      );
      expect(decision.thinking).toMatchObject({
        outcome: "requested",
        optionId: "high",
        wanted: "xhigh",
        clamped: { wanted: "xhigh", applied: "high", how: "nearest-lower" },
        override: { requested: "xhigh", applied: "high", reason: "not-advertised" },
      });
    });

    it("clamps off up to the nearest higher level on Opus 5.5, which cannot disable thinking", () => {
      const decision = classifyAgent(
        child({ labels: { "paseo.agent-type": "worker", "paseo.task-class": "hard" }, requestedThinkingOptionId: "off" }),
        live(),
      );
      expect(decision.model.model).toBe("claude-opus-5-5");
      expect(decision.thinking).toMatchObject({
        outcome: "requested",
        optionId: "low",
        wanted: "off",
        clamped: { wanted: "off", applied: "low", how: "nearest-higher" },
      });
    });

    it("falls back to the model's own default when the requested id isn't on the ladder at all", () => {
      const decision = classifyAgent(
        child({ labels: { "paseo.agent-type": "worker" }, requestedThinkingOptionId: "banana" }),
        onOpus46(),
      );
      expect(decision.thinking).toMatchObject({
        outcome: "requested",
        optionId: "high",
        clamped: { wanted: "banana", applied: "high", how: "model-default" },
      });
    });

    it("a subagent never gets Ultra Code from its model's default, even when that default is Ultra Code", () => {
      const decision = classifyAgent(
        child({ labels: { "paseo.agent-type": "worker", "paseo.task-class": "hard" }, requestedThinkingOptionId: "banana" }),
        live(),
      );
      expect(decision.model.model).toBe("claude-opus-5-5");
      expect(decision.thinking.optionId).toBe("xhigh");
      expect(decision.thinking.subagentCapped).toBe(true);
    });
  });

  it("a model with no thinking options gives optionId null and clears a requested id, with an override", () => {
    const policy = withRole(LIVE_POLICY, "worker", { models: ["claude-haiku-4-5-20251001"] });
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-type": "worker" }, requestedThinkingOptionId: "max" }),
      live({ policy }),
    );
    expect(decision.model.model).toBe("claude-haiku-4-5-20251001");
    expect(decision.thinking).toMatchObject({
      outcome: "no-thinking-options",
      optionId: null,
      requested: "max",
      override: { requested: "max", applied: null, reason: "no-thinking-options" },
    });
    expect(decision.thinking.reason).toContain("no thinking options");
  });

  it("a model missing from the thinking catalog gives model-unknown, leaves the request's own option, and records no override", () => {
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-type": "worker" }, requestedThinkingOptionId: "max" }),
      live({ thinkingCatalog: new Map() }),
    );
    expect(decision.thinking).toMatchObject({ outcome: "model-unknown", optionId: "max", requested: "max" });
    expect(decision.thinking.override).toBeUndefined();
  });

  describe("the effective model follows the model decision", () => {
    it("a request for opus overridden by policy to sonnet is decided against sonnet, not opus", () => {
      const decision = classifyAgent(
        child({
          labels: { "paseo.agent-type": "worker" },
          requestedModel: "claude-opus-5",
          requestedThinkingOptionId: "max",
        }),
        live(),
      );
      expect(decision.model.outcome).toBe("selected");
      expect(decision.model.model).toBe("claude-sonnet-5"); // worker's pool doesn't include opus-5; policy overrode
      expect(decision.thinking).toMatchObject({ outcome: "requested", optionId: "max", modelRef: "claude-sonnet-5" });
    });

    it("an unconfigured role is decided against the request's own model", () => {
      const decision = classifyAgent(
        { callerAgentId: "caller-1", requestedModel: "claude-sonnet-5", requestedThinkingOptionId: "max" },
        live({ policy: DEFAULT_POLICY }),
      );
      expect(decision.model.outcome).toBe("unconfigured");
      expect(decision.thinking).toMatchObject({ outcome: "requested", optionId: "max", modelRef: "claude-sonnet-5" });
    });

    it("a root agent on an unconfigured leader role is decided against the model it asked for", () => {
      const decision = classifyAgent(
        { requestedModel: "claude-sonnet-5", requestedThinkingOptionId: "high" },
        live({ policy: DEFAULT_POLICY }),
      );
      expect(decision.model.outcome).toBe("unconfigured");
      expect(decision.thinking).toMatchObject({ outcome: "leader-rule", optionId: "xhigh", modelRef: "claude-sonnet-5" });
    });
  });
});

/**
 * The live catalog lists Haiku as `claude-haiku-4-5`; the policy the operator
 * wrote spelled it as the dated snapshot. The classifier must resolve the
 * spelling against the catalog rather than skip the entry as unadvertised.
 */
describe("classifyAgent — a pool entry spelled differently from the catalog", () => {
  const LIVE_CATALOG = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];
  const spelled = () =>
    world({
      policy: LIVE_POLICY,
      catalog: catalog(LIVE_CATALOG),
      thinkingCatalog: thinkingCatalog({
        claude: {
          "claude-opus-5": { optionIds: ["off", "low", "medium", "high", "xhigh", "max"], defaultOptionId: "high" },
          "claude-sonnet-5": { optionIds: ["off", "low", "medium", "high", "xhigh", "max"], defaultOptionId: "high" },
          "claude-haiku-4-5": { optionIds: [] },
        },
      }),
    } as Partial<ClassifierWorld>);

  it("runs the catalog's Haiku for a mechanical worker, without falling back or flagging it unadvertised", () => {
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-type": "worker", "paseo.task-class": "mechanical" } }),
      spelled(),
    );
    expect(decision.model).toMatchObject({
      outcome: "selected",
      model: "claude-haiku-4-5",
      resolvedFrom: "claude-haiku-4-5-20251001",
      poolSlot: "mechanical",
      unadvertisedPoolEntries: [],
    });
    expect(decision.model.unadvertised).toBeUndefined();
    expect(decision.model.reason).toContain("claude-haiku-4-5-20251001");
    expect(decision.thinking.outcome).toBe("no-thinking-options");
  });

  it("honors an explicit request for the catalog's spelling instead of overriding it to Sonnet", () => {
    const decision = classifyAgent(
      child({
        labels: { "paseo.agent-type": "worker", "paseo.task-class": "mechanical" },
        requestedProvider: "claude",
        requestedModel: "claude-haiku-4-5",
      }),
      spelled(),
    );
    expect(decision.model.outcome).toBe("honored-request");
    expect(decision.model.override).toBeUndefined();
  });

  it("still lists a pool entry that no spelling of matches, so it is never silently dead", () => {
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-type": "worker", "paseo.task-class": "hard" } }),
      spelled(),
    );
    // opus-5-5 is not in this catalog and the policy allowlists it, so it is not skipped;
    // with the allowlist removed it must be reported.
    const strict = classifyAgent(
      child({ labels: { "paseo.agent-type": "worker", "paseo.task-class": "hard" } }),
      world({ ...spelled(), policy: { ...LIVE_POLICY, allowUnlistedModels: [] } } as Partial<ClassifierWorld>),
    );
    expect(decision.model.unadvertisedPoolEntries).toEqual([]);
    expect(strict.model.unadvertisedPoolEntries).toEqual(["claude-opus-5-5"]);
    expect(strict.model.model).toBe("claude-opus-5");
  });
});

describe("classifyAgent — output style", () => {
  const live = (overrides: Partial<ClassifierWorld> = {}) =>
    world({ policy: LIVE_POLICY, ...overrides } as Partial<ClassifierWorld>);

  it("gives a child the policy's style, and says why", () => {
    const decision = classifyAgent(child({ labels: { "paseo.agent-type": "worker" } }), live());
    expect(decision.outputStyle).toMatchObject({ style: "Concise", source: "policy" });
    expect(decision.outputStyle.reason).toContain("Concise");
  });

  it("leaves a root agent alone: the operator reads a leader's narration", () => {
    const decision = classifyAgent({ title: "orchestrate the fleet" }, live());
    expect(decision.outputStyle).toMatchObject({ style: null, source: "none" });
    expect(decision.outputStyle.reason).toContain("root");
  });

  it("applies to every child role, not only workers", () => {
    for (const agentType of ["worker", "reviewer", "advisor"]) {
      expect(classifyAgent(child({ labels: { "paseo.agent-type": agentType } }), live()).outputStyle.style).toBe(
        "Concise",
      );
    }
  });

  it("is off when the policy says null", () => {
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-type": "worker" } }),
      live({ policy: { ...LIVE_POLICY, childOutputStyle: null } } as Partial<ClassifierWorld>),
    );
    expect(decision.outputStyle).toMatchObject({ style: null, source: "none" });
    expect(decision.outputStyle.reason).toContain("switched off");
  });

  it("keeps a style the caller set: explicit beats inferred", () => {
    const decision = classifyAgent(child({ requestedOutputStyle: "Explanatory" }), live());
    expect(decision.outputStyle).toMatchObject({ style: "Explanatory", source: "requested" });
  });

  it("does not apply to a non-Claude child, which has no such setting", () => {
    const decision = classifyAgent(
      child({ requestedProvider: "codex", requestedModel: "gpt-5" }),
      world({ policy: DEFAULT_POLICY, catalog: new Map([["codex", new Set(["gpt-5"])]]) } as Partial<ClassifierWorld>),
    );
    expect(decision.outputStyle).toMatchObject({ style: null, source: "none" });
    expect(decision.outputStyle.reason).toContain("codex");
  });
});

describe("classifyAgent — arena-ranked model pick (U8)", () => {
  function arenaPolicy(overrides: Partial<ArenaPolicy> = {}): ArenaPolicy {
    return { enabled: true, shadow: false, roles: ["worker", "reviewer"], topTier: ["claude-opus-5-5"], topTierMarginCi: 0, maxAgeHours: 72, ...overrides };
  }

  function row(overrides: Partial<ArenaRankingRow> & { ours: string }): ArenaRankingRow {
    return { arenaName: overrides.ours, effort: "high", rating: 1500, ratingLower: 1490, ratingUpper: 1510, votes: 500, ...overrides };
  }

  function rankings(boards: Record<string, ArenaRankingRow[]>): ArenaRankingsFile {
    return { fetchedAt: Date.now(), publishDate: "2026-10-08", boards, unmatched: {} };
  }

  // Operator order deliberately does NOT match rank order (haiku first, sonnet second): a test
  // that picks sonnet would otherwise prove nothing, since sonnet is also the pool's own default.
  const arenaPool: RoleModelPolicy = withRole(
    withRole(DEFAULT_POLICY, "worker", { models: ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5-5"] }),
    "reviewer",
    { models: ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5-5"] },
  );

  function workKindHint(choice: string, status: "answered" | "shadow" = "answered"): SpawnHint {
    return {
      status,
      callId: "jev-call-arena",
      answers: { workKind: { choice, confidence: 0.9 } },
      proposal: {},
      applyHard: false,
      applyRole: false,
      declaredAudit: status === "shadow",
    };
  }

  function arenaWorld(overrides: Partial<ClassifierWorld> = {}): ClassifierWorld {
    return world({
      policy: { ...arenaPool, arena: arenaPolicy() },
      catalog: catalog(["claude-sonnet-5", "claude-opus-5-5", "claude-haiku-4-5-20251001"]),
      // Non-overlapping CIs, so a genuine score-order win is distinguishable from a CI-overlap tie
      // (which would fall back to operator order instead — see `arenaPool` above for why that matters).
      arenaRanking: rankings({
        "webdev/webdev-react": [
          row({ ours: "claude-sonnet-5", rating: 1774, ratingLower: 1760, ratingUpper: 1790 }),
          row({ ours: "claude-opus-5-5", rating: 1900, ratingLower: 1880, ratingUpper: 1920 }),
          row({ ours: "claude-haiku-4-5-20251001", rating: 1500, ratingLower: 1480, ratingUpper: 1510 }),
        ],
      }),
      ...overrides,
    } as Partial<ClassifierWorld>);
  }

  it("a frontend standard worker: ranking reorders the pool to the higher-ranked mid-tier model", () => {
    const decision = classifyAgent(child({ jevHint: workKindHint("frontend") }), arenaWorld());
    // claude-opus-5-5 is topTier, dropped from a standard pool before ranking ever runs, so the
    // best REMAINING ranked candidate (sonnet-5, over haiku) wins — proving the reorder landed,
    // not just "whatever was listed first".
    expect(decision.model.model).toBe("claude-sonnet-5");
    expect(decision.model.ranking).toMatchObject({ outcome: "ranked", applied: true, ref: "claude-sonnet-5" });
  });

  it("with arena.shadow on: the label/decision show the would-be pick, applied 0, and the model stays today's order", () => {
    const shadowPool = withRole(arenaPool, "worker", { models: ["codex/gpt-6-sol", "claude-sonnet-5"] });
    const decision = classifyAgent(
      child({ jevHint: workKindHint("frontend") }),
      world({
        policy: { ...shadowPool, arena: arenaPolicy({ shadow: true, topTier: [] }) },
        catalog: new Map([
          ["claude", new Set(["claude-sonnet-5"])],
          ["codex", new Set(["gpt-6-sol"])],
        ]),
        arenaRanking: rankings({
          "webdev/webdev-react": [
            row({ ours: "claude-sonnet-5", rating: 1774, ratingLower: 1760, ratingUpper: 1790 }),
            row({ ours: "codex/gpt-6-sol", rating: 1688, ratingLower: 1670, ratingUpper: 1700 }),
          ],
        }),
      } as Partial<ClassifierWorld>),
    );
    // Today's order (operator order) still wins: codex/gpt-6-sol is first in the pool.
    expect(decision.model.provider).toBe("codex");
    expect(decision.model.model).toBe("gpt-6-sol");
    expect(decision.model.ranking).toMatchObject({ outcome: "ranked", applied: false, ref: "claude-sonnet-5" });
  });

  it("no leader decision carries a ranking, even with arena.enabled true", () => {
    const decision = classifyAgent({ title: "lead this" }, arenaWorld());
    expect(decision.model.ranking).toBeUndefined();
  });

  it("every fallback case gives today's order with a reason", () => {
    // Declared class: always falls back, whatever the kind.
    const declared = classifyAgent(
      child({ labels: { "paseo.task-class": "standard" }, jevHint: workKindHint("frontend") }),
      arenaWorld(),
    );
    expect(declared.model.ranking).toMatchObject({ outcome: "fallback", reason: "declared-class" });

    // Unknown kind: no hint at all, and the role isn't a reviewer.
    const unknownKind = classifyAgent(child(), arenaWorld());
    expect(unknownKind.model.ranking).toMatchObject({ outcome: "fallback", reason: "unknown-kind" });

    // Ranking disabled.
    const disabled = classifyAgent(
      child({ jevHint: workKindHint("frontend") }),
      arenaWorld({ policy: { ...arenaPool, arena: arenaPolicy({ enabled: false }) } } as Partial<ClassifierWorld>),
    );
    expect(disabled.model.ranking).toMatchObject({ outcome: "fallback", reason: "disabled" });

    // Role not in arena.roles.
    const outOfScope = classifyAgent(
      child({ labels: { "paseo.agent-type": "advisor" }, jevHint: workKindHint("research") }),
      arenaWorld(),
    );
    expect(outOfScope.model.ranking).toMatchObject({ outcome: "fallback", reason: "role-out-of-scope" });

    // Missing rankings file.
    const noFile = classifyAgent(child({ jevHint: workKindHint("frontend") }), arenaWorld({ arenaRanking: undefined }));
    expect(noFile.model.ranking).toMatchObject({ outcome: "fallback", reason: "no-file" });
  });

  it("a reviewer with no work_kind answer defaults to the review kind", () => {
    const reviewPolicy = withRole(arenaPool, "reviewer", { models: ["claude-sonnet-5", "codex/gpt-6-sol"] });
    const decision = classifyAgent(
      child({ labels: { "paseo.agent-type": "reviewer" } }),
      world({
        policy: { ...reviewPolicy, arena: arenaPolicy() },
        catalog: new Map([
          ["claude", new Set(["claude-sonnet-5"])],
          ["codex", new Set(["gpt-6-sol"])],
        ]),
        arenaRanking: rankings({
          "text_style_control/hard_prompts": [row({ ours: "claude-sonnet-5", rating: 1500 }), row({ ours: "codex/gpt-6-sol", rating: 1400 })],
        }),
      } as Partial<ClassifierWorld>),
    );
    expect(decision.model.ranking).toMatchObject({ outcome: "ranked", board: "text_style_control/hard_prompts" });
  });

  it("an old policy without the arena key parses and behaves exactly as before: no ranking field at all", () => {
    const decision = classifyAgent(child({ jevHint: workKindHint("frontend") }), world({ policy: arenaPool }));
    expect(decision.model.ranking).toBeUndefined();
  });

  it("a ref the usability check rejects is never picked and does not count toward the two-candidate floor", () => {
    // Neither candidate is topTier, so this isolates the usability check: codex/gpt-6-sol is
    // ranked and would otherwise count, but it's absent from the catalog and not allowlisted.
    const usabilityPool = withRole(arenaPool, "worker", { models: ["claude-sonnet-5", "codex/gpt-6-sol"] });
    const decision = classifyAgent(
      child({ jevHint: workKindHint("frontend") }),
      world({
        policy: { ...usabilityPool, arena: arenaPolicy({ topTier: [] }) },
        catalog: new Map([["claude", new Set(["claude-sonnet-5"])]]), // no "codex" family at all
        arenaRanking: rankings({
          "webdev/webdev-react": [row({ ours: "claude-sonnet-5", rating: 1774 }), row({ ours: "codex/gpt-6-sol", rating: 1900 })],
        }),
      } as Partial<ClassifierWorld>),
    );
    expect(decision.model.ranking).toMatchObject({ outcome: "fallback", reason: "no-ranked-board" });
  });
});
