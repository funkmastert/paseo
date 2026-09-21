import type { IncomingMessage, ServerResponse } from "node:http";
import express from "express";

import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { isAgentMcpRequestAuthorized } from "../auth.js";
import { McpGatewayUpstreamUnavailableError, type McpGateway } from "./gateway.js";

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

// JSON-RPC server-error range (-32000 to -32099 per spec); distinct from the SDK's own
// ErrorCode.ConnectionClosed (-32000) and ErrorCode.RequestTimeout (-32001).
const MCP_GATEWAY_NEEDS_AUTH_ERROR_CODE = -32010;

export const MCP_GATEWAY_CALLBACK_ROUTE = "/mcp/gateway/oauth/callback";
const MCP_GATEWAY_PROXY_ROUTE = "/mcp/gateway/:name";

export interface McpGatewayRoutesOptions {
  gateway: McpGateway;
  /** Distinct capability token for `/mcp/gateway/*` (KTD1) — never the `/mcp/agents` token. */
  capabilityToken: string;
  password: string | undefined;
  mcpDebug?: boolean;
  logger?: LoggerLike;
}

/** Replaces the given query param values with a redaction marker for logging. */
function redactedRequestUrl(originalUrl: string, paramNames: readonly string[]): string {
  try {
    const url = new URL(originalUrl, "http://mcp-gateway.internal");
    for (const name of paramNames) {
      if (url.searchParams.has(name)) {
        url.searchParams.set(name, "[redacted]");
      }
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return "[unparseable-url]";
  }
}

function firstStringQueryParam(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

/**
 * Builds the per-request MCP server facade that stands in for the upstream connection (KTD1's
 * "reverse-proxy routes" approach). Tool list/call requests forward verbatim to the gateway's
 * live upstream `Client`; when the server isn't connected, or its login dies under the request,
 * handlers throw a generic needs-auth `McpError`, so the response is always a clean,
 * well-formed MCP error rather than a hang or a passthrough of upstream details.
 */
function createProxyFacadeServer(gateway: McpGateway, name: string): McpProtocolServer {
  const forward = async <T>(request: (client: Client) => Promise<T>): Promise<T> => {
    try {
      return await gateway.requestUpstream(name, request);
    } catch (error) {
      if (error instanceof McpGatewayUpstreamUnavailableError) {
        throw new McpError(MCP_GATEWAY_NEEDS_AUTH_ERROR_CODE, error.message);
      }
      throw error;
    }
  };

  const server = new McpProtocolServer(
    { name: `paseo-mcp-gateway-${name}`, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () =>
    forward((client) => client.listTools()),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    forward((client) => client.callTool(request.params)),
  );
  return server;
}

const CALLBACK_PAGE_STYLE =
  "font-family: system-ui, sans-serif; display: flex; align-items: center; " +
  "justify-content: center; height: 100vh; margin: 0; color: #1a1a1a;";

function renderCallbackPage(options: { title: string; message: string }): string {
  // Fully static per server response — never interpolates request data (query params,
  // upstream error text) into the page, so nothing from the callback request or the OAuth
  // exchange can leak into what's rendered.
  return `<!doctype html><html><head><meta charset="utf-8"><title>${options.title}</title></head><body style="${CALLBACK_PAGE_STYLE}"><p>${options.message}</p></body></html>`;
}

const CALLBACK_SUCCESS_PAGE = renderCallbackPage({
  title: "Authorized",
  message: "You can close this tab.",
});
const CALLBACK_INVALID_STATE_PAGE = renderCallbackPage({
  title: "Authorization link expired",
  message: "This authorization link has expired or was already used. Try again from the app.",
});
const CALLBACK_EXCHANGE_FAILED_PAGE = renderCallbackPage({
  title: "Authorization failed",
  message: "Authorization failed. Try again from the app.",
});

/**
 * Mounts the MCP gateway's inbound surface (U2): the per-server proxy route sessions use to
 * reach brokered upstreams, and the OAuth callback route that completes PKCE (KTD3).
 *
 * Both routes are self-authenticating and must be exempted from the global bearer-auth
 * middleware via `isBearerFreeRoute`'s `/mcp/gateway/` prefix match (`server/auth.ts`) — the
 * proxy route checks its own distinct capability token below, and the callback route
 * authenticates via the single-use `state` value instead of a bearer header (it's a browser
 * redirect target, which can't carry one).
 */
export function installMcpGatewayRoutes(
  app: express.Express,
  options: McpGatewayRoutesOptions,
): void {
  const logger = options.logger?.child({ module: "mcp-gateway-routes" });

  const handleProxyRequest: express.RequestHandler = (req, res) => {
    void (async () => {
      if (
        !(await isAgentMcpRequestAuthorized({
          password: options.password,
          capabilityToken: options.capabilityToken,
          authorizationHeader: req.header("authorization"),
        }))
      ) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const name = req.params.name;
      if (!options.gateway.getServerNames().includes(name)) {
        res.status(404).json({ error: `Unknown MCP gateway server "${name}"` });
        return;
      }

      if (options.mcpDebug) {
        logger?.debug(
          {
            method: req.method,
            url: redactedRequestUrl(req.originalUrl, ["code", "state"]),
            server: name,
          },
          "MCP gateway proxy request",
        );
      }

      // Stateless mode, matching the /mcp/agents precedent: GET (standalone SSE) and DELETE
      // (session termination) have no meaning without sessions.
      if (req.method !== "POST") {
        res.status(405).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed" },
          id: null,
        });
        return;
      }

      try {
        const server = createProxyFacadeServer(options.gateway, name);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableDnsRebindingProtection: false,
        });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body,
        );
      } catch (err) {
        logger?.warn({ err, server: name }, "Failed to handle MCP gateway proxy request");
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal MCP gateway error" },
            id: null,
          });
        }
      }
    })();
  };

  // Body parsing is handled by the daemon's global `express.json()` middleware, matching
  // /mcp/agents — this route doesn't add its own.
  app.post(MCP_GATEWAY_PROXY_ROUTE, handleProxyRequest);
  app.get(MCP_GATEWAY_PROXY_ROUTE, handleProxyRequest);
  app.delete(MCP_GATEWAY_PROXY_ROUTE, handleProxyRequest);

  const handleOAuthCallback: express.RequestHandler = (req, res) => {
    void (async () => {
      if (options.mcpDebug) {
        logger?.debug(
          { url: redactedRequestUrl(req.originalUrl, ["code", "state"]) },
          "MCP gateway OAuth callback",
        );
      }

      const code = firstStringQueryParam(req.query.code);
      const state = firstStringQueryParam(req.query.state);

      // Consume the state unconditionally, even when `code` is missing: a state value is
      // never usable twice regardless of which half of the pair was malformed.
      const serverName = state ? options.gateway.consumeOAuthState(state) : undefined;
      if (!code || !serverName) {
        res.status(400).send(CALLBACK_INVALID_STATE_PAGE);
        return;
      }

      try {
        await options.gateway.completeOAuthCallback(serverName, code);
      } catch (err) {
        logger?.warn({ err, server: serverName }, "MCP gateway OAuth exchange failed");
        res.status(400).send(CALLBACK_EXCHANGE_FAILED_PAGE);
        return;
      }

      res.status(200).send(CALLBACK_SUCCESS_PAGE);
    })();
  };

  app.get(MCP_GATEWAY_CALLBACK_ROUTE, handleOAuthCallback);
}
