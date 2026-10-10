import { describe, expect, test } from "vitest";

import { createSavingsLookups } from "./savings-lookups.js";

describe("the savings ledger's lookups", () => {
  test("a stored agent's title and a live agent's workspace; a workspace's title over its name", async () => {
    const lookups = createSavingsLookups({
      liveAgent: (id) => (id === "live-1" ? { title: "Live title", workspaceId: "ws-1" } : null),
      listStoredAgents: async () => [
        { id: "live-1", title: "Renamed", workspaceId: "ws-old" },
        { id: "gone-1", title: "Archived run", workspaceId: "ws-2" },
      ],
      listWorkspaces: async () => [
        { workspaceId: "ws-1", title: "Billing", displayName: "billing-repo" },
        { workspaceId: "ws-2", title: null, displayName: "infra" },
      ],
    });
    await lookups.refresh();

    expect(lookups.agentTitle("live-1")).toBe("Renamed");
    expect(lookups.workspaceOf("live-1")).toBe("ws-1");
    expect(lookups.agentTitle("gone-1")).toBe("Archived run");
    expect(lookups.workspaceOf("gone-1")).toBe("ws-2");
    expect(lookups.workspaceLabel("ws-1")).toBe("Billing");
    expect(lookups.workspaceLabel("ws-2")).toBe("infra");
    expect(lookups.agentTitle("unknown")).toBeNull();
    expect(lookups.workspaceLabel("unknown")).toBeNull();
  });

  test("answers from the live agent before the first load, and a throwing source breaks nothing", async () => {
    const lookups = createSavingsLookups({
      liveAgent: () => ({ title: "Live title", workspaceId: "ws-1" }),
      listStoredAgents: () => {
        throw new Error("not built yet");
      },
      listWorkspaces: async () => {
        throw new Error("not built yet");
      },
    });

    expect(lookups.agentTitle("a1")).toBe("Live title");
    expect(lookups.workspaceOf("a1")).toBe("ws-1");
    await lookups.refresh();
    expect(lookups.workspaceLabel("ws-1")).toBeNull();
  });

  test("a miss reloads within seconds, a hit within a minute", async () => {
    const clock = { now: 0 };
    let workspaces = [{ workspaceId: "ws-1", displayName: "one" }];
    let loads = 0;
    const lookups = createSavingsLookups({
      liveAgent: () => null,
      listStoredAgents: async () => [],
      listWorkspaces: async () => {
        loads += 1;
        return workspaces;
      },
      now: () => clock.now,
    });
    await lookups.refresh();
    workspaces = [...workspaces, { workspaceId: "ws-2", displayName: "two" }];

    clock.now = 1_000;
    expect(lookups.workspaceLabel("ws-2")).toBeNull();
    expect(lookups.workspaceLabel("ws-1")).toBe("one");
    expect(loads).toBe(1);

    clock.now = 6_000;
    expect(lookups.workspaceLabel("ws-2")).toBeNull();
    await lookups.refresh();
    expect(loads).toBe(2);
    expect(lookups.workspaceLabel("ws-2")).toBe("two");
  });
});
