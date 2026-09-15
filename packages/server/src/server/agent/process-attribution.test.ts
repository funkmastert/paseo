import { describe, expect, test } from "vitest";
import { attributeProcessTrees } from "./process-attribution.js";
import type { ProcessSampleRow } from "./process-sampler.js";

function row(
  overrides: Partial<ProcessSampleRow> & Pick<ProcessSampleRow, "pid">,
): ProcessSampleRow {
  return {
    ppid: 1,
    rssKb: 1000,
    cpuPercent: 0,
    etime: "00:01",
    command: "some-process",
    ...overrides,
  };
}

describe("attributeProcessTrees", () => {
  test("sums a nested process tree rooted at the callerAgentId marker", () => {
    const rows: ProcessSampleRow[] = [
      row({ pid: 100, ppid: 1, command: "node daemon.js" }),
      row({
        pid: 200,
        ppid: 100,
        rssKb: 50_000,
        cpuPercent: 10,
        command: "claude --mcp-config url=http://localhost/mcp/agents?callerAgentId=agent-1",
      }),
      row({ pid: 201, ppid: 200, rssKb: 20_000, cpuPercent: 5, command: "node worker.js" }),
      row({ pid: 202, ppid: 201, rssKb: 30_000, cpuPercent: 15, command: "gradle build" }),
    ];

    const result = attributeProcessTrees(rows, ["agent-1"]);

    expect(result.agentTrees).toHaveLength(1);
    expect(result.agentTrees[0]).toEqual({
      agentId: "agent-1",
      rssBytes: (50_000 + 20_000 + 30_000) * 1024,
      cpuPercent: 30,
      pids: [200, 201, 202],
    });
  });

  test("excludes unrelated processes outside the agent's tree", () => {
    const rows: ProcessSampleRow[] = [
      row({ pid: 200, command: "claude ...callerAgentId=agent-1" }),
      row({ pid: 999, ppid: 1, rssKb: 999_999, command: "unrelated-process --big" }),
    ];

    const result = attributeProcessTrees(rows, ["agent-1"]);

    expect(result.agentTrees[0]?.pids).toEqual([200]);
  });

  test("attributes two distinct agents to two distinct trees", () => {
    const rows: ProcessSampleRow[] = [
      row({ pid: 10, rssKb: 1000, command: "claude ...callerAgentId=agent-a" }),
      row({ pid: 11, ppid: 10, rssKb: 500, command: "child of a" }),
      row({ pid: 20, rssKb: 2000, command: "claude ...callerAgentId=agent-b" }),
      row({ pid: 21, ppid: 20, rssKb: 1500, command: "child of b" }),
    ];

    const result = attributeProcessTrees(rows, ["agent-a", "agent-b"]);

    const byId = new Map(result.agentTrees.map((tree) => [tree.agentId, tree]));
    expect(byId.get("agent-a")?.pids).toEqual([10, 11]);
    expect(byId.get("agent-a")?.rssBytes).toBe(1500 * 1024);
    expect(byId.get("agent-b")?.pids).toEqual([20, 21]);
    expect(byId.get("agent-b")?.rssBytes).toBe(3500 * 1024);
  });

  test("an agent with no matching process is omitted rather than reported as zero", () => {
    const rows: ProcessSampleRow[] = [row({ pid: 10, command: "unrelated" })];

    const result = attributeProcessTrees(rows, ["agent-missing"]);

    expect(result.agentTrees).toEqual([]);
  });

  test("groups detached Gradle/Kotlin daemons as orphan build daemons, not attributed to any agent", () => {
    const rows: ProcessSampleRow[] = [
      row({ pid: 10, command: "claude ...callerAgentId=agent-1" }),
      row({
        pid: 500,
        ppid: 1,
        rssKb: 400_000,
        command: "java org.gradle.launcher.daemon.bootstrap.GradleDaemon",
      }),
      row({
        pid: 501,
        ppid: 1,
        rssKb: 300_000,
        command: "java org.jetbrains.kotlin.daemon.KotlinCompileDaemon",
      }),
    ];

    const result = attributeProcessTrees(rows, ["agent-1"]);

    expect(result.agentTrees[0]?.pids).toEqual([10]);
    expect(result.orphanBuildDaemons).toEqual({
      count: 2,
      rssBytes: 700_000 * 1024,
      pids: [500, 501],
    });
  });

  test("a ppid-1 process without a build-daemon marker is neither attributed nor counted as orphan", () => {
    const rows: ProcessSampleRow[] = [
      row({ pid: 10, command: "claude ...callerAgentId=agent-1" }),
      row({ pid: 999, ppid: 1, rssKb: 999_999, command: "/usr/sbin/some-system-daemon" }),
    ];

    const result = attributeProcessTrees(rows, ["agent-1"]);

    expect(result.orphanBuildDaemons).toEqual({ count: 0, rssBytes: 0, pids: [] });
  });
});
