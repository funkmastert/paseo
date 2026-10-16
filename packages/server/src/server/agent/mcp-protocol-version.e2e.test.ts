import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import pino from "pino";

import { createPaseoDaemon, type PaseoDaemonConfig } from "../bootstrap.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

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

// StreamableHTTPServerTransport 406s any POST whose Accept header doesn't list both
// content types (application/json for direct responses, text/event-stream for streaming).
function jsonRpcHeaders(protocolVersion?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
  };
}

// The stateless StreamableHTTPServerTransport replies over SSE by default — one
// `data: <json>` line per response — rather than a bare JSON body.
async function readJsonRpcResponse(response: Response): Promise<{
  result?: { protocolVersion?: string; tools?: unknown[] };
  error?: { code: number; message: string };
}> {
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice("data: ".length) : body);
}

describe("agent MCP protocol version negotiation", () => {
  const tempDirs: string[] = [];
  const daemons: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (daemons.length > 0) {
      const stop = daemons.pop();
      if (stop) await stop();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  async function startDaemon(): Promise<{ url: string }> {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    tempDirs.push(paseoHome, staticDir);
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();
    daemons.push(() => daemon.stop());
    return { url: `http://127.0.0.1:${port}/mcp/agents` };
  }

  // Our stateless transport builds a fresh session per HTTP request, so each request
  // validates `Mcp-Protocol-Version` independently of what `initialize` negotiated. A
  // client that keeps sending the version it originally asked for — rather than the one
  // the server actually negotiated back — must still get a working session.
  test("a client announcing a future protocol version initializes and lists tools", async () => {
    const { url } = await startDaemon();
    const futureVersion = "2026-07-28";

    const initResponse = await fetch(url, {
      method: "POST",
      headers: jsonRpcHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: futureVersion,
          capabilities: {},
          clientInfo: { name: "future-test-client", version: "0.0.0" },
        },
      }),
    });
    expect(initResponse.status).toBe(200);
    const initPayload = await readJsonRpcResponse(initResponse);
    expect(initPayload.error).toBeUndefined();
    // The SDK negotiates down to its own latest known version rather than echoing back
    // a version it doesn't recognize.
    expect(initPayload.result?.protocolVersion).toBeDefined();
    expect(initPayload.result?.protocolVersion).not.toBe(futureVersion);

    const listResponse = await fetch(url, {
      method: "POST",
      // A client that still reports the version it originally requested, not the one
      // the server negotiated, must not get a hard 400 on this follow-up call.
      headers: jsonRpcHeaders(futureVersion),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(listResponse.status).toBe(200);
    const listPayload = await readJsonRpcResponse(listResponse);
    expect(listPayload.error).toBeUndefined();
    expect(Array.isArray(listPayload.result?.tools)).toBe(true);
    expect(listPayload.result!.tools!.length).toBeGreaterThan(0);
  });

  test("a client announcing an older supported protocol version still works", async () => {
    const { url } = await startDaemon();
    const olderVersion = "2025-06-18";

    const initResponse = await fetch(url, {
      method: "POST",
      headers: jsonRpcHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: olderVersion,
          capabilities: {},
          clientInfo: { name: "legacy-test-client", version: "0.0.0" },
        },
      }),
    });
    expect(initResponse.status).toBe(200);
    const initPayload = await readJsonRpcResponse(initResponse);
    expect(initPayload.error).toBeUndefined();
    expect(initPayload.result?.protocolVersion).toBe(olderVersion);

    const listResponse = await fetch(url, {
      method: "POST",
      headers: jsonRpcHeaders(olderVersion),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(listResponse.status).toBe(200);
    const listPayload = await readJsonRpcResponse(listResponse);
    expect(listPayload.error).toBeUndefined();
    expect(Array.isArray(listPayload.result?.tools)).toBe(true);
    expect(listPayload.result!.tools!.length).toBeGreaterThan(0);
  });
});
