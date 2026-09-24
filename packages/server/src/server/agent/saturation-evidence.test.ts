import { describe, expect, test } from "vitest";
import { describeProcess } from "./memory-consumers.js";
import type { ProcessSampleRow } from "./process-sampler.js";
import {
  buildSaturationEvidence,
  type EvidenceProcessSample,
  formatSaturationEvidence,
} from "./saturation-evidence.js";
import type { SystemLoadReading } from "./system-load.js";

function row(overrides: Partial<ProcessSampleRow> & { pid: number }): ProcessSampleRow {
  return {
    ppid: 1,
    uid: 501,
    rssKb: 1024,
    cpuPercent: 0,
    etime: "01:00",
    command: "sleep 60",
    ...overrides,
  };
}

const LOAD_38: SystemLoadReading = { kind: "loadavg", cores: 16, load1: 38, load5: 30, load15: 20 };

// The 2026-09-24 incident, roughly: a .NET compiler server and a Gradle JVM under two agents.
function cpuBoundSample(takenAtMs = 0): EvidenceProcessSample {
  return {
    rows: [
      row({ pid: 100, ppid: 1, command: "claude --mcp callerAgentId=backend" }),
      row({
        pid: 101,
        ppid: 100,
        cpuPercent: 1_900,
        rssKb: 2_097_152,
        command: "/usr/local/share/dotnet/dotnet exec VBCSCompiler.dll -pipename:abc",
      }),
      row({ pid: 200, ppid: 1, command: "claude --mcp callerAgentId=android" }),
      row({
        pid: 201,
        ppid: 200,
        cpuPercent: 1_200,
        rssKb: 4_194_304,
        command: "/usr/bin/java -Xmx4g org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10",
      }),
      row({ pid: 300, cpuPercent: 400, command: "/usr/bin/tsgo --noEmit" }),
    ],
    agentTrees: [
      { agentId: "android", rssBytes: 4 * 1024 ** 3, cpuPercent: 1_200, pids: [200, 201] },
      { agentId: "backend", rssBytes: 2 * 1024 ** 3, cpuPercent: 1_900, pids: [100, 101] },
    ],
    takenAtMs,
  };
}

const LABELS = new Map([
  ["backend", { title: "Fix orders API", cwd: "/Users/t/backend-net" }],
  ["android", { title: "Android checkout", cwd: "/Users/t/mobile" }],
]);

describe("buildSaturationEvidence", () => {
  test("names the heaviest agent trees with their top commands, then everything else", () => {
    const evidence = buildSaturationEvidence({
      load: LOAD_38,
      sample: cpuBoundSample(),
      fresh: true,
      nowMs: 0,
      agentLabels: LABELS,
    });

    expect(evidence.sample).toEqual({ status: "fresh", ageMs: 0 });
    expect(evidence.agentTrees.map((tree) => tree.agentId)).toEqual(["backend", "android"]);
    expect(evidence.agentTrees[0]).toMatchObject({
      title: "Fix orders API",
      cwd: "/Users/t/backend-net",
      cpuPercent: 1_900,
    });
    expect(evidence.agentTrees[0]?.topCommands[0]).toMatchObject({
      pid: 101,
      name: "dotnet",
      cpuPercent: 1_900,
      rssBytes: 2 * 1024 ** 3,
    });
    expect(evidence.otherProcesses.map((process) => process.pid)).toEqual([300]);
  });

  test("a load the sampled CPU explains is CPU, split between agents and the rest", () => {
    const { cause } = buildSaturationEvidence({
      load: LOAD_38,
      sample: cpuBoundSample(),
      fresh: true,
      nowMs: 0,
      agentLabels: LABELS,
    });

    expect(cause).toMatchObject({ kind: "cpu", explainedByAgents: 31, explainedByOthers: 4 });
    expect(cause.unexplained).toBeCloseTo(3);
  });

  test("a high load the CPU does not explain, with a fresh sample, is I/O and names suspects", () => {
    const sample: EvidenceProcessSample = {
      rows: [
        row({ pid: 10, cpuPercent: 40, command: "/System/Library/.../mds_stores" }),
        row({ pid: 11, cpuPercent: 5, command: "/usr/libexec/mdworker_shared" }),
        row({ pid: 12, cpuPercent: 80, command: "/opt/homebrew/bin/node /x/npm-cli.js ci" }),
        row({ pid: 13, cpuPercent: 30, command: "git -c gc.auto=0 fetch origin" }),
        row({ pid: 14, cpuPercent: 3, command: "/usr/bin/vim notes.md" }),
      ],
      agentTrees: [],
      takenAtMs: 0,
    };

    const { cause } = buildSaturationEvidence({
      load: LOAD_38,
      sample,
      fresh: true,
      nowMs: 0,
      agentLabels: new Map(),
    });

    expect(cause.kind).toBe("io");
    expect(cause.ioProcesses.map((process) => process.pid)).toEqual([12, 10, 13, 11]);
    expect(cause.ioProcesses.map((process) => process.name)).toEqual([
      "npm-cli.js",
      "mds_stores",
      "git",
      "mdworker_shared",
    ]);
  });

  test("a stale sample leaves the cause unknown however well it fits, and says how old it is", () => {
    const evidence = buildSaturationEvidence({
      load: LOAD_38,
      sample: cpuBoundSample(1_000),
      fresh: false,
      nowMs: 181_000,
      agentLabels: LABELS,
    });

    expect(evidence.sample).toEqual({ status: "stale", ageMs: 180_000 });
    expect(evidence.cause.kind).toBe("unknown");
    // Attribution is still reported from the last good sample.
    expect(evidence.agentTrees).toHaveLength(2);
    expect(formatSaturationEvidence(LOAD_38, evidence)).toContain("180s old");
  });

  test("with no sample at all, the cause is unknown and nothing is attributed", () => {
    const evidence = buildSaturationEvidence({
      load: LOAD_38,
      sample: undefined,
      fresh: false,
      nowMs: 0,
      agentLabels: LABELS,
    });

    expect(evidence).toMatchObject({
      sample: { status: "none" },
      cause: { kind: "unknown" },
      agentTrees: [],
      otherProcesses: [],
    });
  });

  test("on Windows, ignores the idle pseudo-process and never calls busy CPU I/O", () => {
    const load: SystemLoadReading = {
      kind: "cpu-busy",
      cores: 16,
      busyFraction: 0.95,
      load1: 15.2,
    };
    const sample: EvidenceProcessSample = {
      rows: [
        row({ pid: 0, ppid: 0, cpuPercent: 80, command: "System Idle Process" }),
        row({ pid: 50, cpuPercent: 200, command: '"C:\\Program Files\\Git\\bin\\git.exe" status' }),
      ],
      agentTrees: [],
      takenAtMs: 0,
    };

    const evidence = buildSaturationEvidence({
      load,
      sample,
      fresh: true,
      nowMs: 0,
      agentLabels: new Map(),
    });

    expect(evidence.cause.kind).toBe("cpu");
    expect(evidence.otherProcesses.map((process) => process.name)).toEqual(["git"]);
  });
});

describe("describeProcess on Windows command lines", () => {
  test("strips the quoted path and .exe, and still finds a JVM's main class", () => {
    expect(describeProcess('"C:\\Program Files\\dotnet\\dotnet.exe" exec VBCSCompiler.dll')).toBe(
      "dotnet",
    );
    expect(
      describeProcess(
        '"C:\\Program Files\\Java\\bin\\java.exe" -Xmx4g org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10',
      ),
    ).toBe("java org.gradle.launcher.daemon.bootstrap.GradleDaemon");
  });
});
