import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DaemonConfigStore } from "../daemon-config-store.js";
import { loadPersistedConfig } from "../persisted-config.js";
import { McpGatewayActionError } from "./action-failure.js";
import { McpGateway, type McpGatewayConfig } from "./gateway.js";
import type { LocalServerLaunchSpec } from "./local-server-installer.js";
import {
  deriveCallbackUrl,
  McpGatewaySetupService,
  type McpGatewaySetupServiceOptions,
} from "./setup.js";
import { McpGatewayTokenStore } from "./token-store.js";

const tempDirs: string[] = [];
const gateways: McpGateway[] = [];

function createTempHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-mcp-setup-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (gateways.length > 0) await gateways.pop()?.stop();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const FIGMA_TOKEN = "figd_fake-token-do-not-use";
const SLACK_SECRET = "slack-fake-secret-do-not-use";

/** A real stdio MCP server whose only tool reports the env variables it can see. */
function writeEnvFixtureServer(): LocalServerLaunchSpec {
  const require = createRequire(import.meta.url);
  const dir = createTempHome();
  const script = path.join(dir, "fixture-stdio-server.cjs");
  writeFileSync(
    script,
    `
const { McpServer } = require(${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/server/mcp.js"))});
const { StdioServerTransport } = require(${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/server/stdio.js"))});
const { z } = require(${JSON.stringify(require.resolve("zod"))});
const server = new McpServer({ name: "fixture-stdio-server", version: "1.0.0" });
server.registerTool("env", { description: "Reports env", inputSchema: { names: z.array(z.string()) } },
  async ({ names }) => ({ content: [{ type: "text", text: JSON.stringify(Object.fromEntries(names.map((n) => [n, process.env[n] ?? null]))) }] }));
void server.connect(new StdioServerTransport());
`,
  );
  return { command: process.execPath, args: [script], env: {} };
}

interface Harness {
  paseoHome: string;
  gateway: McpGateway;
  tokenStore: McpGatewayTokenStore;
  configStore: DaemonConfigStore;
  service: McpGatewaySetupService;
  install: ReturnType<typeof vi.fn>;
}

const hostedConfig: McpGatewayConfig = {
  enabled: true,
  servers: {
    figma: { url: "https://mcp.figma.com/mcp", transport: "http", auth: "oauth" },
    slack: { url: "https://mcp.slack.com/mcp", transport: "http", auth: "oauth" },
    zeeq: { url: "https://zeeq.example.test/mcp", transport: "http" },
  },
};

async function createHarness(
  overrides: {
    config?: McpGatewayConfig;
    install?: McpGatewaySetupServiceOptions["install"];
    writeLocalServer?: McpGatewaySetupServiceOptions["writeLocalServer"];
    baseUrl?: string | null;
  } = {},
): Promise<Harness> {
  const paseoHome = createTempHome();
  const config = overrides.config ?? hostedConfig;
  writeFileSync(
    path.join(paseoHome, "config.json"),
    `${JSON.stringify({ version: 1, mcpGateway: config }, null, 2)}\n`,
  );
  const configStore = new DaemonConfigStore(
    paseoHome,
    {
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
      metadataGeneration: { providers: [] },
      mcpGateway: config,
    },
    undefined,
  );
  const tokenStore = new McpGatewayTokenStore(paseoHome);
  const gateway = new McpGateway({
    paseoHome,
    config,
    tokenStore,
    ...(overrides.baseUrl === null
      ? {}
      : { oauthRedirectBaseUrl: overrides.baseUrl ?? "http://127.0.0.1:6767" }),
  });
  gateways.push(gateway);
  await gateway.start();
  const install = vi.fn(overrides.install ?? (async () => writeEnvFixtureServer()));
  const service = new McpGatewaySetupService({
    paseoHome,
    gateway,
    tokenStore,
    install,
    writeLocalServer:
      overrides.writeLocalServer ??
      ((name, localConfig) => {
        configStore.patch({
          mcpGateway: { localServers: { [name]: localConfig } },
          removeMcpGatewayServers: [name],
        });
      }),
  });
  return { paseoHome, gateway, tokenStore, configStore, service, install };
}

function readTokenFile(paseoHome: string): unknown {
  return JSON.parse(readFileSync(path.join(paseoHome, "mcp-gateway", "tokens.json"), "utf8"));
}

async function failureOf(operation: unknown): Promise<McpGatewayActionError> {
  const result = await Promise.resolve(operation).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(McpGatewayActionError);
  return result as McpGatewayActionError;
}

