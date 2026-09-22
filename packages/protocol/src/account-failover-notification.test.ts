import { describe, expect, test } from "vitest";
import {
  buildAccountFailoverNotificationPayload,
  buildAccountFailoverReturnNotificationPayload,
} from "./account-failover-notification.js";

const BASE = {
  serverId: "server-1",
  workspaceId: "ws-1",
  oldAgentId: "agent-old",
  oldAgentTitle: "Build failover",
  newAgentId: "agent-old",
  targetProviderId: "claude-personal",
};

describe("buildAccountFailoverNotificationPayload", () => {
  test("a move that restarted reads as finished business", () => {
    const payload = buildAccountFailoverNotificationPayload(BASE);

    expect(payload.title).toBe("Agent moved to a new account");
    expect(payload.body).toBe(
      "Build failover hit its account's usage limit and now runs on claude-personal, " +
        "still as agent-old.",
    );
    // No hint at all when there is nothing to do: an app reading `outcome` sees undefined.
    expect(payload.data.outcome).toBeUndefined();
  });

  test("a move that never restarted says so and says what to do", () => {
    const payload = buildAccountFailoverNotificationPayload({ ...BASE, resumed: false });

    expect(payload.title).toBe("Agent moved but did not restart");
    expect(payload.body).toContain("could not be restarted");
    expect(payload.body).toContain("send any message to continue");
    expect(payload.data.outcome).toBe("needs_prompt");
  });

  test("an app that ignores `outcome` still gets the whole story from body and agentId", () => {
    // The old-client contract: `outcome` is additive, so a client that never reads it behaves
    // exactly as it did before — it renders `body` verbatim and taps through to `agentId`.
    const payload = buildAccountFailoverNotificationPayload({
      ...BASE,
      newAgentId: "agent-new",
      resumed: false,
    });

    const { outcome, ...withoutOutcome } = payload.data;
    expect(outcome).toBe("needs_prompt");
    expect(withoutOutcome).toEqual({
      serverId: "server-1",
      workspaceId: "ws-1",
      agentId: "agent-new",
      reason: "account_failover",
    });
    expect(payload.body).toContain("moved from agent-old to agent-new on claude-personal");
    expect(payload.body).toContain("could not be restarted");
  });
});

describe("buildAccountFailoverReturnNotificationPayload", () => {
  test("names both ends of the round trip and why it happened now", () => {
    const payload = buildAccountFailoverReturnNotificationPayload({
      serverId: "server-1",
      workspaceId: "ws-1",
      agentId: "agent-1",
      agentTitle: "Build failover",
      homeProviderId: "claude",
      fromProviderId: "claude-personal",
    });

    expect(payload.title).toBe("Agent returned to its own account");
    expect(payload.body).toBe(
      "Build failover went back to claude from claude-personal now that claude's usage " +
        "window has reset.",
    );
    expect(payload.data).toEqual({
      serverId: "server-1",
      workspaceId: "ws-1",
      agentId: "agent-1",
      reason: "account_failover",
      outcome: "returned_home",
    });
  });

  test("rides the rescue's reason so an app that never heard of returns still renders it", () => {
    const payload = buildAccountFailoverReturnNotificationPayload({
      serverId: "server-1",
      agentId: "agent-1",
      agentTitle: null,
      homeProviderId: "claude",
      fromProviderId: "claude-backup",
    });

    expect(payload.data.reason).toBe("account_failover");
    expect(payload.data.workspaceId).toBeUndefined();
    // An unrecognised `outcome` reads as no hint, and `body` carries the whole story either way.
    expect(payload.body).toContain("An agent went back to claude");
  });
});
