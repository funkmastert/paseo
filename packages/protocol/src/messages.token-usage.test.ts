import { describe, expect, test } from "vitest";
import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";

const payload = {
  requestId: "req-1",
  generatedAt: "2026-10-07T12:00:00.000Z",
  range: "7d",
  rangeStartMs: 1_759_190_400_000,
  rows: [
    {
      provider: "claude",
      model: "claude-opus-5-5",
      role: "leader",
      input: 120,
      cacheWrite: 40_000,
      cacheRead: 2_000_000,
      output: 9_000,
      weighted: 300_000,
      responses: 42,
    },
    {
      provider: "codex",
      model: "unknown",
      role: "outside",
      input: 0,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
      weighted: 0,
      responses: 1,
    },
  ],
  coverage: {
    enabled: true,
    recordingSinceMs: 1_759_190_400_000,
    backfill: { state: "running", filesDone: 10, filesTotal: 120 },
  },
};

describe("usage.tokens.get_breakdown", () => {
  test("routes the request through the session inbound union", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "usage.tokens.get_breakdown.request",
      requestId: "req-1",
      range: "30d",
    });

    expect(parsed.type).toBe("usage.tokens.get_breakdown.request");
  });

  test("rejects a range the daemon does not serve", () => {
    for (const range of ["90d", "", undefined]) {
      const result = SessionInboundMessageSchema.safeParse({
        type: "usage.tokens.get_breakdown.request",
        requestId: "req-1",
        range,
      });
      expect(result.success).toBe(false);
    }
  });

  test("routes a breakdown through the session outbound union", () => {
    const message = { type: "usage.tokens.get_breakdown.response", payload };

    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  test("the generated client validator accepts the response", () => {
    const message = { type: "usage.tokens.get_breakdown.response", payload };

    expect(validateWSOutboundMessage({ type: "session", message }).success).toBe(true);
  });

  test("carries the disabled state and an error with no rows", () => {
    const message = {
      type: "usage.tokens.get_breakdown.response",
      payload: {
        ...payload,
        rows: [],
        coverage: {
          enabled: false,
          recordingSinceMs: null,
          backfill: { state: "off", filesDone: 0, filesTotal: 0 },
        },
        error: "store unavailable",
      },
    };

    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  test("rejects a negative count", () => {
    const message = {
      type: "usage.tokens.get_breakdown.response",
      payload: { ...payload, rows: [{ ...payload.rows[0], output: -1 }] },
    };

    expect(SessionOutboundMessageSchema.safeParse(message).success).toBe(false);
  });

  test("accepts a role or backfill state an older client doesn't know yet", () => {
    // `role` and `backfill.state` are open strings, not closed enums (docs/protocol-compatibility.md
    // — never narrow): a daemon that adds a fourth role or backfill state must not fail validation
    // on an app that predates it.
    const message = {
      type: "usage.tokens.get_breakdown.response",
      payload: {
        ...payload,
        rows: [{ ...payload.rows[0], role: "reviewer" }],
        coverage: {
          ...payload.coverage,
          backfill: { ...payload.coverage.backfill, state: "paused" },
        },
      },
    };

    expect(SessionOutboundMessageSchema.safeParse(message).success).toBe(true);
  });

  test("an older client ignores fields a newer daemon adds", () => {
    const message = {
      type: "usage.tokens.get_breakdown.response",
      payload: {
        ...payload,
        someFutureField: 1,
        rows: [{ ...payload.rows[0], someFutureCategory: 5 }],
      },
    };

    expect(SessionOutboundMessageSchema.safeParse(message).success).toBe(true);
  });

  test("server_info carries the tokenUsage capability, and an older daemon's omits it", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv",
      features: { usageHistory: true, tokenUsage: true },
    });
    const older = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv",
      features: { usageHistory: true },
    });

    expect(parsed.features?.tokenUsage).toBe(true);
    expect(older.features?.tokenUsage).toBeUndefined();
  });
});
