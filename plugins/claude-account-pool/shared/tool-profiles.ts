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
 *
 * A denial is only real if every tool with the same reach is denied.
 * `Bash` is one tool name among several with shell-equivalent reach: Paseo's
 * own MCP tools can open a terminal or run a workspace's configured script
 * just as well (see `MCP_SHELL_TOOLS` below), and neither enforcement layer
 * closes that path unless it's named explicitly — `disallowedTools` and
 * `settings.permissions.deny` only ever act on the exact tool name given
 * them. What this does not and cannot cover — MCP servers outside Paseo's own
 * registry, `browser_navigate`, the network tools, the agent-lifecycle tools
 * — is set out in full in the README's "What a tool profile does and does not
 * guarantee".
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

/**
 * Paseo's own MCP tools that reach a shell or run arbitrary configured
 * commands — the same capability `Bash` grants, through a completely
 * different tool name. Denying `Bash` without denying these is not a denial:
 * a session can `mcp__paseo__create_terminal` a terminal, `send_terminal_keys`
 * to run anything in it, and `capture_terminal` to read the result, or
 * `start_workspace_script` an operator-configured script — all without ever
 * calling the tool named `Bash`. Verified against the fork's tool
 * registrations in `packages/server/src/server/agent/tools/paseo-tools.ts`
 * (`registerTool("create_terminal", ...)` etc.); MCP tool names reach
 * `disallowedTools`/`settings.permissions.deny` as `mcp__paseo__<name>`, the
 * same mechanism `NATIVE_SUBAGENT_TOOLS` already relies on for `Task`/`Agent`.
 *
 * Deliberately excludes `mcp__paseo__list_terminals` and
 * `mcp__paseo__list_workspace_scripts`: they report state (terminal ids,
 * script status) and can't execute or mutate anything themselves, so they
 * stay available to `read-only`.
 */
const MCP_SHELL_TOOLS = [
  "mcp__paseo__create_terminal",
  "mcp__paseo__send_terminal_keys",
  "mcp__paseo__kill_terminal",
  "mcp__paseo__capture_terminal",
  "mcp__paseo__start_workspace_script",
  "mcp__paseo__stop_workspace_script",
] as const;

/**
 * `mcp__paseo__update_agent` rewrites an agent's name, LABELS and runtime
 * settings. Labels are where a restriction is recorded so a child can inherit
 * it (`TOOLS_DENIED_LABEL`), so an agent that can rewrite its own labels can
 * erase the evidence of its own restriction and spawn a clean child — which
 * would make inheritance, and therefore `read-only` itself, a suggestion
 * again. Its `settings` argument also sets another agent's model. Verified
 * against the fork's `registerTool("update_agent", ...)`.
 */
const MCP_AGENT_MUTATION_TOOLS = ["mcp__paseo__update_agent"] as const;

/**
 * Agent-lifecycle tools that act destructively on ANOTHER agent: abort its
 * run, soft-delete it, or terminate it permanently. None of these touch this
 * agent's own sandbox, so `read-only`'s file/shell denials don't cover them —
 * they act outward, on agents this one may have had no part in creating.
 * Verified against the fork's `registerTool("cancel_agent", ...)`,
 * `registerTool("archive_agent", ...)`, and `registerTool("kill_agent", ...)`.
 */
const AGENT_DESTRUCTIVE_TOOLS = [
  "mcp__paseo__cancel_agent",
  "mcp__paseo__archive_agent",
  "mcp__paseo__kill_agent",
] as const;

/**
 * Agent-lifecycle tools that escalate a PEER's privilege rather than this
 * agent's own: `set_agent_mode` can flip another agent into a more permissive
 * mode (including `bypassPermissions`), and `respond_to_permission` can
 * approve another agent's pending permission request on its behalf. Both are
 * privilege escalation performed by proxy — the exact thing a `read-only`
 * role exists to prevent, just aimed at a peer instead of at this agent's own
 * tool list. Verified against the fork's `registerTool("set_agent_mode", ...)`
 * and `registerTool("respond_to_permission", ...)`.
 */
const AGENT_ESCALATION_TOOLS = [
  "mcp__paseo__set_agent_mode",
  "mcp__paseo__respond_to_permission",
] as const;

