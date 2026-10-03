import { describe, expect, test } from "vitest";

import {
  computeRecoveryDepths,
  groupByDepth,
  nearestRecoveringAncestor,
  orderForRecovery,
  rollUpReadiness,
} from "./plan.js";

const PARENT = "paseo.parent-agent-id";

function waveIds(wave: readonly { agentId: string }[]): string[] {
  return wave.map((entry) => entry.agentId);
}

function agent(id: string, parent?: string) {
  return { id, labels: parent ? { [PARENT]: parent } : {} };
}

describe("rollUpReadiness", () => {
  test("red beats unknown beats yellow beats green", () => {
    const green = { id: "a", status: "green", detail: "" };
    const yellow = { id: "b", status: "yellow", detail: "" };
    const unknown = { id: "c", status: "unknown", detail: "" };
    const red = { id: "d", status: "red", detail: "" };
    expect(rollUpReadiness([green])).toBe("restorable");
    expect(rollUpReadiness([green, yellow])).toBe("restorable_with_caveats");
    expect(rollUpReadiness([yellow, unknown])).toBe("unknown");
    expect(rollUpReadiness([unknown, red])).toBe("not_restorable");
  });
});

describe("recovery order", () => {
  // leader → idle-middle → grandchild; leader → child; and an unrelated root.
  const lineage = [
    agent("leader"),
    agent("child", "leader"),
    agent("middle", "leader"),
    agent("grandchild", "middle"),
    agent("other"),
  ];
  const recovering = new Set(["leader", "child", "grandchild", "other"]);

  test("counts only ancestors that are recovering, walking through idle ones", () => {
    const depths = computeRecoveryDepths(recovering, lineage);
    expect(Object.fromEntries(depths)).toEqual({ leader: 0, child: 1, grandchild: 1, other: 0 });
    expect(nearestRecoveringAncestor("grandchild", recovering, lineage)).toBe("leader");
    expect(nearestRecoveringAncestor("other", recovering, lineage)).toBeNull();
  });

  test("resumes leaders first, then by when the run started, in waves of equal depth", () => {
    const entries = [
      { agentId: "child", depth: 1, runStartedAt: "2026-09-23T10:00:02Z" },
      { agentId: "leader", depth: 0, runStartedAt: "2026-09-23T10:00:05Z" },
      { agentId: "grandchild", depth: 1, runStartedAt: "2026-09-23T10:00:01Z" },
      { agentId: "other", depth: 0, runStartedAt: "2026-09-23T10:00:03Z" },
    ];
    const ordered = orderForRecovery(entries);
    expect(ordered.map((entry) => entry.agentId)).toEqual([
      "other",
      "leader",
      "grandchild",
      "child",
    ]);
    expect(groupByDepth(ordered).map(waveIds)).toEqual([
      ["other", "leader"],
      ["grandchild", "child"],
    ]);
  });

  test("survives a parent cycle", () => {
    const cyclic = [agent("a", "b"), agent("b", "a")];
    const depths = computeRecoveryDepths(new Set(["a", "b"]), cyclic);
    expect(depths.get("a")).toBe(1);
    expect(depths.get("b")).toBe(1);
  });
});
