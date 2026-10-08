import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import express from "express";
import {
  auth as runOAuthOrchestration,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { DemoInMemoryAuthProvider } from "@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js";
import {
  InvalidClientError,
  InvalidGrantError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { McpGatewayTokenStore } from "./token-store.js";
import {
  McpGatewayOAuthStateStore,
  MissingOAuthClientError,
  createGatewayOAuthClientProvider,
  describeOAuthFailure,
} from "./oauth.js";

function writeTokenFile(paseoHome: string, servers: Record<string, unknown>): void {
  const filePath = path.join(paseoHome, "mcp-gateway", "tokens.json");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ version: 1, servers }), { mode: 0o600 });
}

const tempDirs: string[] = [];

function createTempHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-mcp-gateway-oauth-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("McpGatewayOAuthStateStore", () => {
  test("consuming a freshly created state returns the server name it was minted for", () => {
    const store = new McpGatewayOAuthStateStore();
    const state = store.create("github", 0);
    expect(store.consume(state, 10)).toBe("github");
  });

  test("a state value is single-use: the second consume fails even though the first succeeded", () => {
    const store = new McpGatewayOAuthStateStore();
    const state = store.create("github", 0);
    store.consume(state, 10);
    expect(store.consume(state, 20)).toBeUndefined();
  });

  test("consuming an unknown state returns undefined", () => {
    const store = new McpGatewayOAuthStateStore();
    expect(store.consume("never-issued", 0)).toBeUndefined();
  });

  test("a state expires after its TTL and can never be consumed", () => {
    const store = new McpGatewayOAuthStateStore(5 * 60_000);
    const state = store.create("zeeq", 0);
    expect(store.consume(state, 5 * 60_000 + 1)).toBeUndefined();
  });

  test("two servers get independent, non-colliding state values", () => {
    const store = new McpGatewayOAuthStateStore();
    const githubState = store.create("github", 0);
    const zeeqState = store.create("zeeq", 0);
    expect(githubState).not.toBe(zeeqState);
    expect(store.consume(zeeqState, 1)).toBe("zeeq");
    expect(store.consume(githubState, 1)).toBe("github");
  });

  test("starting a second flow for the same server invalidates the first's state (last-start-wins)", () => {
    const store = new McpGatewayOAuthStateStore();
    const first = store.create("zeeq", 0);
    const second = store.create("zeeq", 0);
    expect(first).not.toBe(second);
    // The earlier device's callback hits the existing unknown/expired-state path cleanly.
    expect(store.consume(first, 1)).toBeUndefined();
    expect(store.consume(second, 1)).toBe("zeeq");
  });

  test("invalidateFor removes a server's state without touching other servers'", () => {
    const store = new McpGatewayOAuthStateStore();
    const zeeqState = store.create("zeeq", 0);
    const githubState = store.create("github", 0);
    store.invalidateFor("zeeq");
    expect(store.consume(zeeqState, 1)).toBeUndefined();
    expect(store.consume(githubState, 1)).toBe("github");
  });
});

