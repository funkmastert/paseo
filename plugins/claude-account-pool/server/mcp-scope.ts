import { MCP_LABEL, type RoleRecord } from "../shared/role-policy-schema";

/**
 * The MCP half of the tools decision: which of the daemon's MCP gateway
 * servers an agent is spawned with, and whether it keeps the account's
 * claude.ai connectors. Called only from `classifyAgent`
 * (server/classifier.ts), whose principles apply here unchanged.
 *
 * A root keeps everything. A child gets the servers marked `critical` in
 * `mcpGateway`, plus whatever `paseo.mcp`, its role's `mcpServers`, or its
 * title/prompt ask for. Explicit and inferred requests only ever ADD, so a
 * wrong inference costs tokens, never a capability. Paseo's own MCP server is
 * injected separately and is never scoped.
 *
 * Decided at spawn only. The router records the set in `paseo.mcp-scope`
 * and the daemon replays it on every launch, because connecting or
 * dropping a server mid-session rebuilds the prompt cache.
 */

/** Names the account's claude.ai connectors (Claude Docs, Google Drive, …) in `paseo.mcp` and a role's `mcpServers`. */
export const CLAUDE_AI_CONNECTORS = "claude.ai";
/** `paseo.mcp=all`: every server, as a root gets. */
const ALL_SERVERS = "all";
/** Paseo's own MCP server, always injected, so naming it asks for nothing. */
const PASEO_SERVER = "paseo";
/** What `paseo.mcp-scope` holds when a child gets no gateway server at all. */
const EMPTY_SCOPE = "none";

/** Text that means the claude.ai connectors: their server-name prefix, and the ones an account typically has. */
const CLAUDE_AI_TEXT_RE = /mcp__claude_ai_|\bclaude docs\b|\bgoogle drive\b/i;

export interface McpGatewayServerInfo {
  name: string;
  critical: boolean;
}

/** The daemon's `mcpGateway` servers as the classifier sees them. A disabled gateway has none. */
export interface McpGatewaySnapshot {
  servers: readonly McpGatewayServerInfo[];
}

export type McpGrantSource = "declared" | "role" | "critical" | "inferred";

export interface McpDecision {
  /** False keeps every server and the connectors, the behaviour before scoping. */
  scoped: boolean;
  /** Gateway servers the agent gets, in config order. Every one when not scoped. */
  gatewayServers: string[];
  /** Gateway servers left out. */
  withheldServers: string[];
  claudeAiConnectors: boolean;
  /** Each granted server, in config order, with the strongest reason it is there: declared, role, critical, inferred. */
  grants: { server: string; source: McpGrantSource }[];
  /** Names in `paseo.mcp` that are no gateway server. Never blocks. */
  unknownDeclaredValues?: string[];
  reason: string;
}

export interface McpDecisionInput {
  hasCaller: boolean;
  labels?: Record<string, string>;
  title?: string | null;
  initialPrompt?: string;
}

function splitNames(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `name` appears as a whole word. Hyphens count as part of a word, so
 * `github-actions` does not name `github`; underscores do not, so
 * `mcp__linear__search` names `linear`.
 */
function textNames(text: string, name: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(name)}(?![A-Za-z0-9-])`, "i").test(text);
}

function everything(
  gateway: McpGatewaySnapshot | undefined,
  reason: string,
  unknownDeclaredValues: string[] | undefined,
): McpDecision {
  return {
    scoped: false,
    gatewayServers: gateway ? gateway.servers.map((server) => server.name) : [],
    withheldServers: [],
    claudeAiConnectors: true,
    grants: [],
    ...(unknownDeclaredValues ? { unknownDeclaredValues } : {}),
    reason,
  };
}

function unknownNote(unknown: readonly string[]): string {
  if (unknown.length === 0) {
    return "";
  }
  const names = unknown.map((name) => `"${name}"`).join(", ");
  return ` ${MCP_LABEL} named ${names}, which no gateway server is called, so ${unknown.length === 1 ? "it was" : "they were"} ignored rather than blocking the create.`;
}

const SOURCE_PHRASE: Record<McpGrantSource, string> = {
  declared: `asked for by ${MCP_LABEL}`,
  role: "added by the role",
  critical: "critical",
  inferred: "named in the title/prompt",
};

function describeScoped(decision: Omit<McpDecision, "reason">, roleName: string): string {
  const bySource = (source: McpGrantSource) =>
    decision.grants.filter((grant) => grant.source === source).map((grant) => grant.server);
  const parts = (["declared", "role", "critical", "inferred"] as const)
    .map((source) => {
      const servers = bySource(source);
      return servers.length > 0 ? `${servers.join(", ")} (${SOURCE_PHRASE[source]}${source === "role" ? ` ${roleName}` : ""})` : "";
    })
    .filter((part) => part.length > 0);
  const granted = parts.length > 0 ? parts.join("; ") : "no gateway server";
  const withheld =
    decision.withheldServers.length > 0 ? ` Left out: ${decision.withheldServers.join(", ")}.` : "";
  const connectors = decision.claudeAiConnectors ? "" : " The account's claude.ai connectors are off.";
  return `A child gets Paseo's own tools plus ${granted}.${withheld}${connectors} Set ${MCP_LABEL} to add servers.${unknownNote(decision.unknownDeclaredValues ?? [])}`;
}

