import { afterEach, describe, expect, it } from "vitest";
import { countRunningCodexChildren, createCodexGuardSession } from "./codex-guard-session.js";
import {
  resetCodexGuardHealthStateForTests,
  setCodexGuardHealthState,
} from "../../agent/codex-guard-health.js";
import type { ResourceMonitorAgentSummary } from "../../agent/agent-manager.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";

afterEach(() => {
  resetCodexGuardHealthStateForTests();
});

function agent(overrides: Partial<ResourceMonitorAgentSummary> = {}): ResourceMonitorAgentSummary {
  return {
    id: "agent-1",
    provider: "codex",
    workspaceId: "ws-1",
    internal: false,
    isRunning: true,
    parentAgentId: "parent-1",
    title: null,
    ...overrides,
  };
}

describe("countRunningCodexChildren", () => {
  it("counts a running codex agent with a parent", () => {
    expect(countRunningCodexChildren([agent()])).toBe(1);
  });

  it("does not count a non-codex provider", () => {
    expect(countRunningCodexChildren([agent({ provider: "claude" })])).toBe(0);
  });

  it("does not count an idle codex agent", () => {
    expect(countRunningCodexChildren([agent({ isRunning: false })])).toBe(0);
  });

  it("does not count a root codex agent (Tyler's own session, no parent)", () => {
    expect(countRunningCodexChildren([agent({ parentAgentId: null })])).toBe(0);
  });

  it("sums across several agents", () => {
    expect(
      countRunningCodexChildren([
        agent({ id: "a" }),
        agent({ id: "b" }),
        agent({ id: "c", provider: "claude" }),
      ]),
    ).toBe(2);
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
