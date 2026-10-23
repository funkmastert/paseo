import { describe, expect, it } from "vitest";
import {
  buildBatchedMcpGatewayNotificationPayload,
  buildMcpGatewayNotificationPayload,
} from "./mcp-notification.js";

describe("buildMcpGatewayNotificationPayload", () => {
  it("builds a needs-auth notification", () => {
    const payload = buildMcpGatewayNotificationPayload({
      serverId: "srv-1",
      name: "zeeq",
      status: "needs-auth",
    });

    expect(payload).toEqual({
      title: "MCP server needs re-authentication",
      body: "zeeq lost its connection and needs you to sign in again.",
      data: {
        serverId: "srv-1",
        name: "zeeq",
        reason: "mcp_gateway_needs_auth",
      },
    });
  });

  it("builds an error (unavailable) notification", () => {
    const payload = buildMcpGatewayNotificationPayload({
      serverId: "srv-1",
      name: "agent-gateway",
      status: "error",
    });

    expect(payload).toEqual({
      title: "MCP server is unavailable",
      body: "agent-gateway stopped responding.",
      data: {
        serverId: "srv-1",
        name: "agent-gateway",
        reason: "mcp_gateway_error",
      },
    });
  });
});

describe("buildBatchedMcpGatewayNotificationPayload", () => {
  it("builds a combined notification carrying every server name", () => {
    const payload = buildBatchedMcpGatewayNotificationPayload({
      serverId: "srv-1",
      transitions: [
        { name: "zeeq" },
        { name: "agent-gateway" },
        { name: "github" },
        { name: "slack" },
      ],
    });

    expect(payload).toEqual({
      title: "Multiple MCP servers need attention",
      body: "4 critical MCP servers lost their connection.",
      data: {
        serverId: "srv-1",
        name: "zeeq",
        names: ["zeeq", "agent-gateway", "github", "slack"],
        reason: "mcp_gateway_multi",
      },
    });
  });

  it("throws when given no transitions", () => {
    expect(() =>
      buildBatchedMcpGatewayNotificationPayload({ serverId: "srv-1", transitions: [] }),
    ).toThrow();
  });
});
