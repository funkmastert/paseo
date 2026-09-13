import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { McpGateway } from "./gateway.js";
import { McpGatewayTokenStore } from "./token-store.js";

const tempDirs: string[] = [];
const fixtureServers: Array<() => Promise<void>> = [];

function createTempHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-mcp-gateway-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (fixtureServers.length > 0) {
    const close = fixtureServers.pop();
    if (close) await close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

/**
 * A minimal, real, local MCP server for exercising `McpGateway`'s live
 * connect path without mocks. When `expectedAuthorizationHeader` is set, any
 * request whose `Authorization` header doesn't match exactly is rejected
 * with 401, standing in for an upstream that requires a static bearer token.
 */
async function startFixtureMcpServer(options: {
  expectedAuthorizationHeader?: string;
}): Promise<{ url: string }> {
  const mcpServer = new McpServer({ name: "fixture-mcp-server", version: "1.0.0" });
  mcpServer.registerTool(
    "ping",
    { title: "Ping", description: "Replies pong", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );

  // Session mode, not stateless (`sessionIdGenerator: undefined`): a stateless transport
  // 500s on the post-initialize `notifications/initialized` message, which this fixture
  // needs to survive since it drives a real `Client.connect()` handshake end to end.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableDnsRebindingProtection: false,
  });
  await mcpServer.connect(transport);

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      if (
        options.expectedAuthorizationHeader !== undefined &&
        req.headers.authorization !== options.expectedAuthorizationHeader
      ) {
        res.statusCode = 401;
        res.end();
        return;
      }
      try {
        const body = req.method === "POST" ? await readJsonBody(req) : undefined;
        await transport.handleRequest(req, res, body);
      } catch (error) {
        res.statusCode = 500;
        res.end(String(error));
      }
    })();
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;

  fixtureServers.push(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));

  return { url: `http://127.0.0.1:${port}/mcp` };
}

