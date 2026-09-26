import { describe, expect, test } from "vitest";
import {
  MutableDaemonConfigPatchSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

const usage = {
  provider: "claude",
  model: "claude-opus-5-5[1m]",
  capturedAt: "2026-09-24T23:21:54.742Z",
  source: "session",
  totalTokens: 174085,
  maxTokens: 1000000,
  categories: [
    { id: "system_tools", label: "System tools", tokens: 23754, kind: "used" },
    { id: "messages", label: "Messages", tokens: 130302, kind: "used" },
    { id: "free_space", label: "Free space", tokens: 790633, kind: "free" },
  ],
  memoryFiles: [{ path: "/repo/CLAUDE.md", type: "Project", tokens: 8580 }],
};

describe("agent.context_usage.read", () => {
  test("routes the request through the session inbound union", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "agent.context_usage.read.request",
      requestId: "req-1",
      agentId: "agent-1",
    });

    expect(parsed.type).toBe("agent.context_usage.read.request");
  });

  test("rejects a request without an agent", () => {
    const result = SessionInboundMessageSchema.safeParse({
      type: "agent.context_usage.read.request",
      requestId: "req-1",
      agentId: "",
    });

    expect(result.success).toBe(false);
  });

  test("routes a captured breakdown through the session outbound union", () => {
    const message = {
      type: "agent.context_usage.read.response",
      payload: { requestId: "req-1", agentId: "agent-1", status: "captured", usage, error: null },
    };

    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  test("accepts a status and a row kind this client does not know", () => {
    const message = {
      type: "agent.context_usage.read.response",
      payload: {
        requestId: "req-1",
        agentId: "agent-1",
        status: "some_future_status",
        usage: {
          ...usage,
          categories: [{ id: "new_row", label: "New row", tokens: 1, kind: "some_future_kind" }],
        },
        error: null,
      },
    };

    expect(SessionOutboundMessageSchema.safeParse(message).success).toBe(true);
  });

  test("an older daemon's server_info parses without the capability", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv",
      features: { usageHistory: true },
    });

    expect(parsed.features?.agentContextUsage).toBeUndefined();
  });

  test("the context meter thresholds patch through daemon config", () => {
    const parsed = MutableDaemonConfigPatchSchema.parse({
      contextMeter: { amberTokens: 150000, redPercent: 75 },
    });

    expect(parsed.contextMeter).toEqual({ amberTokens: 150000, redPercent: 75 });
  });
});
