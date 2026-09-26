import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { DoctorContext } from "../context.js";
import { resolveAccountSlots } from "../accounts.js";
import { realpathOrNull } from "../helpers.js";

/**
 * What the token audit reads from Claude Code's own configuration: every settings layer that
 * applies to an account, the environment an agent process really runs with, and which directories
 * to audit. Everything here is read-only and redacts secrets before anything reaches a row.
 */

export type SettingsScope = "managed" | "user" | "user-local" | "project" | "project-local";

export interface SettingsLayer {
  scope: SettingsScope;
  path: string;
  data: Record<string, unknown>;
}

export interface SettingsRead {
  layers: SettingsLayer[];
  /** Files that exist but are not a JSON object. A layer Claude Code would also fail to read. */
  unreadable: Array<{ path: string; reason: string }>;
}

/** `PASEO_TOKEN_AUDIT_MANAGED_SETTINGS` exists so tests do not read the real machine's file. */
export function managedSettingsPath(ctx: DoctorContext): string {
  const override = ctx.env["PASEO_TOKEN_AUDIT_MANAGED_SETTINGS"];
  if (override) return override;
  if (ctx.platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  if (ctx.platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

function readJsonObject(
  file: string,
): { data: Record<string, unknown> } | { error: string } | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? null
      : { error: (error as Error).message };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: "not a JSON object" };
    }
    return { data: parsed as Record<string, unknown> };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** Lowest precedence first: managed settings win over everything, project over user. */
export function readSettingsLayers(
  ctx: DoctorContext,
  input: { configDir: string; cwd?: string },
): SettingsRead {
  const candidates: Array<{ scope: SettingsScope; path: string }> = [
    { scope: "user", path: path.join(input.configDir, "settings.json") },
    { scope: "user-local", path: path.join(input.configDir, "settings.local.json") },
    ...(input.cwd
      ? [
          { scope: "project" as const, path: path.join(input.cwd, ".claude", "settings.json") },
          {
            scope: "project-local" as const,
            path: path.join(input.cwd, ".claude", "settings.local.json"),
          },
        ]
      : []),
    { scope: "managed", path: managedSettingsPath(ctx) },
  ];
  const layers: SettingsLayer[] = [];
  const unreadable: SettingsRead["unreadable"] = [];
  for (const candidate of candidates) {
    const result = readJsonObject(candidate.path);
    if (!result) continue;
    if ("error" in result) unreadable.push({ path: candidate.path, reason: result.error });
    else layers.push({ ...candidate, data: result.data });
  }
  return { layers, unreadable };
}

// ---- secrets ---------------------------------------------------------------------------------

const SECRET_NAME = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE/i;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** Scheme and host only: a base URL can carry credentials in its userinfo, path or query. */
export function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "<set, not a URL>";
  }
}

/**
 * Names that route requests through something other than the direct Anthropic API. Any of them
 * can turn tool deferral off: the client cannot know the far end supports it.
 */
const GATEWAY_NAME =
  /^(ANTHROPIC_(BASE_URL|AUTH_TOKEN|BEDROCK_BASE_URL|VERTEX_BASE_URL|FOUNDRY_BASE_URL)|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)|(HTTPS?|ALL)_PROXY|NODE_EXTRA_CA_CERTS)$|GATEWAY/i;

export function isGatewayName(name: string): boolean {
  return GATEWAY_NAME.test(name);
}

/** The value as it may appear in a row: secrets are `<redacted>`, base URLs lose everything but the host. */
export function displayEnvValue(name: string, value: string): string {
  if (isSecretName(name)) return "<redacted>";
  if (/URL$/i.test(name) || /PROXY$/i.test(name)) return sanitizeUrl(value);
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}

/** Env names a layer sets, with the value only when it is safe and interesting. */
export function envEntriesOf(
  data: Record<string, unknown>,
): Array<{ name: string; display: string }> {
  const env = data["env"];
  if (typeof env !== "object" || env === null) return [];
  return Object.entries(env as Record<string, unknown>).map(([name, value]) => ({
    name,
    display: typeof value === "string" ? displayEnvValue(name, value) : "<non-string>",
  }));
}

// ---- accounts and directories ----------------------------------------------------------------

export interface AuditAccount {
  configDir: string;
  providers: string[];
  /** The provider entry's own `env`, from `config.json` (agents.providers.<id>.env). */
  providerEnv: Array<{ name: string; display: string }>;
}

function providerEnvOf(
  ctx: DoctorContext,
  providerId: string,
): Array<{ name: string; display: string }> {
  const agents = ctx.rawConfig?.["agents"] as Record<string, unknown> | undefined;
  const providers = (agents?.["providers"] ?? ctx.rawConfig?.["providers"]) as
    | Record<string, Record<string, unknown>>
    | undefined;
  const env = providers?.[providerId]?.["env"];
  if (typeof env !== "object" || env === null) return [];
  return Object.entries(env as Record<string, unknown>).map(([name, value]) => ({
    name,
    display: typeof value === "string" ? displayEnvValue(name, value) : "<non-string>",
  }));
}

/** The Claude config dirs in the pool, one per distinct dir; symlinked dirs count once. */
export function auditAccounts(ctx: DoctorContext): AuditAccount[] {
  const seen = new Set<string>();
  const out: AuditAccount[] = [];
  for (const slot of resolveAccountSlots(ctx)) {
    const real = realpathOrNull(slot.configDir) ?? slot.configDir;
    if (seen.has(real)) continue;
    seen.add(real);
    out.push({
      configDir: slot.configDir,
      providers: slot.providers.map((p) => p.id),
      providerEnv: slot.providers.flatMap((p) => providerEnvOf(ctx, p.id)),
    });
  }
  return out;
}

