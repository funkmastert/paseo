import { describe, expect, it } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AccountFailoverAgentSummary } from "./agent-manager.js";
import { ACCOUNT_FAILOVER_MIGRATED_TO_LABEL } from "./account-failover-detector.js";
import { planIdleRehomes, type PlanIdleRehomesInput } from "./account-failover-rehome.js";

const NOW = Date.parse("2026-09-24T18:00:00.000Z");

/** A root that finished its turn on `claude-backup`, which is out for the week. */
function idleRoot(
  overrides: Partial<AccountFailoverAgentSummary> = {},
): AccountFailoverAgentSummary {
  return {
    id: "root-1",
    provider: "claude-backup",
    cwd: "/tmp/work",
    workspaceId: "ws-1",
    internal: false,
    lifecycle: "idle",
    lastError: undefined,
    title: "Check mobile support needs",
    busy: false,
    pendingPermissionCount: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    timelineSeq: 40,
    lastTimelineAt: new Date(NOW - 60_000).toISOString(),
    labels: {},
    sessionId: "session-root-1",
    model: "claude-opus-5-5",
    modeId: "bypassPermissions",
    thinkingOptionId: "max",
    ...overrides,
  };
}

function plan(
  agents: AccountFailoverAgentSummary[],
  overrides: Partial<PlanIdleRehomesInput> = {},
): string[] {
  return planIdleRehomes({
    agents,
    poolProviderIds: new Set(["claude", "claude-personal", "claude-backup"]),
    deadProviderIds: new Set(["claude-backup"]),
    backoffs: new Map(),
    nowMs: NOW,
    migrateSubagents: true,
    ...overrides,
  }).map((agent) => agent.id);
}

describe("planIdleRehomes", () => {
  it("moves an idle root off a dead account, so it can answer the next message", () => {
    expect(plan([idleRoot()])).toEqual(["root-1"]);
  });

  it("moves an idle child too", () => {
    const child = idleRoot({ id: "child-1", labels: { [PARENT_AGENT_ID_LABEL]: "root-1" } });
    expect(plan([child])).toEqual(["child-1"]);
    expect(plan([child], { migrateSubagents: false })).toEqual([]);
  });

  it("leaves an agent on a healthy account, or outside the pool, where it is", () => {
    expect(plan([idleRoot({ provider: "claude-personal" })])).toEqual([]);
    expect(
      plan([idleRoot({ provider: "codex" })], { deadProviderIds: new Set(["codex"]) }),
    ).toEqual([]);
  });

  it("leaves an agent cut off by the cap to the rescue leg, which also resumes it", () => {
    const cutOff = idleRoot({
      lifecycle: "error",
      lastError: "You've hit your weekly limit · resets Saturday 7am (America/Los_Angeles)",
    });
    expect(plan([cutOff])).toEqual([]);
  });

  it.each([
    ["running", idleRoot({ lifecycle: "running" })],
    ["initializing", idleRoot({ lifecycle: "initializing" })],
    ["closed", idleRoot({ lifecycle: "closed" })],
    ["mid-turn", idleRoot({ busy: true })],
    ["waiting on a permission", idleRoot({ pendingPermissionCount: 1 })],
    ["without a session", idleRoot({ sessionId: undefined })],
    ["internal", idleRoot({ internal: true })],
    ["retired", idleRoot({ labels: { [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: "successor" } })],
  ])("never touches an agent that is %s", (_label, agent) => {
    expect(plan([agent])).toEqual([]);
  });

  it("moves an agent whose turn ended in an unrelated error, without resuming it", () => {
    expect(plan([idleRoot({ lifecycle: "error", lastError: "tool crashed" })])).toEqual(["root-1"]);
  });

  it("holds an agent whose move was refused until its backoff runs out", () => {
    const backoffs = new Map([["root-1", NOW + 60_000]]);
    expect(plan([idleRoot()], { backoffs })).toEqual([]);
    expect(plan([idleRoot()], { backoffs, nowMs: NOW + 60_000 })).toEqual(["root-1"]);
  });
});
