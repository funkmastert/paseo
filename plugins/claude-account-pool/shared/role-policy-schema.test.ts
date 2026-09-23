import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_PROFILE } from "./tool-profiles";
import {
  DEFAULT_POLICY,
  MAX_ALIASES_PER_ROLE,
  MAX_MAPPINGS,
  MAX_MODELS_PER_ROLE,
  MAX_ROLES,
  DEFAULT_MODEL_BUDGET_THRESHOLD_PCT,
  RoleModelPolicySchema,
  classModels,
  migrateRoleModelPolicy,
  rolePolicyFamilies,
  splitModelRef,
  type RoleModelPolicy,
  type RoleRecord,
} from "./role-policy-schema";

function role(overrides: Partial<RoleRecord>): RoleRecord {
  return {
    id: "worker",
    name: "worker",
    standard: true,
    aliases: [],
    models: [],
    mechanicalModels: [],
    hardModels: [],
    toolProfile: DEFAULT_TOOL_PROFILE,
    ...overrides,
  };
}

function policy(overrides: Partial<RoleModelPolicy>): RoleModelPolicy {
  return {
    schemaVersion: 4,
    roles: [
      role({ id: "worker", name: "worker" }),
      role({ id: "reviewer", name: "reviewer" }),
      role({ id: "advisor", name: "advisor" }),
      role({ id: "leader", name: "leader" }),
    ],
    agentTypeMappings: {},
    modelBudgetThresholdPct: DEFAULT_MODEL_BUDGET_THRESHOLD_PCT,
    enforceToolsOnClassifiedRoles: false,
    exposeClassifierTool: false,
    allowUnlistedModels: [],
    revision: "r1",
    ...overrides,
  };
}