describe("createGatewayOAuthClientProvider", () => {
  function buildProvider(serverName: string) {
    const tokenStore = new McpGatewayTokenStore(createTempHome());
    const stateStore = new McpGatewayOAuthStateStore();
    const provider = createGatewayOAuthClientProvider({
      serverName,
      tokenStore,
      stateStore,
      redirectUrl: "https://daemon.example.test/mcp/gateway/oauth/callback",
    });
    return { provider, tokenStore, stateStore };
  }

  test("exposes the configured redirect URL and client metadata", () => {
    const { provider } = buildProvider("github");
    expect(provider.redirectUrl).toBe("https://daemon.example.test/mcp/gateway/oauth/callback");
    expect(provider.clientMetadata.redirect_uris).toEqual([
      "https://daemon.example.test/mcp/gateway/oauth/callback",
    ]);
  });

  test("state() mints a state bound to this server via the shared state store", async () => {
    const { provider, stateStore } = buildProvider("github");
    const state = await provider.state?.();
    expect(typeof state).toBe("string");
    expect(stateStore.consume(state as string)).toBe("github");
  });

  test("tokens()/saveTokens() round-trip through the token store", async () => {
    const { provider, tokenStore } = buildProvider("github");
    await provider.saveTokens({ access_token: "at-1", token_type: "Bearer" });
    expect(await provider.tokens()).toEqual({ access_token: "at-1", token_type: "Bearer" });
    expect(tokenStore.getOAuthTokens("github")).toEqual({
      access_token: "at-1",
      token_type: "Bearer",
    });
  });

  test("clientInformation()/saveClientInformation() round-trip through the token store", async () => {
    const { provider } = buildProvider("github");
    expect(await provider.clientInformation()).toBeUndefined();
    await provider.saveClientInformation?.({
      client_id: "client-1",
      redirect_uris: ["https://daemon.example.test/mcp/gateway/oauth/callback"],
    });
    expect(await provider.clientInformation()).toEqual({
      client_id: "client-1",
      redirect_uris: ["https://daemon.example.test/mcp/gateway/oauth/callback"],
    });
  });

  test("a pre-registered client is returned to the SDK, which is what skips dynamic registration", async () => {
    const paseoHome = createTempHome();
    writeTokenFile(paseoHome, {
      slack: {
        auth: "oauth",
        clientCredentials: { clientId: "slack-app-id", clientSecret: "slack-app-secret" },
      },
    });
    const provider = createGatewayOAuthClientProvider({
      serverName: "slack",
      tokenStore: new McpGatewayTokenStore(paseoHome),
      stateStore: new McpGatewayOAuthStateStore(),
      redirectUrl: "https://daemon.example.test/mcp/gateway/oauth/callback",
    });

    expect(await provider.clientInformation()).toEqual({
      client_id: "slack-app-id",
      client_secret: "slack-app-secret",
    });
  });

  test("a pre-registered client's own redirect URI replaces the one the daemon derived", async () => {
    const paseoHome = createTempHome();
    writeTokenFile(paseoHome, {
      slack: {
        auth: "oauth",
        clientCredentials: {
          clientId: "slack-app-id",
          redirectUrl: "http://localhost:6767/mcp/gateway/oauth/callback",
        },
      },
    });
    const provider = createGatewayOAuthClientProvider({
      serverName: "slack",
      tokenStore: new McpGatewayTokenStore(paseoHome),
      stateStore: new McpGatewayOAuthStateStore(),
      redirectUrl: "http://127.0.0.1:6767/mcp/gateway/oauth/callback",
    });

    expect(provider.redirectUrl).toBe("http://localhost:6767/mcp/gateway/oauth/callback");
    expect(provider.clientMetadata.redirect_uris).toEqual([
      "http://localhost:6767/mcp/gateway/oauth/callback",
    ]);
  });

  test("a pre-registered client outranks a client the daemon registered dynamically", async () => {
    const paseoHome = createTempHome();
    writeTokenFile(paseoHome, {
      slack: {
        auth: "oauth",
        clientCredentials: { clientId: "slack-app-id" },
        clientInformation: {
          client_id: "stale-dcr-client",
          redirect_uris: ["https://daemon.example.test/mcp/gateway/oauth/callback"],
        },
      },
    });
    const provider = createGatewayOAuthClientProvider({
      serverName: "slack",
      tokenStore: new McpGatewayTokenStore(paseoHome),
      stateStore: new McpGatewayOAuthStateStore(),
      redirectUrl: "https://daemon.example.test/mcp/gateway/oauth/callback",
    });

    expect(await provider.clientInformation()).toEqual({ client_id: "slack-app-id" });
  });

  test("saveCodeVerifier()/codeVerifier() round-trip through the token store", async () => {
    const { provider } = buildProvider("github");
    await provider.saveCodeVerifier("verifier-1");
    expect(await provider.codeVerifier()).toBe("verifier-1");
  });

  test("codeVerifier() throws when nothing was saved, rather than returning an empty PKCE value", () => {
    const { provider } = buildProvider("github");
    expect(() => provider.codeVerifier()).toThrow();
  });

  test("a second flow's state() clobbers the first's code verifier, but only the second's state survives to exchange against it", async () => {
    const tokenStore = new McpGatewayTokenStore(createTempHome());
    const stateStore = new McpGatewayOAuthStateStore();
    const redirectUrl = "https://daemon.example.test/mcp/gateway/oauth/callback";
    const deviceA = createGatewayOAuthClientProvider({
      serverName: "zeeq",
      tokenStore,
      stateStore,
      redirectUrl,
    });
    const deviceB = createGatewayOAuthClientProvider({
      serverName: "zeeq",
      tokenStore,
      stateStore,
      redirectUrl,
    });

    const stateA = (await deviceA.state?.()) as string;
    await deviceA.saveCodeVerifier("verifier-a");

    const stateB = (await deviceB.state?.()) as string;
    await deviceB.saveCodeVerifier("verifier-b");

    // Device A's state was invalidated the moment device B started a new flow.
    expect(stateStore.consume(stateA)).toBeUndefined();
    expect(stateStore.consume(stateB)).toBe("zeeq");
    // The token store only ever holds one verifier per server, and it's the latest one —
    // the same one the only state that can still consume would exchange against.
    expect(await deviceB.codeVerifier()).toBe("verifier-b");
  });

  test("redirectToAuthorization() invokes the onRedirect hook instead of navigating a browser", () => {
    const tokenStore = new McpGatewayTokenStore(createTempHome());
    const stateStore = new McpGatewayOAuthStateStore();
    const onRedirect = vi.fn();
    const provider = createGatewayOAuthClientProvider({
      serverName: "github",
      tokenStore,
      stateStore,
      redirectUrl: "https://daemon.example.test/mcp/gateway/oauth/callback",
      onRedirect,
    });

    const url = new URL("https://github.com/login/oauth/authorize?client_id=x");
    provider.redirectToAuthorization(url);
    expect(onRedirect).toHaveBeenCalledWith(url);
  });
});

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

