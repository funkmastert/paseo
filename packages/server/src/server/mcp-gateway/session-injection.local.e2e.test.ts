/**
 * Local e2e coverage for U3's daemon-level session-injection wiring: a real daemon (the real
 * `McpGateway` service + bootstrap.ts's `agentManager.setMcpGateway`/`setMcpGatewayBaseUrl`
 * wiring + the real `/mcp/gateway/*` routes from U2) and a real fixture upstream OAuth MCP
 * server (see `routes.local.e2e.test.ts` for the U2 sibling coverage, same fixture shape).
 *
 * Uses a capturing test client (like `agent-manager.test.ts`'s "injects paseo MCP server"
 * test) rather than a live Claude subprocess, so this proves the daemon/agent-manager
 * injection wiring end-to-end without needing API credentials. The Claude-adapter-specific
 * half of U3 — `strictMcpConfig` plus per-dir stdio re-injection inside
 * `ClaudeAgentSession.buildOptions` — is covered separately in
 * `agent/providers/claude/agent.test.ts`'s "MCP gateway session injection (U3)" suite, using
 * the real adapter with a stubbed SDK query factory (the established pattern for testing that
 * adapter without a live subprocess); routing a live turn through the full async-generator turn
 * machinery here, against a stubbed query that never completes a turn, risks hanging rather than
 * exercising anything this daemon-level test doesn't already cover.
 *
 * Proves:
 *  - the launched session receives a brokered entry with the capability header (KTD1),
 *    absent from the persisted record (KTD6)
 *  - the brokered URL is stable across a re-auth at the daemon (KTD6) — the same URL+token
 *    pair the already-created session was launched with, which fails while the upstream needs
 *    auth, succeeds afterward with no session restart (R4; U3 is the structural owner)
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

import { createPaseoDaemon, type PaseoDaemonConfig } from "../bootstrap.js";
import type { AgentClient, AgentSessionConfig } from "../agent/agent-sdk-types.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { startMcpGatewayAuthorization } from "./oauth.js";

/**
 * Wraps the shared fake Claude client to capture the exact `AgentSessionConfig` it launched
 * with — the same "capture the provider launch config" trick `agent-manager.test.ts`'s
 * "injects paseo MCP server only into provider launch config" test uses, adapted to wrap the
 * shared fake client (whose class isn't exported) instead of subclassing it.
 */
function createCapturingClaudeClient(
  onCreateSession: (config: AgentSessionConfig) => void,
): AgentClient {
  const baseClient = createTestAgentClient("claude", { supportsMcpServers: true });
  return {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: (config, launchContext, options) => {
      onCreateSession(config);
      return baseClient.createSession(config, launchContext, options);
    },
    resumeSession: (handle, overrides, launchContext, options) =>
      baseClient.resumeSession(handle, overrides, launchContext, options),
    fetchCatalog: (options, context) => baseClient.fetchCatalog(options, context),
    isAvailable: () => baseClient.isAvailable(),
  };
}

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

/** Same fixture shape as U2's `routes.local.e2e.test.ts` — see that file's doc comment. */
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

describe("MCP gateway session injection (U3, local e2e, fixture upstream)", () => {
  test("brokered entry reaches the session with the capability header; its URL is stable across a re-auth (R4)", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-mcp-gateway-inject-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-mcp-gateway-inject-"));
    const daemonPort = await getAvailablePort();
    const fixture = await startOAuthFixtureMcpServer();

    let lastConfig: AgentSessionConfig | null = null;
    const claudeClient = createCapturingClaudeClient((config) => {
      lastConfig = config;
    });

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${daemonPort}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: { claude: claudeClient },
      agentStoragePath: path.join(paseoHome, "agents"),
      mcpGateway: {
        enabled: true,
        servers: { fixture: { url: fixture.mcpUrl, transport: "http", auth: "oauth" } },
      },
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    try {
      expect(daemon.mcpGateway.getServerState("fixture")?.status).toBe("needs-auth");

      const projectDir = await mkdtemp(path.join(os.tmpdir(), "paseo-claude-project-inject-"));
      const snapshot = await daemon.agentManager.createAgent(
        { provider: "claude", cwd: projectDir },
        undefined,
        { workspaceId: undefined },
      );

      expect(lastConfig?.mcpGatewayEnabled).toBe(true);
      const gatewayToken = daemon.getMcpGatewayAuthToken();
      const brokeredEntry = lastConfig?.mcpServers?.fixture as
        | { type: string; url: string; headers?: Record<string, string> }
        | undefined;
      expect(brokeredEntry).toMatchObject({
        type: "http",
        url: `http://127.0.0.1:${daemonPort}/mcp/gateway/fixture`,
        headers: { Authorization: `Bearer ${gatewayToken}` },
      });
      const brokeredUrl = brokeredEntry!.url;

      // Never persisted (KTD6).
      const stored = await daemon.agentStorage.get(snapshot.id);
      expect(stored?.config?.mcpServers?.fixture).toBeUndefined();

      // Same URL+token the session was already launched with — before completing OAuth, the
      // upstream still needs auth, so the proxy must return a clean MCP error (U2: HTTP 200
      // with a JSON-RPC error, never a passthrough or a hang), not a live tool list.
      const preAuthCall = await fetch(brokeredUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${gatewayToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(preAuthCall.status).toBe(200);
      expect(await preAuthCall.text()).toContain("needs authentication");

      // Complete OAuth against the daemon, exactly as F3's "owner re-auths from the strip"
      // flow would (U2's callback route) — the already-created session above is never touched.
      const authProvider = daemon.mcpGateway.buildOAuthProvider("fixture");
      const { authorizationUrl } = await startMcpGatewayAuthorization({
        serverUrl: fixture.mcpUrl,
        provider: authProvider,
      });
      const authorizeResponse = await fetch(authorizationUrl, { redirect: "manual" });
      const redirectLocation = authorizeResponse.headers.get("location");
      expect(redirectLocation).toBeTruthy();
      const callbackResponse = await fetch(redirectLocation!);
      expect(callbackResponse.status).toBe(200);
      expect(daemon.mcpGateway.getServerState("fixture")?.status).toBe("connected");

      // R4: the *same* URL+token pair captured from the *already-created* session — no
      // re-creation, no restart — now succeeds.
      const client = await experimental_createMCPClient({
        transport: new StreamableHTTPClientTransport(new URL(brokeredUrl), {
          requestInit: { headers: { Authorization: `Bearer ${gatewayToken}` } },
        }),
      });
      try {
        const tools = (await Reflect.get(client, "listTools").call(client)) as {
          tools?: Array<{ name: string }>;
        };
        expect(tools.tools?.some((tool) => tool.name === "ping")).toBe(true);
      } finally {
        await client.close();
      }

      await rm(projectDir, { recursive: true, force: true });
    } finally {
      await daemon.stop();
      await fixture.close();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  }, 30_000);
});
