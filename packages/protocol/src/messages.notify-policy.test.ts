import { describe, expect, test } from "vitest";
import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";
import { NOTIFY_LEVELS } from "./notify-policy/types.js";

describe("notification policy wire schemas", () => {
  test("keeps the capability optional for old daemons", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "old-host",
        features: {},
      }).features.notificationPolicy,
    ).toBeUndefined();
  });

  test("the levels are ordered from quietest to loudest", () => {
    expect(NOTIFY_LEVELS).toEqual(["record", "notice", "alert", "urgent"]);
  });

  test("a set request names only what it changes", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "notifications.policy.set.request",
        requestId: "req-1",
        availability: { mode: "focus", until: "2026-09-23T14:00:00.000Z" },
      }),
    ).toMatchObject({ availability: { mode: "focus" } });
  });

  test("rejects a level or mode the daemon does not know", () => {
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "notifications.policy.set.request",
        requestId: "req-1",
        minInterruptLevel: "critical",
      }).success,
    ).toBe(false);
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "notifications.policy.set.request",
        requestId: "req-1",
        availability: { mode: "sleep" },
      }).success,
    ).toBe(false);
  });

  test("parses a ledger response carrying digest members", () => {
    const entry = {
      id: "e1",
      at: "2026-09-23T12:00:00.000Z",
      level: "notice",
      levelDeclared: true,
      reason: "notify_digest",
      title: "3 notices from Paseo",
      body: "a\nb",
      agentId: null,
      outcome: "notify",
      state: "delivered",
      repeatCount: 0,
      digestId: null,
      memberIds: ["m1", "m2", "m3"],
      error: null,
      settledAt: "2026-09-23T12:16:00.000Z",
    };
    expect(
      SessionOutboundMessageSchema.parse({
        type: "notifications.ledger.list.response",
        payload: { requestId: "req-1", entries: [entry], unreachedCount: 0 },
      }),
    ).toMatchObject({ payload: { entries: [{ memberIds: ["m1", "m2", "m3"] }] } });
  });
});
