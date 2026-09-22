import { describe, expect, it, vi } from "vitest";
import type { PluginBeforeRequests, PluginHookContext } from "@getpaseo/plugin/server";
import type { ResolvedPool } from "../shared/pool-config";
import {
  AGENT_ROLE_LABEL,
  AGENT_TYPE_LABEL,
  DEFAULT_POLICY,
  MODEL_OVERRIDDEN_LABEL,
  TASK_CLASS_LABEL,
  TOOLS_DENIED_LABEL,
  type RoleModelPolicy,
} from "../shared/role-policy-schema";
import { createHealthTracker } from "./health";
import type { ModelCatalog } from "./model-catalog";
import { createRouter } from "./router";
import { createRecentAgentTypes } from "./recent-agent-types";
import { createRoleRouter, type RoleCreateRouter, type RoleRouterOptions } from "./role-router";

type CreateAgentRequest = PluginBeforeRequests["agent.create"];

function request(overrides: Record<string, unknown>): { request: CreateAgentRequest } {
  return {
    request: {
      config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp/work" },
      ...overrides,
    } as unknown as CreateAgentRequest,
  };
}

const fakeContext = {} as PluginHookContext;

function fakePolicyCache(policy: RoleModelPolicy) {
  return { get: () => policy, isMalformed: () => false, lastError: () => undefined, forceRefresh: vi.fn(), stop: vi.fn() };
}

function fakeCatalogCache(catalog: ModelCatalog) {
  return { get: () => catalog, forceRefresh: vi.fn(), stop: vi.fn() };
}

function fakePoolCache(pool: ResolvedPool, failOpen = false) {
  return { get: () => ({ pool, failOpen }), forceRefresh: vi.fn(), stop: vi.fn() };
}

function catalog(entries: Record<string, string[]>): ModelCatalog {
  return new Map(Object.entries(entries).map(([family, models]) => [family, new Set(models)]));
}

function policyWithWorkerModels(models: string[]): RoleModelPolicy {
  return {
    ...DEFAULT_POLICY,
    roles: DEFAULT_POLICY.roles.map((role) => (role.id === "worker" ? { ...role, models } : role)),
  };
}

function baseOptions(overrides: Partial<RoleRouterOptions> = {}): RoleRouterOptions {
  return {
    policyCache: fakePolicyCache(DEFAULT_POLICY),
    catalogCache: fakeCatalogCache(new Map()),
    poolCache: fakePoolCache({ workers: [], leader: null }),
    health: createHealthTracker(),
    recentAgentTypes: createRecentAgentTypes(),
    ...overrides,
  };
}

