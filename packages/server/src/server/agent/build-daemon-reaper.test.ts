import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import {
  type BuildDaemonReaperConfig,
  type BuildDaemonReaperMemory,
  createSystemBuildDaemonConnectionChecker,
  createSystemBuildDaemonCwdResolver,
  createSystemProcessSignaller,
  evaluateBuildDaemonReapCandidates,
  markBuildDaemonHandled,
  parseLsofCwdOutput,
  parseLsofPidOutput,
  selectBuildDaemonPidsNeedingConnectionCheck,
  selectBuildDaemonPidsNeedingCwd,
} from "./build-daemon-reaper.js";
import { parsePsOutput, type ProcessSampleRow } from "./process-sampler.js";

const OWNER_UID = 501;
/** The home directory every fixture path below lives under. */
const HOME = "/Users/t";
/**
 * Appended to a daemon's command line to mark it as attributable to an agent, the same marker
 * `withRuntimePaseoMcpServer` writes into an agent's own launch and process-attribution.ts reads
 * back. Most fixtures below carry it: they represent a daemon an agent's build left behind.
 */
const AGENT_MARKER_SUFFIX = " --init-script /tmp/paseo?callerAgentId=agent-9";
const UNATTRIBUTED_GRADLE_COMMAND =
  "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java -Xmx4g " +
  "-cp /Users/t/.gradle/wrapper/dists/gradle-9.7.1/lib/gradle-daemon-main-9.7.1.jar " +
  "org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.7.1";
const GRADLE_COMMAND = UNATTRIBUTED_GRADLE_COMMAND + AGENT_MARKER_SUFFIX;
const KOTLIN_COMMAND =
  "/usr/bin/java -Xmx2g -cp kotlin-daemon.jar org.jetbrains.kotlin.daemon.KotlinCompileDaemon " +
  "--daemon-runFilesPath=/Users/t/Library/Application Support/kotlin/daemon" +
  AGENT_MARKER_SUFFIX;

