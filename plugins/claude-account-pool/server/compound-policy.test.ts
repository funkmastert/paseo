import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import { AGENT_ROLE_LABEL, AGENT_TYPE_LABEL, DEFAULT_POLICY } from "../shared/role-policy-schema";
import {
  CE_PLUGIN_ID,
  COMPOUND_POLICY_LABEL,
  COMPOUND_POLICY_NOTICE,
  createCompoundPolicyRouter,
  isLeaderCreate,
  probeCompoundPlugin,
  resolveClaudeConfigDir,
  type CompoundPluginProbe,
  type CompoundPolicyOptions,
  type ProviderEntryShape,
} from "./compound-policy";

/**
 * Tyler: "every leader should always use [compound-engineering] and that needs
 * to be enforced in the bozeo code." These pin the leader path: every leader
 * create carries the policy, a leader on an account without the CE plugin is
 * flagged rather than silently left without its skills, and nothing that is
 * not a leader is touched.
 */

type CreateAgentRequest = PluginBeforeRequests["agent.create"];

/** The pool as ~/.paseo/config.json declares it: one leader account, two worker accounts extending it. */
const ENTRIES: Record<string, ProviderEntryShape> = {
  claude: { env: { CLAUDE_CONFIG_DIR: "/profiles/leader" } },
  "claude-personal": { extends: "claude", env: { CLAUDE_CONFIG_DIR: "/profiles/personal" } },
  "claude-backup": { extends: "claude", env: { CLAUDE_CONFIG_DIR: "/profiles/backup" } },
  codex: {},
};

function create(provider: string, extra: Partial<CreateAgentRequest> & Record<string, unknown> = {}): { request: CreateAgentRequest } {
  return {
    request: { config: { provider, cwd: "/tmp/work" }, labels: {}, ...extra } as unknown as CreateAgentRequest,
  };
}

function probeEnabledFor(...dirs: string[]): CompoundPluginProbe {
  return async (configDir) =>
    dirs.includes(configDir) ? { enabled: true } : { enabled: false, reason: "settings.json does not enable it" };
}

function router(extra: Partial<CompoundPolicyOptions> = {}) {
  return createCompoundPolicyRouter({
    policy: () => DEFAULT_POLICY,
    providerEntries: async () => ENTRIES,
    probe: probeEnabledFor("/profiles/leader", "/profiles/personal", "/profiles/backup"),
    daemonEnv: {},
    homeDir: "/home/op",
    ...extra,
  });
}

function appendOf(result: CreateAgentRequest | void): string | undefined {
  return (result?.config.providerOptions as { appendSystemPrompt?: string } | undefined)?.appendSystemPrompt;
}

describe("isLeaderCreate", () => {
  it("treats a create with no calling agent and no role label as the leader", () => {
    expect(isLeaderCreate(DEFAULT_POLICY, create("claude").request)).toBe(true);
  });

  it("treats a caller-less create that declares a worker role as a child", () => {
    const request = create("claude", { labels: { [AGENT_TYPE_LABEL]: "worker" } }).request;
    expect(isLeaderCreate(DEFAULT_POLICY, request)).toBe(false);
  });

  it("treats a spawned child as a non-leader", () => {
    expect(isLeaderCreate(DEFAULT_POLICY, create("claude", { callerAgentId: "parent-1" }).request)).toBe(false);
  });

  it("treats a spawned child that explicitly declares the leader role as a leader", () => {
    const request = create("claude", { callerAgentId: "parent-1", labels: { [AGENT_ROLE_LABEL]: "leader" } }).request;
    expect(isLeaderCreate(DEFAULT_POLICY, request)).toBe(true);
  });
});

describe("compound policy router — leaders", () => {
  it("injects the policy into a leader on the leader account and labels it injected", async () => {
    const result = await router()(create("claude"));
    expect(appendOf(result)).toBe(COMPOUND_POLICY_NOTICE);
    expect(result?.labels?.[COMPOUND_POLICY_LABEL]).toBe("injected");
  });

  it("names the core CE skills, the pre-push review gate and the child-brief rule", () => {
    for (const skill of ["ce-plan", "ce-work", "ce-code-review", "ce-debug", "ce-compound"]) {
      expect(COMPOUND_POLICY_NOTICE).toContain(`/compound-engineering:${skill}`);
    }
    expect(COMPOUND_POLICY_NOTICE).toContain("BEFORE EVERY PUSH AND EVERY PR");
    expect(COMPOUND_POLICY_NOTICE).toContain("Every Paseo child brief names the CE skill");
    expect(COMPOUND_POLICY_NOTICE).toContain("Wondergit");
  });

  it("checks the profile of the account the leader was rerouted to, not the leader account", async () => {
    const probe = vi.fn(probeEnabledFor("/profiles/backup"));
    const result = await router({ probe })(create("claude-backup", { labels: { "paseo.account-rerouted": "claude" } }));
    expect(probe).toHaveBeenCalledWith("/profiles/backup");
    expect(result?.labels?.[COMPOUND_POLICY_LABEL]).toBe("injected");
    expect(result?.labels?.["paseo.account-rerouted"]).toBe("claude");
  });

  it("flags a leader whose account lacks the CE plugin, still injects the policy, and does not refuse it", async () => {
    const onPluginMissing = vi.fn();
    const result = await router({ probe: probeEnabledFor("/profiles/leader"), onPluginMissing })(create("claude-personal"));
    expect(result?.labels?.[COMPOUND_POLICY_LABEL]).toBe("ce-plugin-missing");
    expect(appendOf(result)).toContain(COMPOUND_POLICY_NOTICE);
    expect(appendOf(result)).toContain("NOT enabled in this agent's Claude profile (/profiles/personal)");
    expect(onPluginMissing).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "claude-personal", configDir: "/profiles/personal" }),
    );
  });

  it("appends after the restriction notice and keeps the other provider options", async () => {
    const result = await router()(
      create("claude", {
        config: {
          provider: "claude",
          cwd: "/tmp/work",
          providerOptions: { appendSystemPrompt: "restriction notice", disallowedTools: ["Bash"] },
        },
      } as Partial<CreateAgentRequest>),
    );
    expect(appendOf(result)).toBe(`restriction notice\n\n${COMPOUND_POLICY_NOTICE}`);
    expect((result?.config.providerOptions as { disallowedTools?: string[] }).disallowedTools).toEqual(["Bash"]);
  });

  it("enforces on a child that explicitly declares the leader role", async () => {
    const result = await router()(create("claude-personal", { callerAgentId: "parent-1", labels: { [AGENT_ROLE_LABEL]: "leader" } }));
    expect(result?.labels?.[COMPOUND_POLICY_LABEL]).toBe("injected");
  });

  it("still covers a pooled leader when the provider entries cannot be read", async () => {
    const probe = vi.fn(probeEnabledFor("/home/op/.claude"));
    const result = await router({ providerEntries: async () => undefined, isPoolProvider: (id) => id === "claude-backup", probe })(
      create("claude-backup"),
    );
    expect(probe).toHaveBeenCalledWith("/home/op/.claude");
    expect(appendOf(result)).toBe(COMPOUND_POLICY_NOTICE);
  });
});

