import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TOOL_PROFILE } from "../../shared/tool-profiles";
import { DEFAULT_POLICY, MAX_ALIASES_PER_ROLE, MAX_MAPPINGS, MAX_MODELS_PER_ROLE, MAX_ROLES, type RoleModelPolicy } from "../../shared/role-policy-schema";
import type { RoleModelPolicyWriteResult } from "../../shared/role-policy-rpc";
import {
  formatAliasesText,
  openRoleModelPolicyModel,
  parseAliasesText,
  type RoleModelPolicyModelDeps,
} from "./role-model-policy-model";

function policyWith(overrides: Partial<RoleModelPolicy> = {}): RoleModelPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}

/** A fake `write` that behaves like the real RPC: applies the patch, bumps revision, returns `saved`. */
function fakeSavingWrite(): { write: RoleModelPolicyModelDeps["write"]; calls: unknown[] } {
  const calls: unknown[] = [];
  let counter = 0;
  const write: RoleModelPolicyModelDeps["write"] = async (input) => {
    calls.push(input);
    counter += 1;
    return {
      status: "saved",
      policy: {
        schemaVersion: 4,
        roles: input.patch.roles,
        agentTypeMappings: input.patch.agentTypeMappings,
        modelBudgetThresholdPct: input.patch.modelBudgetThresholdPct,
        enforceToolsOnClassifiedRoles: false,
        revision: `rev-${counter}`,
      },
    };
  };
  return { write, calls };
}

function openModel(policy: RoleModelPolicy, deps: Partial<RoleModelPolicyModelDeps> = {}) {
  const { write } = fakeSavingWrite();
  return openRoleModelPolicyModel({ policy, malformed: false }, { write, generateRoleId: () => "role-fixed-id", ...deps });
}

describe("parseAliasesText / formatAliasesText", () => {
  it("trims, drops empties, and dedupes case-insensitively while preserving first-seen order", () => {
    expect(parseAliasesText(" Scout, scout ,  , Researcher,researcher ")).toEqual(["Scout", "Researcher"]);
  });

  it("round-trips through formatAliasesText as a comma-space join", () => {
    expect(formatAliasesText(["scout", "delegate"])).toBe("scout, delegate");
  });
});

