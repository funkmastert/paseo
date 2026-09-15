import { readFileSync } from "node:fs";
import path from "node:path";

import type { McpServerConfig, McpStdioServerConfig } from "../agent/agent-sdk-types.js";

interface LoggerLike {
  warn(...args: unknown[]): void;
}

export interface ReadPerDirStdioMcpServersOptions {
  /** The session's resolved Claude config dir (`resolveClaudeConfigDir`'s result, KTD5). */
  configDir: string;
  /** The session's project directory — read for a project-level `.mcp.json`. */
  projectDir: string;
  logger?: LoggerLike;
}

const GLOBAL_CONFIG_FILENAME = ".claude.json";
const PROJECT_CONFIG_FILENAME = ".mcp.json";

// Matches Claude Code's own `.mcp.json`/`.claude.json` env-var expansion syntax: `${VAR}` and
// `${VAR:-default}`.
const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g;

/**
 * Expands `${VAR}`/`${VAR:-default}` references against the daemon's own process env. Native
 * `settingSources` loading (the CLI's own file parsing) performs this expansion as part of
 * reading `.mcp.json`/`.claude.json` from disk; the SDK's programmatic `mcpServers` option does
 * not repeat it for already-parsed objects. Without doing it here, a re-injected entry using
 * this syntax would diverge from native spawn semantics (an unexpanded literal string instead
 * of the resolved value) — the parity this module exists to preserve.
 */
function expandEnvVars(value: string): string {
  return value.replace(ENV_VAR_PATTERN, (_match, name: string, _group, fallback?: string) => {
    const resolved = process.env[name];
    return resolved !== undefined ? resolved : (fallback ?? "");
  });
}

function expandStdioEntry(entry: McpStdioServerConfig): McpStdioServerConfig {
  const expanded: McpStdioServerConfig = {
    type: "stdio",
    command: expandEnvVars(entry.command),
  };
  if (entry.args) {
    expanded.args = entry.args.map(expandEnvVars);
  }
  if (entry.env) {
    expanded.env = Object.fromEntries(
      Object.entries(entry.env).map(([key, value]) => [key, expandEnvVars(value)]),
    );
  }
  if (entry.alwaysLoad !== undefined) {
    expanded.alwaysLoad = entry.alwaysLoad;
  }
  return expanded;
}

function isStdioEntry(value: unknown): value is McpStdioServerConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== undefined && record.type !== "stdio") {
    return false;
  }
  return typeof record.command === "string";
}

/** Only `stdio` entries — remote (`http`/`sse`) per-dir entries are the gateway's job (KTD1). */
function extractStdioServers(mcpServers: unknown): Record<string, McpStdioServerConfig> {
  if (typeof mcpServers !== "object" || mcpServers === null) {
    return {};
  }
  const result: Record<string, McpStdioServerConfig> = {};
  for (const [name, value] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (isStdioEntry(value)) {
      result[name] = expandStdioEntry(value);
    }
  }
  return result;
}

function readJsonFile(filePath: string, logger?: LoggerLike): unknown {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger?.warn(
        { err: error, filePath },
        "Failed to read MCP config file for per-dir stdio re-injection",
      );
    }
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    logger?.warn(
      { err: error, filePath },
      "Failed to parse MCP config file for per-dir stdio re-injection",
    );
    return null;
  }
}

function readMcpServersField(parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  return (parsed as Record<string, unknown>).mcpServers;
}

export interface PerDirRemoteMcpServer {
  url: string;
  transport: "http" | "sse";
  headers?: Record<string, string>;
}

function resolveRemoteTransport(type: unknown): PerDirRemoteMcpServer["transport"] | undefined {
  if (type === "sse") {
    return "sse";
  }
  if (type === "http" || type === undefined) {
    return "http";
  }
  return undefined;
}

function toRemoteEntry(value: unknown): PerDirRemoteMcpServer | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.url !== "string" || record.url.length === 0) {
    return undefined;
  }
  // Claude Code's per-dir remote entries are `type: "http" | "sse"`; a missing type with a url
  // is treated as http, matching the CLI.
  const transport = resolveRemoteTransport(record.type);
  if (!transport) {
    return undefined;
  }
  const rawHeaders =
    typeof record.headers === "object" && record.headers !== null
      ? (record.headers as Record<string, unknown>)
      : {};
  const headers = Object.fromEntries(
    Object.entries(rawHeaders)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, headerValue]) => [key, expandEnvVars(headerValue)]),
  );
  return {
    url: expandEnvVars(record.url),
    transport,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

function readLocalScopeMcpServersField(parsed: unknown, projectDir: string): unknown {
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const projects = (parsed as Record<string, unknown>).projects;
  if (typeof projects !== "object" || projects === null) {
    return undefined;
  }
  const entry = (projects as Record<string, unknown>)[projectDir];
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  return (entry as Record<string, unknown>).mcpServers;
}

/**
 * Finds one remote (http/sse) MCP definition the way the CLI resolves it for a session in
 * `projectDir`: the project's `.mcp.json`, then the config dir's local scope
 * (`projects[projectDir].mcpServers` in `.claude.json`), then its user scope. Powers the
 * gateway's adopt action (docs/mcp-gateway.md); stdio entries are never adoptable and are
 * skipped. `${VAR}` expansion applies to the url and header values, as for stdio entries.
 */
export function readPerDirRemoteMcpServer(
  options: ReadPerDirStdioMcpServersOptions & { name: string },
): PerDirRemoteMcpServer | undefined {
  const globalConfig = readJsonFile(
    path.join(options.configDir, GLOBAL_CONFIG_FILENAME),
    options.logger,
  );
  const projectConfig = readJsonFile(
    path.join(options.projectDir, PROJECT_CONFIG_FILENAME),
    options.logger,
  );
  const scopes = [
    readMcpServersField(projectConfig),
    readLocalScopeMcpServersField(globalConfig, options.projectDir),
    readMcpServersField(globalConfig),
  ];
  for (const mcpServers of scopes) {
    if (typeof mcpServers !== "object" || mcpServers === null) {
      continue;
    }
    const entry = toRemoteEntry((mcpServers as Record<string, unknown>)[options.name]);
    if (entry) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Re-reads the stdio MCP server entries that would otherwise load natively via
 * `settingSources` (KTD5), for re-injection alongside brokered gateway servers once
 * `strictMcpConfig` suppresses per-dir loading. Reads two sources verbatim — never
 * transformed beyond the env-var expansion above:
 *  - the global `<configDir>/.claude.json`'s top-level `mcpServers`
 *  - the project's `<projectDir>/.mcp.json`'s `mcpServers`
 *
 * Project entries win over global entries on name collision, matching the settings-hierarchy
 * convention elsewhere (project overrides user). Fails open to `{}` on a missing or malformed
 * file — a broken stdio config must never break the rest of the session.
 */
export function readPerDirStdioMcpServers(
  options: ReadPerDirStdioMcpServersOptions,
): Record<string, McpServerConfig> {
  const globalConfig = readJsonFile(
    path.join(options.configDir, GLOBAL_CONFIG_FILENAME),
    options.logger,
  );
  const projectConfig = readJsonFile(
    path.join(options.projectDir, PROJECT_CONFIG_FILENAME),
    options.logger,
  );

  return {
    ...extractStdioServers(readMcpServersField(globalConfig)),
    ...extractStdioServers(readMcpServersField(projectConfig)),
  };
}
