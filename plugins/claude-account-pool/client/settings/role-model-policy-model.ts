import {
  EXACT_AGENT_NAME_RE,
  MAX_ALIASES_PER_ROLE,
  MAX_MAPPINGS,
  MAX_MODELS_PER_ROLE,
  MAX_MODEL_REF_LENGTH,
  MAX_ROLES,
  MODEL_REF_RE,
  ROLE_WORD_RE,
  type RoleModelPolicy,
  type RoleRecord,
} from "../../shared/role-policy-schema";

/**
 * Which of a role's three model pools a mutation targets. "standard" is
 * `RoleRecord.models` — the default pool, unaffected in name by this
 * feature. Exported so the settings screen can render one editor per slot
 * instead of duplicating add/remove/move per pool.
 */
export type ModelPoolSlot = "standard" | "mechanical" | "hard";

function poolField(slot: ModelPoolSlot): "models" | "mechanicalModels" | "hardModels" {
  if (slot === "mechanical") return "mechanicalModels";
  if (slot === "hard") return "hardModels";
  return "models";
}
import type { RoleModelPolicyWriteResult } from "../../shared/role-policy-rpc";
import { DEFAULT_TOOL_PROFILE, ToolProfileSchema, type ToolProfile } from "../../shared/tool-profiles";

/**
 * Follows docs/forms.md's plain-TS form model: zero React imports, commands
 * mutate, derived state (limits, dirty) is recomputed on every publish. The
 * component renders `getState()` and dispatches these commands; all network
 * I/O is the injected `write` dependency, so this file (and its tests) never
 * touch a transport.
 *
 * Two persistence shapes, per plan §2.9:
 * - Name/alias edits stage in `nameDraft`/`aliasesDraft` behind an explicit
 *   `save()`/`cancelDraft()` pair (one role editable at a time).
 * - Every other mutation (model add/remove/reorder, mapping add/remove,
 *   role add/delete) commits immediately: it mutates local state and fires
 *   the same underlying `write` as `save()`, with no separate confirm step.
 */

export interface RoleModelPolicyModelDeps {
  write(input: {
    revision: string;
    patch: { roles: RoleRecord[]; agentTypeMappings: Record<string, string>; modelBudgetThresholdPct: number };
  }): Promise<RoleModelPolicyWriteResult>;
  /** Injectable for tests; defaults to a timestamp+random id (uniqueness, not cryptographic strength, is all a role id needs). */
  generateRoleId?: () => string;
}

export interface RoleModelPolicyModelSnapshot {
  policy: RoleModelPolicy;
  malformed: boolean;
  malformedError?: string;
}

export interface LimitStatus {
  allowed: boolean;
  reason?: string;
}

export interface RoleModelPolicyModelState {
  policy: RoleModelPolicy;
  malformed: boolean;
  malformedError?: string;
  editingRoleId: string | null;
  nameDraft: string;
  aliasesDraft: string;
  saving: boolean;
  saveError: string | null;
  canAddRole: LimitStatus;
  canAddMapping: LimitStatus;
  canAddAlias(roleId: string): LimitStatus;
  canAddModel(roleId: string, slot?: ModelPoolSlot): LimitStatus;
  canDeleteRole(roleId: string): LimitStatus;
  roleById(roleId: string): RoleRecord | undefined;
}

export interface RoleModelPolicyModel {
  getState(): RoleModelPolicyModelState;
  subscribe(listener: () => void): () => void;

  /** External input: a fresh read/reload result. Never clobbers an open metadata draft's text. */
  applyPolicySnapshot(snapshot: RoleModelPolicyModelSnapshot): void;

  beginEditRole(roleId: string): void;
  renameRole(name: string): void;
  setAliases(aliasesText: string): void;
  cancelDraft(): void;
  /** Commits the open metadata draft (name/aliases) for `editingRoleId`. */
  save(): Promise<boolean>;

  addRole(name: string): Promise<boolean>;
  deleteRole(roleId: string): Promise<boolean>;
  /** `slot` defaults to "standard" (`RoleRecord.models`); pass "mechanical"/"hard" to edit that class's override pool instead. */
  addModel(roleId: string, modelRef: string, slot?: ModelPoolSlot): Promise<boolean>;
  removeModel(roleId: string, modelRef: string, slot?: ModelPoolSlot): Promise<boolean>;
  moveModel(roleId: string, modelRef: string, direction: "up" | "down", slot?: ModelPoolSlot): Promise<boolean>;
  addMapping(agentType: string, roleId: string): Promise<boolean>;
  removeMapping(agentType: string): Promise<boolean>;
  /** Sets the percent at/above which a budget-gated model family stops being selectable. */
  setModelBudgetThreshold(thresholdPct: number): Promise<boolean>;
  /** Replaces a role's tool profile. Commits immediately, like the model/mapping mutations. */
  setToolProfile(roleId: string, profile: ToolProfile): Promise<boolean>;
}

