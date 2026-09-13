import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { PRIVATE_FILE_MODE } from "../private-files.js";
import { McpGatewayTokenStore } from "./token-store.js";

const MODE_MASK = 0o777;
const TOKENS_RELATIVE_PATH = path.join("mcp-gateway", "tokens.json");

const tempDirs: string[] = [];

function createTempHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-mcp-gateway-tokens-"));
  tempDirs.push(dir);
  return dir;
}

function modeOf(filePath: string): number {
  return statSync(filePath).mode & MODE_MASK;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("McpGatewayTokenStore", () => {
  test("returns undefined for a server with no stored tokens", () => {
    const store = new McpGatewayTokenStore(createTempHome());
    expect(store.getOAuthTokens("github")).toBeUndefined();
    expect(store.getStaticHeaders("slack")).toBeUndefined();
  });

  test("round-trips OAuth tokens and writes the file 0600", () => {
    const paseoHome = createTempHome();
    const store = new McpGatewayTokenStore(paseoHome);

    store.saveOAuthTokens("github", {
      access_token: "at-1",
      token_type: "Bearer",
      refresh_token: "rt-1",
    });

    expect(store.getOAuthTokens("github")).toEqual({
      access_token: "at-1",
      token_type: "Bearer",
      refresh_token: "rt-1",
    });
    expect(modeOf(path.join(paseoHome, TOKENS_RELATIVE_PATH))).toBe(PRIVATE_FILE_MODE);
  });

  test("tokens survive reload via a fresh store instance", () => {
    const paseoHome = createTempHome();
    new McpGatewayTokenStore(paseoHome).saveOAuthTokens("zeeq", {
      access_token: "at-2",
      token_type: "Bearer",
    });

    const reloaded = new McpGatewayTokenStore(paseoHome);
    expect(reloaded.getOAuthTokens("zeeq")).toEqual({
      access_token: "at-2",
      token_type: "Bearer",
    });
  });

  test("round-trips client information and code verifier alongside tokens", () => {
    const paseoHome = createTempHome();
    const store = new McpGatewayTokenStore(paseoHome);

    store.saveClientInformation("github", {
      client_id: "client-1",
      redirect_uris: ["https://daemon.example.test/mcp/gateway/oauth/callback"],
    });
    store.saveCodeVerifier("github", "verifier-1");

    expect(store.getClientInformation("github")).toEqual({
      client_id: "client-1",
      redirect_uris: ["https://daemon.example.test/mcp/gateway/oauth/callback"],
    });
    expect(store.getCodeVerifier("github")).toBe("verifier-1");
  });

  test("round-trips static auth header values, never touching config", () => {
    const paseoHome = createTempHome();
    const store = new McpGatewayTokenStore(paseoHome);

    store.saveStaticHeaders("slack", { Authorization: "Bearer static-secret" });

    expect(store.getStaticHeaders("slack")).toEqual({ Authorization: "Bearer static-secret" });
    expect(store.getOAuthTokens("slack")).toBeUndefined();
  });

  test("deleteServer removes only the named server's record", () => {
    const paseoHome = createTempHome();
    const store = new McpGatewayTokenStore(paseoHome);
    store.saveOAuthTokens("github", { access_token: "at-1", token_type: "Bearer" });
    store.saveOAuthTokens("zeeq", { access_token: "at-2", token_type: "Bearer" });

    store.deleteServer("github");

    expect(store.getOAuthTokens("github")).toBeUndefined();
    expect(store.getOAuthTokens("zeeq")).toEqual({ access_token: "at-2", token_type: "Bearer" });
  });

  test("a malformed token file fails closed to no tokens instead of crashing", () => {
    const paseoHome = createTempHome();
    const filePath = path.join(paseoHome, TOKENS_RELATIVE_PATH);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "{ not valid json", { mode: 0o600 });
    chmodSync(filePath, 0o600);

    const store = new McpGatewayTokenStore(paseoHome);
    expect(() => store.getOAuthTokens("github")).not.toThrow();
    expect(store.getOAuthTokens("github")).toBeUndefined();
  });

  test("a token file with the wrong shape fails closed instead of crashing", () => {
    const paseoHome = createTempHome();
    const filePath = path.join(paseoHome, TOKENS_RELATIVE_PATH);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ version: 1, servers: { github: { auth: "bogus" } } }),
      {
        mode: 0o600,
      },
    );

    const store = new McpGatewayTokenStore(paseoHome);
    expect(() => store.getOAuthTokens("github")).not.toThrow();
    expect(store.getOAuthTokens("github")).toBeUndefined();
  });

  test("writing after a malformed read still succeeds", () => {
    const paseoHome = createTempHome();
    const filePath = path.join(paseoHome, TOKENS_RELATIVE_PATH);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "not json at all", { mode: 0o600 });

    const store = new McpGatewayTokenStore(paseoHome);
    store.saveOAuthTokens("github", { access_token: "at-1", token_type: "Bearer" });

    expect(store.getOAuthTokens("github")).toEqual({ access_token: "at-1", token_type: "Bearer" });
  });
});
