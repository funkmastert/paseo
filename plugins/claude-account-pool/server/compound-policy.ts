import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import { LEADER_ROLE_ID, type RoleModelPolicy } from "../shared/role-policy-schema";
import { resolveDeclaredRootRole } from "./role-resolve";

/**
 * The compound-engineering work policy, enforced on every leader.
 *
 * Tyler's rule: every leader always works through the compound-engineering
 * (CE) loop — plan, work, review before any push, ship, compound the learning
 * — and briefs its children with the CE skill each one runs. Two halves, both
 * decided here, after the account router, so they see the account the leader
 * actually runs on (a leader can be moved onto any pooled account when its own
 * is at a cap):
 *
 * 1. The policy itself rides into the leader's system prompt through
 *    `providerOptions.appendSystemPrompt`, appended after anything already
 *    there (the restriction notice, a caller's own note).
 * 2. The account's Claude profile must have the CE plugin enabled, or the
 *    policy names skills the leader cannot invoke. That is checked from the
 *    profile's own files. A missing plugin is flagged — a label, a log line,
 *    and a degraded-mode note telling the leader to read the skills' SKILL.md
 *    files instead — and never refused: a root is never refused (see
 *    router.ts), and a missing plugin is the operator's to fix, not the
 *    leader's.
 *
 * Only claude-family providers are touched: `appendSystemPrompt` is a Claude
 * provider option, and another provider's strict options schema would reject
 * it. Every non-leader create passes through byte-identical.
 */

/**
 * Set on every leader create this hook handled: `injected` when the policy
 * went in and the account has CE, `ce-plugin-missing` when the policy went in
 * but the account's profile cannot run the CE skills.
 */
export const COMPOUND_POLICY_LABEL = "paseo.compound-policy";

/** The CE plugin's id as Claude Code's `enabledPlugins` and `installed_plugins.json` spell it. */
export const CE_PLUGIN_ID = "compound-engineering@compound-engineering-plugin";

/** The short form of ~/bozeo-ops/compound-policy/POLICY.md, as every leader receives it. */
export const COMPOUND_POLICY_NOTICE = [
  "COMPOUND-ENGINEERING WORK POLICY (Bozeo, enforced for every leader): run every unit of work through the compound-engineering loop with its skills.",
  "/compound-engineering:ce-brainstorm when the requirements are unclear; /compound-engineering:ce-plan always, sized to the work; /compound-engineering:ce-work to execute; /compound-engineering:ce-simplify-code after non-trivial code; /compound-engineering:ce-code-review BEFORE EVERY PUSH AND EVERY PR; /compound-engineering:ce-commit or ce-commit-push-pr to ship; then /compound-engineering:ce-compound to record what was learned.",
  "A bug, error or failing test starts with /compound-engineering:ce-debug instead of brainstorm/plan/work, then review, ship and compound.",
  "Every Paseo child brief names the CE skill that child runs (ce-work on a plan path, ce-debug, ce-code-review mode:report-only, ce-compound) and says: if that skill is not in your skill list, read its SKILL.md in the compound-engineering plugin cache and follow it.",
  "On Wondergit repos (origin on git.wonderly.info) the gh-based skills (ce-commit-push-pr, ce-babysit-pr, ce-resolve-pr-feedback, lfg, ce-code-review with a PR target) cannot reach the forge: review the local branch with ce-code-review base:<ref>, commit with ce-commit, and push, open PRs and answer review comments with the wondergit and gh-fix-pr-comments skills.",
  "Rapid mode changes when these steps run, never whether. Full policy: ~/bozeo-ops/compound-policy/POLICY.md.",
].join(" ");

/** Appended after the policy when the leader's account cannot invoke the CE skills. */
export function missingPluginNotice(configDir: string): string {
  return `WARNING: the compound-engineering plugin is NOT enabled in this agent's Claude profile (${configDir}), so the ce-* skills are not in your skill list. The policy above still applies: read each skill's SKILL.md under ~/.claude*/plugins/cache/compound-engineering-plugin/compound-engineering/*/skills/<skill>/ and follow it, and tell Tyler the profile needs the plugin.`;
}