/**
 * `send_agent_prompt` sends a task to ANY running agent by id, not only one
 * this agent created, so the inheritance guarantee below does not cover it:
 * the recipient is a peer that resolved its own role independently, and if
 * that peer is unrestricted, prompting it is a proxy for doing the thing
 * directly. That peer could also rewrite this agent's own
 * `paseo.tools-denied` label through its own `update_agent`, breaking
 * inheritance for any child this agent spawns later. Both enforcement layers
 * act only on exact tool names, and there is no parameter-level distinction
 * between "prompt a child I created" and "prompt an arbitrary peer" available
 * at authorization time — it is one tool name allowed or denied, not a
 * per-target decision. Denied for `read-only` because the requirement for
 * that role is that it cannot do anything harmful, full stop; a `read-only`
 * agent that needs help still has `mcp__paseo__create_agent`, and inheritance
 * guarantees whatever it spawns is at least as restricted as itself.
 * `orchestrator` keeps this tool deliberately: coordinating agents, including
 * ones it didn't create, is that profile's entire job. Verified against the
 * fork's `registerTool("send_agent_prompt", ...)`.
 */
const AGENT_PROMPT_TOOLS = ["mcp__paseo__send_agent_prompt"] as const;

/**
 * Browser automation that ACTS on a page. A `read-only` agent holding these
 * is not read-only in any sense an operator would recognise: `browser_click`
 * and `browser_fill`/`browser_type`/`browser_select`/`browser_keypress`
 * submit forms, `browser_upload` sends local files to a remote site, and
 * `browser_evaluate` runs arbitrary JavaScript in a page that is already
 * logged in as the operator. That is real-world mutation — it just doesn't
 * touch the local filesystem, which is why it went unnoticed when the
 * filesystem tools were closed. `browser_drag` and `browser_hover` are here
 * because they are input events too, and neither is useful to an agent that
 * cannot click.
 *
 * Verified against the fork's `packages/server/src/server/browser-tools/tools.ts`.
 */
const BROWSER_INPUT_TOOLS = [
  "mcp__paseo__browser_click",
  "mcp__paseo__browser_fill",
  "mcp__paseo__browser_type",
  "mcp__paseo__browser_keypress",
  "mcp__paseo__browser_select",
  "mcp__paseo__browser_drag",
  "mcp__paseo__browser_hover",
  "mcp__paseo__browser_upload",
  "mcp__paseo__browser_evaluate",
] as const;

/**
 * The rest of the browser surface: navigation and observation.
 *
 * `read-only` KEEPS these, deliberately. A reviewer asked to look at a web UI
 * needs to open a page and see it; a browser it cannot point anywhere is not
 * an investigation tool, and a guard rail that makes the job impossible gets
 * turned off. The honest cost is that `browser_navigate` and
 * `browser_new_tab` take a URL, and a GET to a crafted URL from a session
 * that is already authenticated can change server state. That is a real,
 * documented hole rather than an oversight — see the README's limits section,
 * and use a `custom` profile that also denies these if your threat model
 * needs it.
 *
 * `orchestrator` denies the whole family, including this half: a profile that
 * cannot `Read` a local file has no business reading a rendered page either,
 * and its job is to delegate, not to look.
 */
