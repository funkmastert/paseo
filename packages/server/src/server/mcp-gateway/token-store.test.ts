import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

  test("forgetClientInformation drops a dynamic registration and keeps everything else", () => {
    const store = new McpGatewayTokenStore(createTempHome());
    store.saveClientInformation("zeeq", {
      client_id: "client-1",
      redirect_uris: ["https://daemon.example.test/mcp/gateway/oauth/callback"],
    });
    store.saveOAuthTokens("zeeq", { access_token: "token-1", token_type: "Bearer" });

    store.forgetClientInformation("zeeq");

    expect(store.getClientInformation("zeeq")).toBeUndefined();
    expect(store.getOAuthTokens("zeeq")).toEqual({ access_token: "token-1", token_type: "Bearer" });
  });

  test("round-trips static auth header values, never touching config", () => {
    const paseoHome = createTempHome();
    const store = new McpGatewayTokenStore(paseoHome);

    store.saveStaticHeaders("slack", { Authorization: "Bearer static-secret" });

    expect(store.getStaticHeaders("slack")).toEqual({ Authorization: "Bearer static-secret" });
    expect(store.getOAuthTokens("slack")).toBeUndefined();
  });

  test("getOAuthExtraHeaders reads operator-seeded extra headers, undefined otherwise", () => {
    const paseoHome = createTempHome();
    const store = new McpGatewayTokenStore(paseoHome);
    store.saveOAuthTokens("github", { access_token: "at-1", token_type: "Bearer" });
    store.saveStaticHeaders("slack", { Authorization: "Bearer s" });

    const tokensPath = path.join(paseoHome, TOKENS_RELATIVE_PATH);
    const file = JSON.parse(readFileSync(tokensPath, "utf8"));
    file.servers.zeeq = {
      auth: "oauth",
      extraHeaders: { "x-zeeq-prompts-repo": "wonderly/mobile" },
    };
    writeFileSync(tokensPath, JSON.stringify(file));

    const reloaded = new McpGatewayTokenStore(paseoHome);
    expect(reloaded.getOAuthExtraHeaders("zeeq")).toEqual({
      "x-zeeq-prompts-repo": "wonderly/mobile",
    });
    expect(reloaded.getOAuthExtraHeaders("github")).toBeUndefined();
    expect(reloaded.getOAuthExtraHeaders("slack")).toBeUndefined();
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

  test("a hand-written pre-registered client record is readable and keeps the rest of the file", () => {
    const paseoHome = createTempHome();
    const filePath = path.join(paseoHome, TOKENS_RELATIVE_PATH);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        servers: {
          slack: {
            auth: "oauth",
            clientCredentials: { clientId: "slack-app-id", clientSecret: "slack-app-secret" },
          },
          zeeq: { auth: "oauth", tokens: { access_token: "at-1", token_type: "Bearer" } },
        },
      }),
      { mode: 0o600 },
    );

    const store = new McpGatewayTokenStore(paseoHome);
    expect(store.getClientCredentials("slack")).toEqual({
      clientId: "slack-app-id",
      clientSecret: "slack-app-secret",
    });
    // A typo in one server's record must not take the whole file down with it, so prove the
    // neighbouring record still reads after a hand edit.
    expect(store.getOAuthTokens("zeeq")).toEqual({ access_token: "at-1", token_type: "Bearer" });
  });

  test("a pre-registered client without a secret is accepted — public clients have none", () => {
    const paseoHome = createTempHome();
    const filePath = path.join(paseoHome, TOKENS_RELATIVE_PATH);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        servers: { slack: { auth: "oauth", clientCredentials: { clientId: "public-app" } } },
      }),
      { mode: 0o600 },
    );

    expect(new McpGatewayTokenStore(paseoHome).getClientCredentials("slack")).toEqual({
      clientId: "public-app",
    });
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