/** A Metro an agent started in its worktree; no marker, so cwd is what attributes it. */
const AGENT_METRO_COMMAND =
  "/usr/local/bin/node /Users/t/.paseo/worktrees/abc12345/node_modules/.bin/expo start --port 8081";

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
  agentOwnedDirs?: readonly string[];
  pidCwd?: ReadonlyMap<number, string>;
  pidTcpConnected?: ReadonlyMap<number, boolean>;
}) {
  const config = { ...CONFIG, ...params.config };
  const agentOwnedDirs = params.agentOwnedDirs ?? [];
  const pidCwd = params.pidCwd ?? new Map();
  const pidTcpConnected = params.pidTcpConnected;
  let memory: BuildDaemonReaperMemory | undefined;
  let nowMs = params.startMs ?? 1_000_000;
  let last = evaluateBuildDaemonReapCandidates({
    rows: [],
    attributedPids: new Set(),
    ownerUid: OWNER_UID,
    config,
    previous: undefined,
    nowMs,
    agentOwnedDirs,
    pidCwd,
    pidTcpConnected,
    homeDir: HOME,
  });
  for (let index = 0; index < params.sweeps; index += 1) {
    last = evaluateBuildDaemonReapCandidates({
      rows: params.rowsForSweep(index),
      attributedPids: params.attributedPids ?? new Set(),
      ownerUid: "ownerUid" in params ? params.ownerUid : OWNER_UID,
      config,
      previous: memory,
      nowMs,
      agentOwnedDirs,
      pidCwd,
      pidTcpConnected,
      homeDir: HOME,
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

  test("a daemon whose own reading is idle but a busy worker child keeps its tree busy", () => {
    // Same shape as the sustained-idleness test above (18 sweeps is enough to reap on the
    // daemon's own reading alone), but a worker JVM child stays busy the whole time.
    const result = runSweeps({
      sweeps: 18,
      rowsForSweep: () => [
        row({ pid: 28056, cpuPercent: 1 }),
        row({ pid: 28057, ppid: 28056, cpuPercent: 180, command: "worker jvm" }),
      ],
    });

    expect(result.candidates).toEqual([]);
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

  test("a daemon carrying an agent marker is attributable and reapable even once that agent is gone", () => {
    // GRADLE_COMMAND already carries the marker: attribution reads the marker itself, not
    // membership in a currently-live agent's tree, since the daemon detached to ppid 1 long ago.
    const result = runSweeps({
      sweeps: 18,
      rowsForSweep: () => [row({ pid: 28056 })],
    });

    expect(result.candidates).toEqual([expect.objectContaining({ pid: 28056, kind: "gradle" })]);
  });

  test("a same-uid daemon with no agent marker is Tyler's own and is never reaped, however idle", () => {
    const result = runSweeps({
      sweeps: 60,
      rowsForSweep: () => [row({ pid: 28056, command: UNATTRIBUTED_GRADLE_COMMAND })],
    });

    expect(result.candidates).toEqual([]);
  });

  test("a daemon with no marker but a cwd under an agent worktree is attributable and reapable", () => {
    const result = runSweeps({
      sweeps: 18,
      rowsForSweep: () => [row({ pid: 28056, command: UNATTRIBUTED_GRADLE_COMMAND })],
      agentOwnedDirs: ["/Users/t/.paseo/worktrees/abc12345"],
      pidCwd: new Map([[28056, "/Users/t/.paseo/worktrees/abc12345/app"]]),
    });

    expect(result.candidates).toEqual([expect.objectContaining({ pid: 28056, kind: "gradle" })]);
  });

  test("a daemon whose cwd falls outside every agent-owned directory is spared, however idle", () => {
    const result = runSweeps({
      sweeps: 60,
      rowsForSweep: () => [row({ pid: 28056, command: UNATTRIBUTED_GRADLE_COMMAND })],
      agentOwnedDirs: ["/Users/t/.paseo/worktrees/abc12345"],
      pidCwd: new Map([[28056, "/Users/t/Projects/some-other-repo"]]),
    });

    expect(result.candidates).toEqual([]);
  });

  test("a same-named sibling directory is not treated as under the agent-owned root", () => {
    // "/Users/t/.paseo/worktrees/abc123" must not match a directory just because it starts with
    // the same characters as "/Users/t/.paseo/worktrees/abc12345" — only real containment counts.
    const result = runSweeps({
      sweeps: 60,
      rowsForSweep: () => [row({ pid: 28056, command: UNATTRIBUTED_GRADLE_COMMAND })],
      agentOwnedDirs: ["/Users/t/.paseo/worktrees/abc12345"],
      pidCwd: new Map([[28056, "/Users/t/.paseo/worktrees/abc123"]]),
    });

    expect(result.candidates).toEqual([]);
  });

  test("a Gradle daemon with no cwd resolved is attributed from a project path in its argv", () => {
    const result = runSweeps({
      sweeps: 18,
      rowsForSweep: () => [
        row({
          pid: 28056,
          command: `${UNATTRIBUTED_GRADLE_COMMAND} -Dorg.gradle.project.dir=/Users/t/.paseo/worktrees/abc12345/app`,
        }),
      ],
      agentOwnedDirs: ["/Users/t/.paseo/worktrees/abc12345"],
      // No lsof entry for 28056 — this daemon is attributed by argv alone.
      pidCwd: new Map(),
    });

    expect(result.candidates).toEqual([expect.objectContaining({ pid: 28056, kind: "gradle" })]);
  });

  test("a failed cwd resolution leaves an unmarked daemon judged on argv alone, and spares it", () => {
    // Simulates every pid missing from `pidCwd` because the batched lsof call itself failed —
    // the reaper must not treat "unresolved" as "attributed".
    const result = runSweeps({
      sweeps: 60,
      rowsForSweep: () => [row({ pid: 28056, command: UNATTRIBUTED_GRADLE_COMMAND })],
      agentOwnedDirs: ["/Users/t/.paseo/worktrees/abc12345"],
      pidCwd: new Map(),
    });

    expect(result.candidates).toEqual([]);
  });

  test("an agent whose cwd was $HOME does not make Tyler's own daemons agent-owned", () => {
    // Nine live agent records have cwd = $HOME. Counting it would make every daemon that runs
    // anywhere in the home directory, or names a home path in its argv, look like an agent's.
    const studioGradle = row({ pid: 28056, command: UNATTRIBUTED_GRADLE_COMMAND });
    const checkoutGradle = row({ pid: 28057, command: UNATTRIBUTED_GRADLE_COMMAND });
    const result = runSweeps({
      sweeps: 60,
      rowsForSweep: () => [studioGradle, checkoutGradle],
      agentOwnedDirs: ["/Users/t/.paseo/worktrees", HOME, `${HOME}/`],
      pidCwd: new Map([
        [28056, "/Users/t/.gradle/daemon/9.7.1"],
        [28057, "/Users/t/mobile-worktrees/main"],
      ]),
      config: { maxPerSweep: 10 },
    });

    expect(result.candidates).toEqual([]);
    expect(result.sightings.map((sighting) => sighting.verdict)).toEqual([
      "not-abandoned",
      "not-abandoned",
    ]);
  });

  test("/ and every ancestor of $HOME are never agent-owned either", () => {
    const result = runSweeps({
      sweeps: 60,
      rowsForSweep: () => [row({ pid: 28056, command: UNATTRIBUTED_GRADLE_COMMAND })],
      agentOwnedDirs: ["/", "/Users", "/Users/", "", "relative/dir"],
      pidCwd: new Map([[28056, "/Users/t/Projects/tylers-own-app"]]),
    });

    expect(result.candidates).toEqual([]);
  });

  test("an agent worktree daemon is still reapable with $HOME among the agent cwds", () => {
    const result = runSweeps({
      sweeps: 18,
      rowsForSweep: () => [row({ pid: 28056, command: UNATTRIBUTED_GRADLE_COMMAND })],
      agentOwnedDirs: ["/Users/t/.paseo/worktrees", HOME],
      pidCwd: new Map([[28056, "/Users/t/.paseo/worktrees/abc12345/app"]]),
    });

    expect(result.candidates).toEqual([expect.objectContaining({ pid: 28056, kind: "gradle" })]);
  });

  test("an argv path matches an agent-owned directory only on a path boundary", () => {
    const withArg = (pid: number, arg: string) =>
      row({ pid, command: `${UNATTRIBUTED_GRADLE_COMMAND} ${arg}` });
    const result = runSweeps({
      sweeps: 18,
      rowsForSweep: () => [
        withArg(701, "-Dorg.gradle.project.dir=/Users/t/paseo-worktrees/x/app"),
        withArg(702, "--project-cache-dir /Users/t/paseo-scratch/cache"),
        withArg(703, "-Dorg.gradle.project.dir=/Users/t/other/Users/t/paseo/app"),
        withArg(704, "-Dorg.gradle.project.dir=/Users/t/paseo/android"),
        withArg(705, "-cp /Users/t/paseo:/opt/lib/tools.jar"),
        withArg(706, "--project-dir /Users/t/paseo"),
      ],
      agentOwnedDirs: ["/Users/t/paseo"],
      config: { maxPerSweep: 10 },
    });

    expect(result.candidates.map((candidate) => candidate.pid).sort()).toEqual([704, 705, 706]);
  });

  test("an idle Metro with an established client, such as Tyler's phone, is spared however long", () => {
    const result = runSweeps({
      sweeps: 60,
      rowsForSweep: () => [row({ pid: 901, command: AGENT_METRO_COMMAND })],
      agentOwnedDirs: ["/Users/t/.paseo/worktrees"],
      pidCwd: new Map([[901, "/Users/t/.paseo/worktrees/abc12345"]]),
      pidTcpConnected: new Map([[901, true]]),
    });

    expect(result.candidates).toEqual([]);
    expect(result.sightings).toEqual([
      expect.objectContaining({ pid: 901, kind: "metro", verdict: "serving-clients" }),
    ]);
  });

  test("a Metro whose connections could not be checked is spared, never assumed idle", () => {
    const result = runSweeps({
      sweeps: 60,
      rowsForSweep: () => [row({ pid: 901, command: AGENT_METRO_COMMAND })],
      agentOwnedDirs: ["/Users/t/.paseo/worktrees"],
      pidCwd: new Map([[901, "/Users/t/.paseo/worktrees/abc12345"]]),
      pidTcpConnected: new Map(),
    });

    expect(result.candidates).toEqual([]);
  });

  test("a client connecting mid-way restarts a Metro's idle clock", () => {
    const result = runSweeps({
      sweeps: 18,
      rowsForSweep: () => [row({ pid: 901, command: AGENT_METRO_COMMAND })],
      agentOwnedDirs: ["/Users/t/.paseo/worktrees"],
      pidCwd: new Map([[901, "/Users/t/.paseo/worktrees/abc12345"]]),
      pidTcpConnected: new Map([[901, false]]),
    });
    expect(result.candidates).toEqual([expect.objectContaining({ pid: 901, kind: "metro" })]);

    const connected = evaluateBuildDaemonReapCandidates({
      rows: [row({ pid: 901, command: AGENT_METRO_COMMAND })],
      attributedPids: new Set(),
      ownerUid: OWNER_UID,
      config: CONFIG,
      previous: result.memory,
      nowMs: 1_000_000 + 18 * 60_000,
      agentOwnedDirs: ["/Users/t/.paseo/worktrees"],
      pidCwd: new Map([[901, "/Users/t/.paseo/worktrees/abc12345"]]),
      pidTcpConnected: new Map([[901, true]]),
      homeDir: HOME,
    });
    expect(connected.candidates).toEqual([]);
    expect(connected.memory.get(901)).toMatchObject({ idleSinceMs: undefined, idleSweeps: 0 });
  });

  test("the connection check only gates dev servers: an idle Gradle daemon needs no answer", () => {
    const result = runSweeps({
      sweeps: 18,
      rowsForSweep: () => [row({ pid: 28056 })],
      pidTcpConnected: new Map(),
    });

    expect(result.candidates).toEqual([expect.objectContaining({ pid: 28056, kind: "gradle" })]);
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

  test("reaps every .NET and Metro kind under the same abandonment rules as Gradle", () => {
    const commands = {
      vbcscompiler:
        "/Users/t/.dotnet/sdk/10.0.200/Roslyn/bincore/VBCSCompiler -pipename:jFFfIURcCsGm+nTDd_yF" +
        AGENT_MARKER_SUFFIX,
      "msbuild-node":
        "/Users/t/.dotnet/dotnet /Users/t/.dotnet/sdk/10.0.200/MSBuild.dll /noautoresponse " +
        "/nologo /nodemode:1 /nodeReuse:true /low:false" +
        AGENT_MARKER_SUFFIX,
      "razor-server":
        "/Users/t/.dotnet/dotnet /Users/t/.dotnet/sdk/10.0.200/Sdks/Microsoft.NET.Sdk.Razor/" +
        "tools/rzc.dll server -p rzc-4f2a91c0" +
        AGENT_MARKER_SUFFIX,
      metro:
        "/usr/local/bin/node /Users/t/app/node_modules/.bin/expo start --port 8081" +
        AGENT_MARKER_SUFFIX,
    } as const;
    const kinds = Object.keys(commands) as (keyof typeof commands)[];

    const result = runSweeps({
      sweeps: 20,
      rowsForSweep: () =>
        kinds.map((kind, index) => row({ pid: 800 + index, command: commands[kind] })),
      config: { maxPerSweep: 10 },
      // Metro is the one dev server: it is reapable only once lsof says nobody is connected.
      pidTcpConnected: new Map([[800 + kinds.indexOf("metro"), false]]),
    });

    expect(result.candidates.map((candidate) => candidate.kind).sort()).toEqual([...kinds].sort());
    expect(result.candidates.map((candidate) => candidate.label).sort()).toEqual([
      ".NET compiler server (VBCSCompiler)",
      "MSBuild node",
      "Metro bundler",
      "Razor build server",
    ]);
  });

  test("an MSBuild worker or Metro whose launcher is still alive is somebody's session", () => {
    const result = runSweeps({
      sweeps: 30,
      rowsForSweep: () => [
        row({
          pid: 900,
          ppid: 45279,
          command:
            "/Users/t/.dotnet/dotnet /Users/t/.dotnet/sdk/10.0.200/MSBuild.dll /nodemode:1 " +
            "/nodeReuse:true",
        }),
        row({
          pid: 901,
          ppid: 5150,
          command: "node /Users/t/app/node_modules/.bin/expo start",
        }),
      ],
    });

    expect(result.candidates).toEqual([]);
    expect(result.memory.size).toBe(0);
  });

  test("a busy Metro is spared however long it has been orphaned", () => {
    const result = runSweeps({
      sweeps: 30,
      rowsForSweep: () => [
        row({
          pid: 901,
          command: "node /Users/t/app/node_modules/.bin/expo start" + AGENT_MARKER_SUFFIX,
          cpuPercent: 35,
        }),
      ],
    });

    expect(result.candidates).toEqual([]);
  });

  test("a ppid-1 dotnet client is reported as not-on-allowlist, never signalled", () => {
    const result = runSweeps({
      sweeps: 30,
      rowsForSweep: () => [
        row({ pid: 902, command: "grep VBCSCompiler" }),
        row({ pid: 903, command: "dotnet build src/Crm.csproj" }),
      ],
    });

    expect(result.candidates).toEqual([]);
    expect(result.sightings).toEqual([
      expect.objectContaining({ pid: 902, verdict: "not-on-allowlist" }),
    ]);
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

  test("parses and then reaps an attributed daemon, so the sampler and the signature agree on the real thing", () => {
    const rows = parsePsOutput(
      ["  PID  PPID   UID    RSS %CPU     ELAPSED        TIME COMMAND", PS_LINE].join("\n"),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pid: 28056, ppid: 1, uid: 501, rssKb: 3_369_792 });

    // A real ps line never carries the agent marker on its own — it is added here to represent
    // the case this daemon was left behind by an agent's build, not typed by Tyler's own hand.
    const attributedCommand = (rows[0] as ProcessSampleRow).command + AGENT_MARKER_SUFFIX;
    const result = runSweeps({
      sweeps: 20,
      rowsForSweep: () => [
        { ...(rows[0] as ProcessSampleRow), cpuPercent: 0, command: attributedCommand },
      ],
    });

    expect(result.candidates).toMatchObject([{ pid: 28056, kind: "gradle" }]);
  });
});

describe("selectBuildDaemonPidsNeedingCwd", () => {
  test("selects only same-uid, ppid-1, allowlisted daemons with no marker and no prior handling", () => {
    const rows = [
      row({ pid: 1, command: "/sbin/launchd" }), // pid 1 itself, never a candidate
      row({ pid: 28056, command: UNATTRIBUTED_GRADLE_COMMAND }), // selected
      row({ pid: 28057, command: GRADLE_COMMAND }), // carries the marker already
      row({ pid: 28058, ppid: 4242, command: UNATTRIBUTED_GRADLE_COMMAND }), // has a live parent
      row({ pid: 28059, uid: 502, command: UNATTRIBUTED_GRADLE_COMMAND }), // another user
      row({ pid: 28060, command: "vim notes.md" }), // not on the allowlist
    ];

    expect(selectBuildDaemonPidsNeedingCwd(rows, new Set(), OWNER_UID, undefined)).toEqual([28056]);
  });

  test("skips a pid the reaper has already attributed via a live agent tree", () => {
    const rows = [row({ pid: 28056, command: UNATTRIBUTED_GRADLE_COMMAND })];

    expect(selectBuildDaemonPidsNeedingCwd(rows, new Set([28056]), OWNER_UID, undefined)).toEqual(
      [],
    );
  });

  test("skips a pid already marked handled in a previous sweep's memory", () => {
    const rows = [row({ pid: 28056, command: UNATTRIBUTED_GRADLE_COMMAND })];
    const previous: BuildDaemonReaperMemory = new Map([
      [
        28056,
        { kind: "gradle", firstSeenAtMs: 0, idleSinceMs: 0, idleSweeps: 5, handled: "reported" },
      ],
    ]);

    expect(selectBuildDaemonPidsNeedingCwd(rows, new Set(), OWNER_UID, previous)).toEqual([]);
  });

  test("selects nothing when the owner uid is unknown", () => {
    const rows = [row({ pid: 28056, command: UNATTRIBUTED_GRADLE_COMMAND })];

    expect(selectBuildDaemonPidsNeedingCwd(rows, new Set(), undefined, undefined)).toEqual([]);
  });
});

describe("selectBuildDaemonPidsNeedingConnectionCheck", () => {
  test("selects same-uid, ppid-1 Metro daemons only, marker or not, and nothing already handled", () => {
    const memory: BuildDaemonReaperMemory = new Map();
    const rows = [
      row({ pid: 1, command: AGENT_METRO_COMMAND }),
      row({ pid: 2, command: AGENT_METRO_COMMAND + AGENT_MARKER_SUFFIX }),
      row({ pid: 3 }), // Gradle: not a dev server
      row({ pid: 4, command: AGENT_METRO_COMMAND, ppid: 777 }),
      row({ pid: 5, command: AGENT_METRO_COMMAND, uid: 502 }),
      row({ pid: 6, command: AGENT_METRO_COMMAND }),
      row({ pid: 7, command: AGENT_METRO_COMMAND }),
    ];
    memory.set(6, {
      kind: "metro",
      firstSeenAtMs: 0,
      idleSinceMs: 0,
      idleSweeps: 20,
      handled: "signalled",
    });

    expect(
      selectBuildDaemonPidsNeedingConnectionCheck(rows, new Set([7]), OWNER_UID, memory),
    ).toEqual([1, 2]);
    expect(selectBuildDaemonPidsNeedingConnectionCheck(rows, new Set(), undefined, memory)).toEqual(
      [],
    );
  });
});

describe("parseLsofPidOutput", () => {
  test("collects every p-line and ignores the fd and name lines", () => {
    expect(parseLsofPidOutput("p901\nf14\nn127.0.0.1:8081->127.0.0.1:50122\np902\nf9\n")).toEqual(
      new Set([901, 902]),
    );
  });

  test("empty output means no pid had a connection", () => {
    expect(parseLsofPidOutput("")).toEqual(new Set());
  });
});

async function listenOnLoopback(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => socket.on("error", () => {}));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { server, port: address.port };
}

async function connectOnLoopback(port: number): Promise<Socket> {
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  return socket;
}

describe("createSystemBuildDaemonConnectionChecker", () => {
  let server: Server | undefined;
  let client: Socket | undefined;
  let child: ReturnType<typeof spawn> | undefined;

  afterEach(() => {
    client?.destroy();
    server?.close();
    child?.kill("SIGKILL");
    client = undefined;
    server = undefined;
    child = undefined;
  });

  test.skipIf(process.platform === "win32")(
    "sees this process's established loopback connection, and none on an idle child",
    async () => {
      const listening = await listenOnLoopback();
      server = listening.server;
      client = await connectOnLoopback(listening.port);
      child = spawn("sleep", ["30"], { stdio: "ignore" });
      const childPid = child.pid;
      if (childPid === undefined) throw new Error("no child pid");

      const result = await createSystemBuildDaemonConnectionChecker().check([
        process.pid,
        childPid,
      ]);

      expect(result).toEqual(
        new Map([
          [process.pid, true],
          [childPid, false],
        ]),
      );
    },
  );

  test("an empty pid list never shells out and answers nothing", async () => {
    expect(await createSystemBuildDaemonConnectionChecker().check([])).toEqual(new Map());
  });

  test("an lsof that cannot run answers nothing, so every Metro is spared", async () => {
    const checker = createSystemBuildDaemonConnectionChecker({
      lsofPath: "/nonexistent/paseo-test-lsof",
    });

    expect(await checker.check([process.pid])).toEqual(new Map());
  });
});

describe("parseLsofCwdOutput", () => {
  test("pairs each p-line with the n-line that follows it", () => {
    const output = ["p28056", "n/Users/t/.paseo/worktrees/abc12345/app", "p900", "n/Users/t"].join(
      "\n",
    );

    expect(parseLsofCwdOutput(output)).toEqual(
      new Map([
        [28056, "/Users/t/.paseo/worktrees/abc12345/app"],
        [900, "/Users/t"],
      ]),
    );
  });

  test("ignores an n-line before any p-line, and tolerates blank lines", () => {
    const output = ["", "n/orphaned", "p28056", "", "n/Users/t/app", ""].join("\n");

    expect(parseLsofCwdOutput(output)).toEqual(new Map([[28056, "/Users/t/app"]]));
  });

  test("empty output resolves nothing", () => {
    expect(parseLsofCwdOutput("")).toEqual(new Map());
  });
});

describe("createSystemBuildDaemonCwdResolver", () => {
  test("resolves this very process's own cwd via a real lsof call", async () => {
    const resolver = createSystemBuildDaemonCwdResolver();

    const result = await resolver.resolve([process.pid]);

    // lsof reports the real (symlink-resolved) path, which is what realpathSync gives too.
    expect(result.get(process.pid)).toBe(realpathSync(process.cwd()));
  });

  test("an empty pid list never shells out and resolves nothing", async () => {
    const resolver = createSystemBuildDaemonCwdResolver();

    expect(await resolver.resolve([])).toEqual(new Map());
  });

  test("a pid that cannot exist resolves to an empty map rather than throwing", async () => {
    const resolver = createSystemBuildDaemonCwdResolver();

    await expect(resolver.resolve([0x7fff_fffe])).resolves.toEqual(new Map());
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
