import type { McpGatewaySessionMode } from "@getpaseo/protocol/messages";
import type { AgentSessionConfig, McpServerConfig } from "./agent-sdk-types.js";

const PASEO_MCP_SERVER_NAME = "paseo";
const PASEO_MCP_PATHNAME = "/mcp/agents";

export function stripInternalPaseoMcpServer(config: AgentSessionConfig): AgentSessionConfig {
  const mcpServers = config.mcpServers;
  if (!mcpServers) {
    return config;
  }

  const paseoServer = mcpServers[PASEO_MCP_SERVER_NAME];
  if (!paseoServer || !isInternalPaseoMcpServer(paseoServer)) {
    return config;
  }

  const nextMcpServers = { ...mcpServers };
  delete nextMcpServers[PASEO_MCP_SERVER_NAME];

  const next = { ...config };
  if (Object.keys(nextMcpServers).length > 0) {
    next.mcpServers = nextMcpServers;
  } else {
    delete next.mcpServers;
  }
  return next;
}

export function withRuntimePaseoMcpServer(params: {
  config: AgentSessionConfig;
  agentId: string;
  mcpBaseUrl: string | null;
  /**
   * Capability token authenticating the injected connection to the daemon's
   * Agent MCP endpoint. The daemon password is gated off this route, so without
   * this header the agent's MCP requests are rejected when a password is set.
   */
  mcpAuthToken: string | null;
}): AgentSessionConfig {
  const storedConfig = stripInternalPaseoMcpServer(params.config);
  if (!params.mcpBaseUrl || storedConfig.mcpServers?.[PASEO_MCP_SERVER_NAME]) {
    return storedConfig;
  }

  return {
    ...storedConfig,
    mcpServers: {
      [PASEO_MCP_SERVER_NAME]: {
        type: "http",
        url: `${params.mcpBaseUrl}?callerAgentId=${params.agentId}`,
        ...(params.mcpAuthToken
          ? { headers: { Authorization: `Bearer ${params.mcpAuthToken}` } }
          : {}),
      },
      ...storedConfig.mcpServers,
    },
  };
}

function isInternalPaseoMcpServer(config: McpServerConfig): boolean {
  if (config.type !== "http" && config.type !== "sse") {
    return false;
  }

  try {
    return new URL(config.url).pathname === PASEO_MCP_PATHNAME;
  } catch {
    return false;
  }
}

const MCP_GATEWAY_PATH_PREFIX = "/mcp/gateway/";

/**
 * The gateway servers an agent was spawned with, as a comma-separated list of
 * `mcpGateway.servers` names (`none` for an empty list). Written once at
 * create by a `before("agent.create")` hook (the account-pool plugin's
 * classifier) and read on every launch, so a resumed or reloaded agent gets
 * the same set it started with: connecting or dropping a server mid-session
 * rebuilds the prompt cache. Absent means every server. `claude.ai` in the
 * list keeps the account's claude.ai connectors (`claudeAiConnectorsInScope`).
 */
export const MCP_SCOPE_LABEL = "paseo.mcp-scope";

export function scopeMcpGatewayServerNames(
  serverNames: readonly string[],
  labels: Readonly<Record<string, string>> | undefined,
): string[] {
  const scope = labels?.[MCP_SCOPE_LABEL];
  if (scope === undefined) {
    return [...serverNames];
  }
  const granted = new Set(scope.split(",").map((name) => name.trim()));
  return serverNames.filter((name) => granted.has(name));
}

/** The scope entry naming the account's claude.ai connectors, which the CLI loads itself. */
const CLAUDE_AI_CONNECTORS_SCOPE = "claude.ai";

/** Whether the agent's recorded scope keeps the claude.ai connectors. No scope keeps them. */
export function claudeAiConnectorsInScope(
  labels: Readonly<Record<string, string>> | undefined,
): boolean {
  const scope = labels?.[MCP_SCOPE_LABEL];
  if (scope === undefined) {
    return true;
  }
  return scope.split(",").some((name) => name.trim() === CLAUDE_AI_CONNECTORS_SCOPE);
}