function defaultGenerateRoleId(): string {
  return `role-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Comma-separated -> trimmed, empty-filtered, case-insensitive-deduped (first occurrence wins), order preserved. */
export function parseAliasesText(text: string): string[] {
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const raw of text.split(",")) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    aliases.push(trimmed);
  }
  return aliases;
}

export function formatAliasesText(aliases: readonly string[]): string {
  return aliases.join(", ");
}

function isRoleWordTaken(policy: RoleModelPolicy, word: string, exceptRoleId?: string): boolean {
  const lower = word.toLowerCase();
  return policy.roles.some((role) => {
    if (role.id === exceptRoleId) return false;
    return role.name.toLowerCase() === lower || role.aliases.some((a) => a.toLowerCase() === lower);
  });
}

function isRoleInUse(policy: RoleModelPolicy, roleId: string): boolean {
  return Object.values(policy.agentTypeMappings).includes(roleId);
}

export function openRoleModelPolicyModel(
  snapshot: RoleModelPolicyModelSnapshot,
  deps: RoleModelPolicyModelDeps,
): RoleModelPolicyModel {
  const generateRoleId = deps.generateRoleId ?? defaultGenerateRoleId;
  const listeners = new Set<() => void>();

  let policy = snapshot.policy;
  let malformed = snapshot.malformed;
  let malformedError = snapshot.malformedError;
  let editingRoleId: string | null = null;
  let nameDraft = "";
  let aliasesDraft = "";
  let saving = false;
  let saveError: string | null = null;

  function publish(): void {
    for (const listener of listeners) listener();
  }

  function roleById(roleId: string): RoleRecord | undefined {
    return policy.roles.find((role) => role.id === roleId);
  }

  function limitStatus(allowed: boolean, reason: string): LimitStatus {
    return allowed ? { allowed: true } : { allowed: false, reason };
  }

  function canAddRole(): LimitStatus {
    return limitStatus(policy.roles.length < MAX_ROLES, `at the ${MAX_ROLES}-role limit`);
  }

  function canAddMapping(): LimitStatus {
    return limitStatus(
      Object.keys(policy.agentTypeMappings).length < MAX_MAPPINGS,
      `at the ${MAX_MAPPINGS}-mapping limit`,
    );
  }

  function canAddAlias(roleId: string): LimitStatus {
    const role = roleById(roleId);
    if (!role) return { allowed: false, reason: "unknown role" };
    return limitStatus(role.aliases.length < MAX_ALIASES_PER_ROLE, `at the ${MAX_ALIASES_PER_ROLE}-alias limit`);
  }

  function canAddModel(roleId: string, slot: ModelPoolSlot = "standard"): LimitStatus {
    const role = roleById(roleId);
    if (!role) return { allowed: false, reason: "unknown role" };
    return limitStatus(role[poolField(slot)].length < MAX_MODELS_PER_ROLE, `at the ${MAX_MODELS_PER_ROLE}-model limit`);
  }

  function canDeleteRole(roleId: string): LimitStatus {
    const role = roleById(roleId);
    if (!role) return { allowed: false, reason: "unknown role" };
    if (role.standard) return { allowed: false, reason: "standard roles can't be deleted" };
    if (isRoleInUse(policy, roleId)) return { allowed: false, reason: "in use by an agent-type mapping" };
    return { allowed: true };
  }

  function getState(): RoleModelPolicyModelState {
    return {
      policy,
      malformed,
      malformedError,
      editingRoleId,
      nameDraft,
      aliasesDraft,
      saving,
      saveError,
      canAddRole: canAddRole(),
      canAddMapping: canAddMapping(),
      canAddAlias,
      canAddModel,
      canDeleteRole,
      roleById,
    };
  }

  /**
   * Shared commit path for every mutation (immediate or drafted). Always
   * sends the whole editable document — the write RPC defaults an omitted
   * `modelBudgetThresholdPct`, so leaving it out of an unrelated save would
   * silently reset a configured threshold back to the default.
   */
  async function commit(
    nextRoles: RoleRecord[],
    nextMappings: Record<string, string>,
    nextThresholdPct: number = policy.modelBudgetThresholdPct,
  ): Promise<boolean> {
    saving = true;
    saveError = null;
    publish();

    const result = await deps.write({
      revision: policy.revision,
      patch: { roles: nextRoles, agentTypeMappings: nextMappings, modelBudgetThresholdPct: nextThresholdPct },
    });

    saving = false;
    if (result.status === "saved") {
      policy = result.policy;
      saveError = null;
      publish();
      return true;
    }
    if (result.status === "conflict") {
      // Re-seed from the authoritative state so a retry uses the current
      // revision; keep the open draft's text so the user doesn't retype it.
      policy = result.policy;
      saveError = result.error;
      publish();
      return false;
    }
    saveError = result.error;
    publish();
    return false;
  }

  function guardEditable(): boolean {
    if (malformed) {
      saveError = "the stored policy is malformed; showing the last known-good version";
      publish();
      return false;
    }
    return true;
  }

  return {
    getState,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    applyPolicySnapshot(next) {
      policy = next.policy;
      malformed = next.malformed;
      malformedError = next.malformedError;
      // Late data is explicit input, not a reconstruction: don't wipe an
      // in-progress metadata edit just because the background policy moved.
      if (editingRoleId && !roleById(editingRoleId)) {
        // The role we were editing no longer exists (e.g. deleted elsewhere).
        editingRoleId = null;
        nameDraft = "";
        aliasesDraft = "";
      }
      publish();
    },

    beginEditRole(roleId) {
      const role = roleById(roleId);
      if (!role || !guardEditable()) return;
      editingRoleId = roleId;
      nameDraft = role.name;
      aliasesDraft = formatAliasesText(role.aliases);
      saveError = null;
      publish();
    },

    renameRole(name) {
      if (editingRoleId === null) return;
      const role = roleById(editingRoleId);
      if (role?.standard) return; // standard role names are fixed
      nameDraft = name;
      publish();
    },

    setAliases(aliasesText) {
      if (editingRoleId === null) return;
      aliasesDraft = aliasesText;
      publish();
    },

    cancelDraft() {
      editingRoleId = null;
      nameDraft = "";
      aliasesDraft = "";
      saveError = null;
      publish();
    },

    async save() {
      if (editingRoleId === null || !guardEditable()) return false;
      const role = roleById(editingRoleId);
      if (!role) return false;

      const name = role.standard ? role.name : nameDraft.trim();
      if (!role.standard) {
        if (!ROLE_WORD_RE.test(name)) {
          saveError = "role names must start with a letter and contain only letters/numbers";
          publish();
          return false;
        }
        if (isRoleWordTaken(policy, name, role.id)) {
          saveError = `"${name}" is already used by another role's name or alias`;
          publish();
          return false;
        }
      }

      const aliases = parseAliasesText(aliasesDraft);
      if (aliases.length > MAX_ALIASES_PER_ROLE) {
        saveError = `at most ${MAX_ALIASES_PER_ROLE} aliases per role`;
        publish();
        return false;
      }
      for (const alias of aliases) {
        if (!ROLE_WORD_RE.test(alias)) {
          saveError = `alias "${alias}" must start with a letter and contain only letters/numbers`;
          publish();
          return false;
        }
        if (isRoleWordTaken(policy, alias, role.id)) {
          saveError = `"${alias}" is already used by another role's name or alias`;
          publish();
          return false;
        }
      }
      // Aliases can repeat each other within THIS role's own draft only if
      // parseAliasesText already deduped them; a within-role collision with
      // the (fixed) name is still possible and must be rejected too.
      if (aliases.some((alias) => alias.toLowerCase() === name.toLowerCase())) {
        saveError = "an alias can't match the role's own name";
        publish();
        return false;
      }

      const nextRoles = policy.roles.map((r) => (r.id === role.id ? { ...r, name, aliases } : r));
      const ok = await commit(nextRoles, policy.agentTypeMappings);
      if (ok) {
        editingRoleId = null;
        nameDraft = "";
        aliasesDraft = "";
        publish();
      }
      return ok;
    },

    async addRole(name) {
      if (!guardEditable()) return false;
      const trimmed = name.trim();
      const { allowed, reason } = canAddRole();
      if (!allowed) {
        saveError = reason ?? "can't add another role";
        publish();
        return false;
      }
      if (!ROLE_WORD_RE.test(trimmed)) {
        saveError = "role names must start with a letter and contain only letters/numbers";
        publish();
        return false;
      }
      if (isRoleWordTaken(policy, trimmed)) {
        saveError = `"${trimmed}" is already used by another role's name or alias`;
        publish();
        return false;
      }
      const newRole: RoleRecord = {
        id: generateRoleId(),
        name: trimmed,
        standard: false,
        aliases: [],
        models: [],
        mechanicalModels: [],
        hardModels: [],
        toolProfile: DEFAULT_TOOL_PROFILE,
      };
      return commit([...policy.roles, newRole], policy.agentTypeMappings);
    },

    async deleteRole(roleId) {
      if (!guardEditable()) return false;
      const { allowed, reason } = canDeleteRole(roleId);
      if (!allowed) {
        saveError = reason ?? "can't delete this role";
        publish();
        return false;
      }
      const nextRoles = policy.roles.filter((r) => r.id !== roleId);
      return commit(nextRoles, policy.agentTypeMappings);
    },

    async addModel(roleId, modelRef, slot = "standard") {
      if (!guardEditable()) return false;
      const role = roleById(roleId);
      if (!role) return false;
      const field = poolField(slot);
      const { allowed, reason } = canAddModel(roleId, slot);
      if (!allowed) {
        saveError = reason ?? "can't add another model";
        publish();
        return false;
      }
      const trimmed = modelRef.trim();
      if (trimmed.length > MAX_MODEL_REF_LENGTH || !MODEL_REF_RE.test(trimmed)) {
        saveError = `"${modelRef}" isn't a valid model reference (use "model", or "provider/model" to pin a provider)`;
        publish();
        return false;
      }
      if (role[field].some((m) => m.toLowerCase() === trimmed.toLowerCase())) {
        saveError = `"${trimmed}" is already in this role's ${slot} model list`;
        publish();
        return false;
      }
      const nextRoles = policy.roles.map((r) => (r.id === roleId ? { ...r, [field]: [...r[field], trimmed] } : r));
      return commit(nextRoles, policy.agentTypeMappings);
    },

    async removeModel(roleId, modelRef, slot = "standard") {
      if (!guardEditable()) return false;
      const role = roleById(roleId);
      if (!role) return false;
      const field = poolField(slot);
      const nextRoles = policy.roles.map((r) =>
        r.id === roleId ? { ...r, [field]: r[field].filter((m) => m !== modelRef) } : r,
      );
      return commit(nextRoles, policy.agentTypeMappings);
    },

    async moveModel(roleId, modelRef, direction, slot = "standard") {
      if (!guardEditable()) return false;
      const role = roleById(roleId);
      if (!role) return false;
      const field = poolField(slot);
      const index = role[field].indexOf(modelRef);
      if (index === -1) return false;
      const swapWith = direction === "up" ? index - 1 : index + 1;
      if (swapWith < 0 || swapWith >= role[field].length) return false;
      const nextModels = [...role[field]];
      [nextModels[index], nextModels[swapWith]] = [nextModels[swapWith], nextModels[index]];
      const nextRoles = policy.roles.map((r) => (r.id === roleId ? { ...r, [field]: nextModels } : r));
      return commit(nextRoles, policy.agentTypeMappings);
    },

    async addMapping(agentType, roleId) {
      if (!guardEditable()) return false;
      const trimmed = agentType.trim();
      if (!EXACT_AGENT_NAME_RE.test(trimmed)) {
        saveError = `"${agentType}" isn't a valid agent-type key`;
        publish();
        return false;
      }
      if (!roleById(roleId)) {
        saveError = "unknown role";
        publish();
        return false;
      }
      const isNewKey = !(trimmed in policy.agentTypeMappings);
      if (isNewKey) {
        const { allowed, reason } = canAddMapping();
        if (!allowed) {
          saveError = reason ?? "can't add another mapping";
          publish();
          return false;
        }
      }
      const nextMappings = { ...policy.agentTypeMappings, [trimmed]: roleId };
      return commit(policy.roles, nextMappings);
    },

    async removeMapping(agentType) {
      if (!guardEditable()) return false;
      const nextMappings = { ...policy.agentTypeMappings };
      delete nextMappings[agentType];
      return commit(policy.roles, nextMappings);
    },

    async setToolProfile(roleId, profile) {
      if (!guardEditable()) return false;
      if (!roleById(roleId)) return false;
      const parsed = ToolProfileSchema.safeParse(profile);
      if (!parsed.success) {
        saveError = "tool names must be plain identifiers, e.g. Bash or mcp__paseo__create_agent";
        publish();
        return false;
      }
      const nextRoles = policy.roles.map((r) => (r.id === roleId ? { ...r, toolProfile: parsed.data } : r));
      return commit(nextRoles, policy.agentTypeMappings);
    },

    async setModelBudgetThreshold(thresholdPct) {
      if (!guardEditable()) return false;
      if (!Number.isInteger(thresholdPct) || thresholdPct < 1 || thresholdPct > 100) {
        saveError = "the budget threshold must be a whole percent between 1 and 100";
        publish();
        return false;
      }
      return commit(policy.roles, policy.agentTypeMappings, thresholdPct);
    },
  };
}
