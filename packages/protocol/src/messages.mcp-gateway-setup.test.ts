import { describe, expect, test } from "vitest";
import {
  MutableDaemonConfigPatchSchema,
  McpGatewaySetupDescribeRequestSchema,
  McpGatewaySetupLocalTokenRequestSchema,
  McpGatewaySetupSaveClientRequestSchema,
  McpGatewayStatusEntrySchema,
  SessionInboundMessageSchema,
} from "./messages.js";

describe("mcp_gateway.setup requests", () => {
  test("describe needs a server name", () => {
    const base = { type: "mcp_gateway.setup.describe.request", requestId: "r1" };
    expect(McpGatewaySetupDescribeRequestSchema.safeParse({ ...base, name: "slack" }).success).toBe(
      true,
    );
    expect(McpGatewaySetupDescribeRequestSchema.safeParse(base).success).toBe(false);
    expect(McpGatewaySetupDescribeRequestSchema.safeParse({ ...base, name: "" }).success).toBe(
      false,
    );
  });

  test("save_client accepts a public client with no secret, redirect or scope", () => {
    const parsed = McpGatewaySetupSaveClientRequestSchema.parse({
      type: "mcp_gateway.setup.save_client.request",
      requestId: "r2",
      name: "slack",
      clientId: "123.456",
    });
    expect(parsed.clientSecret).toBeUndefined();
    expect(parsed.redirectUrl).toBeUndefined();
    expect(parsed.scope).toBeUndefined();
  });

  test("local_token names a preset and carries the token", () => {
    const message = {
      type: "mcp_gateway.setup.set_local_token.request",
      requestId: "r3",
      name: "figma",
      preset: "figma",
      token: "figd_fake-token-value",
    };
    expect(McpGatewaySetupLocalTokenRequestSchema.parse(message)).toEqual(message);
    expect(
      McpGatewaySetupLocalTokenRequestSchema.safeParse({ ...message, preset: undefined }).success,
    ).toBe(false);
  });

  test("all three are part of the inbound session union", () => {
    for (const message of [
      { type: "mcp_gateway.setup.describe.request", requestId: "r", name: "slack" },
      {
        type: "mcp_gateway.setup.save_client.request",
        requestId: "r",
        name: "slack",
        clientId: "id",
      },
      {
        type: "mcp_gateway.setup.set_local_token.request",
        requestId: "r",
        name: "figma",
        preset: "figma",
        token: "t",
      },
    ]) {
      expect(SessionInboundMessageSchema.safeParse(message).success).toBe(true);
    }
  });
});

describe("mcp_gateway.setup responses", () => {
  test("round-trip through the generated outbound validator and carry no secret fields", async () => {
    const { validateWSOutboundMessage } = await import("./validation/ws-outbound.js");
    const messages = [
      {
        type: "mcp_gateway.setup.describe.response",
        payload: {
          requestId: "r1",
          error: null,
          redirectUrl: "http://localhost:6767/mcp/gateway/oauth/callback",
          clientIdSet: true,
          clientSecretSet: true,
          scope: "users:read",
          tokenSet: false,
        },
      },
      {
        type: "mcp_gateway.setup.save_client.response",
        payload: { requestId: "r2", error: null },
      },
      {
        type: "mcp_gateway.setup.set_local_token.response",
        payload: { requestId: "r3", error: "boom", reason: "install_failed", status: null },
      },
    ];
    for (const message of messages) {
      expect(validateWSOutboundMessage({ type: "session", message }).success).toBe(true);
    }
  });
});

describe("status entry setup hint", () => {
  test("an entry without it still parses (old daemon)", () => {
    const parsed = McpGatewayStatusEntrySchema.parse({
      name: "figma",
      status: "needs-auth",
      critical: false,
      lastChangedAt: 1,
    });
    expect(parsed.setup).toBeUndefined();
  });

  test("accepts the two setup kinds and rejects anything else", () => {
    const entry = { name: "slack", status: "needs-auth", critical: false, lastChangedAt: 1 };
    expect(
      McpGatewayStatusEntrySchema.safeParse({ ...entry, setup: "client_credentials" }).success,
    ).toBe(true);
    expect(McpGatewayStatusEntrySchema.safeParse({ ...entry, setup: "local_token" }).success).toBe(
      true,
    );
    expect(McpGatewayStatusEntrySchema.safeParse({ ...entry, setup: "other" }).success).toBe(false);
  });
});

describe("config patch removeMcpGatewayServers", () => {
  test("is optional and a patch without it parses unchanged", () => {
    const patch = { mcpGateway: { servers: { zeeq: { critical: true } } } };
    expect(MutableDaemonConfigPatchSchema.parse(patch).removeMcpGatewayServers).toBeUndefined();
  });

  test("carries server names to drop", () => {
    const parsed = MutableDaemonConfigPatchSchema.parse({ removeMcpGatewayServers: ["figma"] });
    expect(parsed.removeMcpGatewayServers).toEqual(["figma"]);
  });
});
