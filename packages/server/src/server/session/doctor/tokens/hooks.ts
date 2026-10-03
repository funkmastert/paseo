import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { DoctorContext } from "../context.js";
import { expandPathLike, realpathOrNull } from "../helpers.js";
import { auditAccounts, auditCwds, readSettingsLayers } from "./settings.js";
import { row, type TokenAuditCheck, type TokenAuditRow } from "./types.js";

/** A hook script that emits `updatedInput` rewrites the tool call before it runs. */
const REWRITES_INPUT = /updatedInput|\brtk\b/;
const SCRIPT_READ_BYTES = 64 * 1024;

export interface HookCommand {
  event: string;
  matcher: string;
  command: string;
  /** The settings file or plugin `hooks.json` it came from. */
  source: string;
  /** The plugin's install dir, which `${CLAUDE_PLUGIN_ROOT}` in the command stands for. */
  pluginRoot?: string;
}

interface RawMatcherGroup {
  matcher?: unknown;
  hooks?: Array<{ type?: unknown; command?: unknown }>;
}

/** Every command hook in a `hooks` object (settings.json and a plugin's hooks.json share the shape). */
export function commandHooksOf(hooks: unknown, source: string, pluginRoot?: string): HookCommand[] {
  if (typeof hooks !== "object" || hooks === null) return [];
  const out: HookCommand[] = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups as RawMatcherGroup[]) {
      for (const hook of group.hooks ?? []) {
        if (typeof hook.command !== "string") continue;
        out.push({
          event,
          matcher: typeof group.matcher === "string" ? group.matcher : "",
          command: hook.command,
          source,
          ...(pluginRoot ? { pluginRoot } : {}),
        });
      }
    }
  }
  return out;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

interface InstalledPlugin {
  id: string;
  installPath: string;
}

function installedPlugins(configDir: string): InstalledPlugin[] {
  const parsed = readJson(path.join(configDir, "plugins", "installed_plugins.json")) as {
    plugins?: Record<string, Array<{ installPath?: unknown }>>;
  } | null;
  const out: InstalledPlugin[] = [];
  for (const [id, installs] of Object.entries(parsed?.plugins ?? {})) {
    for (const install of installs) {
      if (typeof install.installPath === "string")
        out.push({ id, installPath: install.installPath });
    }
  }
  return out;
}

/** Whether the script a hook runs contains a rewrite. Null when no script could be read. */
export function hookRewrites(
  ctx: Pick<DoctorContext, "home" | "env">,
  hook: Pick<HookCommand, "command">,
  pluginRoot?: string,
): boolean | null {
  const expanded = expandPathLike(
    hook.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot ?? ""),
    ctx.home,
    ctx.env,
  );
  let readAny = false;
  if (REWRITES_INPUT.test(hook.command)) return true;
  for (const token of expanded.split(/\s+/)) {
    const cleaned = token.replace(/^["']|["']$/g, "");
    if (!path.isAbsolute(cleaned) || !existsSync(cleaned) || !statSync(cleaned).isFile()) continue;
    try {
      const text = readFileSync(cleaned, "utf8").slice(0, SCRIPT_READ_BYTES);
      readAny = true;
      if (REWRITES_INPUT.test(text)) return true;
    } catch {
      // Unreadable script: falls through to null below.
    }
  }
  return readAny ? false : null;
}

export const hooksCheck: TokenAuditCheck = {
  id: "tokens.hooks",
  item: "hooks",
  timeoutMs: 30_000,
  async measure(ctx) {
    const rows: TokenAuditRow[] = [];
    const cwds = auditCwds(ctx);
    const seenDirs = new Set<string>();
    let preToolTotal = 0;
    let rewritingTotal = 0;
    const examined: string[] = [];
    const evidencePer: string[] = [];

    for (const account of auditAccounts(ctx)) {
      const real = realpathOrNull(account.configDir) ?? account.configDir;
      if (seenDirs.has(real)) continue;
      seenDirs.add(real);
      const hooks: HookCommand[] = [];
      for (const dir of [undefined, ...cwds]) {
        for (const layer of readSettingsLayers(ctx, { configDir: account.configDir, cwd: dir })
          .layers) {
          // The user and managed layers repeat for every cwd; count each file once.
          if (examined.includes(layer.path)) continue;
          examined.push(layer.path);
          hooks.push(...commandHooksOf(layer.data["hooks"], layer.path));
        }
      }
      for (const plugin of installedPlugins(account.configDir)) {
        const file = path.join(plugin.installPath, "hooks", "hooks.json");
        if (examined.includes(file)) continue;
        examined.push(file);
        const data = readJson(file) as { hooks?: unknown } | null;
        hooks.push(...commandHooksOf(data?.hooks, file, plugin.installPath));
      }
      const preTool = hooks.filter((hook) => hook.event === "PreToolUse");
      const rewriting = preTool.filter((hook) => hookRewrites(ctx, hook, hook.pluginRoot) === true);
      const unreadable = preTool.filter(
        (hook) => hookRewrites(ctx, hook, hook.pluginRoot) === null,
      );
      preToolTotal += preTool.length;
      rewritingTotal += rewriting.length;
      const events = [...new Set(hooks.map((hook) => hook.event))].join(", ") || "none";
      evidencePer.push(
        `${account.configDir}: ${preTool.length} PreToolUse hooks (${rewriting.length} rewrite input, ${unreadable.length} script unreadable); events with hooks: ${events}`,
      );
    }

    if (rewritingTotal > 0) {
      rows.push(
        row(
          "hooks",
          "hooks:pretooluse-rewrite",
          "GREEN",
          `${rewritingTotal} PreToolUse hooks rewrite tool input`,
          evidencePer.join(" | "),
          "noisy command output is trimmed before it enters the context",
          { "hooks.rewriting": rewritingTotal },
        ),
      );
    } else {
      rows.push(
        row(
          "hooks",
          "hooks:pretooluse-rewrite",
          "AMBER",
          preToolTotal === 0
            ? "No PreToolUse hook exists to rewrite noisy commands"
            : `${preToolTotal} PreToolUse hooks, none rewrite tool input`,
          `${evidencePer.join(" | ") || "no account directory"}; looked for updatedInput or rtk in ${examined.length} settings and plugin hook files`,
          "full build, test and git output enters the context and is re-read from cache on every later turn",
          { "hooks.rewriting": 0 },
        ),
      );
    }
    return rows;
  },
};
