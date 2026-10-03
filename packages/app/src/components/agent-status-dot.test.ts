import { describe, expect, it } from "vitest";
import { shouldAnimateAgentStatusDot } from "./agent-status-dot";

describe("shouldAnimateAgentStatusDot", () => {
  it("shows the running ring for a running child row, same as a running root row", () => {
    // The orchestration tree flattens roots and their descendants into the same row shape
    // (orchestration-panel-model.ts `flattenOrchestrationTree`), so a depth-0 leader and a
    // depth-N subagent reach this helper identically — pinning "running" here covers both.
    expect(shouldAnimateAgentStatusDot({ bucket: "running", animated: true })).toBe(true);
  });

  it("keeps the static dot when the caller has not opted into animation", () => {
    expect(shouldAnimateAgentStatusDot({ bucket: "running", animated: false })).toBe(false);
  });

  it("keeps the static dot for non-running buckets even when animated", () => {
    expect(shouldAnimateAgentStatusDot({ bucket: "attention", animated: true })).toBe(false);
    expect(shouldAnimateAgentStatusDot({ bucket: "needs_input", animated: true })).toBe(false);
    expect(shouldAnimateAgentStatusDot({ bucket: "failed", animated: true })).toBe(false);
    expect(shouldAnimateAgentStatusDot({ bucket: "done", animated: true })).toBe(false);
  });
});