describe("openRoleModelPolicyModel — metadata draft (rename/setAliases/save/cancelDraft)", () => {
  it("beginEditRole seeds drafts from the role, save() commits them, and clears the editor", async () => {
    const model = openModel(policyWith());

    model.beginEditRole("advisor");
    expect(model.getState().editingRoleId).toBe("advisor");
    expect(model.getState().aliasesDraft).toBe("");

    model.setAliases("oracle, sage");
    const ok = await model.save();

    expect(ok).toBe(true);
    const state = model.getState();
    expect(state.editingRoleId).toBeNull();
    expect(state.policy.roles.find((r) => r.id === "advisor")?.aliases).toEqual(["oracle", "sage"]);
  });

  it("cancelDraft discards in-progress edits without calling write", async () => {
    const { write, calls } = fakeSavingWrite();
    const model = openRoleModelPolicyModel({ policy: policyWith(), malformed: false }, { write });

    model.beginEditRole("advisor");
    model.setAliases("oracle");
    model.cancelDraft();

    expect(model.getState().editingRoleId).toBeNull();
    expect(model.getState().policy.roles.find((r) => r.id === "advisor")?.aliases).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("refuses to rename a standard role: renameRole is a no-op, nameDraft stays the seeded value", () => {
    const model = openModel(policyWith());
    model.beginEditRole("worker");
    model.renameRole("worker-renamed");
    expect(model.getState().nameDraft).toBe("worker");
  });

  it("a custom role can be renamed via the same save() path", async () => {
    const withCustom: RoleModelPolicy = {
      ...policyWith(),
      roles: [...policyWith().roles, { id: "custom-1", name: "helper", standard: false, aliases: [], models: [], mechanicalModels: [], hardModels: [], toolProfile: DEFAULT_TOOL_PROFILE }],
    };
    const model = openModel(withCustom);

    model.beginEditRole("custom-1");
    model.renameRole("assistant");
    expect(await model.save()).toBe(true);
    expect(model.getState().policy.roles.find((r) => r.id === "custom-1")?.name).toBe("assistant");
  });

  it("rejects a save whose alias collides with another role's name/alias, without calling write", async () => {
    const { write, calls } = fakeSavingWrite();
    const model = openRoleModelPolicyModel({ policy: policyWith(), malformed: false }, { write });

    model.beginEditRole("advisor");
    model.setAliases("reviewer"); // collides with the reviewer role's own name
    const ok = await model.save();

    expect(ok).toBe(false);
    expect(model.getState().saveError).toMatch(/already used/);
    expect(model.getState().editingRoleId).toBe("advisor"); // stays open so the user can fix it
    expect(calls).toHaveLength(0);
  });

  it("rejects more than the alias limit locally, without calling write", async () => {
    const { write, calls } = fakeSavingWrite();
    const model = openRoleModelPolicyModel({ policy: policyWith(), malformed: false }, { write });

    model.beginEditRole("advisor");
    model.setAliases(Array.from({ length: MAX_ALIASES_PER_ROLE + 1 }, (_, i) => `alias${i}`).join(", "));
    const ok = await model.save();

    expect(ok).toBe(false);
    expect(model.getState().saveError).toMatch(new RegExp(`${MAX_ALIASES_PER_ROLE}`));
    expect(calls).toHaveLength(0);
  });
});

describe("openRoleModelPolicyModel — immediate model mutations", () => {
  it("addModel appends to the role's model list and commits immediately", async () => {
    const model = openModel(policyWith());
    const ok = await model.addModel("worker", "claude/opus");
    expect(ok).toBe(true);
    expect(model.getState().policy.roles.find((r) => r.id === "worker")?.models).toEqual(["claude/opus"]);
  });

  it("rejects a malformed model ref locally, without calling write", async () => {
    const { write, calls } = fakeSavingWrite();
    const model = openRoleModelPolicyModel({ policy: policyWith(), malformed: false }, { write });

    const ok = await model.addModel("worker", "not a valid ref");
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("rejects a duplicate model (case-insensitive) locally", async () => {
    const withModel = { ...policyWith(), roles: policyWith().roles.map((r) => (r.id === "worker" ? { ...r, models: ["claude/Opus"] } : r)) };
    const { write, calls } = fakeSavingWrite();
    const model = openRoleModelPolicyModel({ policy: withModel, malformed: false }, { write });

    const ok = await model.addModel("worker", "claude/opus");
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("enforces the per-role model limit before calling write", async () => {
    const maxedOut = {
      ...policyWith(),
      roles: policyWith().roles.map((r) =>
        r.id === "worker" ? { ...r, models: Array.from({ length: MAX_MODELS_PER_ROLE }, (_, i) => `claude/m${i}`) } : r,
      ),
    };
    const { write, calls } = fakeSavingWrite();
    const model = openRoleModelPolicyModel({ policy: maxedOut, malformed: false }, { write });

    expect(model.getState().canAddModel("worker")).toEqual({ allowed: false, reason: expect.any(String) });
    const ok = await model.addModel("worker", "codex/gpt-5.1");
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("removeModel drops a model, leaving the role unconfigured (not deleted) when it was the last one", async () => {
    const withModel = { ...policyWith(), roles: policyWith().roles.map((r) => (r.id === "worker" ? { ...r, models: ["claude/opus"] } : r)) };
    const model = openModel(withModel);

    const ok = await model.removeModel("worker", "claude/opus");
    expect(ok).toBe(true);
    const role = model.getState().policy.roles.find((r) => r.id === "worker");
    expect(role?.models).toEqual([]);
    expect(role).toBeDefined(); // role itself still exists, just unconfigured
  });

  it("moveModel reorders adjacent entries and no-ops past either end", async () => {
    const withModels = {
      ...policyWith(),
      roles: policyWith().roles.map((r) => (r.id === "worker" ? { ...r, models: ["a/1", "b/2", "c/3"] } : r)),
    };
    const model = openModel(withModels);

    expect(await model.moveModel("worker", "b/2", "up")).toBe(true);
    expect(model.getState().policy.roles.find((r) => r.id === "worker")?.models).toEqual(["b/2", "a/1", "c/3"]);

    expect(await model.moveModel("worker", "b/2", "up")).toBe(false); // already first
    expect(await model.moveModel("worker", "c/3", "down")).toBe(false); // already last
  });

  it("addModel/removeModel/moveModel target the mechanical/hard pools independently of the standard pool via the slot argument", async () => {
    const model = openModel(policyWith());

    expect(await model.addModel("worker", "claude-haiku-5", "mechanical")).toBe(true);
    expect(await model.addModel("worker", "claude-opus-5", "hard")).toBe(true);
    let worker = model.getState().policy.roles.find((r) => r.id === "worker");
    expect(worker?.models).toEqual([]); // standard pool untouched
    expect(worker?.mechanicalModels).toEqual(["claude-haiku-5"]);
    expect(worker?.hardModels).toEqual(["claude-opus-5"]);

    expect(await model.addModel("worker", "claude-opus-5-fallback", "hard")).toBe(true);
    expect(await model.moveModel("worker", "claude-opus-5-fallback", "up", "hard")).toBe(true);
    worker = model.getState().policy.roles.find((r) => r.id === "worker");
    expect(worker?.hardModels).toEqual(["claude-opus-5-fallback", "claude-opus-5"]);

    expect(await model.removeModel("worker", "claude-haiku-5", "mechanical")).toBe(true);
    worker = model.getState().policy.roles.find((r) => r.id === "worker");
    expect(worker?.mechanicalModels).toEqual([]);
    expect(worker?.hardModels).toEqual(["claude-opus-5-fallback", "claude-opus-5"]); // untouched by the mechanical removal
  });

  it("canAddModel enforces the per-role model limit independently per pool", async () => {
    const model = openModel(policyWith());
    for (let i = 0; i < MAX_MODELS_PER_ROLE; i += 1) {
      expect(await model.addModel("worker", `claude/model-${i}`, "mechanical")).toBe(true);
    }
    expect(model.getState().canAddModel("worker", "mechanical").allowed).toBe(false);
    expect(model.getState().canAddModel("worker", "standard").allowed).toBe(true);
    expect(model.getState().canAddModel("worker", "hard").allowed).toBe(true);
  });
});

describe("openRoleModelPolicyModel — mappings", () => {
  it("addMapping sets or overwrites a mapping immediately", async () => {
    const model = openModel(policyWith());
    expect(await model.addMapping("ce-code-reviewer", "reviewer")).toBe(true);
    expect(model.getState().policy.agentTypeMappings["ce-code-reviewer"]).toBe("reviewer");
  });

  it("rejects an unknown target role locally", async () => {
    const { write, calls } = fakeSavingWrite();
    const model = openRoleModelPolicyModel({ policy: policyWith(), malformed: false }, { write });
    expect(await model.addMapping("ce-code-reviewer", "not-a-role")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("enforces the mapping limit only for brand-new keys, not overwrites of existing ones", async () => {
    const maxed = {
      ...policyWith(),
      agentTypeMappings: Object.fromEntries(Array.from({ length: MAX_MAPPINGS }, (_, i) => [`key${i}`, "worker"])),
    };
    const model = openModel(maxed);

    expect(await model.addMapping("key0", "reviewer")).toBe(true); // overwrite, doesn't grow the map
    expect(await model.addMapping("brand-new-key", "reviewer")).toBe(false); // would grow past the limit
  });

  it("removeMapping deletes the key immediately", async () => {
    const withMapping = { ...policyWith(), agentTypeMappings: { ...policyWith().agentTypeMappings, custom: "worker" } };
    const model = openModel(withMapping);
    expect(await model.removeMapping("custom")).toBe(true);
    expect(model.getState().policy.agentTypeMappings.custom).toBeUndefined();
  });
});

describe("openRoleModelPolicyModel — roles (add/delete)", () => {
  it("addRole creates a new custom role with empty models/aliases", async () => {
    const model = openModel(policyWith());
    expect(await model.addRole("helper")).toBe(true);
    const created = model.getState().policy.roles.find((r) => r.id === "role-fixed-id");
    expect(created).toEqual({
      id: "role-fixed-id",
      name: "helper",
      standard: false,
      aliases: [],
      models: [],
      mechanicalModels: [],
      hardModels: [],
      toolProfile: DEFAULT_TOOL_PROFILE,
    });
  });

  it("rejects addRole at the role limit before calling write", async () => {
    const maxed = {
      ...policyWith(),
      roles: [
        ...policyWith().roles,
        ...Array.from({ length: MAX_ROLES - policyWith().roles.length }, (_, i) => ({
          id: `extra-${i}`,
          name: `extra${i}`,
          standard: false,
          aliases: [],
          models: [],
          mechanicalModels: [],
          hardModels: [],
          toolProfile: DEFAULT_TOOL_PROFILE,
        })),
      ],
    };
    const { write, calls } = fakeSavingWrite();
    const model = openRoleModelPolicyModel({ policy: maxed, malformed: false }, { write });

    expect(model.getState().canAddRole).toEqual({ allowed: false, reason: expect.any(String) });
    expect(await model.addRole("one-too-many")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("deleteRole is blocked (locally) for standard roles and for a custom role referenced by a mapping", async () => {
    const withCustom: RoleModelPolicy = {
      ...policyWith(),
      roles: [...policyWith().roles, { id: "custom-1", name: "helper", standard: false, aliases: [], models: [], mechanicalModels: [], hardModels: [], toolProfile: DEFAULT_TOOL_PROFILE }],
      agentTypeMappings: { ...policyWith().agentTypeMappings, "ce-helper": "custom-1" },
    };
    const { write, calls } = fakeSavingWrite();
    const model = openRoleModelPolicyModel({ policy: withCustom, malformed: false }, { write });

    expect(model.getState().canDeleteRole("worker")).toEqual({ allowed: false, reason: expect.any(String) });
    expect(model.getState().canDeleteRole("custom-1")).toEqual({ allowed: false, reason: expect.any(String) });
    expect(await model.deleteRole("worker")).toBe(false);
    expect(await model.deleteRole("custom-1")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("deleteRole succeeds for an unreferenced custom role", async () => {
    const withCustom: RoleModelPolicy = {
      ...policyWith(),
      roles: [...policyWith().roles, { id: "custom-1", name: "helper", standard: false, aliases: [], models: [], mechanicalModels: [], hardModels: [], toolProfile: DEFAULT_TOOL_PROFILE }],
    };
    const model = openModel(withCustom);
    expect(await model.deleteRole("custom-1")).toBe(true);
    expect(model.getState().policy.roles.find((r) => r.id === "custom-1")).toBeUndefined();
  });
});

describe("openRoleModelPolicyModel — conflict, malformed lock, and applyPolicySnapshot", () => {
  it("a write conflict re-seeds the authoritative policy and reports the error, without clearing the open draft", async () => {
    const conflictPolicy = policyWith({ revision: "server-rev-2" });
    const write: RoleModelPolicyModelDeps["write"] = vi.fn().mockResolvedValue({
      status: "conflict",
      error: "the policy changed since you loaded it",
      policy: conflictPolicy,
    } satisfies RoleModelPolicyWriteResult);
    const model = openRoleModelPolicyModel({ policy: policyWith({ revision: "stale-rev" }), malformed: false }, { write });

    model.beginEditRole("advisor");
    model.setAliases("oracle");
    const ok = await model.save();

    expect(ok).toBe(false);
    const state = model.getState();
    expect(state.saveError).toMatch(/changed since you loaded it/);
    expect(state.policy.revision).toBe("server-rev-2"); // re-seeded
    expect(state.editingRoleId).toBe("advisor"); // kept open so the user can retry
    expect(state.aliasesDraft).toBe("oracle"); // their typed edit survives the conflict
  });

  it("locks out every mutation while malformed, and never calls write", async () => {
    const { write, calls } = fakeSavingWrite();
    const model = openRoleModelPolicyModel(
      { policy: policyWith(), malformed: true, malformedError: "roles must be an array" },
      { write },
    );

    model.beginEditRole("advisor"); // no-op: guarded
    expect(model.getState().editingRoleId).toBeNull();
    expect(await model.addModel("worker", "claude/opus")).toBe(false);
    expect(await model.addRole("helper")).toBe(false);
    expect(await model.addMapping("x", "worker")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("applyPolicySnapshot updates state from an external reload without wiping an unrelated in-progress edit", () => {
    const model = openModel(policyWith());
    model.beginEditRole("advisor");
    model.setAliases("oracle");

    model.applyPolicySnapshot({ policy: policyWith({ revision: "external-rev" }), malformed: false });

    const state = model.getState();
    expect(state.policy.revision).toBe("external-rev");
    expect(state.editingRoleId).toBe("advisor");
    expect(state.aliasesDraft).toBe("oracle");
  });

  it("applyPolicySnapshot closes the editor if the role being edited no longer exists", () => {
    const withCustom: RoleModelPolicy = {
      ...policyWith(),
      roles: [...policyWith().roles, { id: "custom-1", name: "helper", standard: false, aliases: [], models: [], mechanicalModels: [], hardModels: [], toolProfile: DEFAULT_TOOL_PROFILE }],
    };
    const model = openModel(withCustom);
    model.beginEditRole("custom-1");

    model.applyPolicySnapshot({ policy: policyWith(), malformed: false }); // custom-1 is gone

    expect(model.getState().editingRoleId).toBeNull();
  });
});

describe("openRoleModelPolicyModel — subscribe", () => {
  it("notifies subscribers on every mutating command and stops after unsubscribe", async () => {
    const model = openModel(policyWith());
    const listener = vi.fn();
    const unsubscribe = model.subscribe(listener);

    model.beginEditRole("advisor");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    model.setAliases("oracle");
    expect(listener).toHaveBeenCalledTimes(1); // no further calls after unsubscribe
  });
});

describe("openRoleModelPolicyModel — tool profiles", () => {
  it("setToolProfile commits immediately and stores the new profile", async () => {
    const model = openModel(policyWith());

    expect(await model.setToolProfile("leader", { kind: "orchestrator" })).toBe(true);
    expect(model.getState().policy.roles.find((r) => r.id === "leader")?.toolProfile).toEqual({ kind: "orchestrator" });
  });

  it("stores a custom profile's deny and allow lists", async () => {
    const model = openModel(policyWith());

    await model.setToolProfile("worker", { kind: "custom", deny: ["Bash"], allow: ["Read"] });

    expect(model.getState().policy.roles.find((r) => r.id === "worker")?.toolProfile).toEqual({
      kind: "custom",
      deny: ["Bash"],
      allow: ["Read"],
    });
  });

  it("rejects a malformed tool name locally, without calling write", async () => {
    const { write, calls } = fakeSavingWrite();
    const model = openRoleModelPolicyModel({ policy: policyWith(), malformed: false }, { write });

    expect(await model.setToolProfile("worker", { kind: "custom", deny: ["Bash(rm -rf /)"] })).toBe(false);
    expect(model.getState().saveError).toMatch(/plain identifiers/);
    expect(calls).toHaveLength(0);
  });
});

describe("openRoleModelPolicyModel — model budget threshold", () => {
  it("setModelBudgetThreshold commits the new percent", async () => {
    const model = openModel(policyWith());

    expect(await model.setModelBudgetThreshold(60)).toBe(true);
    expect(model.getState().policy.modelBudgetThresholdPct).toBe(60);
  });

  it("rejects an out-of-range percent locally, without calling write", async () => {
    const { write, calls } = fakeSavingWrite();
    const model = openRoleModelPolicyModel({ policy: policyWith(), malformed: false }, { write });

    expect(await model.setModelBudgetThreshold(0)).toBe(false);
    expect(await model.setModelBudgetThreshold(101)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("an unrelated mutation echoes the configured threshold back, instead of resetting it to the default", async () => {
    const configured = { ...policyWith(), modelBudgetThresholdPct: 55 };
    const { write, calls } = fakeSavingWrite();
    const model = openRoleModelPolicyModel({ policy: configured, malformed: false }, { write });

    await model.addModel("worker", "claude-sonnet-5");

    expect(calls).toHaveLength(1);
    expect((calls[0] as { patch: { modelBudgetThresholdPct: number } }).patch.modelBudgetThresholdPct).toBe(55);
    expect(model.getState().policy.modelBudgetThresholdPct).toBe(55);
  });
});