/** What a Claude profile directory says about the CE plugin. */
export interface CompoundPluginStatus {
  enabled: boolean;
  /** Why it isn't, for the log line. Absent when enabled. */
  reason?: string;
}

/** Reads a Claude profile directory and says whether the CE plugin is installed and enabled there. */
export type CompoundPluginProbe = (configDir: string) => Promise<CompoundPluginStatus>;

/** A provider entry as `paseo.config.get()` returns it, reduced to what this hook reads. */
export interface ProviderEntryShape {
  extends?: string;
  env?: Record<string, string>;
}

/** The daemon's provider entries by id, or undefined when they could not be read. */
export type ProviderEntriesReader = () => Promise<Record<string, ProviderEntryShape> | undefined>;

export interface CompoundPolicyEpisode {
  providerId: string;
  configDir: string;
  reason: string;
  callerAgentId?: string;
}

export interface CompoundPolicyOptions {
  policy: () => RoleModelPolicy;
  providerEntries: ProviderEntriesReader;
  /**
   * Whether the pool knows this provider id. Pooled accounts are all Claude
   * accounts, so this keeps a leader on one covered even when the provider
   * entries could not be read.
   */
  isPoolProvider?: (providerId: string) => boolean;
  probe?: CompoundPluginProbe;
  /** The daemon's own environment, which an agent inherits under its provider env. Defaults to process.env. */
  daemonEnv?: Record<string, string | undefined>;
  /** Defaults to os.homedir(). */
  homeDir?: string;
  onPluginMissing?: (episode: CompoundPolicyEpisode) => void;
  onError?: (error: unknown) => void;
}

export type CompoundPolicyRouter = (input: {
  request: PluginBeforeRequests["agent.create"];
}) => Promise<PluginBeforeRequests["agent.create"] | void>;

type Labels = Record<string, string>;

/** The claude provider every pooled account extends; `appendSystemPrompt` is its option. */
const CLAUDE_PROVIDER_ID = "claude";

/** Longest `extends` chain followed before giving up; a cycle in operator config must not hang a create. */
const MAX_EXTENDS_DEPTH = 8;

/**
 * Whether this create runs at the leader tier, by the classifier's own rule
 * (classifier.ts, `isLeaderTier`): an explicit label that resolves to a role
 * decides it either way; without one, a create with no calling agent is a
 * leader and a spawned child is not.
 */
export function isLeaderCreate(policy: RoleModelPolicy, request: PluginBeforeRequests["agent.create"]): boolean {
  const declared = resolveDeclaredRootRole(policy, request.labels);
  if (declared) {
    return declared.role.id === LEADER_ROLE_ID;
  }
  return !request.callerAgentId;
}

/**
 * The provider's `extends` chain from itself to its root, stopping at a
 * missing entry, a cycle, or MAX_EXTENDS_DEPTH. `claude` itself is the root
 * whether or not the config declares an entry for it.
 */
function extendsChain(providerId: string, entries: Record<string, ProviderEntryShape>): string[] {
  const chain: string[] = [];
  let current: string | undefined = providerId;
  while (current !== undefined && !chain.includes(current) && chain.length < MAX_EXTENDS_DEPTH) {
    chain.push(current);
    current = entries[current]?.extends;
  }
  return chain;
}

/**
 * The Claude profile directory an agent on this provider runs with, resolved
 * the way the agent's environment is layered: the create's own env, then the
 * provider entry and what it extends (nearest wins), then the daemon's
 * environment, then Claude Code's default.
 */