describe("compound policy router — passthrough", () => {
  it("leaves a spawned worker child untouched", async () => {
    expect(await router()(create("claude-personal", { callerAgentId: "parent-1" }))).toBeUndefined();
  });

  it("leaves a caller-less daemon job labelled as a worker untouched", async () => {
    expect(await router()(create("claude", { labels: { [AGENT_TYPE_LABEL]: "worker" } }))).toBeUndefined();
  });

  it("leaves a non-claude leader untouched, since appendSystemPrompt is a Claude option", async () => {
    const probe = vi.fn(probeEnabledFor());
    expect(await router({ probe })(create("codex"))).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it("never throws: a failing probe leaves the request as it arrived", async () => {
    const onError = vi.fn();
    const probe: CompoundPluginProbe = async () => {
      throw new Error("disk on fire");
    };
    expect(await router({ probe, onError })(create("claude"))).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("resolveClaudeConfigDir", () => {
  it("prefers the create's own env, then the entry, then what it extends, then the daemon, then ~/.claude", () => {
    expect(resolveClaudeConfigDir("claude-personal", ENTRIES, { CLAUDE_CONFIG_DIR: "/req" }, {}, "/h")).toBe("/req");
    expect(resolveClaudeConfigDir("claude-personal", ENTRIES, undefined, {}, "/h")).toBe("/profiles/personal");
    expect(resolveClaudeConfigDir("child", { child: { extends: "claude" }, ...ENTRIES }, undefined, {}, "/h")).toBe("/profiles/leader");
    expect(resolveClaudeConfigDir("bare", {}, undefined, { CLAUDE_CONFIG_DIR: "/daemon" }, "/h")).toBe("/daemon");
    expect(resolveClaudeConfigDir("bare", {}, undefined, {}, "/h")).toBe("/h/.claude");
  });

  it("stops on an extends cycle instead of looping", () => {
    const cyclic = { a: { extends: "b" }, b: { extends: "a" } };
    expect(resolveClaudeConfigDir("a", cyclic, undefined, {}, "/h")).toBe("/h/.claude");
  });
});

describe("probeCompoundPlugin", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function profile(settings: unknown, installed?: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "ce-probe-"));
    dirs.push(dir);
    writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
    if (installed !== undefined) {
      mkdirSync(join(dir, "plugins"));
      writeFileSync(join(dir, "plugins", "installed_plugins.json"), JSON.stringify(installed));
    }
    return dir;
  }

  const userInstall = { version: 2, plugins: { [CE_PLUGIN_ID]: [{ scope: "user", version: "3.19.0" }] } };

  it("is enabled when settings enable it and there is a user-scope install", async () => {
    expect(await probeCompoundPlugin(profile({ enabledPlugins: { [CE_PLUGIN_ID]: true } }, userInstall))).toEqual({ enabled: true });
  });

  it("is not enabled when settings.json has no enabledPlugins entry", async () => {
    const status = await probeCompoundPlugin(profile({ theme: "dark" }, userInstall));
    expect(status.enabled).toBe(false);
    expect(status.reason).toContain("does not enable");
  });

  it("does not count a project-scope install, which loads in one project only", async () => {
    const projectOnly = { version: 2, plugins: { [CE_PLUGIN_ID]: [{ scope: "project", projectPath: "/x" }] } };
    const status = await probeCompoundPlugin(profile({ enabledPlugins: { [CE_PLUGIN_ID]: true } }, projectOnly));
    expect(status).toEqual({ enabled: false, reason: `no user-scope install of ${CE_PLUGIN_ID}` });
  });

  it("is not enabled for a profile directory that does not exist", async () => {
    const status = await probeCompoundPlugin(join(tmpdir(), "no-such-claude-profile-xyz"));
    expect(status.enabled).toBe(false);
    expect(status.reason).toContain("settings.json unreadable");
  });
});
