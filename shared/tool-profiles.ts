import { z } from "zod";

/**
 * Per-role tool enforcement.
 *
 * pi-roles (the package this plugin's policy model was ported from) states
 * outright that role resolution is "guidance, not launch enforcement", and
 * buys enforcement by writing routes into the agent definition files its host
 * reads. Paseo has no such file: our equivalent is `config.providerOptions`,
 * which a `before("agent.create")` hook may rewrite and a spawned agent cannot
 * undo (`update_agent_request` accepts only name and labels).
 *
 * Two layers, both verified against the fork:
 * - `disallowedTools` — the Claude Agent SDK removes these "from the model's
 *   context and cannot be used, even if they would otherwise be allowed".
 *   This is the real enforcement: the tool is not offered at all.
 * - `settings.permissions.deny` — the `--settings` tier, which outranks
 *   project and user settings files. Defence in depth for anything that
 *   reaches the permission layer anyway (notably sidechain subagents, which
 *   run inside the parent session).
 */

/**
 * Claude tool names, spelled as the Claude Agent SDK reports them. Verified
 * against the fork rather than guessed: the shell/read/write/edit/search sets
 * come from `providers/claude/tool-call-mapper.ts`, and the exact
 * `["Bash","Write","Edit","NotebookEdit"]` + `["Bash(*)",...]` pairing is the
 * one exercised end-to-end in `server/hub/provider-policy.real.e2e.test.ts`.
 */
const READ_TOOLS = ["Read", "Glob", "Grep"] as const;
const EDIT_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"] as const;
const SHELL_TOOLS = ["Bash"] as const;
/**
 * Native subagent launchers. These do NOT get their own `agent.create`: they
 * run as sidechains inside the PARENT's session, on the parent's account, and
 * their tokens land in the parent's usage window. Paseo has no hook on them,
 * so an orchestrator that keeps them can still burn its own budget doing the
 * work "itself" one level down. Denying them is what forces a real
 * `mcp__paseo__create_agent`, which is the only path that moves spend to
 * another account.
 */
const NATIVE_SUBAGENT_TOOLS = ["Task", "Agent"] as const;

export const TOOL_PROFILE_IDS = ["unrestricted", "orchestrator", "read-only", "write", "custom"] as const;
export type ToolProfileId = (typeof TOOL_PROFILE_IDS)[number];

/** A tool name, or an MCP tool name like `mcp__paseo__create_agent`. */
export const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
export const MAX_CUSTOM_TOOLS = 64;

export const ToolProfileSchema = z.object({
  kind: z.enum(TOOL_PROFILE_IDS),
  /**
   * Only read for `kind: "custom"`. `deny` removes tools; `allow`
   * pre-approves the ones that remain — it can never re-enable a denied tool,
   * because `disallowedTools` is applied first and drops them from context.
   */
  deny: z.array(z.string().regex(TOOL_NAME_RE)).max(MAX_CUSTOM_TOOLS).optional(),
  allow: z.array(z.string().regex(TOOL_NAME_RE)).max(MAX_CUSTOM_TOOLS).optional(),
});
export type ToolProfile = z.infer<typeof ToolProfileSchema>;

/** Today's behaviour: the plugin writes nothing, so upgrading changes nothing until a role is configured. */
export const DEFAULT_TOOL_PROFILE: ToolProfile = { kind: "unrestricted" };

/** What each built-in profile denies. `custom` is resolved from the role's own lists. */
const BUILT_IN_DENY: Record<Exclude<ToolProfileId, "custom">, readonly string[]> = {
  // Nothing at all: byte-identical pass-through.
  unrestricted: [],
  // Delegation and coordination only — cannot read, write, or run anything,
  // and cannot fan out natively onto its own account either.
  orchestrator: [...READ_TOOLS, ...EDIT_TOOLS, ...SHELL_TOOLS, ...NATIVE_SUBAGENT_TOOLS],
  // Can investigate, cannot change anything. Bash is denied because a shell
  // redirect writes files just as well as Write does.
  "read-only": [...EDIT_TOOLS, ...SHELL_TOOLS],
  // The implementer kit: file and shell tools are exactly what this role is
  // for, so it denies nothing. It differs from `unrestricted` in intent only.
  write: [],
};

/** The tool names a profile denies, deduplicated and in a stable order. */
export function profileDeniedTools(profile: ToolProfile): string[] {
  const denied = profile.kind === "custom" ? (profile.deny ?? []) : BUILT_IN_DENY[profile.kind];
  return [...new Set(denied)];
}

/** The tool names a profile pre-approves. Only a custom profile names any. */
export function profileAllowedTools(profile: ToolProfile): string[] {
  return profile.kind === "custom" ? [...new Set(profile.allow ?? [])] : [];
}

/**
 * A permission rule denying/allowing every call of one tool. `Tool(*)` is the
 * spelling the fork's real end-to-end provider-policy test proves works.
 */
function permissionRule(tool: string): string {
  return `${tool}(*)`;
}

interface ProviderOptionsShape {
  disallowedTools?: unknown;
  settings?: { permissions?: { allow?: unknown; deny?: unknown } } & Record<string, unknown>;
  [key: string]: unknown;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function union(existing: readonly string[], added: readonly string[]): string[] {
  return [...new Set([...existing, ...added])];
}

/**
 * Merges a role's tool profile into a request's `providerOptions`.
 *
 * Returns undefined when the profile has nothing to say, so the caller can
 * pass the request through byte-identical. Restrictions only ever accumulate:
 * whatever the caller already denied stays denied, because a plugin that can
 * silently widen a caller's own sandbox is a worse bug than an unenforced
 * role.
 */
export function applyToolProfile(
  providerOptions: unknown,
  profile: ToolProfile,
): Record<string, unknown> | undefined {
  const deniedTools = profileDeniedTools(profile);
  const allowedTools = profileAllowedTools(profile);
  if (deniedTools.length === 0 && allowedTools.length === 0) {
    return undefined;
  }

  const current: ProviderOptionsShape =
    typeof providerOptions === "object" && providerOptions !== null
      ? (providerOptions as ProviderOptionsShape)
      : {};
  const currentSettings = typeof current.settings === "object" && current.settings !== null ? current.settings : {};
  const currentPermissions =
    typeof currentSettings.permissions === "object" && currentSettings.permissions !== null
      ? currentSettings.permissions
      : {};

  const nextPermissions: Record<string, unknown> = { ...currentPermissions };
  if (deniedTools.length > 0) {
    nextPermissions.deny = union(stringArray(currentPermissions.deny), deniedTools.map(permissionRule));
  }
  if (allowedTools.length > 0) {
    nextPermissions.allow = union(stringArray(currentPermissions.allow), allowedTools.map(permissionRule));
  }

  const next: Record<string, unknown> = {
    ...current,
    settings: { ...currentSettings, permissions: nextPermissions },
  };
  if (deniedTools.length > 0) {
    next.disallowedTools = union(stringArray(current.disallowedTools), deniedTools);
  }
  return next;
}
