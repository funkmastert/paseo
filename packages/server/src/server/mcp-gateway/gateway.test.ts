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
  McpGatewayUpstreamUnavailableError,
  type McpGatewaySnapshotEntry,
} from "./gateway.js";
import { McpGatewayTokenStore } from "./token-store.js";
import { McpGatewayActionError } from "./action-failure.js";

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
async function startOAuthAuthorizationServer(options?: {
  /** false drops `registration_endpoint` from the metadata, the way an upstream without DCR
   * advertises itself — which is what makes the SDK ask for a hand-registered client. */
  supportsRegistration?: boolean;
  /** Advertise registration and then refuse it, with a non-JSON body, exactly as Figma does. */
  registrationStatus?: number;
  /** Scopes the authorization server advertises; the resource keeps advertising `mcp:tools`. */
  authorizationServerScopes?: string[];
}): Promise<{ url: string }> {
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
  if (options?.supportsRegistration === false) {
    app.use((_req, res, next) => {
      const sendJson = res.json.bind(res);
      res.json = (body: unknown) => {
        if (body && typeof body === "object" && "registration_endpoint" in body) {
          const { registration_endpoint: _dropped, ...rest } = body as Record<string, unknown>;
          return sendJson(rest);
        }
        return sendJson(body);
      };
      next();
    });
  }
  const authorizationServerScopes = options?.authorizationServerScopes;
  if (authorizationServerScopes) {
    // Zeeq's shape: the protected resource names only its own scope, while the authorization
    // server also lists `offline_access`.
    app.use((_req, res, next) => {
      const sendJson = res.json.bind(res);
      res.json = (body: unknown) => {
        if (body && typeof body === "object" && "issuer" in body) {
          return sendJson({ ...body, scopes_supported: authorizationServerScopes });
        }
        return sendJson(body);
      };
      next();
    });
  }
  if (options?.registrationStatus !== undefined) {
    const status = options.registrationStatus;
    app.post("/register", (_req, res) => {
      // Content-Type says JSON, body is the bare word — the shape that produced the SDK's
      // "Invalid OAuth error response: SyntaxError" in the strip.
      res.status(status).type("application/json").send("Forbidden");
    });
  }
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

/**
 * A real MCP upstream whose access token can expire under a live connection, with an optional
 * refresh-token grant on its own authorization server. `/mcp` answers only `Bearer <accepted>`;
 * `setAcceptedToken` is the upstream expiring the token the gateway holds. Everything else
 * 404s, as a server without protected-resource metadata does, so the SDK falls back to the
 * origin's `/authorize` and `/token` exactly as it would in the field.
 */
async function startExpiringOAuthUpstream(options: {
  acceptedToken: string;
  refresh?: { refreshToken: string; nextAccessToken: string };
}): Promise<{ url: string; setAcceptedToken(token: string): void; refreshGrants: number }> {
  const mcpServer = new McpServer({ name: "expiring-mcp-server", version: "1.0.0" });
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

  const state = { acceptedToken: options.acceptedToken, refreshGrants: 0 };
  const httpServer = http.createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? "/", "http://fixture").pathname;
      if (pathname === "/token" && req.method === "POST" && options.refresh) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        if (
          form.get("grant_type") !== "refresh_token" ||
          form.get("refresh_token") !== options.refresh.refreshToken
        ) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        state.refreshGrants += 1;
        state.acceptedToken = options.refresh.nextAccessToken;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: options.refresh.nextAccessToken,
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
        return;
      }
      if (pathname !== "/mcp") {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${state.acceptedToken}`) {
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

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    setAcceptedToken: (token) => {
      state.acceptedToken = token;
    },
    get refreshGrants() {
      return state.refreshGrants;
    },
  };
}

/** A dynamic registration as the token store holds one, for servers the SDK must not re-register. */
function storedRegistration(scope?: string) {
  return {
    client_id: "registered-client",
    redirect_uris: ["https://daemon.example.test/mcp/gateway/oauth/callback"],
    ...(scope === undefined ? {} : { scope }),
  };
}

/** The typed failure a gateway action rejected with, for asserting on `reason` and `remedy`. */
async function actionFailureOf(operation: Promise<unknown>): Promise<McpGatewayActionError> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(McpGatewayActionError);
  return caught as McpGatewayActionError;
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
      await expect(gateway.startAuthorization("never-configured")).rejects.toMatchObject({
        reason: "unknown_server",
      });
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

      await expect(gateway.startAuthorization("slack")).rejects.toMatchObject({
        reason: "static_auth",
      });
    });

    test("names the reason for every way starting sign-in can fail", async () => {
      const home = createTempHome();
      const withoutRedirectBase = new McpGateway({
        paseoHome: home,
        config: {
          enabled: true,
          servers: { fixture: { url: "http://127.0.0.1:1/mcp", transport: "http", auth: "oauth" } },
        },
      });

      // Nothing the daemon can hand an upstream as a callback target.
      await expect(withoutRedirectBase.startAuthorization("fixture")).rejects.toMatchObject({
        reason: "no_redirect_url",
      });

      // An upstream that is not listening at all is unreachable, not unauthenticated.
      const unreachable = new McpGateway({
        paseoHome: home,
        config: {
          enabled: true,
          servers: { fixture: { url: "http://127.0.0.1:1/mcp", transport: "http", auth: "oauth" } },
        },
        oauthRedirectBaseUrl: "https://daemon.example.test",
      });
      const failure = await actionFailureOf(unreachable.startAuthorization("fixture"));
      expect(failure.reason).toBe("server_unreachable");
      expect(failure.message).not.toContain("SyntaxError");
    });

    test("says the provider refused to register us when it offers registration and then 403s", async () => {
      // Figma, measured on the wire: discovery succeeds, the metadata advertises
      // `registration_endpoint`, and the POST to it answers `403 Forbidden` to every payload
      // shape including an empty body and a bearer token. Its docs say only clients in Figma's
      // own catalog may connect, so no credential or config on this host is the answer — which
      // makes this a different failure from `client_not_registered`.
      const authServer = await startOAuthAuthorizationServer({ registrationStatus: 403 });
      const gateway = new McpGateway({
        paseoHome: createTempHome(),
        config: {
          enabled: true,
          servers: { figma: { url: authServer.url, transport: "http", auth: "oauth" } },
        },
        oauthRedirectBaseUrl: "https://daemon.example.test",
      });

      const failure = await actionFailureOf(gateway.startAuthorization("figma"));

      expect(failure.reason).toBe("client_registration_refused");
      expect(failure.message).toContain("refused to register Paseo as a client");
      expect(failure.message).toContain("HTTP 403");
      // Nothing to change on this host, so no remedy is offered — offering one would be a lie.
      expect(failure.remedy).toEqual({});
      // And never the SDK's parse failure about the non-JSON body.
      expect(failure.message).not.toContain("SyntaxError");
    });

    test("asks for a hand-registered OAuth app, naming the redirect URI and the file to write", async () => {
      const authServer = await startOAuthAuthorizationServer({ supportsRegistration: false });
      const home = createTempHome();
      const gateway = new McpGateway({
        paseoHome: home,
        config: {
          enabled: true,
          servers: { slack: { url: authServer.url, transport: "http", auth: "oauth" } },
        },
        oauthRedirectBaseUrl: "https://daemon.example.test",
      });

      const failure = await actionFailureOf(gateway.startAuthorization("slack"));

      expect(failure.reason).toBe("client_not_registered");
      expect(failure.remedy).toEqual({
        redirectUrl: "https://daemon.example.test/mcp/gateway/oauth/callback",
        path: path.join(home, "mcp-gateway", "tokens.json"),
      });
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

describe("token lifecycle", () => {
  test("an expired access token is refreshed on the 401 and the new token is persisted", async () => {
    const upstream = await startExpiringOAuthUpstream({
      acceptedToken: "fresh-token",
      refresh: { refreshToken: "refresh-1", nextAccessToken: "fresh-token" },
    });
    const home = createTempHome();
    const tokenStore = new McpGatewayTokenStore(home);
    tokenStore.saveClientInformation("linear", storedRegistration());
    tokenStore.saveOAuthTokens("linear", {
      access_token: "expired-token",
      token_type: "Bearer",
      refresh_token: "refresh-1",
    });
    const gateway = new McpGateway({
      paseoHome: home,
      config: { enabled: true, servers: { linear: { url: upstream.url, transport: "http" } } },
      oauthRedirectBaseUrl: "https://daemon.example.test",
    });

    await gateway.start();

    expect(gateway.getServerState("linear")?.status).toBe("connected");
    expect(upstream.refreshGrants).toBe(1);
    // Persisted, and the refresh token kept when the upstream did not rotate it — the next
    // daemon boot starts from the renewed login instead of the expired one.
    expect(new McpGatewayTokenStore(home).getOAuthTokens("linear")).toMatchObject({
      access_token: "fresh-token",
      refresh_token: "refresh-1",
    });
  });

  test("a login that expires mid-session with no refresh token moves the server to needs-auth and pushes once", async () => {
    const upstream = await startExpiringOAuthUpstream({ acceptedToken: "hour-token" });
    const push = createFakePushSender();
    const home = createTempHome();
    const tokenStore = new McpGatewayTokenStore(home);
    tokenStore.saveClientInformation("zeeq", storedRegistration("mcp:tools"));
    tokenStore.saveOAuthTokens("zeeq", { access_token: "hour-token", token_type: "Bearer" });
    const gateway = new McpGateway({
      paseoHome: home,
      config: {
        enabled: true,
        servers: { zeeq: { url: upstream.url, transport: "http", critical: true } },
      },
      oauthRedirectBaseUrl: "https://daemon.example.test",
      notifier: { pushNotificationSender: push.sender, serverId: "server-1" },
    });
    await gateway.start();
    expect(gateway.getServerState("zeeq")?.status).toBe("connected");

    // Someone presses Authenticate in the strip; then an agent's call meets the expired token.
    const inFlightState = await gateway.buildOAuthProvider("zeeq").state?.();
    tokenStore.saveCodeVerifier("zeeq", "verifier-from-the-strip");
    upstream.setAcceptedToken("next-hour-token");

    await expect(
      Promise.all([
        gateway.requestUpstream("zeeq", (client) => client.listTools()),
        gateway.requestUpstream("zeeq", (client) => client.listTools()),
      ]),
    ).rejects.toBeInstanceOf(McpGatewayUpstreamUnavailableError);

    expect(gateway.getServerState("zeeq")?.status).toBe("needs-auth");
    expect(push.sent.map((payload) => payload.data.name)).toEqual(["zeeq"]);
    // The background 401 did not start a sign-in of its own over the one in the browser.
    expect(tokenStore.getCodeVerifier("zeeq")).toBe("verifier-from-the-strip");
    expect(inFlightState && gateway.consumeOAuthState(inFlightState)).toBe("zeeq");
    await expect(
      gateway.requestUpstream("zeeq", (client) => client.listTools()),
    ).rejects.toBeInstanceOf(McpGatewayUpstreamUnavailableError);
  });

  test("a failure that is not about the login leaves the server connected", async () => {
    const upstream = await startExpiringOAuthUpstream({ acceptedToken: "good-token" });
    const home = createTempHome();
    const tokenStore = new McpGatewayTokenStore(home);
    tokenStore.saveClientInformation("zeeq", storedRegistration());
    tokenStore.saveOAuthTokens("zeeq", { access_token: "good-token", token_type: "Bearer" });
    const gateway = new McpGateway({
      paseoHome: home,
      config: { enabled: true, servers: { zeeq: { url: upstream.url, transport: "http" } } },
      oauthRedirectBaseUrl: "https://daemon.example.test",
    });
    await gateway.start();

    await expect(
      gateway.requestUpstream("zeeq", async () => {
        throw new Error("tool blew up");
      }),
    ).rejects.toThrow("tool blew up");
    expect(gateway.getServerState("zeeq")?.status).toBe("connected");
  });

  test("sign-in asks for offline_access when only the authorization server offers it", async () => {
    const authServer = await startOAuthAuthorizationServer({
      authorizationServerScopes: ["mcp:tools", "offline_access"],
    });
    const home = createTempHome();
    const tokenStore = new McpGatewayTokenStore(home);
    // A registration made before, for the narrower scope.
    tokenStore.saveClientInformation("zeeq", storedRegistration("mcp:tools"));
    const gateway = new McpGateway({
      paseoHome: home,
      config: { enabled: true, servers: { zeeq: { url: authServer.url, transport: "http" } } },
      oauthRedirectBaseUrl: "https://daemon.example.test",
    });

    const result = await gateway.startAuthorization("zeeq");

    const authorizationUrl = new URL(result.authorizationUrl);
    expect(authorizationUrl.searchParams.get("scope")).toBe("mcp:tools offline_access");
    // Registered again for the wider scope rather than sent to the browser to be refused.
    const registration = tokenStore.getClientInformation("zeeq");
    expect(registration?.client_id).not.toBe("registered-client");
    expect(authorizationUrl.searchParams.get("client_id")).toBe(registration?.client_id);
  });

  test("sign-in leaves the scope alone when offline_access is not on offer", async () => {
    const authServer = await startOAuthAuthorizationServer();
    const home = createTempHome();
    const tokenStore = new McpGatewayTokenStore(home);
    tokenStore.saveClientInformation("zeeq", storedRegistration("mcp:tools"));
    const gateway = new McpGateway({
      paseoHome: home,
      config: { enabled: true, servers: { zeeq: { url: authServer.url, transport: "http" } } },
      oauthRedirectBaseUrl: "https://daemon.example.test",
    });

    const result = await gateway.startAuthorization("zeeq");

    expect(new URL(result.authorizationUrl).searchParams.get("scope")).toBe("mcp:tools");
    expect(tokenStore.getClientInformation("zeeq")?.client_id).toBe("registered-client");
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