export function resolveClaudeConfigDir(
  providerId: string,
  entries: Record<string, ProviderEntryShape>,
  requestEnv: Record<string, string> | undefined,
  daemonEnv: Record<string, string | undefined>,
  homeDir: string,
): string {
  const fromRequest = requestEnv?.CLAUDE_CONFIG_DIR;
  if (fromRequest) {
    return fromRequest;
  }
  for (const id of extendsChain(providerId, entries)) {
    const fromEntry = entries[id]?.env?.CLAUDE_CONFIG_DIR;
    if (fromEntry) {
      return fromEntry;
    }
  }
  return daemonEnv.CLAUDE_CONFIG_DIR || join(homeDir, ".claude");
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

/**
 * The default probe: the plugin is usable when the profile's settings.json
 * enables it and installed_plugins.json has a user-scope install. A
 * project-scope install alone does not count — it only loads in that one
 * project.
 */
export const probeCompoundPlugin: CompoundPluginProbe = async (configDir) => {
  let settings: unknown;
  try {
    settings = await readJson(join(configDir, "settings.json"));
  } catch (error) {
    return { enabled: false, reason: `settings.json unreadable (${error instanceof Error ? error.message : String(error)})` };
  }
  const enabledPlugins = (settings as { enabledPlugins?: Record<string, unknown> } | null)?.enabledPlugins;
  if (enabledPlugins?.[CE_PLUGIN_ID] !== true) {
    return { enabled: false, reason: `settings.json does not enable ${CE_PLUGIN_ID}` };
  }
  let installed: unknown;
  try {
    installed = await readJson(join(configDir, "plugins", "installed_plugins.json"));
  } catch (error) {
    return { enabled: false, reason: `plugins/installed_plugins.json unreadable (${error instanceof Error ? error.message : String(error)})` };
  }
  const installs = (installed as { plugins?: Record<string, unknown> } | null)?.plugins?.[CE_PLUGIN_ID];
  const hasUserInstall =
    Array.isArray(installs) && installs.some((entry) => (entry as { scope?: unknown } | null)?.scope === "user");
  return hasUserInstall ? { enabled: true } : { enabled: false, reason: `no user-scope install of ${CE_PLUGIN_ID}` };
};

/** The request with `notice` appended to its system-prompt note and the policy label set. */
function withPolicy(
  request: PluginBeforeRequests["agent.create"],
  notice: string,
  labelValue: string,
): PluginBeforeRequests["agent.create"] {
  const current =
    typeof request.config.providerOptions === "object" && request.config.providerOptions !== null
      ? (request.config.providerOptions as Record<string, unknown>)
      : {};
  const currentAppend = typeof current.appendSystemPrompt === "string" ? current.appendSystemPrompt : undefined;
  const labels: Labels = { ...request.labels, [COMPOUND_POLICY_LABEL]: labelValue };
  return {
    ...request,
    config: {
      ...request.config,
      providerOptions: { ...current, appendSystemPrompt: currentAppend ? `${currentAppend}\n\n${notice}` : notice },
    },
    labels,
  } as PluginBeforeRequests["agent.create"];
}

/**
 * `before("agent.create")` handler for the compound-engineering policy. Never
 * throws: any failure leaves the request exactly as it arrived.
 */
export function createCompoundPolicyRouter(options: CompoundPolicyOptions): CompoundPolicyRouter {
  const probe = options.probe ?? probeCompoundPlugin;
  const daemonEnv = options.daemonEnv ?? process.env;
  const homeDir = options.homeDir ?? homedir();

  return async function routeCompoundPolicy({ request }) {
    try {
      if (!isLeaderCreate(options.policy(), request)) {
        return;
      }
      const providerId = request.config.provider;
      const entries = (await options.providerEntries()) ?? {};
      const isClaudeFamily =
        options.isPoolProvider?.(providerId) === true || extendsChain(providerId, entries).includes(CLAUDE_PROVIDER_ID);
      if (!isClaudeFamily) {
        return;
      }
      const configDir = resolveClaudeConfigDir(providerId, entries, request.env, daemonEnv, homeDir);
      const status = await probe(configDir);
      if (status.enabled) {
        return withPolicy(request, COMPOUND_POLICY_NOTICE, "injected");
      }
      options.onPluginMissing?.({
        providerId,
        configDir,
        reason: status.reason ?? "not enabled",
        ...(request.callerAgentId ? { callerAgentId: request.callerAgentId } : {}),
      });
      return withPolicy(request, `${COMPOUND_POLICY_NOTICE}\n\n${missingPluginNotice(configDir)}`, "ce-plugin-missing");
    } catch (error) {
      options.onError?.(error);
      return;
    }
  };
}
