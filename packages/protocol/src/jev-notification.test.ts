import { describe, expect, it } from "vitest";
import { buildJevBudgetExhaustedNotificationPayload } from "./jev-notification.js";

describe("buildJevBudgetExhaustedNotificationPayload", () => {
  it("names the lane, the top feature and the local reset time", () => {
    const payload = buildJevBudgetExhaustedNotificationPayload({
      serverId: "server-1",
      lane: "control",
      laneLabel: "control",
      topFeature: "spawnHint",
      resetsAtLocal: "12:00 AM",
    });

    expect(payload.title).toBe("JEV budget spent");
    expect(payload.body).toBe(
      "The control lane hit its daily budget, mostly on spawnHint. Resets at 12:00 AM.",
    );
    expect(payload.data).toEqual({
      serverId: "server-1",
      reason: "jev_budget_exhausted",
      lane: "control",
    });
  });

  it("omits the feature clause when no feature dominated", () => {
    const payload = buildJevBudgetExhaustedNotificationPayload({
      serverId: "server-1",
      lane: "agentTools",
      laneLabel: "agent tools",
      topFeature: null,
      resetsAtLocal: "12:00 AM",
    });

    expect(payload.body).toBe("The agent tools lane hit its daily budget. Resets at 12:00 AM.");
  });
});