export function decideMcp(
  input: McpDecisionInput,
  gateway: McpGatewaySnapshot | undefined,
  role: RoleRecord,
): McpDecision {
  const declared = splitNames(input.labels?.[MCP_LABEL]);
  const gatewayNames = new Set(gateway?.servers.map((server) => server.name) ?? []);
  const unknown = declared.filter(
    (name) =>
      name !== ALL_SERVERS && name !== PASEO_SERVER && name !== CLAUDE_AI_CONNECTORS && !gatewayNames.has(name),
  );
  const unknownDeclaredValues = unknown.length > 0 ? unknown : undefined;

  if (!input.hasCaller) {
    return everything(
      gateway,
      "Every MCP server: this create has no calling agent, and a root keeps everything.",
      unknownDeclaredValues,
    );
  }
  if (!gateway) {
    return everything(
      gateway,
      "Every MCP server: the daemon's mcpGateway config could not be read, so nothing was scoped.",
      unknownDeclaredValues,
    );
  }
  if (declared.includes(ALL_SERVERS)) {
    return everything(
      gateway,
      `Every MCP server: ${MCP_LABEL}=${ALL_SERVERS} asked for all of them.${unknownNote(unknown)}`,
      unknownDeclaredValues,
    );
  }

  const roleNames = role.mcpServers ?? [];
  const text = [input.title ?? "", input.initialPrompt ?? ""].join("\n");
  const sourceOf = (server: McpGatewayServerInfo): McpGrantSource | undefined => {
    if (declared.includes(server.name)) return "declared";
    if (roleNames.includes(server.name)) return "role";
    if (server.critical) return "critical";
    if (textNames(text, server.name)) return "inferred";
    return undefined;
  };

  const grants: McpDecision["grants"] = [];
  const withheldServers: string[] = [];
  for (const server of gateway.servers) {
    const source = sourceOf(server);
    if (source) {
      grants.push({ server: server.name, source });
    } else {
      withheldServers.push(server.name);
    }
  }

  const connectorSource: McpGrantSource | undefined = declared.includes(CLAUDE_AI_CONNECTORS)
    ? "declared"
    : roleNames.includes(CLAUDE_AI_CONNECTORS)
      ? "role"
      : CLAUDE_AI_TEXT_RE.test(text)
        ? "inferred"
        : undefined;
  if (connectorSource) {
    grants.push({ server: CLAUDE_AI_CONNECTORS, source: connectorSource });
  }

  const partial = {
    scoped: true,
    gatewayServers: grants.filter((grant) => grant.server !== CLAUDE_AI_CONNECTORS).map((grant) => grant.server),
    withheldServers,
    claudeAiConnectors: connectorSource !== undefined,
    grants,
    ...(unknownDeclaredValues ? { unknownDeclaredValues } : {}),
  };
  return { ...partial, reason: describeScoped(partial, role.name) };
}

/**
 * The `paseo.mcp-scope` value recording this decision, or undefined when the
 * agent keeps everything and must carry no scope label at all.
 */
export function mcpScopeLabelValue(decision: McpDecision): string | undefined {
  if (!decision.scoped) {
    return undefined;
  }
  const names = [...decision.gatewayServers, ...(decision.claudeAiConnectors ? [CLAUDE_AI_CONNECTORS] : [])];
  return names.length > 0 ? names.join(",") : EMPTY_SCOPE;
}

function objectKeys(value: unknown): string[] {
  return typeof value === "object" && value !== null ? Object.keys(value) : [];
}

function isCritical(entry: unknown): boolean {
  return typeof entry === "object" && entry !== null && (entry as { critical?: unknown }).critical === true;
}

/**
 * The gateway's servers from the daemon config, remote then local, the way
 * the daemon registers them: a name in both keeps the remote entry. A
 * disabled or absent gateway brokers nothing.
 */
export function readMcpGatewaySnapshot(config: Record<string, unknown>): McpGatewaySnapshot {
  const gateway = config.mcpGateway as
    | { enabled?: unknown; servers?: Record<string, unknown>; localServers?: Record<string, unknown> }
    | undefined;
  if (!gateway || gateway.enabled !== true) {
    return { servers: [] };
  }
  const servers: McpGatewayServerInfo[] = [];
  const seen = new Set<string>();
  for (const map of [gateway.servers, gateway.localServers]) {
    for (const name of objectKeys(map)) {
      if (seen.has(name)) continue;
      seen.add(name);
      servers.push({ name, critical: isCritical((map as Record<string, unknown>)[name]) });
    }
  }
  return { servers };
}
