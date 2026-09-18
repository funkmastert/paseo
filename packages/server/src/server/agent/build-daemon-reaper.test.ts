import { describe, expect, test } from "vitest";
import {
  type BuildDaemonReaperConfig,
  type BuildDaemonReaperMemory,
  createSystemProcessSignaller,
  evaluateBuildDaemonReapCandidates,
  markBuildDaemonHandled,
} from "./build-daemon-reaper.js";
import { parsePsOutput, type ProcessSampleRow } from "./process-sampler.js";

const OWNER_UID = 501;
const GRADLE_COMMAND =
  "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java -Xmx4g " +
  "-cp /Users/t/.gradle/wrapper/dists/gradle-9.7.1/lib/gradle-daemon-main-9.7.1.jar " +
  "org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.7.1";
const KOTLIN_COMMAND =
  "/usr/bin/java -Xmx2g -cp kotlin-daemon.jar org.jetbrains.kotlin.daemon.KotlinCompileDaemon " +
  "--daemon-runFilesPath=/Users/t/Library/Application Support/kotlin/daemon";

const CONFIG: BuildDaemonReaperConfig = {
  idleCpuPercent: 2,
  idleMinutes: 15,
  minIdleSweeps: 3,
  maxPerSweep: 2,
};

function row(
  overrides: Partial<ProcessSampleRow> & Pick<ProcessSampleRow, "pid">,
): ProcessSampleRow {
  return {
    ppid: 1,
    uid: OWNER_UID,
    rssKb: 1_500_000,
    cpuPercent: 0,
    etime: "02:14:00",
    cpuSeconds: 754,
    command: GRADLE_COMMAND,
    ...overrides,
  };
}

/**
 * Drives `sweeps` consecutive 60s sweeps over the same rows, the way the monitor would, and
 * returns what the last one selected. `rowsForSweep` lets a test change the snapshot per sweep.
 */
function runSweeps(params: {
  sweeps: number;
  rowsForSweep: (index: number) => ProcessSampleRow[];
  attributedPids?: ReadonlySet<number>;
  ownerUid?: number | undefined;
  config?: Partial<BuildDaemonReaperConfig>;
  startMs?: number;
}) {
  const config = { ...CONFIG, ...params.config };
  let memory: BuildDaemonReaperMemory | undefined;
  let nowMs = params.startMs ?? 1_000_000;
  let last = evaluateBuildDaemonReapCandidates({
    rows: [],
    attributedPids: new Set(),
    ownerUid: OWNER_UID,
    config,
    previous: undefined,
    nowMs,
  });
  for (let index = 0; index < params.sweeps; index += 1) {
    last = evaluateBuildDaemonReapCandidates({
      rows: params.rowsForSweep(index),
      attributedPids: params.attributedPids ?? new Set(),
      ownerUid: "ownerUid" in params ? params.ownerUid : OWNER_UID,
      config,
      previous: memory,
      nowMs,
    });
    memory = last.memory;
    nowMs += 60_000;
  }
  return { ...last, memory: memory as BuildDaemonReaperMemory };
}