export function tokenAuditConfig(ctx: DoctorContext): Record<string, unknown> {
  const agents = ctx.rawConfig?.["agents"] as Record<string, unknown> | undefined;
  const audit = agents?.["tokenAudit"];
  return typeof audit === "object" && audit !== null ? (audit as Record<string, unknown>) : {};
}

/** The shared transcripts directory: every account's `projects/` resolves here. */
export function sharedProjectsDir(ctx: DoctorContext): string | null {
  return realpathOrNull(path.join(ctx.home, ".claude", "projects"));
}

interface SessionFile {
  file: string;
  mtimeMs: number;
}

/** Top-level session transcripts, newest first. Sub-agent transcripts nest deeper and are skipped. */
export function newestSessionFiles(ctx: DoctorContext, limit: number): SessionFile[] {
  const root = sharedProjectsDir(ctx);
  if (!root) return [];
  const found: SessionFile[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(path.join(root, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(root, dir, name);
      try {
        found.push({ file, mtimeMs: statSync(file).mtimeMs });
      } catch {
        // Raced with a deletion.
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

/** The `cwd` a transcript recorded, from its first 64 KB. */
export function transcriptCwd(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(65_536);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buffer.toString("utf8", 0, read));
    return match ? (JSON.parse(`"${match[1]}"`) as string) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Directories to audit: `agents.tokenAudit.cwds` when set, else the cwds of the newest sessions
 * that still exist. A project's own CLAUDE.md, settings and agents only apply from its cwd.
 */
export function auditCwds(ctx: DoctorContext, limit = 3): string[] {
  const configured = tokenAuditConfig(ctx)["cwds"];
  if (Array.isArray(configured)) {
    return configured.filter((c): c is string => typeof c === "string").slice(0, limit);
  }
  const cwds: string[] = [];
  for (const { file } of newestSessionFiles(ctx, 40)) {
    const cwd = transcriptCwd(file);
    if (cwd && existsSync(cwd) && !cwds.includes(cwd)) cwds.push(cwd);
    if (cwds.length >= limit) break;
  }
  return cwds;
}

// ---- running agent processes -----------------------------------------------------------------

export interface AgentProcess {
  pid: number;
  model: string | null;
  effort: string | null;
  thinking: string | null;
  fallbackModel: string | null;
  /** Env names of interest found on the process, values already redacted. */
  env: Array<{ name: string; display: string }>;
  configDir: string | null;
}

const ENV_OF_INTEREST =
  /^(ANTHROPIC_[A-Z_]+|CLAUDE_CODE_[A-Z_]+|CLAUDE_CONFIG_DIR|ENABLE_TOOL_SEARCH|DISABLE_[A-Z_]+|MAX_THINKING_TOKENS|(HTTPS?|ALL)_PROXY|[A-Z_]*GATEWAY[A-Z_]*)$/i;

function flag(command: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)--${name}[ =]([^\\s]+)`).exec(command);
  return match ? (match[1] as string) : null;
}

export function parseAgentProcess(pid: number, command: string, envLine: string): AgentProcess {
  // The system prompt and MCP config sit at the end and can contain text that looks like flags.
  const cut = command.search(/\s--(append-system-prompt|mcp-config)\b/);
  const args = cut === -1 ? command : command.slice(0, cut);
  const env: AgentProcess["env"] = [];
  const seen = new Set<string>();
  for (const match of envLine.matchAll(/(?:^|\s)([A-Z][A-Z0-9_]*)=(\S*)/g)) {
    const name = match[1] as string;
    if (!ENV_OF_INTEREST.test(name) || seen.has(name)) continue;
    seen.add(name);
    env.push({ name, display: displayEnvValue(name, match[2] ?? "") });
  }
  const dir = /(?:^|\s)CLAUDE_CONFIG_DIR=(\S+)/.exec(envLine);
  return {
    pid,
    model: flag(args, "model"),
    effort: flag(args, "effort"),
    thinking: flag(args, "thinking"),
    fallbackModel: flag(args, "fallback-model"),
    env,
    configDir: dir ? (dir[1] as string) : null,
  };
}

/**
 * The `claude` processes an agent runs (Paseo launches `claude --output-format stream-json`),
 * with the env each one really has. macOS only: `ps eww` is where the env is readable. Null when
 * the probe cannot run, never an empty list standing in for "could not look".
 */
export async function readAgentProcesses(ctx: DoctorContext): Promise<AgentProcess[] | null> {
  if (ctx.platform !== "darwin") return null;
  const listing = await ctx.probes.exec("ps", ["-axww", "-o", "pid=,command="], {
    timeoutMs: 10_000,
  });
  if (!listing || listing.code !== 0) return null;
  const pids = listing.stdout
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      return match && /--output-format stream-json/.test(match[2] as string)
        ? [{ pid: Number(match[1]), command: match[2] as string }]
        : [];
    })
    .slice(0, 60);
  const out: AgentProcess[] = [];
  for (const { pid, command } of pids) {
    const env = await ctx.probes.exec("ps", ["eww", "-ww", "-p", String(pid), "-o", "command="], {
      timeoutMs: 5_000,
    });
    out.push(parseAgentProcess(pid, command, env?.stdout ?? ""));
  }
  return out;
}