describe("deriveCallbackUrl", () => {
  test("rewrites a loopback IP to localhost, keeping the daemon's own port", () => {
    expect(deriveCallbackUrl("http://127.0.0.1:6767")).toBe(
      "http://localhost:6767/mcp/gateway/oauth/callback",
    );
    expect(deriveCallbackUrl("http://127.0.0.1:7777")).toBe(
      "http://localhost:7777/mcp/gateway/oauth/callback",
    );
  });

  test("leaves a public base URL alone", () => {
    expect(deriveCallbackUrl("https://daemon.example.test")).toBe(
      "https://daemon.example.test/mcp/gateway/oauth/callback",
    );
  });
});

describe("setLocalToken", () => {
  test("installs, stores the token, switches figma to the local entry, and connects it", async () => {
    const harness = await createHarness();
    expect(harness.gateway.getServerState("figma")?.status).toBe("needs-auth");

    const result = await harness.service.setLocalToken({
      name: "figma",
      preset: "figma",
      token: `  ${FIGMA_TOKEN}\n`,
    });

    expect(result).toEqual({ status: "connected" });
    expect(harness.install).toHaveBeenCalledTimes(1);
    // The token file holds the token under the variable the preset names, never in config.
    expect(readTokenFile(harness.paseoHome)).toMatchObject({
      servers: { figma: { auth: "static", headers: {}, env: { FIGMA_API_KEY: FIGMA_TOKEN } } },
    });
    const persisted = loadPersistedConfig(harness.paseoHome);
    expect(persisted.mcpGateway?.servers?.figma).toBeUndefined();
    expect(persisted.mcpGateway?.localServers?.figma).toMatchObject({
      command: process.execPath,
      auth: "static",
    });
    expect(persisted.mcpGateway?.servers?.slack).toEqual(hostedConfig.servers?.slack);
    expect(JSON.stringify(persisted)).not.toContain(FIGMA_TOKEN);
    expect(JSON.stringify(harness.configStore.get())).not.toContain(FIGMA_TOKEN);
    // And the child really got it.
    const reply = (await harness.gateway
      .getClient("figma")
      ?.callTool({ name: "env", arguments: { names: ["FIGMA_API_KEY"] } })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(reply.content[0]?.text ?? "null")).toEqual({ FIGMA_API_KEY: FIGMA_TOKEN });
    // A bad token starts fine and fails on tool calls, so the form stays on offer to replace it.
    expect(harness.gateway.getSnapshot().find((entry) => entry.name === "figma")?.setup).toBe(
      "local_token",
    );
  });

  test("resolves the gateway's status when the swapped server did not start, with the token and config already written", async () => {
    const harness = await createHarness({
      install: async () => ({
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
        env: {},
      }),
    });

    const result = await harness.service.setLocalToken({
      name: "figma",
      preset: "figma",
      token: FIGMA_TOKEN,
    });

    expect(result).toEqual({ status: "error" });
    expect(harness.gateway.getServerState("figma")?.status).toBe("error");
    expect(harness.tokenStore.getStaticEnv("figma")).toMatchObject({ FIGMA_API_KEY: FIGMA_TOKEN });
    expect(loadPersistedConfig(harness.paseoHome).mcpGateway?.localServers?.figma).toMatchObject({
      auth: "static",
    });
  });

  test("a second call for a server that is still installing is refused, and the first completes", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await createHarness({
      install: async () => {
        await gate;
        return writeEnvFixtureServer();
      },
    });

    const first = harness.service.setLocalToken({
      name: "figma",
      preset: "figma",
      token: FIGMA_TOKEN,
    });
    const refused = await failureOf(
      harness.service.setLocalToken({ name: "figma", preset: "figma", token: "figd_second" }),
    );

    expect(refused.reason).toBe("setup_in_progress");
    expect(harness.install).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toEqual({ status: "connected" });
    // The refused call stored nothing of its own.
    expect(harness.tokenStore.getStaticEnv("figma")).toMatchObject({ FIGMA_API_KEY: FIGMA_TOKEN });
    // Once the first is done the name is free again.
    expect(
      await harness.service.setLocalToken({ name: "figma", preset: "figma", token: "figd_second" }),
    ).toEqual({ status: "connected" });
    expect(harness.tokenStore.getStaticEnv("figma")).toMatchObject({
      FIGMA_API_KEY: "figd_second",
    });
  });

  test("a failed call frees the name for a retry", async () => {
    let attempts = 0;
    const harness = await createHarness({
      install: async () => {
        attempts += 1;
        if (attempts === 1) throw new McpGatewayActionError("install_failed", "offline");
        return writeEnvFixtureServer();
      },
    });
    const failure = await failureOf(
      harness.service.setLocalToken({ name: "figma", preset: "figma", token: FIGMA_TOKEN }),
    );
    expect(failure.reason).toBe("install_failed");
    expect(
      await harness.service.setLocalToken({ name: "figma", preset: "figma", token: FIGMA_TOKEN }),
    ).toEqual({ status: "connected" });
  });

  test("keeps the launch spec's own env next to the token", async () => {
    const harness = await createHarness({
      install: async () => ({ ...writeEnvFixtureServer(), env: { ELECTRON_RUN_AS_NODE: "1" } }),
    });
    await harness.service.setLocalToken({ name: "figma", preset: "figma", token: FIGMA_TOKEN });
    expect(harness.tokenStore.getStaticEnv("figma")).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      FIGMA_API_KEY: FIGMA_TOKEN,
    });
  });

  test("an install failure changes nothing: hosted entry, token file and config stay as they were", async () => {
    const harness = await createHarness({
      install: async () => {
        throw new McpGatewayActionError("install_failed", "npm was not found");
      },
    });

    const failure = await failureOf(
      harness.service.setLocalToken({ name: "figma", preset: "figma", token: FIGMA_TOKEN }),
    );

    expect(failure.reason).toBe("install_failed");
    expect(harness.tokenStore.getStaticEnv("figma")).toBeUndefined();
    expect(loadPersistedConfig(harness.paseoHome).mcpGateway?.servers?.figma).toEqual(
      hostedConfig.servers?.figma,
    );
    expect(loadPersistedConfig(harness.paseoHome).mcpGateway?.localServers).toBeUndefined();
    expect(harness.gateway.getServerState("figma")?.status).toBe("needs-auth");
  });

  test("a config write failure is reported and leaves the live gateway on the hosted entry", async () => {
    const harness = await createHarness({
      writeLocalServer: () => {
        throw new Error("disk full");
      },
    });

    const failure = await failureOf(
      harness.service.setLocalToken({ name: "figma", preset: "figma", token: FIGMA_TOKEN }),
    );

    expect(failure.reason).toBe("config_write_failed");
    expect(failure.message).toContain("disk full");
    expect(failure.message).not.toContain(FIGMA_TOKEN);
    expect(harness.gateway.isRemoteServer("figma")).toBe(true);
  });

  test.each([
    ["an empty token", { token: "   " }, "invalid_input"],
    ["a token with a line break inside", { token: "figd_one\ntwo" }, "invalid_input"],
    ["an unknown preset", { preset: "nope" }, "no_local_preset"],
    ["an inherited property name as the preset", { preset: "toString" }, "no_local_preset"],
    ["a server name that is not a plain name", { name: "../escape" }, "invalid_input"],
  ])("rejects %s before installing anything", async (_label, patch, reason) => {
    const harness = await createHarness();

    const failure = await failureOf(
      harness.service.setLocalToken({
        name: "figma",
        preset: "figma",
        token: FIGMA_TOKEN,
        ...patch,
      }),
    );

    expect(failure.reason).toBe(reason);
    expect(harness.install).not.toHaveBeenCalled();
    expect(harness.tokenStore.getStaticEnv("figma")).toBeUndefined();
  });

  test("a disabled gateway refuses with gateway_disabled", async () => {
    const harness = await createHarness({ config: { enabled: false } });
    const failure = await failureOf(
      harness.service.setLocalToken({ name: "figma", preset: "figma", token: FIGMA_TOKEN }),
    );
    expect(failure.reason).toBe("gateway_disabled");
  });
});