describe("evaluateBuildDaemonReapCandidates", () => {
  test("reaps a Gradle daemon only after sustained idleness across many sweeps", () => {
    const rows = [row({ pid: 28056 })];

    // 3 idle sweeps are observed by sweep 4 (the first carries no rate), but 15 idle minutes
    // are not: the clock starts on sweep 2.
    expect(runSweeps({ sweeps: 4, rowsForSweep: () => rows }).candidates).toEqual([]);

    const result = runSweeps({ sweeps: 18, rowsForSweep: () => rows });

    expect(result.candidates).toEqual([
      {
        pid: 28056,
        kind: "gradle",
        label: "Gradle daemon",
        rssBytes: 1_500_000 * 1024,
        idleMs: 16 * 60_000,
        idleSweeps: 17,
      },
    ]);
  });

  test("a single idle sample is never enough, however long the process has existed", () => {
    const result = runSweeps({
      sweeps: 1,
      rowsForSweep: () => [row({ pid: 28056, etime: "10-19:06:17", cpuPercent: 0 })],
    });

    expect(result.candidates).toEqual([]);
  });

  test("a daemon that is busy mid-build is never reaped, and its idle clock restarts", () => {
    // Idle for a long time, then a build starts on sweep 20 and stays busy.
    const result = runSweeps({
      sweeps: 24,
      rowsForSweep: (index) => [row({ pid: 28056, cpuPercent: index >= 19 ? 180 : 0 })],
    });

    expect(result.candidates).toEqual([]);
    expect(result.memory.get(28056)).toMatchObject({ idleSweeps: 0, idleSinceMs: undefined });
  });

  test("one busy sweep in the middle costs the daemon its whole accumulated idleness", () => {
    const result = runSweeps({
      sweeps: 20,
      rowsForSweep: (index) => [row({ pid: 28056, cpuPercent: index === 10 ? 95 : 0 })],
    });

    expect(result.candidates).toEqual([]);
    expect(result.memory.get(28056)?.idleSweeps).toBe(9);
  });

  test("a daemon whose parent is still alive is somebody's build, not an orphan", () => {
    const result = runSweeps({
      sweeps: 30,
      rowsForSweep: () => [row({ pid: 28056, ppid: 4242 })],
    });

    expect(result.candidates).toEqual([]);
    expect(result.memory.size).toBe(0);
  });

  test("a daemon inside a live agent's process tree is never reaped", () => {
    const result = runSweeps({
      sweeps: 30,
      rowsForSweep: () => [row({ pid: 28056 })],
      attributedPids: new Set([28056]),
    });

    expect(result.candidates).toEqual([]);
  });

  test("a daemon launched by an agent this daemon no longer lists is still spared", () => {
    const result = runSweeps({
      sweeps: 30,
      rowsForSweep: () => [
        row({
          pid: 28056,
          command: `${GRADLE_COMMAND} --init-script /tmp/paseo?callerAgentId=agent-9`,
        }),
      ],
    });

    expect(result.candidates).toEqual([]);
  });

  test("another user's daemon is never signalled", () => {
    const result = runSweeps({
      sweeps: 30,
      rowsForSweep: () => [row({ pid: 28056, uid: 502 })],
    });

    expect(result.candidates).toEqual([]);
  });

  test("an unknown owner uid refuses to reap anything", () => {
    const result = runSweeps({
      sweeps: 30,
      rowsForSweep: () => [row({ pid: 28056 })],
      ownerUid: undefined,
    });

    expect(result.candidates).toEqual([]);
  });

  test("only the allowlisted main classes match, and only as whole argv tokens", () => {
    const result = runSweeps({
      sweeps: 30,
      rowsForSweep: () => [
        row({ pid: 1, command: "/sbin/launchd" }),
        row({ pid: 700, command: "node /Users/t/paseo/packages/server/dist/index.js" }),
        row({ pid: 701, command: "grep -r org.gradle.launcher.daemon.bootstrap.GradleDaemon ." }),
        row({ pid: 705, command: "rg --files-with-matches KotlinCompileDaemon /Users/t/src" }),
        row({ pid: 702, command: "java -cp x.jar com.example.GradleDaemonHelper" }),
        row({ pid: 703, command: "/usr/bin/java -jar my-org.gradle.launcher.jar" }),
        row({ pid: 704, command: KOTLIN_COMMAND, rssKb: 460_000 }),
      ],
    });

    expect(result.candidates.map((candidate) => candidate.pid)).toEqual([704]);
    expect(result.candidates[0]).toMatchObject({ kind: "kotlin", label: "Kotlin compile daemon" });
  });

  test("a sweep signals at most maxPerSweep daemons, the largest first", () => {
    const result = runSweeps({
      sweeps: 20,
      rowsForSweep: () => [
        row({ pid: 101, rssKb: 400_000 }),
        row({ pid: 102, rssKb: 2_600_000 }),
        row({ pid: 103, rssKb: 1_100_000, command: KOTLIN_COMMAND }),
      ],
    });

    expect(result.candidates.map((candidate) => candidate.pid)).toEqual([102, 103]);
  });

  test("a pid the reaper has acted on stays skipped on every later sweep", () => {
    const rows = [row({ pid: 28056 })];
    let memory: BuildDaemonReaperMemory | undefined;
    let nowMs = 1_000_000;
    let candidates: ReturnType<typeof evaluateBuildDaemonReapCandidates>["candidates"] = [];
    for (let index = 0; index < 20; index += 1) {
      const result = evaluateBuildDaemonReapCandidates({
        rows,
        attributedPids: new Set(),
        ownerUid: OWNER_UID,
        config: CONFIG,
        previous: memory,
        nowMs,
      });
      memory = result.memory;
      candidates = result.candidates;
      if (candidates.length > 0 && index < 19) {
        markBuildDaemonHandled(memory, 28056, "signalled");
      }
      nowMs += 60_000;
    }

    expect(candidates).toEqual([]);
    expect(memory?.get(28056)?.handled).toBe("signalled");
  });

  test("a recycled pid starts over instead of inheriting the old process's idleness", () => {
    // pid 28056 is a long-idle Gradle daemon for 17 sweeps, then the pid belongs to something
    // else entirely — which drops out of the allowlist and so out of memory.
    const result = runSweeps({
      sweeps: 19,
      rowsForSweep: (index) =>
        index < 17 ? [row({ pid: 28056 })] : [row({ pid: 28056, command: "vim notes.md" })],
    });

    expect(result.candidates).toEqual([]);
    expect(result.memory.size).toBe(0);
  });
});