describe("createRoleRouter", () => {
  it("returns a root-agent request untouched while the leader role is unconfigured", () => {
    const router = createRoleRouter(baseOptions({ policyCache: fakePolicyCache(policyWithWorkerModels(["codex/gpt-5.1"])) }));

    const result = router(request({}), fakeContext);

    expect(result).toBeUndefined();
  });

  describe("leader role (root agents, no callerAgentId)", () => {
    function policyWithLeader(overrides: Partial<RoleModelPolicy["roles"][number]>): RoleModelPolicy {
      return {
        ...DEFAULT_POLICY,
        roles: DEFAULT_POLICY.roles.map((role) => (role.id === "leader" ? { ...role, ...overrides } : role)),
      };
    }

    it("enforces the leader's tool profile on a root agent", () => {
      const router = createRoleRouter(
        baseOptions({ policyCache: fakePolicyCache(policyWithLeader({ toolProfile: { kind: "orchestrator" } })) }),
      );

      const result = router(request({}), fakeContext);

      const options = result?.config.providerOptions as { disallowedTools: string[] };
      expect(options.disallowedTools).toEqual(expect.arrayContaining(["Read", "Write", "Bash", "Task"]));
    });

    it("applies the leader's own model pool", () => {
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(policyWithLeader({ models: ["claude-opus-5"] })),
          catalogCache: fakeCatalogCache(catalog({ claude: ["claude-opus-5"] })),
          poolCache: fakePoolCache({ workers: [{ providerId: "worker-a", priority: 1 }], leader: { providerId: "claude" } }),
        }),
      );

      const result = router(request({}), fakeContext);

      expect(result?.config.model).toBe("claude-opus-5");
    });

    it("does not apply the leader profile to a spawned child", () => {
      const router = createRoleRouter(
        baseOptions({ policyCache: fakePolicyCache(policyWithLeader({ toolProfile: { kind: "orchestrator" } })) }),
      );

      expect(router(request({ callerAgentId: "c1" }), fakeContext)).toBeUndefined();
    });

    it("does not apply the leader profile to a child whose prompt merely says 'leader'", () => {
      const router = createRoleRouter(
        baseOptions({ policyCache: fakePolicyCache(policyWithLeader({ toolProfile: { kind: "orchestrator" } })) }),
      );

      const result = router(
        request({ callerAgentId: "c1", initialPrompt: "you are the leader of this effort" }),
        fakeContext,
      );

      expect(result).toBeUndefined();
    });
  });

  it("UNCONFIGURED: passes an empty-models role through byte-identical", () => {
    const router = createRoleRouter(baseOptions());

    const result = router(request({ callerAgentId: "c1" }), fakeContext);

    expect(result).toBeUndefined();
  });

  it("rewrites config.model when the resolved role's top model is catalog-eligible", () => {
    const router = createRoleRouter(
      baseOptions({
        policyCache: fakePolicyCache(policyWithWorkerModels(["codex/gpt-5.1"])),
        catalogCache: fakeCatalogCache(catalog({ codex: ["gpt-5.1"] })),
      }),
    );

    const result = router(request({ callerAgentId: "c1" }), fakeContext);

    expect(result?.config.model).toBe("gpt-5.1");
    expect(result?.config.provider).toBe("codex"); // crossed families: claude -> codex
  });

  it("leaves config.provider untouched when the selection stays in the claude family", () => {
    const pool: ResolvedPool = { workers: [{ providerId: "worker-a", priority: 1 }], leader: { providerId: "leader" } };
    const router = createRoleRouter(
      baseOptions({
        policyCache: fakePolicyCache(policyWithWorkerModels(["claude/claude-opus-4"])),
        catalogCache: fakeCatalogCache(catalog({ claude: ["claude-opus-4"] })),
        poolCache: fakePoolCache(pool),
      }),
    );

    const result = router(request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp" } }), fakeContext);

    expect(result?.config.model).toBe("claude-opus-4");
    expect(result?.config.provider).toBe("claude"); // still the family id; the account router decides the account next
  });

  it("leaves config.provider untouched when the request already pinned a pool worker id in the same family", () => {
    const pool: ResolvedPool = { workers: [{ providerId: "worker-a", priority: 1 }], leader: { providerId: "leader" } };
    const router = createRoleRouter(
      baseOptions({
        policyCache: fakePolicyCache(policyWithWorkerModels(["claude/claude-opus-4"])),
        catalogCache: fakeCatalogCache(catalog({ claude: ["claude-opus-4"] })),
        poolCache: fakePoolCache(pool),
      }),
    );

    const result = router(request({ callerAgentId: "c1", config: { provider: "worker-a", model: "claude-sonnet", cwd: "/tmp" } }), fakeContext);

    expect(result?.config.provider).toBe("worker-a");
    expect(result?.config.model).toBe("claude-opus-4");
  });

  describe("account-agnostic (bare) model refs", () => {
    const pool: ResolvedPool = { workers: [{ providerId: "worker-a", priority: 1 }], leader: { providerId: "claude" } };

    function bareRouter() {
      return createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(policyWithWorkerModels(["claude-opus-4"])),
          catalogCache: fakeCatalogCache(catalog({ claude: ["claude-opus-4"] })),
          poolCache: fakePoolCache(pool),
        }),
      );
    }

    it("rewrites only config.model, never config.provider", () => {
      const result = bareRouter()(
        request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp" } }),
        fakeContext,
      );

      expect(result?.config.model).toBe("claude-opus-4");
      expect(result?.config.provider).toBe("claude");
    });

    it("leaves a worker the account router already chose in place", () => {
      const result = bareRouter()(
        request({ callerAgentId: "c1", config: { provider: "worker-a", model: "claude-sonnet", cwd: "/tmp" } }),
        fakeContext,
      );

      expect(result?.config.provider).toBe("worker-a");
      expect(result?.config.model).toBe("claude-opus-4");
    });

    it("reports an unavailable bare ref without a bogus provider prefix", () => {
      const onRoleUnavailable = vi.fn();
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(policyWithWorkerModels(["claude-ghost"])),
          catalogCache: fakeCatalogCache(catalog({ claude: [] })),
          poolCache: fakePoolCache(pool),
          onRoleUnavailable,
        }),
      );

      router(request({ callerAgentId: "c1" }), fakeContext);

      expect(onRoleUnavailable).toHaveBeenCalledWith(
        expect.objectContaining({ requestedModel: "claude-ghost", reason: "no-eligible-model" }),
      );
    });
  });

  describe("tool profile enforcement", () => {
    function policyWithWorkerProfile(profile: RoleModelPolicy["roles"][number]["toolProfile"]): RoleModelPolicy {
      return {
        ...DEFAULT_POLICY,
        roles: DEFAULT_POLICY.roles.map((role) => (role.id === "worker" ? { ...role, toolProfile: profile } : role)),
      };
    }

    // These tests exercise the profile-MERGE mechanics (union with a caller's
    // existing deny list, model rewrite + tool rewrite together, etc.), not
    // tier gating — so every request here declares the role explicitly via
    // labels[AGENT_ROLE_LABEL] (tier 2 = evidence), keeping the resolved role
    // "worker" without depending on the tier-3/4 default. Tier gating itself
    // is covered in the "tool profile gating by resolution tier" block below.
    function declaredWorker(overrides: Record<string, unknown> = {}) {
      return request({ callerAgentId: "c1", labels: { [AGENT_ROLE_LABEL]: "worker" }, ...overrides });
    }

    it("enforces the profile even when the role has NO configured models", () => {
      const router = createRoleRouter(
        baseOptions({ policyCache: fakePolicyCache(policyWithWorkerProfile({ kind: "orchestrator" })) }),
      );

      const result = router(declaredWorker(), fakeContext);

      const options = result?.config.providerOptions as { disallowedTools: string[] };
      expect(options.disallowedTools).toContain("Bash");
      expect(result?.config.model).toBe("claude-sonnet"); // untouched: no models configured
    });

    it("still passes through byte-identical for the default unrestricted profile", () => {
      const router = createRoleRouter(baseOptions());

      expect(router(declaredWorker(), fakeContext)).toBeUndefined();
    });

    it("applies both the model rewrite and the tool profile together", () => {
      const policy = {
        ...policyWithWorkerProfile({ kind: "read-only" }),
        roles: policyWithWorkerProfile({ kind: "read-only" }).roles.map((role) =>
          role.id === "worker" ? { ...role, models: ["codex/gpt-5.1"] } : role,
        ),
      };
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(policy),
          catalogCache: fakeCatalogCache(catalog({ codex: ["gpt-5.1"] })),
        }),
      );

      const result = router(declaredWorker(), fakeContext);

      expect(result?.config.model).toBe("gpt-5.1");
      const options = result?.config.providerOptions as { disallowedTools: string[] };
      expect(options.disallowedTools).toContain("Write");
      expect(options.disallowedTools).not.toContain("Read");
    });

    it("never weakens a restriction the caller already set", () => {
      const router = createRoleRouter(
        baseOptions({ policyCache: fakePolicyCache(policyWithWorkerProfile({ kind: "custom", deny: ["Write"] })) }),
      );

      const result = router(
        declaredWorker({
          config: { provider: "claude", cwd: "/tmp", providerOptions: { disallowedTools: ["Bash"] } },
        }),
        fakeContext,
      );

      const options = result?.config.providerOptions as { disallowedTools: string[] };
      expect(options.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Write"]));
    });

    it("keeps enforcing when a pinned provider vanished from the registry", () => {
      const policy = {
        ...policyWithWorkerProfile({ kind: "orchestrator" }),
        roles: policyWithWorkerProfile({ kind: "orchestrator" }).roles.map((role) =>
          role.id === "worker" ? { ...role, models: ["codex/gpt-5.1"] } : role,
        ),
      };
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(policy),
          catalogCache: fakeCatalogCache(catalog({ codex: ["gpt-5.1"] })),
          providerIds: { get: () => new Set(["claude"]), forceRefresh: vi.fn(), stop: vi.fn() },
        }),
      );

      const result = router(declaredWorker(), fakeContext);

      expect(result?.config.model).toBe("claude-sonnet"); // no model rewrite: target is gone
      const options = result?.config.providerOptions as { disallowedTools: string[] };
      expect(options.disallowedTools).toContain("Bash");
    });

    it("leaves root agents (no callerAgentId) alone", () => {
      const router = createRoleRouter(
        baseOptions({ policyCache: fakePolicyCache(policyWithWorkerProfile({ kind: "orchestrator" })) }),
      );

      expect(router(request({}), fakeContext)).toBeUndefined();
    });
  });

  // A restriction the agent has to discover by hitting it costs a whole turn
  // and then invites it to route around the denial. These cover the other
  // half of enforcement: saying so up front, via the agent's own system
  // prompt (`providerOptions.appendSystemPrompt`) rather than `initialPrompt`
  // — the daemon discards a hook's mutation of the latter.
  describe("restriction notice in the system prompt", () => {
    function policyWithWorkerProfile(profile: RoleModelPolicy["roles"][number]["toolProfile"]): RoleModelPolicy {
      return {
        ...DEFAULT_POLICY,
        roles: DEFAULT_POLICY.roles.map((role) => (role.id === "worker" ? { ...role, toolProfile: profile } : role)),
      };
    }

    function declaredWorker(overrides: Record<string, unknown> = {}) {
      return request({ callerAgentId: "c1", labels: { [AGENT_ROLE_LABEL]: "worker" }, ...overrides });
    }

    function noticeOf(result: ReturnType<RoleCreateRouter>): string | undefined {
      return (result?.config.providerOptions as { appendSystemPrompt?: string } | undefined)?.appendSystemPrompt;
    }

    function promptOf(result: ReturnType<RoleCreateRouter>): string | undefined {
      return (result as { initialPrompt?: string } | undefined)?.initialPrompt;
    }

    it("names the denial and the alternative, and never touches initialPrompt", () => {
      const router = createRoleRouter(
        baseOptions({ policyCache: fakePolicyCache(policyWithWorkerProfile({ kind: "read-only" })) }),
      );

      const result = router(declaredWorker({ initialPrompt: "Audit the auth flow." }), fakeContext);

      const notice = noticeOf(result) as string;
      expect(notice).toContain("Edit");
      expect(notice).toContain("Bash");
      expect(notice).toMatch(/report the change/i);
      expect(promptOf(result)).toBe("Audit the auth flow."); // the caller's initialPrompt passes through untouched
    });

    it("points an orchestrator at create_agent as the way to get work done", () => {
      const router = createRoleRouter(
        baseOptions({ policyCache: fakePolicyCache(policyWithWorkerProfile({ kind: "orchestrator" })) }),
      );

      const notice = noticeOf(router(declaredWorker({ initialPrompt: "Ship the migration." }), fakeContext));

      expect(notice).toContain("mcp__paseo__create_agent");
    });

    it("adds nothing at all for an unrestricted role: byte-identical pass-through", () => {
      const router = createRoleRouter(baseOptions());

      expect(router(declaredWorker({ initialPrompt: "Ship the migration." }), fakeContext)).toBeUndefined();
    });

    it("fires even for a create with no initialPrompt at all — it's a system prompt, not a first turn", () => {
      const router = createRoleRouter(
        baseOptions({ policyCache: fakePolicyCache(policyWithWorkerProfile({ kind: "read-only" })) }),
      );

      const result = router(declaredWorker(), fakeContext);

      expect(noticeOf(result)).toContain("[tool profile: read-only]");
      expect((result?.config.providerOptions as { disallowedTools: string[] }).disallowedTools).toContain("Write");
    });

    it("survives the model-rewrite path, not just the tools-only path", () => {
      const restricted = policyWithWorkerProfile({ kind: "read-only" });
      const policy = {
        ...restricted,
        roles: restricted.roles.map((role) => (role.id === "worker" ? { ...role, models: ["codex/gpt-5.1"] } : role)),
      };
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(policy),
          catalogCache: fakeCatalogCache(catalog({ codex: ["gpt-5.1"] })),
        }),
      );

      const result = router(declaredWorker({ initialPrompt: "Audit the auth flow." }), fakeContext);

      expect(result?.config.model).toBe("gpt-5.1");
      expect(noticeOf(result)).toContain("[tool profile: read-only]");
    });

    it("survives the explicit-model-override path, which also rewrites labels", () => {
      const restricted = policyWithWorkerProfile({ kind: "read-only" });
      const policy = {
        ...restricted,
        roles: restricted.roles.map((role) => (role.id === "worker" ? { ...role, models: ["claude-haiku"] } : role)),
      };
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(policy),
          catalogCache: fakeCatalogCache(catalog({ claude: ["claude-haiku"] })),
          poolCache: fakePoolCache({ workers: [{ providerId: "worker-a", priority: 1 }], leader: null }),
        }),
      );

      const result = router(
        declaredWorker({ initialPrompt: "Audit the auth flow.", config: { provider: "claude", model: "claude-opus-5", cwd: "/tmp" } }),
        fakeContext,
      );

      expect(result?.config.model).toBe("claude-haiku");
      expect(result?.labels?.[MODEL_OVERRIDDEN_LABEL]).toBe("claude/claude-opus-5");
      expect(noticeOf(result)).toContain("[tool profile: read-only]");
    });

    it("says nothing when a guessed role's profile was withheld — no restriction, no notice", () => {
      const router = createRoleRouter(
        baseOptions({ policyCache: fakePolicyCache(policyWithWorkerProfile({ kind: "read-only" })) }),
      );

      // No role label: tier-3/4 classification, whose tool profile is withheld.
      expect(router(request({ callerAgentId: "c1", initialPrompt: "Implement the parser." }), fakeContext)).toBeUndefined();
    });
  });

  // A read-only agent keeps `mcp__paseo__create_agent` on purpose — delegating
  // is the sanctioned path. Inheritance is what stops that being an escape
  // hatch: spawn an unrestricted worker, have it do the writing you can't.
  describe("tool profile inheritance from the spawning agent", () => {
    function policyWithProfile(roleId: string, profile: RoleModelPolicy["roles"][number]["toolProfile"]): RoleModelPolicy {
      return {
        ...DEFAULT_POLICY,
        roles: DEFAULT_POLICY.roles.map((role) => (role.id === roleId ? { ...role, toolProfile: profile } : role)),
      };
    }

    /** A policy that restricts SOME role, which is what arms inheritance at all. */
    const restrictivePolicy = policyWithProfile("reviewer", { kind: "read-only" });

    function parents(map: Record<string, readonly string[]>, fallback: "cold" | "unknown" = "unknown") {
      return {
        note: vi.fn(),
        warm: vi.fn(async () => {}),
        stop: vi.fn(),
        lookup: (agentId: string) =>
          agentId in map ? ({ status: "known", denied: map[agentId] } as const) : ({ status: fallback } as const),
      };
    }

    function denials(result: ReturnType<RoleCreateRouter>): string[] {
      return ((result?.config.providerOptions as { disallowedTools?: string[] })?.disallowedTools ?? []).slice();
    }

    it("a read-only parent cannot spawn an unrestricted child", () => {
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(restrictivePolicy),
          parentProfiles: parents({ reviewer1: ["Edit", "Write", "Bash"] }),
        }),
      );

      const result = router(
        request({ callerAgentId: "reviewer1", labels: { [AGENT_ROLE_LABEL]: "worker" }, initialPrompt: "Apply the fix." }),
        fakeContext,
      );

      expect(denials(result)).toEqual(expect.arrayContaining(["Edit", "Write", "Bash"]));
    });

    it("unions rather than replaces: the child keeps its own role's denials too", () => {
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache({
            ...restrictivePolicy,
            roles: restrictivePolicy.roles.map((role) =>
              role.id === "worker" ? { ...role, toolProfile: { kind: "custom" as const, deny: ["WebFetch"] } } : role,
            ),
          }),
          parentProfiles: parents({ p1: ["Bash"] }),
        }),
      );

      const result = router(
        request({ callerAgentId: "p1", labels: { [AGENT_ROLE_LABEL]: "worker" } }),
        fakeContext,
      );

      expect(denials(result)).toEqual(expect.arrayContaining(["WebFetch", "Bash"]));
    });

    it("never subtracts: an unrestricted parent leaves an unrestricted child alone", () => {
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(restrictivePolicy),
          parentProfiles: parents({ p1: [] }),
        }),
      );

      expect(
        router(request({ callerAgentId: "p1", labels: { [AGENT_ROLE_LABEL]: "worker" } }), fakeContext),
      ).toBeUndefined();
    });

    it("records what was denied on the child's own labels, so its children inherit in turn", () => {
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(restrictivePolicy),
          parentProfiles: parents({ p1: ["Bash"] }),
        }),
      );

      const result = router(request({ callerAgentId: "p1", labels: { [AGENT_ROLE_LABEL]: "worker" } }), fakeContext);

      expect(result?.labels?.[TOOLS_DENIED_LABEL]).toBe("Bash");
    });

    it("strips a caller-forged denial label when nothing was actually denied", () => {
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(restrictivePolicy),
          parentProfiles: parents({ p1: [] }),
        }),
      );

      const result = router(
        request({ callerAgentId: "p1", labels: { [AGENT_ROLE_LABEL]: "worker", [TOOLS_DENIED_LABEL]: "Read" } }),
        fakeContext,
      );

      expect(result?.labels?.[TOOLS_DENIED_LABEL]).toBeUndefined();
    });

    it("tells the child the restriction was inherited, not configured for it", () => {
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(restrictivePolicy),
          parentProfiles: parents({ p1: ["Bash"] }),
        }),
      );

      const result = router(
        request({ callerAgentId: "p1", labels: { [AGENT_ROLE_LABEL]: "worker" }, initialPrompt: "Apply the fix." }),
        fakeContext,
      );

      const notice = (result?.config.providerOptions as { appendSystemPrompt?: string })?.appendSystemPrompt;
      expect(notice).toMatch(/came from the agent that spawned you/);
    });

    it("fails SAFE for a parent the directory does not know, rather than granting a clean child", () => {
      const onParentProfileUnresolved = vi.fn();
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(restrictivePolicy),
          parentProfiles: parents({}, "unknown"),
          onParentProfileUnresolved,
        }),
      );

      const result = router(request({ callerAgentId: "ghost", labels: { [AGENT_ROLE_LABEL]: "worker" } }), fakeContext);

      expect(denials(result)).toEqual(expect.arrayContaining(["Edit", "Write", "Bash"]));
      expect(denials(result)).not.toContain("Read");
      expect(onParentProfileUnresolved).toHaveBeenCalledWith(
        expect.objectContaining({ callerAgentId: "ghost", reason: "not-in-directory", failedSafe: true }),
      );
    });

    it("fails OPEN while the directory has not loaded yet, so a restart cannot cripple every spawn", () => {
      const onParentProfileUnresolved = vi.fn();
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(restrictivePolicy),
          parentProfiles: parents({}, "cold"),
          onParentProfileUnresolved,
        }),
      );

      const result = router(request({ callerAgentId: "p1", labels: { [AGENT_ROLE_LABEL]: "worker" } }), fakeContext);

      expect(result).toBeUndefined();
      expect(onParentProfileUnresolved).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "directory-cold", failedSafe: false }),
      );
    });

    it("notifies once per caller, not once per spawn", () => {
      const onParentProfileUnresolved = vi.fn();
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(restrictivePolicy),
          parentProfiles: parents({}, "unknown"),
          onParentProfileUnresolved,
        }),
      );

      router(request({ callerAgentId: "ghost", labels: { [AGENT_ROLE_LABEL]: "worker" } }), fakeContext);
      router(request({ callerAgentId: "ghost", labels: { [AGENT_ROLE_LABEL]: "worker" } }), fakeContext);

      expect(onParentProfileUnresolved).toHaveBeenCalledTimes(1);
    });

    it("does not consult the parent at all when no role restricts anything", () => {
      const parentProfiles = parents({}, "unknown");
      const lookup = vi.spyOn(parentProfiles, "lookup");
      const router = createRoleRouter(baseOptions({ parentProfiles }));

      const result = router(
        request({ callerAgentId: "ghost", labels: { [AGENT_ROLE_LABEL]: "worker" } }),
        fakeContext,
      );

      expect(result).toBeUndefined(); // byte-identical: the common path is untouched
      expect(lookup).not.toHaveBeenCalled();
    });

    it("leaves root agents alone: a root agent has no parent to inherit from", () => {
      const parentProfiles = parents({}, "unknown");
      const lookup = vi.spyOn(parentProfiles, "lookup");
      const router = createRoleRouter(
        baseOptions({ policyCache: fakePolicyCache(restrictivePolicy), parentProfiles }),
      );

      router(request({}), fakeContext);

      expect(lookup).not.toHaveBeenCalled();
    });

    it("applies inheritance even to a role whose own profile was withheld as a tier-3 guess", () => {
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(restrictivePolicy),
          parentProfiles: parents({ p1: ["Bash"] }),
        }),
      );

      // No role label: tier-3 classification, so the role's OWN profile is
      // withheld. The parent's is not a guess, so it still applies.
      const result = router(request({ callerAgentId: "p1", initialPrompt: "Implement the parser." }), fakeContext);

      expect(denials(result)).toEqual(["Bash"]);
    });
  });

  describe("tool profile gating by resolution tier", () => {
    function policyWithWorkerProfile(profile: RoleModelPolicy["roles"][number]["toolProfile"]): RoleModelPolicy {
      return {
        ...DEFAULT_POLICY,
        roles: DEFAULT_POLICY.roles.map((role) => (role.id === "worker" ? { ...role, toolProfile: profile } : role)),
      };
    }

    function policyWithReviewerProfile(profile: RoleModelPolicy["roles"][number]["toolProfile"]): RoleModelPolicy {
      return {
        ...DEFAULT_POLICY,
        roles: DEFAULT_POLICY.roles.map((role) => (role.id === "reviewer" ? { ...role, toolProfile: profile } : role)),
      };
    }

    function noTools(result: ReturnType<RoleCreateRouter>): boolean {
      const options = result?.config.providerOptions as { disallowedTools?: string[] } | undefined;
      return options?.disallowedTools === undefined;
    }

    it("REGRESSION: a realistic implementation prompt containing 'check'/'verify' does NOT lose its tools", () => {
      // Exactly the shape of the bug that shipped: an implementation brief
      // routinely tells the agent to check types or verify tests, which
      // matches REVIEWER_SEED_RE and classifies as tier-3 "reviewer" even
      // though the agent is meant to write code.
      const router = createRoleRouter(
        baseOptions({ policyCache: fakePolicyCache(policyWithReviewerProfile({ kind: "read-only" })) }),
      );

      const result = router(
        request({
          callerAgentId: "c1",
          initialPrompt:
            "Implement the new caching layer, add a test file, then check types and verify all tests pass before committing.",
        }),
        fakeContext,
      );

      expect(noTools(result)).toBe(true); // no disallowedTools at all: Write/Edit/Bash stay available
    });

    it("tier 4 (bare default, no title/prompt at all) also withholds the profile", () => {
      const router = createRoleRouter(
        baseOptions({ policyCache: fakePolicyCache(policyWithWorkerProfile({ kind: "orchestrator" })) }),
      );

      const result = router(request({ callerAgentId: "c1" }), fakeContext);

      expect(noTools(result)).toBe(true);
    });

    it("tier 1 (explicit paseo.agent-type mapping) still enforces the profile", () => {
      const router = createRoleRouter(
        baseOptions({ policyCache: fakePolicyCache(policyWithWorkerProfile({ kind: "orchestrator" })) }),
      );

      const result = router(
        request({ callerAgentId: "c1", labels: { [AGENT_TYPE_LABEL]: "worker" } }),
        fakeContext,
      );

      const options = result?.config.providerOptions as { disallowedTools: string[] };
      expect(options.disallowedTools).toContain("Bash");
    });

    it("tier 2 (explicit paseo.agent-role label) still enforces the profile", () => {
      const router = createRoleRouter(
        baseOptions({ policyCache: fakePolicyCache(policyWithReviewerProfile({ kind: "read-only" })) }),
      );

      const result = router(
        request({ callerAgentId: "c1", labels: { [AGENT_ROLE_LABEL]: "reviewer" } }),
        fakeContext,
      );

      const options = result?.config.providerOptions as { disallowedTools: string[] };
      expect(options.disallowedTools).toContain("Bash");
    });

    it("the deterministic leader tier (root agent) still enforces the profile", () => {
      const policy = {
        ...DEFAULT_POLICY,
        roles: DEFAULT_POLICY.roles.map((role) =>
          role.id === "leader" ? { ...role, toolProfile: { kind: "orchestrator" as const } } : role,
        ),
      };
      const router = createRoleRouter(baseOptions({ policyCache: fakePolicyCache(policy) }));

      const result = router(request({}), fakeContext); // no callerAgentId: root agent

      const options = result?.config.providerOptions as { disallowedTools: string[] };
      expect(options.disallowedTools).toContain("Bash");
    });

    it("model selection still applies to a tier-3 classified role even though its tool profile is withheld", () => {
      const policy = {
        ...policyWithReviewerProfile({ kind: "read-only" }),
        roles: policyWithReviewerProfile({ kind: "read-only" }).roles.map((role) =>
          role.id === "reviewer" ? { ...role, models: ["codex/gpt-5.1"] } : role,
        ),
      };
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(policy),
          catalogCache: fakeCatalogCache(catalog({ codex: ["gpt-5.1"] })),
        }),
      );

      const result = router(request({ callerAgentId: "c1", initialPrompt: "please review and verify this" }), fakeContext);

      expect(result?.config.model).toBe("gpt-5.1"); // model still routed to reviewer's pool
      expect(noTools(result)).toBe(true); // but the tool restriction is withheld
    });

    it("escape hatch: enforceToolsOnClassifiedRoles=true enforces the profile even for a tier-3 classified role", () => {
      const policy = { ...policyWithReviewerProfile({ kind: "read-only" }), enforceToolsOnClassifiedRoles: true };
      const router = createRoleRouter(baseOptions({ policyCache: fakePolicyCache(policy) }));

      const result = router(request({ callerAgentId: "c1", initialPrompt: "please review and verify this" }), fakeContext);

      const options = result?.config.providerOptions as { disallowedTools: string[] };
      expect(options.disallowedTools).toContain("Bash");
    });

    it("does not fire onToolProfileWithheld when the classified role's own profile is already unrestricted", () => {
      const onToolProfileWithheld = vi.fn();
      const router = createRoleRouter(baseOptions({ onToolProfileWithheld })); // DEFAULT_POLICY: every profile unrestricted

      router(request({ callerAgentId: "c1", initialPrompt: "please review and verify this" }), fakeContext);

      expect(onToolProfileWithheld).not.toHaveBeenCalled();
    });

    it("fires onToolProfileWithheld exactly once per (caller, role), not once per create", () => {
      const onToolProfileWithheld = vi.fn();
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(policyWithReviewerProfile({ kind: "read-only" })),
          onToolProfileWithheld,
        }),
      );
      const req = () => request({ callerAgentId: "c1", initialPrompt: "please review and verify this" });

      router(req(), fakeContext);
      router(req(), fakeContext);

      expect(onToolProfileWithheld).toHaveBeenCalledTimes(1);
      expect(onToolProfileWithheld).toHaveBeenCalledWith({ callerAgentId: "c1", roleId: "reviewer", tier: 3 });
    });
  });

  it("preserves other config fields (modeId, providerOptions, cwd) across the rewrite", () => {
    const router = createRoleRouter(
      baseOptions({
        policyCache: fakePolicyCache(policyWithWorkerModels(["codex/gpt-5.1"])),
        catalogCache: fakeCatalogCache(catalog({ codex: ["gpt-5.1"] })),
      }),
    );

    const result = router(
      request({
        callerAgentId: "c1",
        config: { provider: "claude", model: "claude-sonnet", modeId: "default", providerOptions: { foo: "bar" }, cwd: "/tmp/work" },
      }),
      fakeContext,
    );

    expect(result?.config.modeId).toBe("default");
    expect(result?.config.providerOptions).toEqual({ foo: "bar" });
    expect(result?.config.cwd).toBe("/tmp/work");
  });

  it("resolves via tier 2 declared role label and routes to that role's model", () => {
    const router = createRoleRouter(
      baseOptions({
        policyCache: fakePolicyCache({
          ...DEFAULT_POLICY,
          roles: DEFAULT_POLICY.roles.map((role) => (role.id === "reviewer" ? { ...role, models: ["codex/gpt-5.1"] } : role)),
        }),
        catalogCache: fakeCatalogCache(catalog({ codex: ["gpt-5.1"] })),
      }),
    );

    const result = router(request({ callerAgentId: "c1", labels: { [AGENT_ROLE_LABEL]: "reviewer" } } as unknown as Record<string, unknown>), fakeContext);

    expect(result?.config.model).toBe("gpt-5.1");
  });

  it("records the agent-type label into recentAgentTypes on every gated create", () => {
    const recentAgentTypes = createRecentAgentTypes();
    const router = createRoleRouter(baseOptions({ recentAgentTypes }));

    router(request({ callerAgentId: "c1", labels: { [AGENT_TYPE_LABEL]: "ce-code-reviewer" } } as unknown as Record<string, unknown>), fakeContext);

    expect(recentAgentTypes.list()).toEqual(["ce-code-reviewer"]);
  });

  it("falls back to title for recentAgentTypes when no agent-type label is present", () => {
    const recentAgentTypes = createRecentAgentTypes();
    const router = createRoleRouter(baseOptions({ recentAgentTypes }));

    router(request({ callerAgentId: "c1", config: { provider: "claude", model: "x", cwd: "/tmp", title: "Untitled Scout" } }), fakeContext);

    expect(recentAgentTypes.list()).toEqual(["Untitled Scout"]);
  });

  it("calls onDeclaredRoleUnknown exactly once per (callerAgentId, value), not once per create", () => {
    const onDeclaredRoleUnknown = vi.fn();
    const router = createRoleRouter(baseOptions({ onDeclaredRoleUnknown }));

    router(request({ callerAgentId: "c1", labels: { [AGENT_ROLE_LABEL]: "not-a-role" } } as unknown as Record<string, unknown>), fakeContext);
    router(request({ callerAgentId: "c1", labels: { [AGENT_ROLE_LABEL]: "not-a-role" } } as unknown as Record<string, unknown>), fakeContext);

    expect(onDeclaredRoleUnknown).toHaveBeenCalledTimes(1);
    expect(onDeclaredRoleUnknown).toHaveBeenCalledWith({ callerAgentId: "c1", value: "not-a-role" });
  });

  it("still fires onDeclaredRoleUnknown again for a different caller declaring the same unknown value", () => {
    const onDeclaredRoleUnknown = vi.fn();
    const router = createRoleRouter(baseOptions({ onDeclaredRoleUnknown }));

    router(request({ callerAgentId: "c1", labels: { [AGENT_ROLE_LABEL]: "not-a-role" } } as unknown as Record<string, unknown>), fakeContext);
    router(request({ callerAgentId: "c2", labels: { [AGENT_ROLE_LABEL]: "not-a-role" } } as unknown as Record<string, unknown>), fakeContext);

    expect(onDeclaredRoleUnknown).toHaveBeenCalledTimes(2);
  });

  it("never blocks the create even when the declared role is unknown", () => {
    const router = createRoleRouter(
      baseOptions({
        policyCache: fakePolicyCache(policyWithWorkerModels(["codex/gpt-5.1"])),
        catalogCache: fakeCatalogCache(catalog({ codex: ["gpt-5.1"] })),
      }),
    );

    // Unknown role label falls through to classification -> worker (empty title/prompt) -> routed normally.
    const result = router(request({ callerAgentId: "c1", labels: { [AGENT_ROLE_LABEL]: "not-a-role" } } as unknown as Record<string, unknown>), fakeContext);

    expect(result?.config.model).toBe("gpt-5.1");
  });

  it("UNAVAILABLE: calls onRoleUnavailable exactly once, and re-arms on recovery", () => {
    const onRoleUnavailable = vi.fn();
    const pool: ResolvedPool = { workers: [{ providerId: "worker-a", priority: 1 }], leader: { providerId: "leader" } };
    const health = createHealthTracker();
    // No catalog entries at all: both refs are catalog-missing -> UNAVAILABLE every time.
    const unavailablePolicy = fakePolicyCache(policyWithWorkerModels(["claude/claude-opus-4"]));
    const router = createRoleRouter({
      ...baseOptions({ poolCache: fakePoolCache(pool), health, onRoleUnavailable }),
      policyCache: unavailablePolicy,
      catalogCache: fakeCatalogCache(new Map()), // empty catalog: always catalog-miss
    });

    const first = router(request({ callerAgentId: "c1" }), fakeContext);
    const second = router(request({ callerAgentId: "c2" }), fakeContext);

    expect(first?.config.model).toBe("claude-opus-4"); // still uses models[0]
    expect(second?.config.model).toBe("claude-opus-4");
    expect(onRoleUnavailable).toHaveBeenCalledTimes(1);
    expect(onRoleUnavailable).toHaveBeenCalledWith({
      callerAgentId: "c1",
      roleId: "worker",
      requestedModel: "claude/claude-opus-4",
      reason: "no-eligible-model",
    });

    // Recovery: catalog now has the model and the worker is healthy -> selected, not unavailable.
    const router2 = createRoleRouter({
      ...baseOptions({ poolCache: fakePoolCache(pool), health, onRoleUnavailable }),
      policyCache: unavailablePolicy,
      catalogCache: fakeCatalogCache(catalog({ claude: ["claude-opus-4"] })),
    });
    router2(request({ callerAgentId: "c3" }), fakeContext);
    // A fresh router instance re-arms naturally (its own dedup state); the
    // re-arm-on-recovery guarantee is that the SAME instance clears its
    // dedup set once selection succeeds again, verified below.
    expect(onRoleUnavailable).toHaveBeenCalledTimes(1);
  });

  it("re-arms within the same router instance: unavailable, then recovered, then unavailable again fires twice total", () => {
    const onRoleUnavailable = vi.fn();
    const pool: ResolvedPool = { workers: [{ providerId: "worker-a", priority: 1 }], leader: { providerId: "leader" } };
    const health = createHealthTracker();
    const policy = policyWithWorkerModels(["claude/claude-opus-4"]);
    let currentCatalog: ModelCatalog = new Map(); // starts catalog-missing -> unavailable
    const catalogCache = { get: () => currentCatalog, forceRefresh: vi.fn(), stop: vi.fn() };
    const router = createRoleRouter({
      ...baseOptions({ poolCache: fakePoolCache(pool), health, onRoleUnavailable }),
      policyCache: fakePolicyCache(policy),
      catalogCache,
    });

    router(request({ callerAgentId: "c1" }), fakeContext);
    expect(onRoleUnavailable).toHaveBeenCalledTimes(1);

    router(request({ callerAgentId: "c1" }), fakeContext); // still unavailable: no additional call
    expect(onRoleUnavailable).toHaveBeenCalledTimes(1);

    currentCatalog = catalog({ claude: ["claude-opus-4"] }); // recovers
    router(request({ callerAgentId: "c1" }), fakeContext);
    expect(onRoleUnavailable).toHaveBeenCalledTimes(1); // no call on recovery itself

    currentCatalog = new Map(); // goes unavailable again
    router(request({ callerAgentId: "c1" }), fakeContext);
    expect(onRoleUnavailable).toHaveBeenCalledTimes(2); // re-armed
  });

  it("F2: cross-family rewrite to an unregistered provider family passes through untouched and fires role-unavailable with a distinct reason", () => {
    const onRoleUnavailable = vi.fn();
    const pool: ResolvedPool = { workers: [{ providerId: "worker-a", priority: 1 }], leader: { providerId: "leader" } };
    // Registry the account router actually knows about: "deadfamily" was
    // removed from daemon config, so it's absent here even though the
    // role's models[0] still names it.
    const providerIds = { get: () => new Set(["claude", "worker-a", "leader"]), forceRefresh: vi.fn(), stop: vi.fn() };
    const router = createRoleRouter({
      ...baseOptions({ poolCache: fakePoolCache(pool), onRoleUnavailable }),
      policyCache: fakePolicyCache(policyWithWorkerModels(["deadfamily/some-model"])),
      catalogCache: fakeCatalogCache(new Map()), // "deadfamily" never resolves in the catalog either
      providerIds,
    });

    const initial = request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp" } });
    const result = router(initial, fakeContext);

    expect(result).toBeUndefined(); // pass-through = recovered, not blocked: request untouched
    const finalProvider = (result ?? initial.request).config.provider;
    expect(providerIds.get().has(finalProvider)).toBe(true); // still a provider the registry actually knows

    expect(onRoleUnavailable).toHaveBeenCalledTimes(1);
    expect(onRoleUnavailable).toHaveBeenCalledWith({
      callerAgentId: "c1",
      roleId: "worker",
      requestedModel: "deadfamily/some-model",
      reason: "provider-not-registered",
    });
  });

  it("F3: never propagates a throw from the policy cache — logs and returns undefined (pass-through)", () => {
    const throwingPolicyCache = {
      get: () => {
        throw new Error("policy cache exploded");
      },
      isMalformed: () => false,
      lastError: () => undefined,
      forceRefresh: vi.fn(),
      stop: vi.fn(),
    };
    const router = createRoleRouter(baseOptions({ policyCache: throwingPolicyCache }));

    let result: ReturnType<typeof router> = undefined;
    expect(() => {
      result = router(request({ callerAgentId: "c1" }), fakeContext);
    }).not.toThrow();
    expect(result).toBeUndefined();
  });

  it("F3: throttles the unexpected-error fail-open log to once per window across a burst of identical failures", () => {
    const throwingPolicyCache = {
      get: () => {
        throw new Error("policy cache exploded");
      },
      isMalformed: () => false,
      lastError: () => undefined,
      forceRefresh: vi.fn(),
      stop: vi.fn(),
    };
    let nowMs = 0;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const router = createRoleRouter(
      baseOptions({ policyCache: throwingPolicyCache, now: () => nowMs }),
    );

    for (let i = 0; i < 5; i++) {
      router(request({ callerAgentId: "c1" }), fakeContext);
    }
    expect(errorSpy).toHaveBeenCalledTimes(1);

    nowMs += 60_000;
    router(request({ callerAgentId: "c1" }), fakeContext);
    expect(errorSpy).toHaveBeenCalledTimes(2);

    errorSpy.mockRestore();
  });

  it("F3: never propagates a throw from deep in role resolution (missing standard role) — logs and returns undefined", () => {
    // A policy missing every standard role forces requireStandardRole (via
    // resolveRole's classify()) to throw when there's no title/prompt text
    // to classify against.
    const corruptPolicy = { ...DEFAULT_POLICY, roles: [] };
    const router = createRoleRouter(baseOptions({ policyCache: fakePolicyCache(corruptPolicy) }));

    let result: ReturnType<typeof router> = undefined;
    expect(() => {
      result = router(request({ callerAgentId: "c1" }), fakeContext);
    }).not.toThrow();
    expect(result).toBeUndefined();
  });

  it("never skips or blocks a requested subagent create in any outcome", () => {
    // Exhaustive-ish: unconfigured, selected, and unavailable all return a
    // usable request shape from the caller's perspective (either the
    // original request, unmodified, or a rewritten one) — never null/throw.
    const outcomes = [
      baseOptions(), // unconfigured
      baseOptions({
        policyCache: fakePolicyCache(policyWithWorkerModels(["codex/gpt-5.1"])),
        catalogCache: fakeCatalogCache(catalog({ codex: ["gpt-5.1"] })),
      }), // selected
      baseOptions({ policyCache: fakePolicyCache(policyWithWorkerModels(["codex/gpt-ghost"])) }), // unavailable
    ];
    for (const options of outcomes) {
      const router = createRoleRouter(options);
      expect(() => router(request({ callerAgentId: "c1" }), fakeContext)).not.toThrow();
    }
  });

  describe("explicit model request precedence", () => {
    // worker's pool: "claude-sonnet-5" is the top (only) pick.
    const pool: ResolvedPool = { workers: [{ providerId: "claude-backup", priority: 1 }], leader: { providerId: "leader" } };

    it("honors an explicit request that IS a member of the role's pool, leaving it untouched", () => {
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(policyWithWorkerModels(["claude-sonnet-5", "claude-opus-5"])),
          catalogCache: fakeCatalogCache(catalog({ claude: ["claude-sonnet-5", "claude-opus-5"] })),
          poolCache: fakePoolCache(pool),
        }),
      );

      // The caller asked for a specific pool account AND a specific model
      // that isn't the role's top pick — but it's still one of the role's
      // approved entries, so the request must survive untouched.
      const result = router(
        request({ callerAgentId: "c1", config: { provider: "claude-backup", model: "claude-opus-5", cwd: "/tmp" } }),
        fakeContext,
      );

      expect(result).toBeUndefined(); // byte-identical pass-through: nothing needed rewriting
    });

    it("overrides an explicit request that is NOT a member of the role's pool at all (reason: not-approved)", () => {
      const onExplicitModelOverridden = vi.fn();
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(policyWithWorkerModels(["claude-sonnet-5"])),
          catalogCache: fakeCatalogCache(catalog({ claude: ["claude-sonnet-5"] })),
          poolCache: fakePoolCache(pool),
          onExplicitModelOverridden,
        }),
      );

      // Mirrors the observed bug: caller asks for claude-backup/claude-opus-5,
      // but the worker role's pool only approves claude-sonnet-5.
      const result = router(
        request({ callerAgentId: "c1", config: { provider: "claude-backup", model: "claude-opus-5", cwd: "/tmp" } }),
        fakeContext,
      );

      expect(result?.config.model).toBe("claude-sonnet-5");
      expect(result?.labels).toMatchObject({ [MODEL_OVERRIDDEN_LABEL]: "claude-backup/claude-opus-5" });
      expect(onExplicitModelOverridden).toHaveBeenCalledWith({
        callerAgentId: "c1",
        roleId: "worker",
        requestedRef: "claude-backup/claude-opus-5",
        effectiveRef: "claude-sonnet-5",
        reason: "not-approved",
      });
    });

    it("overrides an explicit request whose model is approved but catalog-missing (reason: not-currently-selectable)", () => {
      const onExplicitModelOverridden = vi.fn();
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(policyWithWorkerModels(["claude-opus-5", "claude-sonnet-5"])),
          // "claude-opus-5" is approved for the role but absent from the live catalog.
          catalogCache: fakeCatalogCache(catalog({ claude: ["claude-sonnet-5"] })),
          poolCache: fakePoolCache(pool),
          onExplicitModelOverridden,
        }),
      );

      const result = router(
        request({ callerAgentId: "c1", config: { provider: "claude-backup", model: "claude-opus-5", cwd: "/tmp" } }),
        fakeContext,
      );

      expect(result?.config.model).toBe("claude-sonnet-5");
      expect(onExplicitModelOverridden).toHaveBeenCalledWith({
        callerAgentId: "c1",
        roleId: "worker",
        requestedRef: "claude-backup/claude-opus-5",
        effectiveRef: "claude-sonnet-5",
        reason: "not-currently-selectable",
      });
    });

    it("overrides an explicit request whose model is approved but capped everywhere in the pool (reason: not-currently-selectable)", () => {
      const onExplicitModelOverridden = vi.fn();
      const health = createHealthTracker();
      health.reportTurnFailure("claude-backup", "hit your limit"); // caps the only worker
      health.reportTurnFailure("leader", "hit your limit"); // and the leader
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(policyWithWorkerModels(["claude-opus-5", "claude-sonnet-5"])),
          catalogCache: fakeCatalogCache(catalog({ claude: ["claude-opus-5", "claude-sonnet-5"] })),
          poolCache: fakePoolCache(pool),
          health,
          onExplicitModelOverridden,
        }),
      );

      const result = router(
        request({ callerAgentId: "c1", config: { provider: "claude-backup", model: "claude-opus-5", cwd: "/tmp" } }),
        fakeContext,
      );

      // No pool member is viable for EITHER entry, so ordered selection also
      // falls back to models[0] (UNAVAILABLE) — the override still fires and
      // is still correctly attributed to "approved but not selectable".
      expect(result?.config.model).toBe("claude-opus-5");
      expect(onExplicitModelOverridden).toHaveBeenCalledWith(
        expect.objectContaining({ requestedRef: "claude-backup/claude-opus-5", reason: "not-currently-selectable" }),
      );
    });

    it("real shape from today: overrides an explicit Fable request once the pool is over the weekly Fable budget threshold (reason: not-currently-selectable)", () => {
      const FABLE = "claude-fable-5-1";
      const onExplicitModelOverridden = vi.fn();
      const health = createHealthTracker();
      // The account the request would land on ("claude-backup") is pinned at
      // 100% of its weekly Fable window; the role's own selection already
      // steps off Fable for the same reason (the Fable budget gate).
      health.reportUsage("claude-backup", [{ window: "weekly_model_fable", usedPct: 100 }]);
      health.reportUsage("leader", [{ window: "weekly_model_fable", usedPct: 100 }]);
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(policyWithWorkerModels([FABLE, "claude-sonnet-5"])),
          catalogCache: fakeCatalogCache(catalog({ claude: [FABLE, "claude-sonnet-5"] })),
          poolCache: fakePoolCache(pool),
          health,
          onExplicitModelOverridden,
        }),
      );

      const result = router(
        request({ callerAgentId: "c1", config: { provider: "claude-backup", model: FABLE, cwd: "/tmp" } }),
        fakeContext,
      );

      expect(result?.config.model).toBe("claude-sonnet-5"); // stepped off Fable, same as ordered selection
      expect(onExplicitModelOverridden).toHaveBeenCalledWith({
        callerAgentId: "c1",
        roleId: "worker",
        requestedRef: `claude-backup/${FABLE}`,
        effectiveRef: "claude-sonnet-5",
        reason: "not-currently-selectable",
      });
    });

    it("dedupes the override notification per (caller, role, requested ref)", () => {
      const onExplicitModelOverridden = vi.fn();
      const router = createRoleRouter(
        baseOptions({
          policyCache: fakePolicyCache(policyWithWorkerModels(["claude-sonnet-5"])),
          catalogCache: fakeCatalogCache(catalog({ claude: ["claude-sonnet-5"] })),
          poolCache: fakePoolCache(pool),
          onExplicitModelOverridden,
        }),
      );
      const req = () =>
        request({ callerAgentId: "c1", config: { provider: "claude-backup", model: "claude-opus-5", cwd: "/tmp" } });

      router(req(), fakeContext);
      router(req(), fakeContext);

      expect(onExplicitModelOverridden).toHaveBeenCalledTimes(1);
    });

    it("does not treat an unconfigured role's pass-through as an override", () => {
      const onExplicitModelOverridden = vi.fn();
      const router = createRoleRouter(baseOptions({ onExplicitModelOverridden })); // worker has no configured models

      const result = router(
        request({ callerAgentId: "c1", config: { provider: "claude-backup", model: "claude-opus-5", cwd: "/tmp" } }),
        fakeContext,
      );

      expect(result).toBeUndefined();
      expect(onExplicitModelOverridden).not.toHaveBeenCalled();
    });
  });
});

