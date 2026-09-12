import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  MAX_ALIASES_PER_ROLE,
  MAX_MAPPINGS,
  MAX_MODELS_PER_ROLE,
  MAX_ROLES,
  RoleModelPolicySchema,
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
    schemaVersion: 1,
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

  it("rejects malformed model ids (missing slash, whitespace, wildcard, comma)", () => {
    for (const bad of ["claude-opus", "claude/ opus", "claude/op*s", "claude/op,us", "claude /opus"]) {
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
  it("splits a valid ref into family and model", () => {
    expect(splitModelRef("claude/claude-opus-4")).toEqual({ family: "claude", model: "claude-opus-4" });
  });

  it("returns null for a ref with no slash", () => {
    expect(splitModelRef("claude-opus-4")).toBeNull();
  });

  it("returns null for a ref with an empty family or model segment", () => {
    expect(splitModelRef("/model")).toBeNull();
    expect(splitModelRef("family/")).toBeNull();
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