describe("saveClient", () => {
  test("stores the app with the redirect and scope it was given, and the sign-in path stays open", async () => {
    const harness = await createHarness();
    expect(harness.gateway.getSnapshot().find((e) => e.name === "slack")?.setup).toBe(
      "client_credentials",
    );

    harness.service.saveClient({
      name: "slack",
      clientId: " 123.456 ",
      clientSecret: SLACK_SECRET,
      redirectUrl: "http://localhost:6767/mcp/gateway/oauth/callback",
      scope: "  users:read   search:read.public ",
    });

    expect(readTokenFile(harness.paseoHome)).toMatchObject({
      servers: {
        slack: {
          auth: "oauth",
          clientCredentials: {
            clientId: "123.456",
            clientSecret: SLACK_SECRET,
            redirectUrl: "http://localhost:6767/mcp/gateway/oauth/callback",
            scope: "users:read search:read.public",
          },
        },
      },
    });
    // Saved credentials can still be wrong, so the form stays on offer until a sign-in succeeds.
    expect(harness.gateway.getSnapshot().find((e) => e.name === "slack")?.setup).toBe(
      "client_credentials",
    );
    expect(JSON.stringify(loadPersistedConfig(harness.paseoHome))).not.toContain(SLACK_SECRET);
  });

  test("leaving the secret blank keeps the stored secret of the same app", async () => {
    const harness = await createHarness();
    harness.service.saveClient({
      name: "slack",
      clientId: "123.456",
      clientSecret: SLACK_SECRET,
      scope: "users:read",
    });

    harness.service.saveClient({ name: "slack", clientId: " 123.456 ", scope: "search:read" });

    expect(harness.tokenStore.getClientCredentials("slack")).toEqual({
      clientId: "123.456",
      clientSecret: SLACK_SECRET,
      scope: "search:read",
    });
    expect(harness.service.describe("slack").clientSecretSet).toBe(true);
  });

  test("a new secret replaces the stored one", async () => {
    const harness = await createHarness();
    harness.service.saveClient({ name: "slack", clientId: "123.456", clientSecret: SLACK_SECRET });
    harness.service.saveClient({
      name: "slack",
      clientId: "123.456",
      clientSecret: "slack-corrected",
    });
    expect(harness.tokenStore.getClientCredentials("slack")).toEqual({
      clientId: "123.456",
      clientSecret: "slack-corrected",
    });
  });

  test("a different client ID is a different app, so the old secret does not carry over", async () => {
    const harness = await createHarness();
    harness.service.saveClient({ name: "slack", clientId: "123.456", clientSecret: SLACK_SECRET });

    harness.service.saveClient({ name: "slack", clientId: "789.012" });

    expect(harness.tokenStore.getClientCredentials("slack")).toEqual({ clientId: "789.012" });
    expect(harness.service.describe("slack").clientSecretSet).toBe(false);
  });

  test("a public client needs no secret", async () => {
    const harness = await createHarness();
    harness.service.saveClient({ name: "slack", clientId: "123.456", clientSecret: "  " });
    expect(harness.tokenStore.getClientCredentials("slack")).toEqual({ clientId: "123.456" });
  });

  test.each([
    ["a missing client id", { clientId: "  " }, "invalid_input"],
    ["a redirect that is not a URL", { redirectUrl: "not a url" }, "invalid_input"],
    [
      "a redirect on another path",
      { redirectUrl: "http://localhost:6767/callback" },
      "invalid_input",
    ],
    [
      "a redirect that is not http",
      { redirectUrl: "ftp://localhost/mcp/gateway/oauth/callback" },
      "invalid_input",
    ],
    ["an unknown server", { name: "nope" }, "unknown_server"],
  ])("rejects %s", async (_label, patch, reason) => {
    const harness = await createHarness();
    const failure = await failureOf(
      Promise.resolve().then(() =>
        harness.service.saveClient({ name: "slack", clientId: "123.456", ...patch }),
      ),
    );
    expect(failure.reason).toBe(reason);
    expect(harness.tokenStore.getClientCredentials("slack")).toBeUndefined();
  });

  test("a local server has no OAuth app to register", async () => {
    const harness = await createHarness({
      config: { enabled: true, localServers: { tool: { command: "/nonexistent" } } },
    });
    const failure = await failureOf(
      Promise.resolve().then(() => harness.service.saveClient({ name: "tool", clientId: "x" })),
    );
    expect(failure.reason).toBe("server_is_local");
  });
});

