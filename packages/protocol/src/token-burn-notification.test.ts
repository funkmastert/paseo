import { describe, expect, it } from "vitest";
import {
  buildBatchedTokenBurnNotificationPayload,
  buildTokenBurnNotificationPayload,
} from "./token-burn-notification.js";

describe("buildTokenBurnNotificationPayload", () => {
  it("describes a rate breach as pace, in weighted tokens per minute", () => {
    const payload = buildTokenBurnNotificationPayload({
      serverId: "server-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      agentTitle: "Refactor the parser",
      trigger: "rate",
      ratePerMinute: 123_456,
    });

    expect(payload.title).toBe("Agent is burning tokens fast");
    expect(payload.body).toBe("Refactor the parser is burning 123K weighted tokens/min.");
    expect(payload.data).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      reason: "token_burn_rate",
    });
  });

  it("gives a cumulative-total breach its own title instead of claiming speed", () => {
    const payload = buildTokenBurnNotificationPayload({
      serverId: "server-1",
      agentId: "agent-1",
      agentTitle: null,
      trigger: "total",
      totalTokens: 5_000_000,
    });

    expect(payload.title).toBe("Agent has used a lot of tokens");
    expect(payload.body).toBe("An agent has used 5.0M weighted tokens this session.");
    expect(payload.data.reason).toBe("token_burn_total");
    expect(payload.data).not.toHaveProperty("workspaceId");
  });
});

describe("buildBatchedTokenBurnNotificationPayload", () => {
  it("collapses a storm into one push that still names every agent", () => {
    const payload = buildBatchedTokenBurnNotificationPayload({
      serverId: "server-1",
      breaches: [{ agentId: "agent-1", workspaceId: "workspace-1" }, { agentId: "agent-2" }],
    });

    expect(payload.title).toBe("Multiple agents are burning tokens fast");
    expect(payload.data.agentId).toBe("agent-1");
    expect(payload.data.agentIds).toEqual(["agent-1", "agent-2"]);
    expect(payload.data.reason).toBe("token_burn_multi");
  });

  it("refuses an empty batch", () => {
    expect(() =>
      buildBatchedTokenBurnNotificationPayload({ serverId: "server-1", breaches: [] }),
    ).toThrow();
  });
});