describe("RoleModelPolicySchema", () => {
  it("round-trips the default policy", () => {
    const result = RoleModelPolicySchema.safeParse(DEFAULT_POLICY);
    expect(result.success).toBe(true);
  });

  describe("allowUnlistedModels", () => {
    it("defaults to empty for a stored v4 document that predates the field, so nothing changes until an operator opts in", () => {
      const { allowUnlistedModels: _omitted, ...stored } = policy({});
      const result = RoleModelPolicySchema.safeParse(stored);
      expect(result.success).toBe(true);
      expect(result.success && result.data.allowUnlistedModels).toEqual([]);
    });

    it("accepts bare and pinned refs and rejects a malformed one", () => {
      expect(RoleModelPolicySchema.safeParse(policy({ allowUnlistedModels: ["claude-opus-5-5", "codex/gpt-9"] })).success).toBe(true);
      expect(RoleModelPolicySchema.safeParse(policy({ allowUnlistedModels: ["claude-opus-*"] })).success).toBe(false);
      expect(RoleModelPolicySchema.safeParse(policy({ allowUnlistedModels: ["has space"] })).success).toBe(false);
    });
  });

  it("accepts a valid custom role with aliases and models", () => {
    const custom = policy({
      roles: [
        role({ id: "worker", name: "worker" }),
        role({ id: "reviewer", name: "reviewer" }),
        role({ id: "advisor", name: "advisor" }),
        role({ id: "leader", name: "leader" }),
        role({
          id: "11111111-1111-1111-1111-111111111111",
          name: "shipper",
          standard: false,
          aliases: ["ship", "release"],
          models: ["claude/claude-opus-4", "codex/gpt-5.1"],
        }),
      ],
    });
    const result = RoleModelPolicySchema.safeParse(custom);
    expect(result.success).toBe(true);
  });

  it("rejects a policy missing a standard role", () => {
    const result = RoleModelPolicySchema.safeParse(
      policy({ roles: [role({ id: "worker", name: "worker" }), role({ id: "reviewer", name: "reviewer" })] }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a policy where a role wrongly claims standard:true", () => {
    const result = RoleModelPolicySchema.safeParse(
      policy({
        roles: [
          role({ id: "worker", name: "worker" }),
          role({ id: "reviewer", name: "reviewer" }),
          role({ id: "advisor", name: "advisor" }),
          role({ id: "extra", name: "extra", standard: true }),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects duplicate role ids", () => {
    const result = RoleModelPolicySchema.safeParse(
      policy({
        roles: [
          role({ id: "worker", name: "worker" }),
          role({ id: "worker", name: "worker2", standard: false }),
          role({ id: "reviewer", name: "reviewer" }),
          role({ id: "advisor", name: "advisor" }),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects names/aliases that collide case-insensitively across roles (one namespace)", () => {
    const result = RoleModelPolicySchema.safeParse(
      policy({
        roles: [
          role({ id: "worker", name: "worker", aliases: ["Scout"] }),
          role({ id: "reviewer", name: "reviewer" }),
          role({
            id: "11111111-1111-1111-1111-111111111111",
            name: "SCOUT",
            standard: false,
          }),
          role({ id: "advisor", name: "advisor" }),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a role with a duplicate name/alias word within itself", () => {
    const result = RoleModelPolicySchema.safeParse(
      policy({ roles: [role({ id: "worker", name: "worker", aliases: ["Worker"] }), role({ id: "reviewer", name: "reviewer" }), role({ id: "advisor", name: "advisor" })] }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects per-role model dupes case-insensitively", () => {
    const result = RoleModelPolicySchema.safeParse(
      policy({
        roles: [
          role({ id: "worker", name: "worker", models: ["claude/Opus", "claude/opus"] }),
          role({ id: "reviewer", name: "reviewer" }),
          role({ id: "advisor", name: "advisor" }),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects malformed model ids (whitespace, wildcard, comma, extra separator)", () => {
    for (const bad of ["claude/ opus", "claude/op*s", "claude/op,us", "claude /opus", "a/b/c", "opu s"]) {
      const result = RoleModelPolicySchema.safeParse(
        policy({
          roles: [
            role({ id: "worker", name: "worker", models: [bad] }),
            role({ id: "reviewer", name: "reviewer" }),
            role({ id: "advisor", name: "advisor" }),
          ],
        }),
      );
      expect(result.success, `expected "${bad}" to be rejected`).toBe(false);
    }
  });

  it("rejects mapping values that reference an unknown role", () => {
    const result = RoleModelPolicySchema.safeParse(
      policy({ agentTypeMappings: { scout: "not-a-role" } }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects mapping keys that fail the exact-agent-name format", () => {
    const result = RoleModelPolicySchema.safeParse(policy({ agentTypeMappings: { "bad key!": "worker" } }));
    expect(result.success).toBe(false);
  });

  it(`enforces the ${MAX_ROLES}-role limit`, () => {
    const extraRoles: RoleRecord[] = Array.from({ length: MAX_ROLES - 4 }, (_, index) =>
      role({ id: `custom-${index}`, name: `custom${index}`, standard: false }),
    );
    const result = RoleModelPolicySchema.safeParse(
      policy({
        roles: [
          role({ id: "worker", name: "worker" }),
          role({ id: "reviewer", name: "reviewer" }),
          role({ id: "advisor", name: "advisor" }),
          role({ id: "leader", name: "leader" }),
          ...extraRoles,
        ],
      }),
    );
    expect(result.success).toBe(true); // exactly at the limit (4 standard + 60 custom = 64)

    const overLimit = RoleModelPolicySchema.safeParse(
      policy({
        roles: [
          role({ id: "worker", name: "worker" }),
          role({ id: "reviewer", name: "reviewer" }),
          role({ id: "advisor", name: "advisor" }),
          role({ id: "leader", name: "leader" }),
          ...extraRoles,
          role({ id: "one-too-many", name: "onetoomany", standard: false }),
        ],
      }),
    );
    expect(overLimit.success).toBe(false);
  });

  it(`enforces the ${MAX_ALIASES_PER_ROLE}-alias-per-role limit`, () => {
    const aliases = Array.from({ length: MAX_ALIASES_PER_ROLE + 1 }, (_, index) => `alias${index}`);
    const result = RoleModelPolicySchema.safeParse(policy({ roles: [role({ id: "worker", name: "worker", aliases }), role({ id: "reviewer", name: "reviewer" }), role({ id: "advisor", name: "advisor" })] }));
    expect(result.success).toBe(false);
  });

  it(`enforces the ${MAX_MODELS_PER_ROLE}-model-per-role limit`, () => {
    const models = Array.from({ length: MAX_MODELS_PER_ROLE + 1 }, (_, index) => `claude/model-${index}`);
    const result = RoleModelPolicySchema.safeParse(policy({ roles: [role({ id: "worker", name: "worker", models }), role({ id: "reviewer", name: "reviewer" }), role({ id: "advisor", name: "advisor" })] }));
    expect(result.success).toBe(false);
  });

  it(`enforces the ${MAX_MAPPINGS}-mapping limit`, () => {
    const agentTypeMappings: Record<string, string> = {};
    for (let index = 0; index < MAX_MAPPINGS + 1; index += 1) {
      agentTypeMappings[`type${index}`] = "worker";
    }
    const result = RoleModelPolicySchema.safeParse(policy({ agentTypeMappings }));
    expect(result.success).toBe(false);
  });
});

describe("splitModelRef", () => {
  it("splits a pinned ref into provider and model", () => {
    expect(splitModelRef("codex/gpt-5.1")).toEqual({ provider: "codex", model: "gpt-5.1" });
  });

  it("reads a bare ref as account-agnostic", () => {
    expect(splitModelRef("claude-opus-4")).toEqual({ provider: null, model: "claude-opus-4" });
  });

  it("returns null for a ref with an empty provider or model segment", () => {
    expect(splitModelRef("/model")).toBeNull();
    expect(splitModelRef("provider/")).toBeNull();
  });

  it("returns null for a ref with more than one separator", () => {
    expect(splitModelRef("a/b/c")).toBeNull();
  });
});

describe("model ref schema", () => {
  it("accepts a bare model id as a role model", () => {
    const result = RoleModelPolicySchema.safeParse(
      policy({
        roles: [
          role({ id: "worker", name: "worker", models: ["claude-sonnet-5"] }),
          role({ id: "reviewer", name: "reviewer" }),
          role({ id: "advisor", name: "advisor" }),
          role({ id: "leader", name: "leader" }),
        ],
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe("migrateRoleModelPolicy", () => {
  const v1 = {
    schemaVersion: 1,
    roles: [
      { id: "worker", name: "worker", standard: true, aliases: [], models: ["claude/claude-sonnet-5", "codex/gpt-5.1"] },
      { id: "reviewer", name: "reviewer", standard: true, aliases: [], models: ["claude/claude-opus-5"] },
      { id: "advisor", name: "advisor", standard: true, aliases: [], models: [] },
    ],
    agentTypeMappings: { worker: "worker" },
    revision: "fcc9e0ec627c",
  };

  it("unpins leader-account refs and leaves cross-family pins intact", () => {
    const migrated = migrateRoleModelPolicy(v1, { poolLeaderProviderId: "claude" }) as typeof v1;
    expect(migrated.schemaVersion).toBe(4);
    expect(migrated.roles[0].models).toEqual(["claude-sonnet-5", "codex/gpt-5.1"]);
    expect(migrated.roles[1].models).toEqual(["claude-opus-5"]);
  });

  it("unpins pool-family refs even when the pool config can't be read", () => {
    const migrated = migrateRoleModelPolicy(v1, {}) as typeof v1;
    expect(migrated.roles[0].models).toEqual(["claude-sonnet-5", "codex/gpt-5.1"]);
  });

  it("unpins refs naming a non-default leader entry id", () => {
    const custom = { ...v1, roles: [{ ...v1.roles[0], models: ["claude-leader/claude-sonnet-5"] }, v1.roles[1], v1.roles[2]] };
    const migrated = migrateRoleModelPolicy(custom, { poolLeaderProviderId: "claude-leader" }) as typeof v1;
    expect(migrated.roles[0].models).toEqual(["claude-sonnet-5"]);
  });

  it("preserves the CAS revision so an open settings screen can still save", () => {
    const migrated = migrateRoleModelPolicy(v1, { poolLeaderProviderId: "claude" }) as typeof v1;
    expect(migrated.revision).toBe("fcc9e0ec627c");
  });

  it("produces a document the current schema accepts", () => {
    expect(RoleModelPolicySchema.safeParse(migrateRoleModelPolicy(v1, { poolLeaderProviderId: "claude" })).success).toBe(true);
  });

  it("passes a current-version document through untouched", () => {
    const current = { ...v1, schemaVersion: 4 };
    expect(migrateRoleModelPolicy(current, { poolLeaderProviderId: "claude" })).toBe(current);
  });

  it("seeds the leader role, unconfigured and unrestricted, when migrating from v2", () => {
    const v2 = { ...v1, schemaVersion: 2 };
    const migrated = migrateRoleModelPolicy(v2) as { schemaVersion: number; roles: { id: string; name: string; models: string[]; toolProfile: unknown }[] };

    expect(migrated.schemaVersion).toBe(4);
    const leader = migrated.roles.find((role) => role.id === "leader");
    expect(leader).toMatchObject({ name: "leader", models: [], toolProfile: { kind: "unrestricted" } });
  });

  it("migrates v3 to v4 with a version bump only — every role's model pool is untouched, and the schema fills mechanicalModels/hardModels as empty", () => {
    // Mirrors Tyler's live v3 config: leader [opus, sonnet], worker
    // [sonnet, haiku, opus], reviewer [sonnet], advisor [opus, sonnet].
    const v3 = {
      schemaVersion: 3,
      roles: [
        { id: "leader", name: "leader", standard: true, aliases: [], models: ["claude-opus-5", "claude-sonnet-5"], toolProfile: { kind: "unrestricted" } },
        { id: "worker", name: "worker", standard: true, aliases: [], models: ["claude-sonnet-5", "claude-haiku-5", "claude-opus-5"], toolProfile: { kind: "unrestricted" } },
        { id: "reviewer", name: "reviewer", standard: true, aliases: [], models: ["claude-sonnet-5"], toolProfile: { kind: "unrestricted" } },
        { id: "advisor", name: "advisor", standard: true, aliases: [], models: ["claude-opus-5", "claude-sonnet-5"], toolProfile: { kind: "unrestricted" } },
      ],
      agentTypeMappings: {},
      modelBudgetThresholdPct: 80,
      revision: "live-rev",
    };
    const migrated = migrateRoleModelPolicy(v3) as { schemaVersion: number; roles: unknown[]; revision: string };
    expect(migrated.schemaVersion).toBe(4);
    expect(migrated.revision).toBe("live-rev");
    // Roles are untouched by the migration step itself — no mechanicalModels/
    // hardModels key is injected; the schema parse below is what fills them.
    expect((migrated.roles as { models: string[] }[]).map((r) => r.models)).toEqual([
      ["claude-opus-5", "claude-sonnet-5"],
      ["claude-sonnet-5", "claude-haiku-5", "claude-opus-5"],
      ["claude-sonnet-5"],
      ["claude-opus-5", "claude-sonnet-5"],
    ]);

    const parsed = RoleModelPolicySchema.safeParse(migrated);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      for (const role of parsed.data.roles) {
        expect(role.mechanicalModels).toEqual([]);
        expect(role.hardModels).toEqual([]);
      }
      expect(parsed.data.roles.find((r) => r.id === "leader")?.models).toEqual(["claude-opus-5", "claude-sonnet-5"]);
      expect(parsed.data.roles.find((r) => r.id === "worker")?.models).toEqual(["claude-sonnet-5", "claude-haiku-5", "claude-opus-5"]);
      expect(parsed.data.roles.find((r) => r.id === "reviewer")?.models).toEqual(["claude-sonnet-5"]);
      expect(parsed.data.modelBudgetThresholdPct).toBe(80);
    }
  });

  it("keeps a v2 document's model refs untouched (the unpin is a v1-only step)", () => {
    const v2 = { ...v1, schemaVersion: 2 };
    const migrated = migrateRoleModelPolicy(v2, { poolLeaderProviderId: "claude" }) as typeof v1;

    expect(migrated.roles[0].models).toEqual(["claude/claude-sonnet-5", "codex/gpt-5.1"]);
  });

  it("picks a free name when a custom role already owns the word 'leader'", () => {
    const conflicting = {
      ...v1,
      schemaVersion: 2,
      roles: [...v1.roles, { id: "custom-1", name: "Leader", standard: false, aliases: [], models: [] }],
    };
    const migrated = migrateRoleModelPolicy(conflicting) as { roles: { id: string; name: string }[] };

    expect(migrated.roles.find((role) => role.id === "leader")?.name).toBe("leader1");
    expect(RoleModelPolicySchema.safeParse(migrated).success).toBe(true);
  });

  it("does not add a second leader role to a document that already has one", () => {
    const v2 = {
      ...v1,
      schemaVersion: 2,
      roles: [...v1.roles, { id: "leader", name: "leader", standard: true, aliases: [], models: ["claude-opus-5"] }],
    };
    const migrated = migrateRoleModelPolicy(v2) as { roles: { id: string; models: string[] }[] };

    expect(migrated.roles.filter((role) => role.id === "leader")).toHaveLength(1);
    expect(migrated.roles.find((role) => role.id === "leader")?.models).toEqual(["claude-opus-5"]);
  });
});

describe("rolePolicyFamilies", () => {
  it("returns the distinct families referenced across all roles", () => {
    const withModels = policy({
      roles: [
        role({ id: "worker", name: "worker", models: ["claude/opus", "claude/sonnet"] }),
        role({ id: "reviewer", name: "reviewer", models: ["codex/gpt-5.1"] }),
        role({ id: "advisor", name: "advisor" }),
      ],
    });
    expect(rolePolicyFamilies(withModels).sort()).toEqual(["claude", "codex"]);
  });

  it("returns an empty array when no role has configured models", () => {
    expect(rolePolicyFamilies(DEFAULT_POLICY)).toEqual([]);
  });

  it("includes families referenced only from mechanicalModels/hardModels", () => {
    const withClassPools = policy({
      roles: [
        role({ id: "worker", name: "worker", models: [], mechanicalModels: ["claude/haiku"], hardModels: ["gemini/gemini-3-pro"] }),
        role({ id: "reviewer", name: "reviewer" }),
        role({ id: "advisor", name: "advisor" }),
      ],
    });
    expect(rolePolicyFamilies(withClassPools).sort()).toEqual(["claude", "gemini"]);
  });
});

describe("classModels", () => {
  it("uses the standard pool for an undefined (unclassified) task class", () => {
    const r = role({ models: ["claude-sonnet-5"], mechanicalModels: ["claude-haiku-5"], hardModels: ["claude-opus-5"] });
    expect(classModels(r, undefined)).toEqual(["claude-sonnet-5"]);
  });

  it("uses the standard pool for an explicit 'standard' task class", () => {
    const r = role({ models: ["claude-sonnet-5"], mechanicalModels: ["claude-haiku-5"], hardModels: ["claude-opus-5"] });
    expect(classModels(r, "standard")).toEqual(["claude-sonnet-5"]);
  });

  it("uses the class-specific pool when configured", () => {
    const r = role({ models: ["claude-sonnet-5"], mechanicalModels: ["claude-haiku-5"], hardModels: ["claude-opus-5"] });
    expect(classModels(r, "mechanical")).toEqual(["claude-haiku-5"]);
    expect(classModels(r, "hard")).toEqual(["claude-opus-5"]);
  });

  it("falls back to the standard pool when the class-specific pool is empty", () => {
    const r = role({ models: ["claude-sonnet-5"], mechanicalModels: [], hardModels: [] });
    expect(classModels(r, "mechanical")).toEqual(["claude-sonnet-5"]);
    expect(classModels(r, "hard")).toEqual(["claude-sonnet-5"]);
  });

  it("stays unconfigured for every class when the whole role is unconfigured", () => {
    const r = role({ models: [], mechanicalModels: [], hardModels: [] });
    expect(classModels(r, undefined)).toEqual([]);
    expect(classModels(r, "mechanical")).toEqual([]);
    expect(classModels(r, "hard")).toEqual([]);
  });
});
