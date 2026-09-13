/**
 * Local e2e coverage for U2's inbound surface: the /mcp/gateway/:name proxy route and the
 * OAuth callback route, driven against a real daemon and a real fixture upstream MCP server
 * (never the live daemon — see docs/testing.md's *.local.e2e.test.ts convention).
 *
 * The fixture combines an OAuth authorization server (the SDK's own demo in-memory provider,
 * `DemoInMemoryAuthProvider` + `mcpAuthRouter`) and a bearer-protected MCP resource server on
 * one origin, so the daemon's gateway can complete a genuine discovery → dynamic client
 * registration → PKCE authorize → token-exchange round trip against it — proving the callback
 * route's `state` handling and U1's oauth module together, not just the route logic in
 * isolation (see routes.test.ts for the fast, fixture-free route-level checks).
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { DemoInMemoryAuthProvider } from "@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js";
import express from "express";

import { hashDaemonPassword } from "../auth.js";
import { createPaseoDaemon, type PaseoDaemonConfig } from "../bootstrap.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { MCP_GATEWAY_CALLBACK_ROUTE } from "./routes.js";

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

interface OAuthFixtureMcpServer {
  mcpUrl: string;
  close: () => Promise<void>;
}

/**
 * A single-origin OAuth authorization server + bearer-protected MCP resource server, standing
 * in for a real remote MCP like GitHub or Zeeq (KTD2/KTD3). `DemoInMemoryAuthProvider` is the
 * SDK's own demo implementation of `OAuthServerProvider` — it always "succeeds" the interactive
 * login step, which is exactly what a test driving the flow without a browser needs.
 */
