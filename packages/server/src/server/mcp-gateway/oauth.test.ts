import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { McpGatewayTokenStore } from "./token-store.js";
import { McpGatewayOAuthStateStore, createGatewayOAuthClientProvider } from "./oauth.js";

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

  test("saveCodeVerifier()/codeVerifier() round-trip through the token store", async () => {
    const { provider } = buildProvider("github");
    await provider.saveCodeVerifier("verifier-1");
    expect(await provider.codeVerifier()).toBe("verifier-1");
  });

  test("codeVerifier() throws when nothing was saved, rather than returning an empty PKCE value", () => {
    const { provider } = buildProvider("github");
    expect(() => provider.codeVerifier()).toThrow();
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