const BROWSER_VIEW_TOOLS = [
  "mcp__paseo__browser_navigate",
  "mcp__paseo__browser_new_tab",
  "mcp__paseo__browser_close_tab",
  "mcp__paseo__browser_back",
  "mcp__paseo__browser_forward",
  "mcp__paseo__browser_reload",
  "mcp__paseo__browser_list_tabs",
  "mcp__paseo__browser_snapshot",
  "mcp__paseo__browser_screenshot",
  "mcp__paseo__browser_logs",
  "mcp__paseo__browser_scroll",
  "mcp__paseo__browser_resize",
  "mcp__paseo__browser_wait",
] as const;

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
  // and cannot fan out natively onto its own account either. Deliberately
  // keeps AGENT_DESTRUCTIVE_TOOLS, AGENT_ESCALATION_TOOLS, and
  // AGENT_PROMPT_TOOLS (unlike `read-only`, below): coordinating agents —
  // cancelling a stalled one, archiving a finished one, prompting an existing
  // peer — IS this profile's job, not a hole in it.
  orchestrator: [
    ...READ_TOOLS,
    ...EDIT_TOOLS,
    ...SHELL_TOOLS,
    ...MCP_SHELL_TOOLS,
    ...MCP_AGENT_MUTATION_TOOLS,
    ...BROWSER_INPUT_TOOLS,
    ...BROWSER_VIEW_TOOLS,
    ...NATIVE_SUBAGENT_TOOLS,
  ],
  // Can investigate, cannot change anything — including anything belonging
  // to another agent. Bash is denied because a shell redirect writes files
  // just as well as Write does; MCP_SHELL_TOOLS is denied for the same reason
  // one level up the stack — a terminal opened through Paseo's own MCP tools
  // is still a shell. AGENT_DESTRUCTIVE_TOOLS and AGENT_ESCALATION_TOOLS are
  // denied because killing, archiving, or mode-flipping a peer is action, not
  // investigation, regardless of whose sandbox it happens in.
  // AGENT_PROMPT_TOOLS is denied because it is the one hole inheritance can't
  // close: it targets an arbitrary existing peer, not a child this agent
  // spawned. `create_agent` stays — inheritance keeps whatever it spawns at
  // least as restricted as this agent itself.
  "read-only": [
    ...EDIT_TOOLS,
    ...SHELL_TOOLS,
    ...MCP_SHELL_TOOLS,
    ...MCP_AGENT_MUTATION_TOOLS,
    ...AGENT_DESTRUCTIVE_TOOLS,
    ...AGENT_ESCALATION_TOOLS,
    ...AGENT_PROMPT_TOOLS,
    ...BROWSER_INPUT_TOOLS,
  ],
  // The implementer kit: file and shell tools are exactly what this role is
  // for, so it denies nothing. It differs from `unrestricted` in intent only.
  write: [],
};

/** The tool names a profile denies, deduplicated and in a stable order. */
export function profileDeniedTools(profile: ToolProfile): string[] {
  const denied = profile.kind === "custom" ? (profile.deny ?? []) : BUILT_IN_DENY[profile.kind];
  return [...new Set(denied)];
}

/**
 * How an applied deny list travels on the created agent's own labels, so a
 * child spawned later can inherit it. A label is the only per-agent field
 * that is both writable by an `agent.create` hook and readable back from the
 * daemon afterwards — `providerOptions` appears nowhere in
 * `AgentSnapshotPayload` — and, unlike anything the plugin holds in memory,
 * it survives a plugin reload and a daemon restart. See server/parent-profiles.ts.
 */
export function serializeDeniedTools(denied: readonly string[]): string {
  return [...new Set(denied)].join(",");
}

/** The inverse. Silently drops anything that isn't a well-formed tool name. */
export function parseDeniedTools(value: string | undefined): string[] {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }
  return [...new Set(value.split(",").map((tool) => tool.trim()).filter((tool) => TOOL_NAME_RE.test(tool)))];
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
 * `additionalDenied` carries restrictions that came from somewhere other than
 * the profile itself — today, the ones inherited from the agent that spawned
 * this one. It unions in exactly like the profile's own denials.
 *
 * `appendSystemPrompt`, when given, is the disclosure half (see
 * shared/restriction-notice.ts): the text telling the restricted agent what
 * it lost and what to do instead. It is written into `providerOptions` under
 * that same key — Paseo-owned, not an SDK option, folded into the agent's
 * actual system prompt by the fork's `buildOptions()` — appended after
 * anything the caller already set there rather than replacing it.
 *
 * Returns undefined when there is nothing to say, so the caller can
 * pass the request through byte-identical. Restrictions only ever accumulate:
 * whatever the caller already denied stays denied, because a plugin that can
 * silently widen a caller's own sandbox is a worse bug than an unenforced
 * role.
 */
export function applyToolProfile(
  providerOptions: unknown,
  profile: ToolProfile,
  additionalDenied: readonly string[] = [],
  appendSystemPrompt?: string,
): Record<string, unknown> | undefined {
  const deniedTools = [...new Set([...profileDeniedTools(profile), ...additionalDenied])];
  const allowedTools = profileAllowedTools(profile);
  if (deniedTools.length === 0 && allowedTools.length === 0 && !appendSystemPrompt) {
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
  if (appendSystemPrompt) {
    const currentAppend = typeof current.appendSystemPrompt === "string" ? current.appendSystemPrompt : undefined;
    next.appendSystemPrompt = currentAppend ? `${currentAppend}\n\n${appendSystemPrompt}` : appendSystemPrompt;
  }
  return next;
}
