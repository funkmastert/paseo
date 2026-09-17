import { describe, expect, it } from "vitest";
import { AGENT_ROLE_LABEL, AGENT_TYPE_LABEL, DEFAULT_POLICY, type RoleModelPolicy } from "../shared/role-policy-schema";
import { resolveRole } from "./role-resolve";

function withRoles(overrides: Partial<RoleModelPolicy>): RoleModelPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}

describe("resolveRole — the leader role", () => {
  it("is not reachable by tier-3 text classification", () => {
    const result = resolveRole(DEFAULT_POLICY, { initialPrompt: "act as the leader for this workstream" });
    expect(result.role.id).toBe("worker");
  });

  it("is still selectable explicitly by the tier-2 role label", () => {
    const result = resolveRole(DEFAULT_POLICY, { labels: { [AGENT_ROLE_LABEL]: "leader" } });
    expect(result).toMatchObject({ tier: 2, role: { id: "leader" } });
  });

  it("is still selectable explicitly by a tier-1 agent-type mapping", () => {
    const policy = withRoles({ agentTypeMappings: { ...DEFAULT_POLICY.agentTypeMappings, "sub-leader": "leader" } });
    const result = resolveRole(policy, { labels: { [AGENT_TYPE_LABEL]: "sub-leader" } });
    expect(result).toMatchObject({ tier: 1, role: { id: "leader" } });
  });
});

describe("resolveRole", () => {
  it("tier 1: resolves via labels[paseo.agent-type] exact-matching agentTypeMappings", () => {
    const result = resolveRole(DEFAULT_POLICY, { labels: { [AGENT_TYPE_LABEL]: "scout" } });
    expect(result).toMatchObject({ tier: 1, role: { id: "worker" } });
  });

  it("tier 1: falls back to title as the exact-match key when the agent-type label is absent", () => {
    const result = resolveRole(DEFAULT_POLICY, { title: "oracle" });
    expect(result).toMatchObject({ tier: 1, role: { id: "advisor" } });
  });

  it("tier 1: does not fall back to title when the agent-type label is present but unmapped", () => {
    // "not-a-known-type" isn't in agentTypeMappings; title ("reviewer", which
    // IS mapped) must not be consulted once the label was present at all.
    const result = resolveRole(DEFAULT_POLICY, {
      labels: { [AGENT_TYPE_LABEL]: "not-a-known-type" },
      title: "reviewer",
    });
    expect(result.tier).not.toBe(1);
  });

  it("tier order: tier 1 wins over a declared tier-2 role label", () => {
    const result = resolveRole(DEFAULT_POLICY, {
      labels: { [AGENT_TYPE_LABEL]: "scout", [AGENT_ROLE_LABEL]: "reviewer" },
    });
    expect(result).toMatchObject({ tier: 1, role: { id: "worker" } });
  });

  it("tier 2: resolves via labels[paseo.agent-role] matching a role name case-insensitively", () => {
    const result = resolveRole(DEFAULT_POLICY, { labels: { [AGENT_ROLE_LABEL]: "REVIEWER" } });
    expect(result).toMatchObject({ tier: 2, role: { id: "reviewer" } });
  });

  it("tier 2: resolves via a role alias case-insensitively", () => {
    const policy = withRoles({
      roles: DEFAULT_POLICY.roles.map((role) => (role.id === "advisor" ? { ...role, aliases: ["sage"] } : role)),
    });
    const result = resolveRole(policy, { labels: { [AGENT_ROLE_LABEL]: "Sage" } });
    expect(result).toMatchObject({ tier: 2, role: { id: "advisor" } });
  });

  it("tier order: tier 2 wins over tier 3/4 classification", () => {
    const result = resolveRole(DEFAULT_POLICY, {
      labels: { [AGENT_ROLE_LABEL]: "reviewer" },
      title: "please research this deeply",
    });
    expect(result).toMatchObject({ tier: 2, role: { id: "reviewer" } });
  });

  it("unknown tier-2 value never blocks: falls through to tier 3/4 and reports unknownDeclaredValue", () => {
    const result = resolveRole(DEFAULT_POLICY, { labels: { [AGENT_ROLE_LABEL]: "not-a-role" }, title: "" });
    expect(result.tier).toBeGreaterThanOrEqual(3);
    expect(result.unknownDeclaredValue).toBe("not-a-role");
    expect(result.role.id).toBe("worker"); // empty text -> tier 4 default
  });

  it("tier 3: configured role vocabulary (name/alias in title+prompt) beats built-in seeds", () => {
    const policy = withRoles({
      roles: DEFAULT_POLICY.roles.map((role) => (role.id === "worker" ? { ...role, aliases: ["oracle"] } : role)),
    });
    // "oracle" is a built-in advisor seed word, but this policy has claimed
    // it as a worker alias — user vocabulary must win.
    const result = resolveRole(policy, { title: "spin up the oracle agent" });
    expect(result).toMatchObject({ tier: 3, role: { id: "worker" } });
  });

  it("tier 3: seed regex routes review-shaped text to reviewer", () => {
    const result = resolveRole(DEFAULT_POLICY, { title: "please review this PR" });
    expect(result).toMatchObject({ tier: 3, role: { id: "reviewer" } });
  });

  it("tier 3: seed regex routes research-shaped text to advisor", () => {
    const result = resolveRole(DEFAULT_POLICY, { initialPrompt: "explore the design space and advise" });
    expect(result).toMatchObject({ tier: 3, role: { id: "advisor" } });
  });

  it("tier 3: unmatched non-empty text classifies to worker", () => {
    const result = resolveRole(DEFAULT_POLICY, { title: "do the thing" });
    expect(result).toMatchObject({ tier: 3, role: { id: "worker" } });
  });

  it("tier 4: default worker when there is no title or prompt to classify", () => {
    const result = resolveRole(DEFAULT_POLICY, {});
    expect(result).toMatchObject({ tier: 4, role: { id: "worker" } });
  });

  it("classification considers both title and initialPrompt together", () => {
    const result = resolveRole(DEFAULT_POLICY, { title: "untitled", initialPrompt: "please audit the output" });
    expect(result).toMatchObject({ tier: 3, role: { id: "reviewer" } });
  });
});
