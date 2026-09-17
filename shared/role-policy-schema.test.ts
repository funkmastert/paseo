import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  MAX_ALIASES_PER_ROLE,
  MAX_MAPPINGS,
  MAX_MODELS_PER_ROLE,
  MAX_ROLES,
  RoleModelPolicySchema,
  migrateRoleModelPolicy,
  rolePolicyFamilies,
  splitModelRef,
  type RoleModelPolicy,
  type RoleRecord,
} from "./role-policy-schema";

function role(overrides: Partial<RoleRecord>): RoleRecord {
  return { id: "worker", name: "worker", standard: true, aliases: [], models: [], ...overrides };
}

function policy(overrides: Partial<RoleModelPolicy>): RoleModelPolicy {
  return {
    schemaVersion: 2,
    roles: [
      role({ id: "worker", name: "worker" }),
      role({ id: "reviewer", name: "reviewer" }),
      role({ id: "advisor", name: "advisor" }),
    ],
    agentTypeMappings: {},
    revision: "r1",
    ...overrides,
  };
}

describe("RoleModelPolicySchema", () => {
  it("round-trips the default policy", () => {
    const result = RoleModelPolicySchema.safeParse(DEFAULT_POLICY);
    expect(result.success).toBe(true);
  });

  it("accepts a valid custom role with aliases and models", () => {
    const custom = policy({
      roles: [
        role({ id: "worker", name: "worker" }),
        role({ id: "reviewer", name: "reviewer" }),
        role({ id: "advisor", name: "advisor" }),
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
    const extraRoles: RoleRecord[] = Array.from({ length: MAX_ROLES - 3 }, (_, index) =>
      role({ id: `custom-${index}`, name: `custom${index}`, standard: false }),
    );
    const result = RoleModelPolicySchema.safeParse(
      policy({
        roles: [
          role({ id: "worker", name: "worker" }),
          role({ id: "reviewer", name: "reviewer" }),
          role({ id: "advisor", name: "advisor" }),
          ...extraRoles,
        ],
      }),
    );
    expect(result.success).toBe(true); // exactly at the limit (3 standard + 61 custom = 64)

    const overLimit = RoleModelPolicySchema.safeParse(
      policy({
        roles: [
          role({ id: "worker", name: "worker" }),
          role({ id: "reviewer", name: "reviewer" }),
          role({ id: "advisor", name: "advisor" }),
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
    expect(migrated.schemaVersion).toBe(2);
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
    const current = { ...v1, schemaVersion: 2 };
    expect(migrateRoleModelPolicy(current, { poolLeaderProviderId: "claude" })).toBe(current);
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
});
