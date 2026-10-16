import { describe, expect, it } from "vitest";
import {
  UNKNOWN_SESSION_GRACE_MS,
  buildSessionRoles,
  resolveRole,
  sessionIdsOf,
} from "./token-usage-attribution.js";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const PARENT = { "paseo.parent-agent-id": "agent-leader" };

describe("buildSessionRoles", () => {
  it("makes an agent with no parent a leader and one with a parent a worker", () => {
    const roles = buildSessionRoles({
      records: [
        { id: "agent-leader", labels: {}, persistence: { sessionId: "s-leader" } },
        { id: "agent-worker", labels: PARENT, runtimeInfo: { sessionId: "s-worker" } },
      ],
      sessions: [],
    });

    expect(Object.fromEntries(roles)).toEqual({ "s-leader": "leader", "s-worker": "worker" });
  });

  it("attributes an earlier session from the index after the record moved on", () => {
    const roles = buildSessionRoles({
      records: [{ id: "agent-worker", labels: PARENT, persistence: { sessionId: "s-now" } }],
      sessions: [
        {
          sessionId: "s-before",
          agentId: "agent-worker",
          parentAgentId: "agent-leader",
          lastSeenMs: NOW,
        },
      ],
    });

    expect(roles.get("s-before")).toBe("worker");
    expect(roles.get("s-now")).toBe("worker");
  });

  it("lets the newest source win when two name the same session", () => {
    const roles = buildSessionRoles({
      records: [
        {
          id: "agent-old",
          labels: {},
          updatedAt: "2026-09-01T00:00:00.000Z",
          persistence: { sessionId: "shared" },
        },
        {
          id: "agent-new",
          labels: PARENT,
          updatedAt: "2026-09-30T00:00:00.000Z",
          persistence: { sessionId: "shared" },
        },
      ],
      sessions: [],
    });

    expect(roles.get("shared")).toBe("worker");
  });
});

describe("sessionIdsOf", () => {
  it("collects every distinct session the record names", () => {
    expect(
      sessionIdsOf({
        id: "a",
        persistence: { sessionId: "s1", nativeHandle: "s1" },
        runtimeInfo: { sessionId: "s2" },
      }),
    ).toEqual(["s1", "s2"]);
    expect(sessionIdsOf({ id: "a", persistence: null, runtimeInfo: { sessionId: null } })).toEqual(
      [],
    );
  });
});

describe("resolveRole", () => {
  const roles = new Map([["known", "leader" as const]]);

  it("returns a known session's role however young its transcript", () => {
    expect(resolveRole({ sessionId: "known", roles, fileStartedMs: NOW, nowMs: NOW })).toBe(
      "leader",
    );
  });

  it("defers an unclaimed session inside the grace period, then books it outside", () => {
    const young = NOW - UNKNOWN_SESSION_GRACE_MS + 1;
    const old = NOW - UNKNOWN_SESSION_GRACE_MS;

    expect(resolveRole({ sessionId: "nobody", roles, fileStartedMs: young, nowMs: NOW })).toBe(
      "defer",
    );
    expect(resolveRole({ sessionId: "nobody", roles, fileStartedMs: old, nowMs: NOW })).toBe(
      "outside",
    );
    expect(resolveRole({ sessionId: null, roles, fileStartedMs: old, nowMs: NOW })).toBe("outside");
  });
});
