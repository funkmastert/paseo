import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  DEFAULT_THINKING_POLICY,
  type RoleModelPolicy,
  type RoleRecord,
  type ThinkingPolicy,
} from "../shared/role-policy-schema";
import { classifyAgent, type ClassifierInput, type ClassifierWorld } from "./classifier";
import { createHealthTracker } from "./health";
import type { ModelThinkingOptions, ThinkingCatalog } from "./model-catalog";
import type { ModelCatalog } from "./role-availability";

/**
 * The world every case below starts from: two healthy pooled workers, a
 * leader, and a catalog listing the live model ids. Health is a plain object
 * rather than the real tracker — the classifier takes health as data, which
 * is the point of it being pure.
 */
function healthyHealth(overrides: Partial<ClassifierWorld["health"]> = {}): ClassifierWorld["health"] {
  return {
    isHealthyFor: () => true,
    isHealthyForAllWindows: () => true,
    isLastResortEligible: () => true,
    windowUtilization: () => undefined,
    describeWindow: () => undefined,
    windowIds: () => [],
    ...overrides,
  } as ClassifierWorld["health"];
}

const LIVE_MODELS = ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"];

function catalog(models: readonly string[] = LIVE_MODELS): ModelCatalog {
  return new Map([["claude", new Set(models)]]);
}

/**
 * A thinking catalog shaped like the real manifest: Opus 5.5 offers no `off`
 * (thinking can't be disabled) and defaults to `ultracode`, the level the
 * app's selector preselects for it; everything else offering `xhigh` also
 * offers `ultracode`; Haiku offers nothing at all.
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
});


/**
 * Tyler's rule, tested end to end: "the leader probably needs ultracode
 * because it DOES work with multiple agents.. but no sub agent would ever
 * need it, the classifier can decide that". `LIVE_POLICY.thinking` is
 * `DEFAULT_THINKING_POLICY`, so every case here is what an operator who never
 * touches the thinking settings gets.
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

  describe("leaders run Ultra Code", () => {
    it("a root agent is the leader tier, and runs Ultra Code", () => {
      const decision = classifyAgent({ title: "orchestrate the fleet" }, live());
      expect(decision.model.model).toBe("claude-opus-5-5");
      expect(decision.thinking).toMatchObject({ outcome: "leader-rule", optionId: "ultracode", wanted: "ultracode" });
      expect(decision.thinking.reason).toContain("Ultra Code");
      expect(decision.thinking.override).toBeUndefined();
    });

    it("the leader rule outranks a root agent's own request, and records the override", () => {
      const decision = classifyAgent({ title: "orchestrate", requestedThinkingOptionId: "low" }, live());
      expect(decision.thinking).toMatchObject({
        outcome: "leader-rule",
        optionId: "ultracode",
        requested: "low",
        override: { requested: "low", applied: "ultracode", reason: "leader-rule" },
      });
      expect(decision.thinking.reason).toContain("outranks");
    });

    it("a leader on a model without Ultra Code runs the highest effort that model offers, and says so", () => {
      const decision = classifyAgent({ title: "orchestrate" }, onOpus46());
      expect(decision.model.model).toBe("claude-opus-4-6");
      expect(decision.thinking).toMatchObject({
        outcome: "leader-rule",
        optionId: "max",
        wanted: "ultracode",
        clamped: { wanted: "ultracode", applied: "max", how: "highest-effort" },
      });
      expect(decision.thinking.reason).toContain("Max");
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

    it("a child resolved to the leader role is still a subagent, so the leader rule gives it Extra High", () => {
      const decision = classifyAgent(child({ labels: { "paseo.agent-role": "leader" } }), live());
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

      // A leader on the same model runs it.
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
      expect(decision.thinking).toMatchObject({ outcome: "leader-rule", optionId: "ultracode", modelRef: "claude-sonnet-5" });
    });
  });
});