describe("describe", () => {
  test("gives the localhost callback and the public client ID, and reports the secret and token as booleans only", async () => {
    const harness = await createHarness();
    expect(harness.service.describe("slack")).toEqual({
      redirectUrl: "http://localhost:6767/mcp/gateway/oauth/callback",
      clientIdSet: false,
      clientId: null,
      clientSecretSet: false,
      scope: null,
      tokenSet: false,
    });

    harness.service.saveClient({
      name: "slack",
      clientId: "123.456",
      clientSecret: SLACK_SECRET,
      scope: "users:read",
    });
    const described = harness.service.describe("slack");

    expect(described).toMatchObject({
      clientIdSet: true,
      clientId: "123.456",
      clientSecretSet: true,
      scope: "users:read",
    });
    expect(JSON.stringify(described)).not.toContain(SLACK_SECRET);
  });

  test("reports a stored token as a boolean", async () => {
    const harness = await createHarness();
    await harness.service.setLocalToken({ name: "figma", preset: "figma", token: FIGMA_TOKEN });
    const described = harness.service.describe("figma");
    expect(described.tokenSet).toBe(true);
    expect(JSON.stringify(described)).not.toContain(FIGMA_TOKEN);
  });

  test("uses the port the daemon is actually on", async () => {
    const harness = await createHarness({ baseUrl: "http://127.0.0.1:7123" });
    expect(harness.service.describe("slack").redirectUrl).toBe(
      "http://localhost:7123/mcp/gateway/oauth/callback",
    );
  });

  test("says why when there is nothing to describe", async () => {
    const noBase = await createHarness({ baseUrl: null });
    expect(
      (await failureOf(Promise.resolve().then(() => noBase.service.describe("slack")))).reason,
    ).toBe("no_redirect_url");
    const harness = await createHarness();
    expect(
      (await failureOf(Promise.resolve().then(() => harness.service.describe("nope")))).reason,
    ).toBe("unknown_server");
  });
});