async function startOAuthFixtureMcpServer(): Promise<OAuthFixtureMcpServer> {
  const port = await getAvailablePort();
  const baseUrl = new URL(`http://127.0.0.1:${port}`);
  const mcpUrl = new URL("/mcp", baseUrl);
  const provider = new DemoInMemoryAuthProvider();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: baseUrl,
      resourceServerUrl: mcpUrl,
      scopesSupported: ["mcp:tools"],
    }),
  );

  const mcpServer = new McpServer({ name: "fixture-oauth-mcp-server", version: "1.0.0" });
  mcpServer.registerTool(
    "ping",
    { title: "Ping", description: "Replies pong", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );
  // Session mode, matching gateway.test.ts's fixture: a stateless transport 500s on the
  // post-initialize notification, which this fixture needs to survive for a real
  // Client.connect() handshake.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableDnsRebindingProtection: false,
  });
  await mcpServer.connect(transport);

  const bearerAuth = requireBearerAuth({ verifier: provider });
  const handleMcpRequest: express.RequestHandler = (req, res) => {
    void transport.handleRequest(req, res, req.method === "POST" ? req.body : undefined);
  };
  app.post("/mcp", bearerAuth, handleMcpRequest);
  app.get("/mcp", bearerAuth, handleMcpRequest);

  const httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const server = app.listen(port, "127.0.0.1", () => resolve(server));
  });

  return {
    mcpUrl: mcpUrl.toString(),
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

interface StructuredContent {
  [key: string]: unknown;
}

async function createGatewayMcpClient(url: string, gatewayToken: string) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${gatewayToken}` } },
  });
  const rawClient = await experimental_createMCPClient({ transport });
  return {
    listTools: (): Promise<Record<string, unknown>> =>
      Reflect.get(rawClient, "listTools").call(rawClient),
    callTool: (input: { name: string; args?: StructuredContent }) =>
      Reflect.get(rawClient, "callTool").call(rawClient, input),
    close: () => rawClient.close(),
  };
}

describe("MCP gateway proxy + OAuth callback (local e2e, fixture upstream)", () => {
  test("authorize → callback → proxy round trip; replay of a spent state is rejected", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-mcp-gateway-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-mcp-gateway-"));
    const daemonPort = await getAvailablePort();
    const fixture = await startOAuthFixtureMcpServer();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${daemonPort}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      mcpGateway: {
        enabled: true,
        servers: { fixture: { url: fixture.mcpUrl, transport: "http", auth: "oauth" } },
      },
      // A daemon password lets the unauthorized/wrong-token proxy checks below prove
      // something (an open, password-less daemon exempts /mcp/gateway/* the same way
      // /mcp/agents is exempt, by design — that path is covered in routes.test.ts).
      auth: { password: hashDaemonPassword("gateway-e2e-secret") },
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    try {
      expect(daemon.mcpGateway.getServerState("fixture")?.status).toBe("needs-auth");

      // A garbage `state` never touches the exchange step and writes nothing.
      const badStateResponse = await fetch(
        `http://127.0.0.1:${daemonPort}${MCP_GATEWAY_CALLBACK_ROUTE}?code=x&state=never-issued`,
      );
      expect(badStateResponse.status).toBe(400);

      // Real discovery + dynamic client registration against the fixture's own AS metadata,
      // using the exact provider the running gateway would use for this server (U1's oauth
      // module) — proving the callback route later validates against the SAME state store.
      const provider = daemon.mcpGateway.buildOAuthProvider("fixture");
      const { startMcpGatewayAuthorization } = await import("./oauth.js");
      const { authorizationUrl } = await startMcpGatewayAuthorization({
        serverUrl: fixture.mcpUrl,
        provider,
      });

      // Stands in for the phone/desktop browser following the authorization URL: the
      // fixture's demo provider "logs the user in" and redirects straight back with
      // `code`+`state` — nothing about this daemon knows or needs to know that happened in
      // a real browser.
      const authorizeResponse = await fetch(authorizationUrl, { redirect: "manual" });
      expect(authorizeResponse.status).toBeGreaterThanOrEqual(300);
      expect(authorizeResponse.status).toBeLessThan(400);
      const redirectLocation = authorizeResponse.headers.get("location");
      expect(redirectLocation).toBeTruthy();
      const callbackUrl = new URL(redirectLocation!);
      expect(callbackUrl.origin + callbackUrl.pathname).toBe(
        `http://127.0.0.1:${daemonPort}${MCP_GATEWAY_CALLBACK_ROUTE}`,
      );

      const callbackResponse = await fetch(callbackUrl.toString());
      expect(callbackResponse.status).toBe(200);
      const callbackBody = await callbackResponse.text();
      expect(callbackBody).toContain("close this tab");

      expect(daemon.mcpGateway.getServerState("fixture")?.status).toBe("connected");

      // Replaying the exact same callback URL a second time is rejected: the state was
      // already consumed on first use, regardless of that first use's outcome.
      const replayResponse = await fetch(callbackUrl.toString());
      expect(replayResponse.status).toBe(400);

      // The proxy route now relays real tool list/call traffic to the fixture, authenticated
      // by the gateway's own distinct capability token (never the /mcp/agents token).
      const gatewayToken = daemon.getMcpGatewayAuthToken();
      const agentMcpToken = daemon.agentManager.getMcpAuthToken();
      expect(gatewayToken).not.toBe(agentMcpToken);

      const gatewayUrl = `http://127.0.0.1:${daemonPort}/mcp/gateway/fixture`;

      const unauthorizedRelay = await fetch(gatewayUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(unauthorizedRelay.status).toBe(401);

      // The /mcp/agents capability token must not work here — leaking one secret must never
      // grant the other surface (KTD1).
      const agentTokenRelay = await fetch(gatewayUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${agentMcpToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(agentTokenRelay.status).toBe(401);

      const client = await createGatewayMcpClient(gatewayUrl, gatewayToken);
      try {
        const tools = (await client.listTools()) as { tools?: Array<{ name: string }> };
        expect(tools.tools?.some((tool) => tool.name === "ping")).toBe(true);

        const result = (await client.callTool({ name: "ping", args: {} })) as {
          content?: Array<{ text?: string }>;
        };
        expect(result.content?.[0]?.text).toBe("pong");
      } finally {
        await client.close();
      }
    } finally {
      await daemon.stop();
      await fixture.close();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  }, 30_000);
});
