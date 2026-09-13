import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import express from "express";

import { hashDaemonPassword } from "../auth.js";
import { McpGateway } from "./gateway.js";
import { McpGatewayTokenStore } from "./token-store.js";
import { installMcpGatewayRoutes, MCP_GATEWAY_CALLBACK_ROUTE } from "./routes.js";

const tempDirs: string[] = [];
const testServers: Array<() => Promise<void>> = [];

function createTempHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-mcp-gateway-routes-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (testServers.length > 0) {
    const close = testServers.pop();
    if (close) await close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface TestAppOptions {
  gateway: McpGateway;
  capabilityToken: string;
  password?: string;
}

async function startTestApp(options: TestAppOptions): Promise<{ url: string }> {
  const app = express();
  app.use(express.json());
  installMcpGatewayRoutes(app, {
    gateway: options.gateway,
    capabilityToken: options.capabilityToken,
    password: options.password,
    mcpDebug: false,
  });
  const httpServer = http.createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  testServers.push(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));
  return { url: `http://127.0.0.1:${port}` };
}

function jsonRpcBody(): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
}

// StreamableHTTPServerTransport 406s any POST whose Accept header doesn't list both
// content types (application/json for direct responses, text/event-stream for streaming).
function jsonRpcHeaders(authorization?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(authorization ? { authorization } : {}),
  };
}

// A stateless StreamableHTTPServerTransport (matching /mcp/agents's precedent) replies over
// SSE by default — one `data: <json>` line per response — rather than a bare JSON body.
async function readJsonRpcResponse(
  response: Response,
): Promise<{ error?: { code: number; message: string } }> {
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice("data: ".length) : body);
}

describe("MCP gateway proxy route", () => {
  test("rejects a request with no bearer token when a daemon password is configured", async () => {
    const gateway = new McpGateway({
      paseoHome: createTempHome(),
      config: {
        enabled: true,
        servers: { github: { url: "http://127.0.0.1:1/mcp", transport: "http", auth: "oauth" } },
      },
    });
    const { url } = await startTestApp({
      gateway,
      capabilityToken: randomUUID(),
      password: hashDaemonPassword("daemon-secret"),
    });

    const response = await fetch(`${url}/mcp/gateway/github`, {
      method: "POST",
      headers: jsonRpcHeaders(),
      body: jsonRpcBody(),
    });

    expect(response.status).toBe(401);
  });

  test("rejects a bearer token that isn't this gateway's own capability token", async () => {
    const gateway = new McpGateway({
      paseoHome: createTempHome(),
      config: {
        enabled: true,
        servers: { github: { url: "http://127.0.0.1:1/mcp", transport: "http", auth: "oauth" } },
      },
    });
    const otherToken = randomUUID(); // stands in for the distinct /mcp/agents capability token
    const { url } = await startTestApp({
      gateway,
      capabilityToken: randomUUID(),
      password: hashDaemonPassword("daemon-secret"),
    });

    const response = await fetch(`${url}/mcp/gateway/github`, {
      method: "POST",
      headers: jsonRpcHeaders(`Bearer ${otherToken}`),
      body: jsonRpcBody(),
    });

    expect(response.status).toBe(401);
  });

  test("an unknown server name is rejected with 404 even with a valid token", async () => {
    const gateway = new McpGateway({ paseoHome: createTempHome(), config: { enabled: true } });
    const capabilityToken = randomUUID();
    const { url } = await startTestApp({
      gateway,
      capabilityToken,
      password: hashDaemonPassword("x"),
    });

    const response = await fetch(`${url}/mcp/gateway/does-not-exist`, {
      method: "POST",
      headers: jsonRpcHeaders(`Bearer ${capabilityToken}`),
      body: jsonRpcBody(),
    });

    expect(response.status).toBe(404);
  });

  test("an authorized request to a needs-auth server gets a clean MCP error, never a hang or upstream passthrough", async () => {
    const gateway = new McpGateway({
      paseoHome: createTempHome(),
      config: {
        enabled: true,
        servers: { github: { url: "http://127.0.0.1:1/mcp", transport: "http", auth: "oauth" } },
      },
    });
    await gateway.start();
    expect(gateway.getServerState("github")?.status).toBe("needs-auth");

    const capabilityToken = randomUUID();
    const { url } = await startTestApp({
      gateway,
      capabilityToken,
      password: hashDaemonPassword("x"),
    });

    const response = await fetch(`${url}/mcp/gateway/github`, {
      method: "POST",
      headers: jsonRpcHeaders(`Bearer ${capabilityToken}`),
      body: jsonRpcBody(),
    });

    expect(response.status).toBe(200);
    const payload = await readJsonRpcResponse(response);
    expect(payload.error?.code).toBe(-32010);
    expect(payload.error?.message).toContain('MCP gateway server "github" needs authentication');
  });

  test("a request with no daemon password configured succeeds without a bearer token", async () => {
    const gateway = new McpGateway({
      paseoHome: createTempHome(),
      config: {
        enabled: true,
        servers: { github: { url: "http://127.0.0.1:1/mcp", transport: "http", auth: "oauth" } },
      },
    });
    await gateway.start();

    const { url } = await startTestApp({ gateway, capabilityToken: randomUUID() });

    const response = await fetch(`${url}/mcp/gateway/github`, {
      method: "POST",
      headers: jsonRpcHeaders(),
      body: jsonRpcBody(),
    });

    expect(response.status).toBe(200);
  });
});