describe("createRoleRouter — task class", () => {
  function policyWithWorkerClassPools(overrides: {
    models?: string[];
    mechanicalModels?: string[];
    hardModels?: string[];
  }): RoleModelPolicy {
    return {
      ...DEFAULT_POLICY,
      roles: DEFAULT_POLICY.roles.map((role) =>
        role.id === "worker"
          ? {
              ...role,
              models: overrides.models ?? [],
              mechanicalModels: overrides.mechanicalModels ?? [],
              hardModels: overrides.hardModels ?? [],
            }
          : role,
      ),
    };
  }

  it("a declared task class routes to that class's pool over the standard pool", () => {
    const router = createRoleRouter(
      baseOptions({
        policyCache: fakePolicyCache(
          policyWithWorkerClassPools({ models: ["claude-sonnet-5"], hardModels: ["claude-opus-5"] }),
        ),
        catalogCache: fakeCatalogCache(catalog({ claude: ["claude-sonnet-5", "claude-opus-5"] })),
      }),
    );

    const result = router(
      request({ callerAgentId: "c1", labels: { [TASK_CLASS_LABEL]: "hard" } } as unknown as Record<string, unknown>),
      fakeContext,
    );

    expect(result?.config.model).toBe("claude-opus-5");
  });

  it("falls back to the standard pool when the resolved class has no override pool configured", () => {
    const router = createRoleRouter(
      baseOptions({
        policyCache: fakePolicyCache(policyWithWorkerClassPools({ models: ["claude-sonnet-5"] })),
        catalogCache: fakeCatalogCache(catalog({ claude: ["claude-sonnet-5"] })),
      }),
    );

    const result = router(
      request({
        callerAgentId: "c1",
        labels: { [TASK_CLASS_LABEL]: "mechanical" },
      } as unknown as Record<string, unknown>),
      fakeContext,
    );

    expect(result?.config.model).toBe("claude-sonnet-5");
  });

  it("an unclassified spawn (no label, no seed match) gets the standard pool, unaffected by mechanical/hard pools", () => {
    const router = createRoleRouter(
      baseOptions({
        policyCache: fakePolicyCache(
          policyWithWorkerClassPools({
            models: ["claude-sonnet-5"],
            mechanicalModels: ["claude-haiku-5"],
            hardModels: ["claude-opus-5"],
          }),
        ),
        catalogCache: fakeCatalogCache(catalog({ claude: ["claude-sonnet-5", "claude-haiku-5", "claude-opus-5"] })),
      }),
    );

    const result = router(
      request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp", title: "do the thing" } }),
      fakeContext,
    );

    expect(result?.config.model).toBe("claude-sonnet-5");
  });

  it("text classification picks the mechanical/hard pool when no label is declared", () => {
    const router = createRoleRouter(
      baseOptions({
        policyCache: fakePolicyCache(
          policyWithWorkerClassPools({
            models: ["claude-sonnet-5"],
            mechanicalModels: ["claude-haiku-5"],
            hardModels: ["claude-opus-5"],
          }),
        ),
        catalogCache: fakeCatalogCache(catalog({ claude: ["claude-sonnet-5", "claude-haiku-5", "claude-opus-5"] })),
      }),
    );

    expect(
      router(
        request({
          callerAgentId: "c1",
          config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp", title: "fix a typo in the readme" },
        }),
        fakeContext,
      )?.config.model,
    ).toBe("claude-haiku-5");
    expect(
      router(
        request({
          callerAgentId: "c2",
          config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp", title: "fix the race condition in the scheduler" },
        }),
        fakeContext,
      )?.config.model,
    ).toBe("claude-opus-5");
  });

  it("an unknown declared task class never blocks: falls through to classification/default and fires onDeclaredTaskClassUnknown once per (caller, value)", () => {
    const onDeclaredTaskClassUnknown = vi.fn();
    const router = createRoleRouter(
      baseOptions({
        policyCache: fakePolicyCache(policyWithWorkerClassPools({ models: ["claude-sonnet-5"] })),
        catalogCache: fakeCatalogCache(catalog({ claude: ["claude-sonnet-5"] })),
        onDeclaredTaskClassUnknown,
      }),
    );

    const req = () =>
      request({ callerAgentId: "c1", labels: { [TASK_CLASS_LABEL]: "urgent" } } as unknown as Record<string, unknown>);
    const first = router(req(), fakeContext);
    router(req(), fakeContext);

    expect(first?.config.model).toBe("claude-sonnet-5"); // fell through to default, not blocked
    expect(onDeclaredTaskClassUnknown).toHaveBeenCalledTimes(1);
    expect(onDeclaredTaskClassUnknown).toHaveBeenCalledWith({ callerAgentId: "c1", value: "urgent" });
  });

  it("an explicit request is evaluated against the RESOLVED class's pool: approved for hard, not for standard", () => {
    const onExplicitModelOverridden = vi.fn();
    const pool: ResolvedPool = { workers: [{ providerId: "claude-backup", priority: 1 }], leader: { providerId: "leader" } };
    const router = createRoleRouter(
      baseOptions({
        policyCache: fakePolicyCache(
          policyWithWorkerClassPools({ models: ["claude-sonnet-5"], hardModels: ["claude-opus-5"] }),
        ),
        catalogCache: fakeCatalogCache(catalog({ claude: ["claude-sonnet-5", "claude-opus-5"] })),
        poolCache: fakePoolCache(pool),
        onExplicitModelOverridden,
      }),
    );

    // Same explicit request, declared hard: honored untouched.
    const honored = router(
      request({
        callerAgentId: "c1",
        labels: { [TASK_CLASS_LABEL]: "hard" },
        config: { provider: "claude-backup", model: "claude-opus-5", cwd: "/tmp" },
      } as unknown as Record<string, unknown>),
      fakeContext,
    );
    expect(honored).toBeUndefined(); // byte-identical pass-through
    expect(onExplicitModelOverridden).not.toHaveBeenCalled();

    // Same explicit request, no declared class (standard/default pool doesn't have opus): overridden.
    const overridden = router(
      request({
        callerAgentId: "c2",
        config: { provider: "claude-backup", model: "claude-opus-5", cwd: "/tmp" },
      }),
      fakeContext,
    );
    expect(overridden?.config.model).toBe("claude-sonnet-5");
    expect(onExplicitModelOverridden).toHaveBeenCalledWith({
      callerAgentId: "c2",
      roleId: "worker",
      requestedRef: "claude-backup/claude-opus-5",
      effectiveRef: "claude-sonnet-5",
      taskClass: undefined,
      reason: "not-approved",
    });
  });

  it("onRoleUnavailable/onExplicitModelOverridden dedupe independently per task class, not just per role", () => {
    const onRoleUnavailable = vi.fn();
    const router = createRoleRouter(
      baseOptions({
        // No catalog entries at all: every pool is catalog-miss -> UNAVAILABLE.
        policyCache: fakePolicyCache(
          policyWithWorkerClassPools({ models: ["claude-sonnet-5"], hardModels: ["claude-opus-5"] }),
        ),
        catalogCache: fakeCatalogCache(new Map()),
        onRoleUnavailable,
      }),
    );

    router(request({ callerAgentId: "c1" }), fakeContext); // standard pool unavailable
    router(request({ callerAgentId: "c2", labels: { [TASK_CLASS_LABEL]: "hard" } } as unknown as Record<string, unknown>), fakeContext); // hard pool unavailable

    expect(onRoleUnavailable).toHaveBeenCalledTimes(2);
    expect(onRoleUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({ callerAgentId: "c1", taskClass: undefined }),
    );
    expect(onRoleUnavailable).toHaveBeenCalledWith(expect.objectContaining({ callerAgentId: "c2", taskClass: "hard" }));
  });
});

