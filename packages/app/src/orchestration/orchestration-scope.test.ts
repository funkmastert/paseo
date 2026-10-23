import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import type { OrchestrationTreeNode } from "./select";
import {
  findOrchestrationRootAgentId,
  resolveOrchestrationScope,
  resolveScopedLeaderAgent,
  selectScopedOrchestrationRoots,
} from "./orchestration-scope";

function node(id: string, children: OrchestrationTreeNode[] = []): OrchestrationTreeNode {
  return {
    agent: { id, title: `Agent ${id}` } as Agent,
    children,
    depth: 0,
    descendantRequiresAttention: false,
    requiresAttentionInSubtree: false,
    subtreePriority: 0,
  };
}

const grandchild = node("grandchild");
const child = node("child", [grandchild]);
const leader = node("leader", [child]);
const otherLeader = node("other-leader", [node("other-child")]);
const ROOTS = [leader, otherLeader];

describe("resolveOrchestrationScope", () => {
  it("is host-wide with no scope agent", () => {
    expect(resolveOrchestrationScope(undefined)).toEqual({ kind: "all" });
  });

  it("is a leader scope with one", () => {
    expect(resolveOrchestrationScope("child")).toEqual({ kind: "leader", agentId: "child" });
  });
});

describe("findOrchestrationRootAgentId", () => {
  it("returns a root for itself", () => {
    expect(findOrchestrationRootAgentId(ROOTS, "leader")).toBe("leader");
  });

  it("walks a subagent up to its leader", () => {
    expect(findOrchestrationRootAgentId(ROOTS, "child")).toBe("leader");
  });

  it("walks any depth up to the same leader", () => {
    expect(findOrchestrationRootAgentId(ROOTS, "grandchild")).toBe("leader");
  });

  it("returns null for an agent no live tree holds", () => {
    expect(findOrchestrationRootAgentId(ROOTS, "archived")).toBeNull();
  });
});

describe("selectScopedOrchestrationRoots", () => {
  it("keeps every root for the host-wide scope", () => {
    expect(selectScopedOrchestrationRoots(ROOTS, { kind: "all" })).toEqual(ROOTS);
  });

  it("keeps only the tree holding the scoped agent", () => {
    expect(
      selectScopedOrchestrationRoots(ROOTS, { kind: "leader", agentId: "grandchild" }),
    ).toEqual([leader]);
  });

  it("is empty when the scoped tree is gone, rather than falling back to everything", () => {
    expect(selectScopedOrchestrationRoots(ROOTS, { kind: "leader", agentId: "archived" })).toEqual(
      [],
    );
  });
});

describe("resolveScopedLeaderAgent", () => {
  it("names the tab after the leader, not the agent it was opened from", () => {
    expect(resolveScopedLeaderAgent(ROOTS, { kind: "leader", agentId: "grandchild" })?.id).toBe(
      "leader",
    );
  });

  it("has no leader to name for the host-wide scope", () => {
    expect(resolveScopedLeaderAgent(ROOTS, { kind: "all" })).toBeNull();
  });
});
