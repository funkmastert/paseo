import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  type RoleModelPolicy,
  type RoleRecord,
} from "../shared/role-policy-schema";
import { classifyAgent, type ClassifierInput, type ClassifierWorld } from "./classifier";
import { createHealthTracker } from "./health";
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

function world(overrides: Partial<ClassifierWorld> = {}): ClassifierWorld {
  return {
    policy: DEFAULT_POLICY,
    catalog: catalog(),
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
      for (const part of [decision.role, decision.taskClass, decision.model, decision.tools, decision.account]) {
        expect(part.reason.length).toBeGreaterThan(20);
        expect(part.reason.endsWith(".")).toBe(true);
      }
    }
  });
});