describe("the ps snapshot a real Gradle daemon produces", () => {
  // Copied from `ps -axo pid,ppid,uid,rss,pcpu,etime,cputime,command` on Tyler's machine, paths
  // shortened: a detached Gradle 9.7.1 daemon holding 3.2 GB. Its JVM lives under
  // "Android Studio.app", so argv[0] contains a space — the reason the signature looks for a
  // `java` token rather than reading argv[0].
  const PS_LINE =
    "28056     1   501 3369792   0.0       15:41  10:17.05 " +
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java " +
    "--add-opens=java.base/java.lang=ALL-UNNAMED -Xmx6g " +
    "-cp /Users/t/.gradle/wrapper/dists/gradle-9.7.1-bin/1w1c7tv/gradle-9.7.1/lib/" +
    "gradle-daemon-main-9.7.1.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.7.1";

  test("parses and then reaps, so the sampler and the signature agree on the real thing", () => {
    const rows = parsePsOutput(
      ["  PID  PPID   UID    RSS %CPU     ELAPSED        TIME COMMAND", PS_LINE].join("\n"),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pid: 28056, ppid: 1, uid: 501, rssKb: 3_369_792 });

    const result = runSweeps({
      sweeps: 20,
      rowsForSweep: () => [{ ...(rows[0] as ProcessSampleRow), cpuPercent: 0 }],
    });

    expect(result.candidates).toMatchObject([{ pid: 28056, kind: "gradle" }]);
  });
});

describe("createSystemProcessSignaller", () => {
  test("refuses pid 1, pid 0 and process groups before any signal is sent", () => {
    const signaller = createSystemProcessSignaller();

    expect(signaller.signal(1, "SIGKILL")).toBe("failed");
    expect(signaller.signal(0, "SIGTERM")).toBe("failed");
    expect(signaller.signal(-4242, "SIGKILL")).toBe("failed");
    expect(signaller.isRunning(1)).toBe(false);
  });

  test("reports a pid that does not exist as gone rather than throwing", () => {
    const signaller = createSystemProcessSignaller();
    // A pid far above the platform maximum can never be live.
    const unusedPid = 0x7fff_fffe;

    expect(signaller.isRunning(unusedPid)).toBe(false);
    expect(signaller.signal(unusedPid, "SIGTERM")).toBe("gone");
  });

  test("sees this very process as running", () => {
    expect(createSystemProcessSignaller().isRunning(process.pid)).toBe(true);
  });
});
