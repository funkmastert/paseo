import { describe, expect, it } from "vitest";
import type {
  RestartRecoveryEntry,
  RestartRecoveryPlan,
} from "@getpaseo/protocol/restart-recovery/rpc-schemas";
import { buildRestartRecoveryStripModel } from "./model";

function entry(overrides: Partial<RestartRecoveryEntry>): RestartRecoveryEntry {
  return {
    agentId: "a",
    title: null,
    provider: "claude",
    cwd: "/w",
    workspaceId: null,
    parentAgentId: null,
    depth: 0,
    runStartedAt: "2026-09-23T10:00:00.000Z",
    readiness: "restorable",
    checks: [],
    state: "pending",
    detail: null,
    resolvedAt: null,
    ...overrides,
  };
}

function plan(entries: RestartRecoveryEntry[], mode = "plan"): RestartRecoveryPlan {
  return {
    mode,
    capturedAt: "2026-09-23T10:01:00.000Z",
    previousShutdown: "unknown",
    applying: false,
    entries,
  };
}

describe("buildRestartRecoveryStripModel", () => {
  it("hides when recovery is off or nothing is left to decide", () => {
    expect(buildRestartRecoveryStripModel(undefined)).toBeNull();
    expect(buildRestartRecoveryStripModel(plan([entry({})], "off"))).toBeNull();
    expect(
      buildRestartRecoveryStripModel(
        plan([entry({ state: "resumed" }), entry({ agentId: "b", state: "dismissed" })]),
      ),
    ).toBeNull();
  });

  it("shows open entries and counts the resumable ones", () => {
    const model = buildRestartRecoveryStripModel(
      plan([
        entry({ agentId: "a" }),
        entry({ agentId: "b", state: "failed" }),
        entry({ agentId: "c", readiness: "not_restorable" }),
        entry({ agentId: "d", state: "resumed" }),
      ]),
    );
    expect(model?.open.map((candidate) => candidate.agentId)).toEqual(["a", "b", "c"]);
    expect(model?.resumableCount).toBe(2);
  });
});
