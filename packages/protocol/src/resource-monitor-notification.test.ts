import { describe, expect, it } from "vitest";
import {
  buildBatchedResourceNotificationPayload,
  buildResourceAgentNotificationPayload,
  buildResourceOrphanBuildDaemonsNotificationPayload,
  buildResourceSystemMemoryNotificationPayload,
} from "./resource-monitor-notification.js";

describe("buildResourceAgentNotificationPayload", () => {
  it("reports both memory and CPU regardless of which leg triggered", () => {
    const payload = buildResourceAgentNotificationPayload({
      serverId: "server-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      agentTitle: "Walk & Talk orchestrator",
      trigger: "memory",
      memoryBytes: 7_730_941_133,
      cpuPercent: 410,
      memoryBytesLimit: 6_442_450_944,
      cpuPercentLimit: 400,
    });

    expect(payload.title).toBe("Agent is using a lot of memory");
    expect(payload.body).toBe(
      "Walk & Talk orchestrator's processes are using 7.2 GB / 410% CPU (limits 6.0 GB / 400%).",
    );
    expect(payload.data).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      reason: "resource_memory",
    });
  });

  it("gives a CPU breach its own title and reason", () => {
    const payload = buildResourceAgentNotificationPayload({
      serverId: "server-1",
      agentId: "agent-1",
      agentTitle: null,
      trigger: "cpu",
      memoryBytes: 1_073_741_824,
      cpuPercent: 500,
      memoryBytesLimit: 6_442_450_944,
      cpuPercentLimit: 400,
    });

    expect(payload.title).toBe("Agent is using a lot of CPU");
    expect(payload.data.reason).toBe("resource_cpu");
    expect(payload.data).not.toHaveProperty("workspaceId");
  });
});

describe("buildBatchedResourceNotificationPayload", () => {
  it("collapses a storm into one push that still names every agent", () => {
    const payload = buildBatchedResourceNotificationPayload({
      serverId: "server-1",
      breaches: [{ agentId: "agent-1", workspaceId: "workspace-1" }, { agentId: "agent-2" }],
    });

    expect(payload.title).toBe("Multiple agents are using a lot of resources");
    expect(payload.data.agentId).toBe("agent-1");
    expect(payload.data.agentIds).toEqual(["agent-1", "agent-2"]);
    expect(payload.data.reason).toBe("resource_multi");
  });

  it("refuses an empty batch", () => {
    expect(() =>
      buildBatchedResourceNotificationPayload({ serverId: "server-1", breaches: [] }),
    ).toThrow();
  });
});

describe("buildResourceSystemMemoryNotificationPayload", () => {
  it("reports the swap ratio without naming an agent", () => {
    const payload = buildResourceSystemMemoryNotificationPayload({
      serverId: "server-1",
      swapUsedBytes: 8_912_896_000,
      swapTotalBytes: 9_663_676_416,
      swapUsedRatio: 0.922,
    });

    expect(payload.title).toBe("System is low on memory");
    expect(payload.body).toBe("Swap is 92% used (8.3 GB / 9.0 GB).");
    expect(payload.data).toEqual({ serverId: "server-1", reason: "resource_system_memory" });
  });
});

describe("buildResourceOrphanBuildDaemonsNotificationPayload", () => {
  it("names the count, RSS, and the fix", () => {
    const payload = buildResourceOrphanBuildDaemonsNotificationPayload({
      serverId: "server-1",
      count: 6,
      rssBytes: 2_791_728_742,
    });

    expect(payload.title).toBe("Orphaned build daemons are eating memory");
    expect(payload.body).toBe(
      "6 orphaned build daemons are using 2.6 GB. Run `./gradlew --stop` to clear them.",
    );
    expect(payload.data).toEqual({ serverId: "server-1", reason: "resource_orphan_daemons" });
  });

  it("uses singular phrasing for exactly one daemon", () => {
    const payload = buildResourceOrphanBuildDaemonsNotificationPayload({
      serverId: "server-1",
      count: 1,
      rssBytes: 500_000_000,
    });

    expect(payload.body).toContain("1 orphaned build daemon is using");
  });
});