/**
 * Strips brokered MCP gateway entries (KTD1) and the runtime-only `mcpGatewayEnabled` /
 * `mcpGatewaySessionMode` signals (KTD6), plus `claudeAiConnectorsDisabled`, from a config before it's persisted — mirrors
 * `stripInternalPaseoMcpServer`. Entries are identified by URL pathname prefix rather than by
 * name, since brokered server names come from the operator's `mcpGateway.servers` config
 * (KTD9), not a fixed identifier.
 */
export function stripMcpGatewayServers(config: AgentSessionConfig): AgentSessionConfig {
  const next = { ...config };
  delete next.mcpGatewayEnabled;
  delete next.mcpGatewaySessionMode;
  delete next.claudeAiConnectorsDisabled;

  const mcpServers = next.mcpServers;
  if (!mcpServers) {
    return next;
  }

  const remainingEntries = Object.entries(mcpServers).filter(
    ([, serverConfig]) => !isMcpGatewayServer(serverConfig),
  );
  if (remainingEntries.length === Object.keys(mcpServers).length) {
    return next;
  }

  if (remainingEntries.length > 0) {
    next.mcpServers = Object.fromEntries(remainingEntries);
  } else {
    delete next.mcpServers;
  }
  return next;
}

/**
 * Gateway sibling of `withRuntimePaseoMcpServer` (KTD1, KTD6): injects one brokered `http` MCP
 * entry per configured gateway server name, pointed at this daemon's `/mcp/gateway/<name>`
 * route and authenticated with the gateway's own distinct capability token — never the
 * `/mcp/agents` token (KTD1). Per-launch only: like the paseo entry, stored config always wins
 * on name collision, and nothing here is ever persisted (`stripMcpGatewayServers` above).
 *
 * No-ops byte-identically (R10) when disabled or when the daemon's own reachable base URL isn't
 * known yet (mirrors `withRuntimePaseoMcpServer`'s `mcpBaseUrl` null-check) — callers gate
 * `enabled` on both the gateway's config flag and the session's provider (v1 targets the Claude
 * adapter only; see Scope Boundaries in the MCP auth gateway plan).
 */
export function withRuntimeMcpGatewayServers(params: {
  config: AgentSessionConfig;
  enabled: boolean;
  /** The daemon's own reachable base URL (no path), or null before the daemon is listening. */
  gatewayBaseUrl: string | null;
  /** Names of the servers currently configured on the gateway (KTD9). */
  serverNames: readonly string[];
  /** The distinct gateway capability token (KTD1). */
  gatewayAuthToken: string | null;
  /** `McpGateway.sessionMode`; defaults to overlay (docs/mcp-gateway.md "Session injection"). */
  sessionMode?: McpGatewaySessionMode;
}): AgentSessionConfig {
  const storedConfig = stripMcpGatewayServers(params.config);
  if (!params.enabled || !params.gatewayBaseUrl) {
    return storedConfig;
  }

  const brokeredServers: Record<string, McpServerConfig> = {};
  for (const name of params.serverNames) {
    brokeredServers[name] = {
      type: "http",
      url: `${params.gatewayBaseUrl}${MCP_GATEWAY_PATH_PREFIX}${name}`,
      ...(params.gatewayAuthToken
        ? { headers: { Authorization: `Bearer ${params.gatewayAuthToken}` } }
        : {}),
    };
  }

  const mergedMcpServers = { ...brokeredServers, ...storedConfig.mcpServers };
  return {
    ...storedConfig,
    mcpGatewayEnabled: true,
    mcpGatewaySessionMode: params.sessionMode ?? "overlay",
    ...(Object.keys(mergedMcpServers).length > 0 ? { mcpServers: mergedMcpServers } : {}),
  };
}

function isMcpGatewayServer(config: McpServerConfig): boolean {
  if (config.type !== "http" && config.type !== "sse") {
    return false;
  }

  try {
    return new URL(config.url).pathname.startsWith(MCP_GATEWAY_PATH_PREFIX);
  } catch {
    return false;
  }
}
