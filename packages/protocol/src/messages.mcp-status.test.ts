import { describe, expect, test } from "vitest";
import {
  McpGatewayStatusEntrySchema,
  McpStatusUpdateMessageSchema,
  SessionEventSubscriptionSchema,
} from "./messages.js";

describe("mcp_status_update message schema", () => {
  test("accepts a per-server status entry", () => {
    const parsed = McpGatewayStatusEntrySchema.parse({
      name: "zeeq",
      status: "needs-auth",
      critical: true,
      lastChangedAt: 1_700_000_000_000,
    });

    expect(parsed).toEqual({
      name: "zeeq",
      status: "needs-auth",
      critical: true,
      lastChangedAt: 1_700_000_000_000,
    });
  });

  test("carries an optional error alongside an error status", () => {
    const parsed = McpGatewayStatusEntrySchema.parse({
      name: "github",
      status: "error",
      critical: false,
      lastChangedAt: 1,
      error: "connection refused",
    });

    expect(parsed.error).toBe("connection refused");
  });

  test("rejects a status outside the gateway's state machine", () => {
    const result = McpGatewayStatusEntrySchema.safeParse({
      name: "zeeq",
      status: "authenticated", // not one of state.ts's McpGatewayServerStatus values
      critical: false,
      lastChangedAt: 1,
    });

    expect(result.success).toBe(false);
  });

  test("parses a full mcp_status_update message", () => {
    const message = {
      type: "mcp_status_update",
      payload: {
        servers: [
          { name: "zeeq", status: "connected", critical: true, lastChangedAt: 1 },
          { name: "github", status: "needs-auth", critical: false, lastChangedAt: 2 },
        ],
        generatedAt: "2026-09-12T00:00:00.000Z",
      },
    };

    expect(McpStatusUpdateMessageSchema.parse(message)).toEqual(message);
  });

  test("is a registered session event subscription", () => {
    expect(SessionEventSubscriptionSchema.options).toContain("mcp_status_update");
  });

  test("round-trips through the generated outbound validator", async () => {
    const { validateWSOutboundMessage } = await import("./validation/ws-outbound.js");
    const message = {
      type: "mcp_status_update",
      payload: {
        servers: [{ name: "zeeq", status: "needs-auth", critical: true, lastChangedAt: 1 }],
        generatedAt: "2026-09-12T00:00:00.000Z",
      },
    };

    const result = validateWSOutboundMessage({ type: "session", message });
    expect(result.success).toBe(true);
  });

  test("the generated outbound validator rejects an unknown status value", async () => {
    const { validateWSOutboundMessage } = await import("./validation/ws-outbound.js");
    const message = {
      type: "mcp_status_update",
      payload: {
        servers: [{ name: "zeeq", status: "bogus", critical: true, lastChangedAt: 1 }],
        generatedAt: "2026-09-12T00:00:00.000Z",
      },
    };

    const result = validateWSOutboundMessage({ type: "session", message });
    expect(result.success).toBe(false);
  });
});
