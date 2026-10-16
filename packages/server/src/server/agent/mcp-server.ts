import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { addModelVisibleStructuredContent } from "./tools/paseo-tool-serialization.js";
import { JEV_TOOL_NAMES } from "./tools/jev-tool-use-log.js";
import { createPaseoToolCatalog, type PaseoToolHostDependencies } from "./tools/paseo-tools.js";
import type { PaseoToolResult } from "./tools/types.js";

const JEV_TOOL_NAME_SET: ReadonlySet<string> = new Set(JEV_TOOL_NAMES);

export type AgentMcpServerOptions = PaseoToolHostDependencies;

type McpToolContext = RequestHandlerExtra<ServerRequest, ServerNotification>;

function toMcpToolResult(result: PaseoToolResult): CallToolResult {
  const modelVisibleResult = addModelVisibleStructuredContent(result);
  return {
    content: modelVisibleResult.content as CallToolResult["content"],
    ...(modelVisibleResult.structuredContent !== undefined
      ? {
          structuredContent:
            modelVisibleResult.structuredContent as CallToolResult["structuredContent"],
        }
      : {}),
    ...(modelVisibleResult.isError !== undefined ? { isError: modelVisibleResult.isError } : {}),
  };
}

/**
 * `toolsScope: "jev"` builds the dedicated eager-load server (docs/jev.md, "Which agents get
 * them"; `runtime-mcp-config.ts`'s `withRuntimeJevToolsMcpServer`) carrying only the 7
 * `ask_jev_*` tools, for `/mcp/agents?...&tools=jev`. Undefined builds the ordinary catalog
 * minus those 7 — they now reach an "on"-arm agent only through the dedicated server, never
 * both, so no tool name is ever registered under two different MCP server identities.
 */
export async function createAgentMcpServer(
  options: AgentMcpServerOptions,
  toolsScope?: "jev",
): Promise<McpServer> {
  const catalog = await createPaseoToolCatalog(options);
  const server = new McpServer({
    name: toolsScope === "jev" ? "agent-mcp-jev" : "agent-mcp",
    version: "2.0.0",
  });

  const tools = [...catalog.tools.values()].filter((tool) =>
    toolsScope === "jev" ? JEV_TOOL_NAME_SET.has(tool.name) : !JEV_TOOL_NAME_SET.has(tool.name),
  );

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: unknown, context?: McpToolContext) =>
        toMcpToolResult(await catalog.executeTool(tool.name, args, { signal: context?.signal })),
    );
  }

  return server;
}
