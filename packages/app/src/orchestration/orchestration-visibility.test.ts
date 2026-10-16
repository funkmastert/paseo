import { describe, expect, it } from "vitest";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { Agent } from "@/stores/session-store";
import type { OrchestrationFlatRow } from "./orchestration-panel-model";
import {
  isPinnedOrchestrationAgent,
  ORCHESTRATION_RECENT_WINDOW_MS,
  selectVisibleOrchestrationRows,
} from "./orchestration-visibility";

const NOW_MS = Date.UTC(2026, 8, 19, 12, 0, 0);
const HOUR_MS = 60 * 60 * 1000;

interface RowSpec {
  id: string;
  depth?: number;
  status?: AgentLifecycleStatus;
  ageHours?: number;
  attentionReason?: Agent["attentionReason"];
  pendingPermission?: boolean;
  tokenBurnAlert?: boolean;
  owedFinishReport?: boolean;
}

function row(spec: RowSpec): OrchestrationFlatRow {
  const agent = {
    id: spec.id,
    status: spec.status ?? "idle",
    updatedAt: new Date(NOW_MS - (spec.ageHours ?? 0) * HOUR_MS),
    pendingPermissions: spec.pendingPermission ? [{ id: "req" }] : [],
    requiresAttention: Boolean(spec.attentionReason),
    attentionReason: spec.attentionReason ?? null,
    ...(spec.tokenBurnAlert ? { tokenBurnAlert: { level: "critical" } } : {}),
    ...(spec.owedFinishReport
      ? { owedFinishReport: { ownerAgentId: "leader", state: "parked", since: "x" } }
      : {}),
  } as unknown as Agent;
  return { agent, depth: spec.depth ?? 0, descendantRequiresAttention: false };
}

function visibleIds(rows: OrchestrationFlatRow[], alwaysKeepAgentId?: string): string[] {
  return selectVisibleOrchestrationRows(rows, { nowMs: NOW_MS, alwaysKeepAgentId }).rows.map(
    (visible) => visible.agent.id,
  );
}

describe("isPinnedOrchestrationAgent", () => {
  it("pins what an orchestrator has to act on", () => {
    expect(isPinnedOrchestrationAgent(row({ id: "a", status: "running" }).agent)).toBe(true);
    expect(isPinnedOrchestrationAgent(row({ id: "a", status: "initializing" }).agent)).toBe(true);
    expect(isPinnedOrchestrationAgent(row({ id: "a", status: "error" }).agent)).toBe(true);
    expect(isPinnedOrchestrationAgent(row({ id: "a", attentionReason: "error" }).agent)).toBe(true);
    expect(isPinnedOrchestrationAgent(row({ id: "a", pendingPermission: true }).agent)).toBe(true);
    expect(isPinnedOrchestrationAgent(row({ id: "a", attentionReason: "permission" }).agent)).toBe(
      true,
    );
    expect(isPinnedOrchestrationAgent(row({ id: "a", tokenBurnAlert: true }).agent)).toBe(true);
    // Its parent is waiting on a report that has not come — however old the row is.
    expect(
      isPinnedOrchestrationAgent(row({ id: "a", status: "closed", owedFinishReport: true }).agent),
    ).toBe(true);
  });

  it("does not pin an unread finish, which is set on every completed agent", () => {
    expect(isPinnedOrchestrationAgent(row({ id: "a", attentionReason: "finished" }).agent)).toBe(
      false,
    );
  });

  it("does not pin a closed or idle agent", () => {
    expect(isPinnedOrchestrationAgent(row({ id: "a", status: "closed" }).agent)).toBe(false);
    expect(isPinnedOrchestrationAgent(row({ id: "a", status: "idle" }).agent)).toBe(false);
  });
});

describe("selectVisibleOrchestrationRows", () => {
  it("keeps what moved inside the window and drops what did not", () => {
    const rows = [row({ id: "fresh", ageHours: 1 }), row({ id: "old", ageHours: 48 })];
    const result = selectVisibleOrchestrationRows(rows, { nowMs: NOW_MS });
    expect(result.rows.map((visible) => visible.agent.id)).toEqual(["fresh"]);
    expect(result.hiddenCount).toBe(1);
  });

  it("keeps a blocked agent however old it is", () => {
    const rows = [
      row({ id: "blocked", ageHours: 200, pendingPermission: true }),
      row({ id: "failed", ageHours: 200, status: "error" }),
      row({ id: "quiet", ageHours: 200 }),
    ];
    expect(visibleIds(rows)).toEqual(["blocked", "failed"]);
  });

  it("keeps a quiet parent whose child is still alive", () => {
    const rows = [
      row({ id: "leader", ageHours: 72 }),
      row({ id: "child", ageHours: 72, depth: 1 }),
      row({ id: "grandchild", ageHours: 0, depth: 2, status: "running" }),
    ];
    expect(visibleIds(rows)).toEqual(["leader", "child", "grandchild"]);
  });

  it("drops a quiet child under a live parent", () => {
    const rows = [
      row({ id: "leader", ageHours: 0, status: "running" }),
      row({ id: "quiet-child", ageHours: 72, depth: 1 }),
    ];
    const result = selectVisibleOrchestrationRows(rows, { nowMs: NOW_MS });
    expect(result.rows.map((visible) => visible.agent.id)).toEqual(["leader"]);
    expect(result.hiddenCount).toBe(1);
  });

  it("does not resurrect an aunt when a cousin is kept", () => {
    const rows = [
      row({ id: "leader", ageHours: 72 }),
      row({ id: "quiet-branch", ageHours: 72, depth: 1 }),
      row({ id: "live-branch", ageHours: 0, depth: 1, status: "running" }),
    ];
    expect(visibleIds(rows)).toEqual(["leader", "live-branch"]);
  });

  it("keeps the scoped agent so its tab is never headless", () => {
    const rows = [
      row({ id: "leader", ageHours: 300 }),
      row({ id: "child", ageHours: 300, depth: 1 }),
    ];
    expect(visibleIds(rows, "leader")).toEqual(["leader"]);
  });

  it("treats the window edge as still recent", () => {
    const edge = row({ id: "edge" });
    edge.agent.updatedAt = new Date(NOW_MS - ORCHESTRATION_RECENT_WINDOW_MS);
    expect(visibleIds([edge])).toEqual(["edge"]);
  });
});