describe("role-router + account router composition", () => {
  it("role hook sets the model; the unmodified account router runs second and picks the account", () => {
    const pool: ResolvedPool = {
      workers: [
        { providerId: "worker-a", priority: 1 },
        { providerId: "worker-b", priority: 2 },
      ],
      leader: { providerId: "leader" },
    };
    const health = createHealthTracker();
    // Cap worker-a specifically for the role's chosen model so the account
    // router's own ladder (not the role hook) is what advances to worker-b.
    health.reportTurnFailure("worker-a", "hit your limit — weekly opus cap reached");

    const poolCache = fakePoolCache(pool);
    const roleRouter = createRoleRouter({
      policyCache: fakePolicyCache(policyWithWorkerModels(["claude/claude-opus-4"])),
      catalogCache: fakeCatalogCache(catalog({ claude: ["claude-opus-4"] })),
      poolCache,
      health,
      recentAgentTypes: createRecentAgentTypes(),
    });
    // Provider-id cache populated (not the null cold-start state) so the
    // assertion below reflects real target selection, not a fail-open guard.
    const providerIds = { get: () => new Set(["worker-a", "worker-b", "leader"]), forceRefresh: vi.fn(), stop: vi.fn() };
    const accountRouter = createRouter({ poolCache, health, providerIds });

    const initial = request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp" } });

    // Registration-order composition, exactly as index.server.ts wires it:
    // role hook's output feeds the account router's input.
    const afterRole = roleRouter(initial, fakeContext);
    expect(afterRole?.config.model).toBe("claude-opus-4");
    expect(afterRole?.config.provider).toBe("claude"); // role hook never touches the account

    const afterAccount = accountRouter({ request: afterRole ?? initial.request }, fakeContext);
    expect(afterAccount?.config.provider).toBe("worker-b"); // worker-a is capped for opus specifically
    expect(afterAccount?.config.model).toBe("claude-opus-4"); // model choice survives untouched
  });

  it("UNCONFIGURED role composes as a true no-op: the account router still runs on the original request", () => {
    const pool: ResolvedPool = { workers: [{ providerId: "worker-a", priority: 1 }], leader: { providerId: "leader" } };
    const health = createHealthTracker();
    const poolCache = fakePoolCache(pool);
    const roleRouter = createRoleRouter({
      policyCache: fakePolicyCache(DEFAULT_POLICY), // every role unconfigured
      catalogCache: fakeCatalogCache(new Map()),
      poolCache,
      health,
      recentAgentTypes: createRecentAgentTypes(),
    });
    const providerIds = { get: () => new Set(["worker-a", "leader"]), forceRefresh: vi.fn(), stop: vi.fn() };
    const accountRouter = createRouter({ poolCache, health, providerIds });

    const initial = request({ callerAgentId: "c1", config: { provider: "claude", model: "claude-sonnet", cwd: "/tmp" } });

    const afterRole = roleRouter(initial, fakeContext);
    expect(afterRole).toBeUndefined(); // byte-identical pass-through

    const afterAccount = accountRouter({ request: initial.request }, fakeContext);
    expect(afterAccount?.config.provider).toBe("worker-a");
    expect(afterAccount?.config.model).toBe("claude-sonnet"); // the caller's original model choice, untouched by the role hook
  });
});
