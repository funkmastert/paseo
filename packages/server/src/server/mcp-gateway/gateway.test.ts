import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { DemoInMemoryAuthProvider } from "@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js";

import {
  evaluateTransitionNotification,
  McpGateway,
  type McpGatewaySnapshotEntry,
} from "./gateway.js";
import { McpGatewayTokenStore } from "./token-store.js";

interface FakePushPayload {
  title: string;
  body: string;
  data: Record<string, unknown>;
}

function createFakePushSender() {
  const sent: FakePushPayload[] = [];
  return {
    sender: { send: async (payload: FakePushPayload) => void sent.push(payload) },
    sent,
  };
}

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
  /** Additional non-auth headers every request must carry exactly (401 otherwise). */
  expectedHeaders?: Record<string, string>;
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
      for (const [key, value] of Object.entries(options.expectedHeaders ?? {})) {
        if (req.headers[key.toLowerCase()] !== value) {
          res.statusCode = 401;
          res.end();
          return;
        }
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

/**
 * A minimal, real OAuth authorization server (the SDK's own `DemoInMemoryAuthProvider` +
 * `mcpAuthRouter`, matching `routes.local.e2e.test.ts`'s fixture) for exercising
 * `startAuthorization()`'s discovery + dynamic-registration + PKCE-challenge path without
 * mocks. No protected resource endpoint is mounted — `startAuthorization()` never calls it,
 * only the authorization server's own discovery and registration endpoints.
 */
async function startOAuthAuthorizationServer(): Promise<{ url: string }> {
  // Bind an ephemeral port first (port 0) so `issuerUrl` can be constructed before the
  // auth router — which signs URLs from it — is mounted.
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const baseUrl = new URL(`http://127.0.0.1:${port}`);

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(
    mcpAuthRouter({
      provider: new DemoInMemoryAuthProvider(),
      issuerUrl: baseUrl,
      resourceServerUrl: baseUrl,
      scopesSupported: ["mcp:tools"],
    }),
  );

  const httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const server = app.listen(port, "127.0.0.1", () => resolve(server));
  });

  fixtureServers.push(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));

  return { url: baseUrl.toString() };
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

  test("session injection defaults to overlay and honours an explicit strict", () => {
    const home = createTempHome();
    expect(new McpGateway({ paseoHome: home, config: { enabled: true } }).sessionMode).toBe(
      "overlay",
    );
    expect(
      new McpGateway({ paseoHome: home, config: { enabled: true, sessionMode: "strict" } })
        .sessionMode,
    ).toBe("strict");
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

  test("an OAuth server with stored extraHeaders sends them alongside the SDK's Authorization", async () => {
    const fixture = await startFixtureMcpServer({
      expectedAuthorizationHeader: "Bearer at-oauth",
      expectedHeaders: { "x-zeeq-prompts-repo": "wonderly/mobile" },
    });
    const paseoHome = createTempHome();
    const tokensPath = path.join(paseoHome, "mcp-gateway", "tokens.json");
    mkdirSync(path.dirname(tokensPath), { recursive: true });
    // Written the way an operator seeds it: extraHeaders live only in the token record.
    writeFileSync(
      tokensPath,
      JSON.stringify({
        version: 1,
        servers: {
          zeeq: {
            auth: "oauth",
            tokens: { access_token: "at-oauth", token_type: "Bearer" },
            extraHeaders: { "x-zeeq-prompts-repo": "wonderly/mobile" },
          },
        },
      }),
    );

    const gateway = new McpGateway({
      paseoHome,
      oauthRedirectBaseUrl: "http://daemon.example.test:6767",
      config: {
        enabled: true,
        servers: { zeeq: { url: fixture.url, transport: "http", auth: "oauth", critical: true } },
      },
    });

    await gateway.start();

    expect(gateway.getServerState("zeeq")?.status).toBe("connected");
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

  test("emits change with the new snapshot when a server's status transitions", async () => {
    const gateway = new McpGateway({
      paseoHome: createTempHome(),
      config: {
        enabled: true,
        servers: { zeeq: { url: "http://127.0.0.1:1/mcp", transport: "http", critical: true } },
      },
    });

    const changes: unknown[] = [];
    gateway.on("change", (snapshot) => changes.push(snapshot));

    await gateway.start();

    // Each real transition notifies: disabled -> connecting -> needs-auth (no stored tokens).
    expect(changes).toEqual([
      [{ name: "zeeq", status: "connecting", critical: true, lastChangedAt: expect.any(Number) }],
      [{ name: "zeeq", status: "needs-auth", critical: true, lastChangedAt: expect.any(Number) }],
    ]);
  });

  test("does not re-emit change for a redundant reconnect() once already connected", async () => {
    const fixture = await startFixtureMcpServer({
      expectedAuthorizationHeader: "Bearer late-secret",
    });
    const paseoHome = createTempHome();
    const tokenStore = new McpGatewayTokenStore(paseoHome);
    tokenStore.saveStaticHeaders("slack", { Authorization: "Bearer late-secret" });

    const gateway = new McpGateway({
      paseoHome,
      config: {
        enabled: true,
        servers: { slack: { url: fixture.url, transport: "http", auth: "static" } },
      },
    });

    await gateway.start();
    expect(gateway.getServerState("slack")?.status).toBe("connected");

    const changes: unknown[] = [];
    gateway.on("change", (snapshot) => changes.push(snapshot));

    // Already connected: the state machine has no "connect again" transition, so this
    // is a no-op that must not re-emit a duplicate snapshot.
    await gateway.reconnect("slack");

    expect(changes).toEqual([]);
  });

  test("off() stops delivering further change events", async () => {
    const gateway = new McpGateway({
      paseoHome: createTempHome(),
      config: {
        enabled: true,
        servers: { zeeq: { url: "http://127.0.0.1:1/mcp", transport: "http" } },
      },
    });

    const changes: unknown[] = [];
    const listener = (snapshot: unknown) => changes.push(snapshot);
    gateway.on("change", listener);
    gateway.off("change", listener);

    await gateway.start();

    expect(changes).toEqual([]);
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

  describe("startAuthorization (U6)", () => {
    test("an unknown server name rejects instead of starting a flow for nothing", async () => {
      const gateway = new McpGateway({
        paseoHome: createTempHome(),
        config: { enabled: true, servers: {} },
        oauthRedirectBaseUrl: "https://daemon.example.test",
      });

      await expect(gateway.startAuthorization("never-configured")).rejects.toThrow(
        /Unknown MCP gateway server/,
      );
    });

    test("a static-auth server rejects: its credential is a stored header, not an interactive flow", async () => {
      const gateway = new McpGateway({
        paseoHome: createTempHome(),
        config: {
          enabled: true,
          servers: { slack: { url: "http://127.0.0.1:1/mcp", transport: "http", auth: "static" } },
        },
        oauthRedirectBaseUrl: "https://daemon.example.test",
      });

      await expect(gateway.startAuthorization("slack")).rejects.toThrow(/static auth/);
    });

    test("an oauth-class server returns an authorization URL carrying a PKCE challenge (R6, happy path)", async () => {
      const authServer = await startOAuthAuthorizationServer();
      const gateway = new McpGateway({
        paseoHome: createTempHome(),
        config: {
          enabled: true,
          servers: { fixture: { url: authServer.url, transport: "http", auth: "oauth" } },
        },
        oauthRedirectBaseUrl: "https://daemon.example.test",
      });

      const result = await gateway.startAuthorization("fixture");

      const authorizationUrl = new URL(result.authorizationUrl);
      expect(authorizationUrl.searchParams.get("code_challenge")).toBeTruthy();
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        "https://daemon.example.test/mcp/gateway/oauth/callback",
      );
    });
  });
});

describe("criticality notifications (U5)", () => {
  test("a critical server going to needs-auth fires exactly one push", async () => {
    const push = createFakePushSender();
    const gateway = new McpGateway({
      paseoHome: createTempHome(),
      config: {
        enabled: true,
        servers: {
          zeeq: {
            url: "http://127.0.0.1:1/mcp",
            transport: "http",
            auth: "static",
            critical: true,
          },
        },
      },
      notifier: { pushNotificationSender: push.sender, serverId: "server-1" },
    });

    await gateway.start();

    expect(gateway.getServerState("zeeq")?.status).toBe("needs-auth");
    expect(push.sent).toEqual([
      {
        title: "MCP server needs re-authentication",
        body: "zeeq lost its connection and needs you to sign in again.",
        data: { serverId: "server-1", name: "zeeq", reason: "mcp_gateway_needs_auth" },
      },
    ]);
  });

  test("a non-critical server going to needs-auth fires no push", async () => {
    const push = createFakePushSender();
    const gateway = new McpGateway({
      paseoHome: createTempHome(),
      config: {
        enabled: true,
        servers: {
          github: { url: "http://127.0.0.1:1/mcp", transport: "http", auth: "static" },
        },
      },
      notifier: { pushNotificationSender: push.sender, serverId: "server-1" },
    });

    await gateway.start();

    expect(gateway.getServerState("github")?.status).toBe("needs-auth");
    expect(push.sent).toEqual([]);
  });

  test("a repeat sweep that lands back in needs-auth without recovering does not re-fire", async () => {
    const push = createFakePushSender();
    const paseoHome = createTempHome();
    const gateway = new McpGateway({
      paseoHome,
      config: {
        enabled: true,
        servers: {
          zeeq: {
            url: "http://127.0.0.1:1/mcp",
            transport: "http",
            auth: "static",
            critical: true,
          },
        },
      },
      notifier: { pushNotificationSender: push.sender, serverId: "server-1" },
    });

    await gateway.start();
    expect(push.sent).toHaveLength(1);

    // Still no stored token: reconnect() cycles needs-auth -> connecting -> needs-auth again,
    // the same unhealthy episode as before — must not fire a second push.
    await gateway.reconnect("zeeq");
    expect(gateway.getServerState("zeeq")?.status).toBe("needs-auth");
    expect(push.sent).toHaveLength(1);
  });

  test("more than 3 transitions in one connect pass batch into a single push", async () => {
    const push = createFakePushSender();
    const gateway = new McpGateway({
      paseoHome: createTempHome(),
      config: {
        enabled: true,
        servers: {
          zeeq: {
            url: "http://127.0.0.1:1/mcp",
            transport: "http",
            auth: "static",
            critical: true,
          },
          agentGateway: {
            url: "http://127.0.0.1:1/mcp",
            transport: "http",
            auth: "static",
            critical: true,
          },
          github: {
            url: "http://127.0.0.1:1/mcp",
            transport: "http",
            auth: "static",
            critical: true,
          },
          slack: {
            url: "http://127.0.0.1:1/mcp",
            transport: "http",
            auth: "static",
            critical: true,
          },
        },
      },
      notifier: { pushNotificationSender: push.sender, serverId: "server-1" },
    });

    await gateway.start();

    expect(push.sent).toEqual([
      {
        title: "Multiple MCP servers need attention",
        body: "4 critical MCP servers lost their connection.",
        data: {
          serverId: "server-1",
          name: expect.any(String),
          names: expect.arrayContaining(["zeeq", "agentGateway", "github", "slack"]),
          reason: "mcp_gateway_multi",
        },
      },
    ]);
  });

  test("omitting a notifier sends no pushes but still tracks state normally", async () => {
    const gateway = new McpGateway({
      paseoHome: createTempHome(),
      config: {
        enabled: true,
        servers: {
          zeeq: {
            url: "http://127.0.0.1:1/mcp",
            transport: "http",
            auth: "static",
            critical: true,
          },
        },
      },
    });

    await expect(gateway.start()).resolves.toBeUndefined();
    expect(gateway.getServerState("zeeq")?.status).toBe("needs-auth");
  });
});

describe("evaluateTransitionNotification (U5 pure episode logic)", () => {
  test("fires exactly once for a critical server entering an unhealthy status", () => {
    const first = evaluateTransitionNotification({
      status: "needs-auth",
      critical: true,
      alreadyNotified: false,
    });
    expect(first).toEqual({ notify: true, nextNotified: true });

    const repeat = evaluateTransitionNotification({
      status: "needs-auth",
      critical: true,
      alreadyNotified: first.nextNotified,
    });
    expect(repeat).toEqual({ notify: false, nextNotified: true });
  });

  test("never fires for a non-critical server", () => {
    expect(
      evaluateTransitionNotification({
        status: "needs-auth",
        critical: false,
        alreadyNotified: false,
      }),
    ).toEqual({ notify: false, nextNotified: false });
    expect(
      evaluateTransitionNotification({ status: "error", critical: false, alreadyNotified: false }),
    ).toEqual({ notify: false, nextNotified: false });
  });

  test("reaching connected re-arms the episode for the next unhealthy transition", () => {
    const notified = evaluateTransitionNotification({
      status: "needs-auth",
      critical: true,
      alreadyNotified: false,
    });
    expect(notified.nextNotified).toBe(true);

    const recovered = evaluateTransitionNotification({
      status: "connected",
      critical: true,
      alreadyNotified: notified.nextNotified,
    });
    expect(recovered).toEqual({ notify: false, nextNotified: false });

    const secondEpisode = evaluateTransitionNotification({
      status: "error",
      critical: true,
      alreadyNotified: recovered.nextNotified,
    });
    expect(secondEpisode).toEqual({ notify: true, nextNotified: true });
  });

  test("intermediate connecting/disabled statuses leave the episode flag untouched", () => {
    expect(
      evaluateTransitionNotification({
        status: "connecting",
        critical: true,
        alreadyNotified: true,
      }),
    ).toEqual({ notify: false, nextNotified: true });
    expect(
      evaluateTransitionNotification({
        status: "disabled",
        critical: true,
        alreadyNotified: false,
      }),
    ).toEqual({ notify: false, nextNotified: false });
  });
});

describe("adoptServer (session-reported server → brokered)", () => {
  test("an OAuth-class definition lands in needs-auth, keeps its extra headers privately, persists, and emits change", async () => {
    const home = createTempHome();
    const persisted: Array<{ name: string; config: unknown }> = [];
    const gateway = new McpGateway({
      paseoHome: home,
      config: { enabled: true, servers: {} },
      oauthRedirectBaseUrl: "https://daemon.example.test",
      persistServer: (name, config) => void persisted.push({ name, config }),
    });
    const snapshots: McpGatewaySnapshotEntry[][] = [];
    gateway.on("change", (snapshot) => {
      snapshots.push(snapshot);
    });

    const result = await gateway.adoptServer({
      name: "zeeq",
      url: "http://127.0.0.1:1/mcp",
      transport: "http",
      headers: { "x-zeeq-prompts-repo": "wonderly/prompts" },
    });

    expect(result).toEqual({ status: "needs-auth", auth: "oauth" });
    expect(gateway.getServerNames()).toEqual(["zeeq"]);
    expect(persisted).toEqual([
      {
        name: "zeeq",
        config: {
          url: "http://127.0.0.1:1/mcp",
          transport: "http",
          critical: false,
          auth: "oauth",
        },
      },
    ]);
    expect(new McpGatewayTokenStore(home).getOAuthExtraHeaders("zeeq")).toEqual({
      "x-zeeq-prompts-repo": "wonderly/prompts",
    });
    expect(snapshots.at(-1)?.map((entry) => entry.name)).toEqual(["zeeq"]);
    // Adoptable, so the strip's Authenticate button has somewhere to go next.
    await expect(gateway.startAuthorization("zeeq")).rejects.toThrow();
  });

  test("an Authorization header makes the adopted server static-auth and connects it outright", async () => {
    const fixture = await startFixtureMcpServer({
      expectedAuthorizationHeader: "Bearer from-mcp-json",
    });
    const gateway = new McpGateway({
      paseoHome: createTempHome(),
      config: { enabled: true, servers: {} },
    });

    const result = await gateway.adoptServer({
      name: "internal-tool",
      url: fixture.url,
      transport: "http",
      headers: { Authorization: "Bearer from-mcp-json" },
    });

    expect(result).toEqual({ status: "connected", auth: "static" });
    expect(gateway.getClient("internal-tool")).toBeDefined();
  });

  test("adopting an already-brokered name changes nothing", async () => {
    const gateway = new McpGateway({
      paseoHome: createTempHome(),
      config: {
        enabled: true,
        servers: { github: { url: "http://127.0.0.1:1/mcp", transport: "http" } },
      },
    });
    await gateway.start();

    const result = await gateway.adoptServer({
      name: "github",
      url: "http://somewhere.else/mcp",
      transport: "sse",
    });

    expect(result).toEqual({ status: "needs-auth", auth: "oauth" });
    expect(gateway.getServerNames()).toEqual(["github"]);
  });

  test("a disabled gateway refuses to adopt", async () => {
    const gateway = new McpGateway({ paseoHome: createTempHome(), config: { enabled: false } });
    await expect(
      gateway.adoptServer({ name: "x", url: "http://127.0.0.1:1/mcp", transport: "http" }),
    ).rejects.toThrow(/disabled/);
  });
});