type RefreshBehavior = "succeed" | "invalid_grant" | "invalid_client";

/**
 * The SDK's demo provider with a controllable `exchangeRefreshToken` — the one call this suite
 * needs to force into each of the SDK's three recoverable-error shapes (dead refresh token,
 * dead client, a refresh that just works) to prove `invalidateCredentials` reacts correctly to
 * each.
 */
class ConfigurableRefreshAuthProvider extends DemoInMemoryAuthProvider {
  refreshBehavior: RefreshBehavior = "succeed";

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    if (this.refreshBehavior === "invalid_grant") {
      throw new InvalidGrantError("refresh token is no longer valid");
    }
    if (this.refreshBehavior === "invalid_client") {
      throw new InvalidClientError("client is no longer recognized");
    }
    return {
      access_token: randomUUID(),
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: (scopes ?? []).join(" "),
    };
  }
}

interface FakeOAuthServer {
  url: string;
  provider: ConfigurableRefreshAuthProvider;
  close: () => Promise<void>;
}

/** A real discovery + DCR + authorize + token-exchange authorization server (KTD2/KTD3's
 * fixture pattern), minus the MCP resource server — this suite never calls a tool, only
 * `auth()`. */
async function startFakeOAuthServer(): Promise<FakeOAuthServer> {
  const port = await getAvailablePort();
  const baseUrl = new URL(`http://127.0.0.1:${port}`);
  const resourceUrl = new URL("/mcp", baseUrl);
  const provider = new ConfigurableRefreshAuthProvider();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: baseUrl,
      resourceServerUrl: resourceUrl,
      scopesSupported: ["mcp:tools"],
    }),
  );

  const httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const server = app.listen(port, "127.0.0.1", () => resolve(server));
  });

  return {
    url: resourceUrl.toString(),
    provider,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

/**
 * Drives a real first sign-in to completion (discovery, DCR, authorize, code exchange) so the
 * token store ends up in the state a previously-connected server would be in. The demo
 * provider's code exchange never issues a refresh token, so one is spliced in afterward — this
 * suite is specifically about what happens when that refresh token later turns out to be dead.
 */
async function signInOnce(params: {
  fixtureUrl: string;
  provider: OAuthClientProvider;
  serverName: string;
  tokenStore: McpGatewayTokenStore;
}): Promise<void> {
  const { fixtureUrl, provider, serverName, tokenStore } = params;
  let capturedUrl: URL | undefined;
  const bootstrapProvider: OAuthClientProvider = {
    ...provider,
    redirectToAuthorization: (url: URL) => {
      capturedUrl = url;
    },
  };
  const started = await runOAuthOrchestration(bootstrapProvider, { serverUrl: fixtureUrl });
  if (started !== "REDIRECT" || !capturedUrl) {
    throw new Error("Expected initial sign-in to redirect");
  }

  const authorizeResponse = await fetch(capturedUrl.toString(), { redirect: "manual" });
  const redirectLocation = authorizeResponse.headers.get("location");
  if (!redirectLocation) {
    throw new Error("Fixture authorize endpoint did not redirect");
  }
  const code = new URL(redirectLocation).searchParams.get("code");
  if (!code) {
    throw new Error("Fixture callback carried no authorization code");
  }

  const exchanged = await runOAuthOrchestration(provider, {
    serverUrl: fixtureUrl,
    authorizationCode: code,
  });
  if (exchanged !== "AUTHORIZED") {
    throw new Error("Expected code exchange to authorize");
  }

  const tokens = tokenStore.getOAuthTokens(serverName);
  if (!tokens) {
    throw new Error("Expected tokens to be stored after a successful exchange");
  }
  tokenStore.saveOAuthTokens(serverName, { ...tokens, refresh_token: "initial-refresh-token" });
}

describe("invalidateCredentials (recovering from a dead refresh token or client)", () => {
  async function buildSignedInProvider(fixtureUrl: string) {
    const tokenStore = new McpGatewayTokenStore(
      mkdtempSync(path.join(tmpdir(), "paseo-mcp-gateway-invalidate-")),
    );
    const stateStore = new McpGatewayOAuthStateStore();
    let capturedUrl: URL | undefined;
    const provider = createGatewayOAuthClientProvider({
      serverName: "fixture",
      tokenStore,
      stateStore,
      redirectUrl: "https://daemon.example.test/mcp/gateway/oauth/callback",
      onRedirect: (url) => {
        capturedUrl = url;
      },
    });
    await signInOnce({ fixtureUrl, provider, serverName: "fixture", tokenStore });
    return {
      tokenStore,
      provider,
      getCapturedUrl: () => capturedUrl,
      resetCapturedUrl: () => {
        capturedUrl = undefined;
      },
    };
  }

  test("a dead refresh token (invalid_grant) clears stored tokens and ends in a fresh authorization URL", async () => {
    const fixture = await startFakeOAuthServer();
    try {
      const { tokenStore, provider, getCapturedUrl, resetCapturedUrl } =
        await buildSignedInProvider(fixture.url);
      expect(tokenStore.getOAuthTokens("fixture")).toBeDefined();

      fixture.provider.refreshBehavior = "invalid_grant";
      resetCapturedUrl();

      const result = await runOAuthOrchestration(provider, { serverUrl: fixture.url });

      expect(result).toBe("REDIRECT");
      expect(getCapturedUrl()).toBeInstanceOf(URL);
      expect(tokenStore.getOAuthTokens("fixture")).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  test("a dead client (invalid_client) clears tokens and client info, then re-registers for the fresh authorization", async () => {
    const fixture = await startFakeOAuthServer();
    try {
      const { tokenStore, provider, getCapturedUrl, resetCapturedUrl } =
        await buildSignedInProvider(fixture.url);
      const originalClientId = tokenStore.getClientInformation("fixture")?.client_id;
      expect(originalClientId).toBeDefined();

      fixture.provider.refreshBehavior = "invalid_client";
      resetCapturedUrl();

      const result = await runOAuthOrchestration(provider, { serverUrl: fixture.url });

      expect(result).toBe("REDIRECT");
      expect(getCapturedUrl()).toBeInstanceOf(URL);
      expect(tokenStore.getOAuthTokens("fixture")).toBeUndefined();
      // Invalidating "all" drops the stale registration too, so the retry's discovery finds no
      // client and dynamically registers a new one rather than reusing the dead one.
      expect(tokenStore.getClientInformation("fixture")?.client_id).toBeDefined();
      expect(tokenStore.getClientInformation("fixture")?.client_id).not.toBe(originalClientId);
    } finally {
      await fixture.close();
    }
  });

  test("a good refresh token still refreshes silently, with no redirect and no cleared tokens", async () => {
    const fixture = await startFakeOAuthServer();
    try {
      const { tokenStore, provider, getCapturedUrl, resetCapturedUrl } =
        await buildSignedInProvider(fixture.url);
      const tokensBefore = tokenStore.getOAuthTokens("fixture");

      fixture.provider.refreshBehavior = "succeed";
      resetCapturedUrl();

      const result = await runOAuthOrchestration(provider, { serverUrl: fixture.url });

      expect(result).toBe("AUTHORIZED");
      expect(getCapturedUrl()).toBeUndefined();
      const tokensAfter = tokenStore.getOAuthTokens("fixture");
      expect(tokensAfter).toBeDefined();
      expect(tokensAfter?.access_token).not.toBe(tokensBefore?.access_token);
    } finally {
      await fixture.close();
    }
  });
});

describe("MissingOAuthClientError", () => {
  test("tells the operator what to supply and where, not what the SDK could not do", () => {
    const error = new MissingOAuthClientError(
      "slack",
      "https://daemon.example.test/mcp/gateway/oauth/callback",
      "/home/t/.paseo/mcp-gateway/tokens.json",
    );

    expect(error.message).toContain('"slack"');
    expect(error.message).toContain("https://daemon.example.test/mcp/gateway/oauth/callback");
    // The resolved path, not "$PASEO_HOME/…" the reader would have to expand themselves.
    expect(error.message).toContain("/home/t/.paseo/mcp-gateway/tokens.json");
    expect(error.message).toContain("clientCredentials");
    // The SDK's own phrasing ("Incompatible auth server") names a limitation with no next step.
    expect(error.message).not.toContain("Incompatible auth server");
    // It leads with what to do, not with what the server does not support.
    expect(error.message.indexOf("needs an OAuth app you register yourself")).toBeLessThan(
      error.message.indexOf("does not support dynamic client registration"),
    );
  });
});

describe("describeOAuthFailure", () => {
  test("humanises the SDK's parse failure into the refusal it was actually reporting", () => {
    // Verbatim shape from client/auth.js `parseErrorResponse` when a body is not OAuth JSON.
    const sdkError = new Error(
      "HTTP 403: Invalid OAuth error response: SyntaxError: Unexpected token 'F', " +
        '"Forbidden" is not valid JSON. Raw body: Forbidden',
    );

    expect(describeOAuthFailure("figma", sdkError)).toEqual({
      reason: "server_rejected",
      message: "figma refused the sign-in request with HTTP 403 and said: Forbidden.",
    });
  });

  test("keeps the status code, which is the only part of that message worth reading", () => {
    const described = describeOAuthFailure(
      "figma",
      new Error("HTTP 503: Invalid OAuth error response: SyntaxError: boom. Raw body: "),
    );

    expect(described.message).toBe(
      "figma refused the sign-in request with HTTP 503 and gave no reason.",
    );
  });

  test("clips a long upstream body instead of pasting a whole error page into the strip", () => {
    const described = describeOAuthFailure(
      "figma",
      new Error(
        `HTTP 500: Invalid OAuth error response: SyntaxError: boom. Raw body: ${"<html>".repeat(80)}`,
      ),
    );

    expect(described.message.length).toBeLessThan(220);
    expect(described.message).toContain("…");
  });

  test("names an unreachable server separately from one that refused", () => {
    const network = new Error("fetch failed");
    (network as Error & { cause?: unknown }).cause = new Error(
      "getaddrinfo ENOTFOUND mcp.figma.com",
    );

    expect(describeOAuthFailure("figma", network).reason).toBe("server_unreachable");
  });

  test("falls back to the error's own message when it is already a real OAuth description", () => {
    expect(describeOAuthFailure("figma", new Error("The user denied the request"))).toEqual({
      reason: "authorization_failed",
      message: "The user denied the request",
    });
  });

  test("says something when the server sent an OAuth error with no description at all", () => {
    const bare = new Error("");
    bare.name = "AccessDeniedError";

    expect(describeOAuthFailure("figma", bare)).toEqual({
      reason: "server_rejected",
      message: "figma refused the sign-in request (AccessDeniedError).",
    });
  });
});