describe("McpGateway", () => {
  test("a disabled gateway constructs no per-server runtime state", () => {
    const gateway = new McpGateway({
      paseoHome: createTempHome(),
      config: {
        enabled: false,
        servers: { zeeq: { url: "https://zeeq.example.test/mcp", transport: "http" } },
      },
    });

    expect(gateway.enabled).toBe(false);
    expect(gateway.getServerNames()).toEqual([]);
    expect(gateway.getSnapshot()).toEqual([]);
  });

  test("an enabled gateway with no servers configured constructs no per-server runtime state", () => {
    const gateway = new McpGateway({
      paseoHome: createTempHome(),
      config: { enabled: true },
    });

    expect(gateway.getServerNames()).toEqual([]);
  });

  test("an OAuth-class server with no stored tokens goes straight to needs-auth without a network attempt", async () => {
    const gateway = new McpGateway({
      paseoHome: createTempHome(),
      config: {
        enabled: true,
        servers: {
          github: { url: "http://127.0.0.1:1/mcp", transport: "http", auth: "oauth" },
        },
      },
    });

    await gateway.start();

    expect(gateway.getServerState("github")?.status).toBe("needs-auth");
  });

  test("a malformed token file fails closed to needs-auth instead of crashing gateway.start()", async () => {
    const paseoHome = createTempHome();
    const tokensPath = path.join(paseoHome, "mcp-gateway", "tokens.json");
    mkdirSync(path.dirname(tokensPath), { recursive: true });
    writeFileSync(tokensPath, "{ not valid json");

    const gateway = new McpGateway({
      paseoHome,
      config: {
        enabled: true,
        servers: {
          github: { url: "http://127.0.0.1:1/mcp", transport: "http", auth: "oauth" },
        },
      },
    });

    await expect(gateway.start()).resolves.toBeUndefined();
    expect(gateway.getServerState("github")?.status).toBe("needs-auth");
  });

  test("a static-auth server with no stored header goes to needs-auth without a network attempt", async () => {
    const gateway = new McpGateway({
      paseoHome: createTempHome(),
      config: {
        enabled: true,
        servers: {
          slack: { url: "http://127.0.0.1:1/mcp", transport: "http", auth: "static" },
        },
      },
    });

    await gateway.start();

    expect(gateway.getServerState("slack")?.status).toBe("needs-auth");
  });

  test("a static-auth server connects using the header value from the token store, never from config", async () => {
    const fixture = await startFixtureMcpServer({
      expectedAuthorizationHeader: "Bearer static-secret-from-token-store",
    });
    const paseoHome = createTempHome();
    new McpGatewayTokenStore(paseoHome).saveStaticHeaders("slack", {
      Authorization: "Bearer static-secret-from-token-store",
    });

    const gateway = new McpGateway({
      paseoHome,
      config: {
        enabled: true,
        servers: { slack: { url: fixture.url, transport: "http", auth: "static" } },
      },
    });

    await gateway.start();

    expect(gateway.getServerState("slack")?.status).toBe("connected");
    expect(gateway.getClient("slack")).toBeDefined();
  });

  test("a static-auth server with the wrong stored header lands in needs-auth, not error", async () => {
    const fixture = await startFixtureMcpServer({
      expectedAuthorizationHeader: "Bearer the-right-secret",
    });
    const paseoHome = createTempHome();
    new McpGatewayTokenStore(paseoHome).saveStaticHeaders("slack", {
      Authorization: "Bearer the-wrong-secret",
    });

    const gateway = new McpGateway({
      paseoHome,
      config: {
        enabled: true,
        servers: { slack: { url: fixture.url, transport: "http", auth: "static" } },
      },
    });

    await gateway.start();

    expect(gateway.getServerState("slack")?.status).toBe("needs-auth");
  });

  test("a server whose URL can't be reached at all lands in error with a message, not needs-auth", async () => {
    const paseoHome = createTempHome();
    new McpGatewayTokenStore(paseoHome).saveStaticHeaders("slack", { Authorization: "Bearer x" });
    const unreachable = new McpGateway({
      paseoHome,
      config: {
        enabled: true,
        servers: { slack: { url: "http://127.0.0.1:1/mcp", transport: "http", auth: "static" } },
      },
    });

    await unreachable.start();

    const state = unreachable.getServerState("slack");
    expect(state?.status).toBe("error");
    expect(state?.error).toBeTruthy();
  });

  test("getSnapshot reports critical, status, and lastChangedAt per server", async () => {
    const gateway = new McpGateway({
      paseoHome: createTempHome(),
      config: {
        enabled: true,
        servers: {
          zeeq: { url: "http://127.0.0.1:1/mcp", transport: "http", critical: true },
          github: { url: "http://127.0.0.1:1/mcp", transport: "http" },
        },
      },
    });

    await gateway.start();

    const snapshot = gateway.getSnapshot().sort((a, b) => a.name.localeCompare(b.name));
    expect(snapshot).toEqual([
      { name: "github", status: "needs-auth", critical: false, lastChangedAt: expect.any(Number) },
      { name: "zeeq", status: "needs-auth", critical: true, lastChangedAt: expect.any(Number) },
    ]);
  });

  test("reconnect() re-attempts a needs-auth server after tokens are saved (R4)", async () => {
    const fixture = await startFixtureMcpServer({
      expectedAuthorizationHeader: "Bearer late-secret",
    });
    const paseoHome = createTempHome();
    const tokenStore = new McpGatewayTokenStore(paseoHome);

    const gateway = new McpGateway({
      paseoHome,
      config: {
        enabled: true,
        servers: { slack: { url: fixture.url, transport: "http", auth: "static" } },
      },
    });

    await gateway.start();
    expect(gateway.getServerState("slack")?.status).toBe("needs-auth");

    tokenStore.saveStaticHeaders("slack", { Authorization: "Bearer late-secret" });
    await gateway.reconnect("slack");

    expect(gateway.getServerState("slack")?.status).toBe("connected");
  });
});
