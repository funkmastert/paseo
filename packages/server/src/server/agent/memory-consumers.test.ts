import { describe, expect, test } from "vitest";
import { formatMemoryConsumers, summarizeMemoryConsumers } from "./memory-consumers.js";
import type { ProcessSampleRow } from "./process-sampler.js";

function row(pid: number, ppid: number, rssKb: number, command: string): ProcessSampleRow {
  return { pid, ppid, uid: 501, rssKb, cpuPercent: 0, etime: "01:00", command };
}

const MB = 1024;

describe("summarizeMemoryConsumers", () => {
  test("sums a process tree under its top-level ancestor and ranks trees by RSS", () => {
    const consumers = summarizeMemoryConsumers({
      rows: [
        row(10, 1, 100 * MB, "/usr/bin/zsh"),
        row(11, 10, 900 * MB, "node /repo/server.js --port 3000"),
        row(20, 1, 400 * MB, "/Applications/Android Studio.app/Contents/MacOS/studio"),
      ],
      agentTrees: [],
    });

    expect(consumers.map((consumer) => [consumer.label, consumer.rssBytes])).toEqual([
      ["zsh (pid 10)", 1000 * MB * 1024],
      ["studio (pid 20)", 400 * MB * 1024],
    ]);
    expect(consumers[0]?.processCount).toBe(2);
  });

  test("labels an agent's tree with the agent and does not fold it into the daemon above it", () => {
    const consumers = summarizeMemoryConsumers({
      rows: [
        row(5, 1, 50 * MB, "node paseo-daemon.js"),
        row(6, 5, 3000 * MB, "claude ...callerAgentId=agent-1"),
        row(7, 6, 500 * MB, "java -Xmx4g org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.7.1"),
      ],
      agentTrees: [{ agentId: "agent-1", rssBytes: 3500 * MB * 1024, cpuPercent: 0, pids: [6, 7] }],
      agentLabels: new Map([["agent-1", "Walk & Talk orchestrator"]]),
    });

    expect(consumers[0]).toMatchObject({
      agentId: "agent-1",
      label: "agent Walk & Talk orchestrator",
      rssBytes: 3500 * MB * 1024,
      processCount: 2,
    });
    expect(consumers[1]?.label).toBe("node (pid 5)");
    expect(consumers[1]?.rssBytes).toBe(50 * MB * 1024);
  });

  test("names a JVM by its main class, not by the shared java binary", () => {
    const [consumer] = summarizeMemoryConsumers({
      rows: [
        row(
          9,
          1,
          3 * 1024 * MB,
          "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java -Xmx6g -cp /x/gradle-daemon-main-9.7.1.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.7.1",
        ),
      ],
      agentTrees: [],
    });

    expect(consumer?.label).toBe("java org.gradle.launcher.daemon.bootstrap.GradleDaemon (pid 9)");
  });

  test("keeps only the largest `limit` trees", () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      row(100 + index, 1, (index + 1) * MB, `proc${index}`),
    );

    const consumers = summarizeMemoryConsumers({ rows, agentTrees: [], limit: 3 });

    expect(consumers.map((consumer) => consumer.label)).toEqual([
      "proc11 (pid 111)",
      "proc10 (pid 110)",
      "proc9 (pid 109)",
    ]);
  });

  test("survives a parent cycle in the sample", () => {
    const consumers = summarizeMemoryConsumers({
      rows: [row(1000, 1001, MB, "a"), row(1001, 1000, MB, "b")],
      agentTrees: [],
    });

    expect(consumers.reduce((sum, consumer) => sum + consumer.processCount, 0)).toBe(2);
  });
});

describe("formatMemoryConsumers", () => {
  test("renders one line per tree with size and process count", () => {
    const text = formatMemoryConsumers([
      { label: "agent X", rssBytes: 3.5 * 1024 ** 3, processCount: 12 },
      { label: "studio (pid 20)", rssBytes: 400 * MB * 1024, processCount: 1 },
    ]);

    expect(text).toBe(
      "- agent X: 3.5 GB across 12 processes\n- studio (pid 20): 0.4 GB (1 process)",
    );
  });
});
