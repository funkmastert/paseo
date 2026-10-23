import { describe, expect, it } from "vitest";
import { resolveOrchestrationRowPresentation } from "./orchestration-row-presentation";
import { buildOrchestrationFixtureFleet } from "./fixture-fleet";
import type { Agent } from "@/stores/session-store";

const fleet = buildOrchestrationFixtureFleet();
const byTitle = (title: string): Agent => {
  const agent = fleet.find((candidate) => candidate.title === title);
  if (!agent) throw new Error(`fixture has no agent titled ${title}`);
  return agent;
};

describe("resolveOrchestrationRowPresentation", () => {
  it("shows the activity line only while the agent is running", () => {
    const running = resolveOrchestrationRowPresentation(
      byTitle("Orchestration panel: staleness then presentation"),
    );
    expect(running).toMatchObject({ isRunning: true, showActivity: true });
  });

  it("says a child waiting for an admission slot is queued, not doing its last activity", () => {
    const running = byTitle("Orchestration panel: staleness then presentation");
    const queued: Agent = { ...running, turnQueued: { queuedAt: "2026-09-24T12:00:00.000Z" } };
    expect(resolveOrchestrationRowPresentation(queued)).toMatchObject({
      isRunning: true,
      showActivity: false,
      statusKey: "queued",
    });
  });

  it("hides a finished agent's last activity rather than passing it off as current work", () => {
    const finished = byTitle("Audit every field the panel renders");
    const withStaleSummary: Agent = { ...finished, lastActivitySummary: "[Bash] npm run lint" };
    expect(resolveOrchestrationRowPresentation(withStaleSummary)).toMatchObject({
      isRunning: false,
      showActivity: false,
    });
  });

  it("badges only the states an orchestrator has to act on", () => {
    expect(
      resolveOrchestrationRowPresentation(byTitle("Match iOS pull-to-refresh on Android Home"))
        .badge,
    ).toBe("needs-input");
    expect(
      resolveOrchestrationRowPresentation(byTitle("Fix pool auth failure detection")).badge,
    ).toBe("failed");
  });

  it("does not badge an agent that merely finished", () => {
    const finished = byTitle("Audit every field the panel renders");
    const attention: Agent = {
      ...finished,
      requiresAttention: true,
      attentionReason: "finished",
    };
    expect(resolveOrchestrationRowPresentation(attention).badge).toBeNull();
  });

  it("badges a subagent whose parent is still owed its finish report", () => {
    const finished = byTitle("Audit every field the panel renders");
    const report = { ownerAgentId: "leader", since: "2026-09-23T12:00:00.000Z" };
    const parked: Agent = { ...finished, owedFinishReport: { ...report, state: "parked" } };
    expect(resolveOrchestrationRowPresentation(parked).badge).toBe("owes-report");
    const undelivered: Agent = {
      ...finished,
      owedFinishReport: { ...report, state: "undelivered", attempts: 2 },
    };
    expect(resolveOrchestrationRowPresentation(undelivered).badge).toBe("report-undelivered");
    // A state a newer daemon adds reads as the stuck one, not as nothing.
    const unknown: Agent = { ...finished, owedFinishReport: { ...report, state: "someday" } };
    expect(resolveOrchestrationRowPresentation(unknown).badge).toBe("report-undelivered");
  });

  it("separates a closed agent from an idle one", () => {
    expect(
      resolveOrchestrationRowPresentation(byTitle("Reap leases whose holder went away")).isClosed,
    ).toBe(true);
    expect(
      resolveOrchestrationRowPresentation(byTitle("Device lease protocol messages")).isClosed,
    ).toBe(false);
  });

  it("names the state the compact row falls back to when there is no activity to show", () => {
    const finished = byTitle("Audit every field the panel renders");
    expect(resolveOrchestrationRowPresentation(finished).statusKey).toBe(finished.status);
    expect(resolveOrchestrationRowPresentation({ ...finished, status: "closed" }).statusKey).toBe(
      "closed",
    );
    expect(resolveOrchestrationRowPresentation({ ...finished, status: "error" }).statusKey).toBe(
      "error",
    );
  });
});