describe("MCP gateway OAuth callback route", () => {
  test("missing code or state is rejected with 400 and writes no tokens", async () => {
    const paseoHome = createTempHome();
    const gateway = new McpGateway({
      paseoHome,
      config: {
        enabled: true,
        servers: { github: { url: "http://127.0.0.1:1/mcp", transport: "http", auth: "oauth" } },
      },
    });
    const { url } = await startTestApp({ gateway, capabilityToken: randomUUID() });

    const response = await fetch(`${url}${MCP_GATEWAY_CALLBACK_ROUTE}?state=only-state`);

    expect(response.status).toBe(400);
    expect(new McpGatewayTokenStore(paseoHome).getOAuthTokens("github")).toBeUndefined();
  });

  test("an unknown state value is rejected with 400", async () => {
    const gateway = new McpGateway({
      paseoHome: createTempHome(),
      config: {
        enabled: true,
        servers: { github: { url: "http://127.0.0.1:1/mcp", transport: "http", auth: "oauth" } },
      },
    });
    const { url } = await startTestApp({ gateway, capabilityToken: randomUUID() });

    const response = await fetch(`${url}${MCP_GATEWAY_CALLBACK_ROUTE}?code=abc&state=never-issued`);

    expect(response.status).toBe(400);
  });

  test("a valid state whose exchange fails is rejected with 400 and writes no tokens", async () => {
    const paseoHome = createTempHome();
    const gateway = new McpGateway({
      paseoHome,
      config: {
        enabled: true,
        servers: { github: { url: "http://127.0.0.1:1/mcp", transport: "http", auth: "oauth" } },
      },
      oauthRedirectBaseUrl: "http://127.0.0.1:1",
    });
    const { url } = await startTestApp({ gateway, capabilityToken: randomUUID() });

    // Mints a real, single-use state bound to "github" via the same machinery the gateway's
    // own auth-start flow uses (KTD3), without driving a full discovery round trip.
    const state = await gateway.buildOAuthProvider("github").state?.();
    expect(typeof state).toBe("string");

    const response = await fetch(
      `${url}${MCP_GATEWAY_CALLBACK_ROUTE}?code=unreachable-upstream-code&state=${state}`,
    );

    expect(response.status).toBe(400);
    expect(new McpGatewayTokenStore(paseoHome).getOAuthTokens("github")).toBeUndefined();
  });

  test("a replayed state is rejected on the second callback even though the first attempt consumed it", async () => {
    const gateway = new McpGateway({
      paseoHome: createTempHome(),
      config: {
        enabled: true,
        servers: { github: { url: "http://127.0.0.1:1/mcp", transport: "http", auth: "oauth" } },
      },
      oauthRedirectBaseUrl: "http://127.0.0.1:1",
    });
    const { url } = await startTestApp({ gateway, capabilityToken: randomUUID() });

    const state = await gateway.buildOAuthProvider("github").state?.();

    const first = await fetch(`${url}${MCP_GATEWAY_CALLBACK_ROUTE}?code=c1&state=${state}`);
    expect(first.status).toBe(400); // exchange fails: nothing real is listening on the upstream

    const replay = await fetch(`${url}${MCP_GATEWAY_CALLBACK_ROUTE}?code=c2&state=${state}`);
    expect(replay.status).toBe(400);
    const replayBody = await replay.text();
    expect(replayBody).toContain("expired or was already used");
  });
});
