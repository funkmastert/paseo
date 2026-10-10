import { afterEach, describe, expect, it } from "vitest";
import { countRunningCodexChildren, createCodexGuardSession } from "./codex-guard-session.js";
import {
  resetCodexGuardHealthStateForTests,
  setCodexGuardHealthState,
} from "../../agent/codex-guard-health.js";
import type { CodexGuardChildCandidateSummary } from "../../agent/agent-manager.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";

const NOW = new Date("2026-10-10T12:00:00.000Z").getTime();
const now = () => NOW;

afterEach(() => {
  resetCodexGuardHealthStateForTests();
});

function agent(
  overrides: Partial<CodexGuardChildCandidateSummary> = {},
): CodexGuardChildCandidateSummary {
  return {
    id: "agent-1",
    provider: "codex",
    parentAgentId: "parent-1",
    lifecycle: "running",
    busy: false,
    createdAt: new Date(NOW - 20 * 60 * 1000).toISOString(), // created well before the recent-create window
    ...overrides,
  };
}

describe("countRunningCodexChildren", () => {
  it("counts a running codex agent with a parent", () => {
    expect(countRunningCodexChildren([agent()], now)).toBe(1);
  });

  it("does not count a non-codex provider", () => {
    expect(countRunningCodexChildren([agent({ provider: "claude" })], now)).toBe(0);
  });

  it("does not count a root codex agent (Tyler's own session, no parent)", () => {
    expect(countRunningCodexChildren([agent({ parentAgentId: null })], now)).toBe(0);
  });

  it("does not count a closed codex agent", () => {
    expect(countRunningCodexChildren([agent({ lifecycle: "closed" })], now)).toBe(0);
  });

  it("counts an initializing codex agent, not just a running one", () => {
    expect(countRunningCodexChildren([agent({ lifecycle: "initializing" })], now)).toBe(1);
  });

  it("counts an idle-but-just-created child (the burst-of-creates gap)", () => {
    const freshlyCreated = agent({
      lifecycle: "idle",
      createdAt: new Date(NOW - 60 * 1000).toISOString(),
    });
    expect(countRunningCodexChildren([freshlyCreated], now)).toBe(1);
  });

  it("does not count an old idle child with no queued turn", () => {
    const oldIdle = agent({
      lifecycle: "idle",
      createdAt: new Date(NOW - 20 * 60 * 1000).toISOString(),
    });
    expect(countRunningCodexChildren([oldIdle], now)).toBe(0);
  });

  it("counts an old idle child that is busy (a queued/admitted turn)", () => {
    const oldIdleButBusy = agent({
      lifecycle: "idle",
      busy: true,
      createdAt: new Date(NOW - 20 * 60 * 1000).toISOString(),
    });
    expect(countRunningCodexChildren([oldIdleButBusy], now)).toBe(1);
  });

  it("counts a child right at the edge of the recent-create window", () => {
    const edge = agent({
      lifecycle: "idle",
      createdAt: new Date(NOW - 15 * 60 * 1000).toISOString(),
    });
    expect(countRunningCodexChildren([edge], now)).toBe(1);
  });

  it("does not count a child just past the recent-create window", () => {
    const pastEdge = agent({
      lifecycle: "idle",
      createdAt: new Date(NOW - 15 * 60 * 1000 - 1).toISOString(),
    });
    expect(countRunningCodexChildren([pastEdge], now)).toBe(0);
  });

  it("sums across several agents", () => {
    expect(
      countRunningCodexChildren(
        [agent({ id: "a" }), agent({ id: "b" }), agent({ id: "c", provider: "claude" })],
        now,
      ),
    ).toBe(2);
  });

  it("defaults now to Date.now when not supplied", () => {
    expect(countRunningCodexChildren([agent()])).toBe(1);
  });
});

describe("CodexGuardSession", () => {
  function requestMsg(): Extract<SessionInboundMessage, { type: "codex.guard.status.request" }> {
    return { type: "codex.guard.status.request", requestId: "req-1" };
  }

  it("reports the daemon's current health state and the running-children count", async () => {
    setCodexGuardHealthState({ status: "green", reason: "all good", codexVersion: "0.160.0" });
    const emitted: SessionOutboundMessage[] = [];
    const session = createCodexGuardSession({
      host: { emit: (msg) => emitted.push(msg) },
      listAgents: () => [agent(), agent({ id: "b", provider: "claude" })],
      now,
    });

    await session.handleStatus(requestMsg());

    expect(emitted).toHaveLength(1);
    const response = emitted[0];
    expect(response.type).toBe("codex.guard.status.response");
    if (response.type !== "codex.guard.status.response") throw new Error("unreachable");
    expect(response.payload.requestId).toBe("req-1");
    expect(response.payload.status).toMatchObject({
      status: "green",
      reason: "all good",
      codexVersion: "0.160.0",
      runningChildren: 1,
    });
  });

  it("reports unknown with no self-test run yet", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const session = createCodexGuardSession({
      host: { emit: (msg) => emitted.push(msg) },
      listAgents: () => [],
      now,
    });

    await session.handleStatus(requestMsg());

    const response = emitted[0];
    if (response.type !== "codex.guard.status.response") throw new Error("unreachable");
    expect(response.payload.status.status).toBe("unknown");
    expect(response.payload.status.runningChildren).toBe(0);
  });

  it("reads health fresh per request, not cached from construction", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const session = createCodexGuardSession({
      host: { emit: (msg) => emitted.push(msg) },
      listAgents: () => [],
      now,
    });

    await session.handleStatus(requestMsg());
    setCodexGuardHealthState({ status: "red", reason: "canary ran", codexVersion: "0.160.0" });
    await session.handleStatus(requestMsg());

    expect(emitted).toHaveLength(2);
    const [first, second] = emitted;
    if (
      first.type !== "codex.guard.status.response" ||
      second.type !== "codex.guard.status.response"
    ) {
      throw new Error("unreachable");
    }
    expect(first.payload.status.status).toBe("unknown");
    expect(second.payload.status.status).toBe("red");
  });
});
