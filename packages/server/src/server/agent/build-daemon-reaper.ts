/**
 * Selection logic for AgentResourceMonitor's opt-in reaper leg: which of the orphan build
 * daemons process-attribution.ts already counts are provably abandoned, and therefore safe to
 * signal. Pure apart from the signaller seam at the bottom — the monitor calls
 * `evaluateBuildDaemonReapCandidates` once per sweep and carries the returned memory to the
 * next one, the same shape process-cpu-rate.ts uses. See docs/resource-monitor.md.
 *
 * Every rule here exists to answer one question: is anybody still using this? A daemon in the
 * middle of somebody's build must survive every sweep, so the checks are conjunctive and each
 * one on its own is enough to spare a process.
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath, sep as PATH_SEP } from "node:path";
import { promisify } from "node:util";
import {
  isOrphanBuildDaemonCommand,
  matchBuildDaemonSignature,
  type BuildDaemonSignature,
  type ReapableBuildDaemonKind,
} from "./build-daemon-signatures.js";
import { buildChildrenByPpid, collectDescendants } from "./process-attribution.js";
import type { ProcessSampleRow } from "./process-sampler.js";

const execFileAsync = promisify(execFile);

export type { ReapableBuildDaemonKind } from "./build-daemon-signatures.js";

/**
 * The marker process-attribution.ts attributes live agent trees by. A ppid-1 build daemon can
 * never itself be a member of a live tree (it detached from its launcher), so this is one of two
 * pieces of evidence that ties one to an agent rather than to Tyler's own terminal or IDE — the
 * other is its cwd or a project path in its argv falling under an agent-owned directory (below).
 * Build tools rarely carry this marker themselves, so relying on it alone left real-world reap
 * coverage near zero; see docs/resource-monitor.md.
 */
const AGENT_MARKER = "callerAgentId=";

/**
 * Dev servers: a process whose client (Tyler's phone through `adb reverse` or the LAN, a browser)
 * holds a connection to it while the process itself sits at zero CPU. For these, idle CPU is not
 * evidence that nobody uses it, so an ESTABLISHED TCP connection also spares it.
 */
const CLIENT_SERVING_KINDS: ReadonlySet<ReapableBuildDaemonKind> = new Set(["metro"]);

export interface BuildDaemonReaperConfig {
  /** A tree-rate CPU reading at or below this counts as idle for the sweep. */
  idleCpuPercent: number;
  /** How long a daemon must have been continuously idle before it can be reaped. */
  idleMinutes: number;
  /** How many separate sweeps must have observed that idleness. One sample is not evidence. */
  minIdleSweeps: number;
  /** Blast radius: the most daemons one sweep may signal. */
  maxPerSweep: number;
}

/** What one sweep remembers per candidate pid so the next sweep can judge sustained idleness. */
export interface BuildDaemonReapState {
  kind: ReapableBuildDaemonKind;
  firstSeenAtMs: number;
  /** When the current unbroken run of idle sweeps started; undefined until one has been seen. */
  idleSinceMs: number | undefined;
  idleSweeps: number;
  /**
   * Why later sweeps must leave this pid alone. Set once the reaper has acted on it — a
   * lingering or un-signallable pid is still in the next `ps` snapshot, and without this it
   * would be signalled and reported again every 60 seconds.
   */
  handled?: BuildDaemonHandledReason;
}

export type BuildDaemonHandledReason = "signalled" | "reported" | "not-permitted";

export type BuildDaemonReaperMemory = Map<number, BuildDaemonReapState>;

export interface BuildDaemonReapCandidate {
  pid: number;
  kind: ReapableBuildDaemonKind;
  label: string;
  rssBytes: number;
  idleMs: number;
  idleSweeps: number;
}

export interface EvaluateBuildDaemonReapCandidatesInput {
  rows: readonly ProcessSampleRow[];
  /** Every pid in a live agent's process tree, from attributeProcessTrees. */
  attributedPids: ReadonlySet<number>;
  /** The uid the daemon itself runs as; undefined on a platform that can't report it. */
  ownerUid: number | undefined;
  config: BuildDaemonReaperConfig;
  previous: BuildDaemonReaperMemory | undefined;
  nowMs: number;
  /**
   * Directories that belong to a Paseo agent workspace — any cwd ever recorded for an agent,
   * live or archived — or a configured Paseo worktree root. A ppid-1 daemon with no agent
   * marker is still attributable if its resolved cwd or a path in its argv falls under one of
   * these. Absent or empty: attribution falls back to the marker alone. Optional so existing
   * callers that only judge by the marker keep compiling.
   */
  agentOwnedDirs?: readonly string[];
  /**
   * Each candidate pid's cwd, resolved out-of-band (macOS: `lsof -d cwd`, batched). A pid
   * missing here was never resolved — the lsof call failed, timed out, or wasn't asked — and is
   * judged on argv and the marker alone, never assumed abandoned by omission.
   */
  pidCwd?: ReadonlyMap<number, string>;
  /**
   * For each client-serving daemon (Metro), whether it has an ESTABLISHED TCP connection. `true`
   * spares it this sweep, and so does a pid missing here: the check failed or never ran.
   */
  pidTcpConnected?: ReadonlyMap<number, boolean>;
  /**
   * The user's home directory; defaults to `os.homedir()`. It and every ancestor of it are
   * dropped from `agentOwnedDirs`: an agent that ran in `$HOME` does not own everything in it.
   */
  homeDir?: string;
}

/**
 * Why a ppid-1 build daemon was or was not selected this sweep. The reaper used to say nothing
 * unless it would kill, which made "never fired" identical to "never saw a daemon" and to "the
 * matcher rejects every real command line": a week of dry run proved none of the three apart.
 */
export type BuildDaemonVerdict =
  /** Carries a build-daemon marker but is not on the allowlist, so it is never signalled. */
  | "not-on-allowlist"
  /** A live agent, an agent launch marker, or another user owns it. */
  | "not-abandoned"
  /** First sighting carries no idle evidence. */
  | "first-sighting"
  /** Above the idle CPU threshold this sweep: somebody is building. Spared. */
  | "busy"
  /** A dev server with an ESTABLISHED TCP client, or whose connections could not be checked. */
  | "serving-clients"
  /** Idle, but not for long enough or across enough sweeps yet. */
  | "idle-accumulating"
  /** Would be (or was) selected. */
  | "candidate"
  /** Already acted on, or reported, in an earlier sweep. */
  | "handled";

export interface BuildDaemonSighting {
  pid: number;
  verdict: BuildDaemonVerdict;
  kind: ReapableBuildDaemonKind | undefined;
  rssBytes: number;
  /** The process tree's rate (this pid plus every descendant), not just the row's own. */
  cpuPercent: number;
  idleSweeps: number;
}

export interface EvaluateBuildDaemonReapCandidatesResult {
  /** Already capped at `maxPerSweep`, largest first — the cap should reclaim the most memory. */
  candidates: BuildDaemonReapCandidate[];
  memory: BuildDaemonReaperMemory;
  /** Every ppid-1 process carrying a build-daemon marker, with the reason it was spared or picked. */
  sightings: BuildDaemonSighting[];
}

/**
 * Whether `candidatePath` is `dir` itself or a real descendant of it — a lexical prefix check,
 * not a filesystem one. Deliberately not realpath-aware: this runs once per ppid-1 row every
 * sweep, and resolving symlinks on every comparison would put disk I/O in the resource monitor's
 * hot path. lsof already reports a process's cwd resolved, so the common case needs no help.
 */
function isPathUnderDir(candidatePath: string, dir: string): boolean {
  if (candidatePath === dir) return true;
  const dirWithSep = dir.endsWith(PATH_SEP) ? dir : `${dir}${PATH_SEP}`;
  return candidatePath.startsWith(dirWithSep);
}

/**
 * The agent-owned directories that can attribute anything: absolute, normalized, deduplicated,
 * and never `$HOME`, `/`, or a directory between them. Agents do run in `$HOME` (the live store
 * has records with it as their cwd), and counting it would make every daemon under the home
 * directory, or naming a home path in its argv, look like an agent's: Android Studio's Gradle
 * daemon in `~/.gradle/daemon`, a Metro Tyler started in his own checkout.
 */
function usableAgentOwnedDirs(dirs: readonly string[], homeDir: string): string[] {
  const home = resolvePath(homeDir);
  const usable = new Set<string>();
  for (const dir of dirs) {
    if (dir.length === 0 || !isAbsolute(dir)) continue;
    const normalized = resolvePath(dir);
    if (isPathUnderDir(home, normalized)) continue;
    usable.add(normalized);
  }
  return [...usable];
}

/** Characters that end a path inside one argv string: spaces, `=` in `-Dkey=path`, list separators. */
const ARGV_PATH_DELIMITERS = new Set([" ", "\t", "=", ":", ";", ",", '"', "'"]);

/**
 * Whether `command` names `dir` or something under it as a whole path: the match must start the
 * string or follow a delimiter, and end the string, a delimiter, or a separator. So
 * `/Users/t/paseo` matches `-Dorg.gradle.project.dir=/Users/t/paseo/app` and `-cp /Users/t/paseo:x`,
 * but not `/Users/t/paseo-worktrees/…`.
 */
function argvNamesPathUnder(command: string, dir: string): boolean {
  for (let at = command.indexOf(dir); at !== -1; at = command.indexOf(dir, at + 1)) {
    const before = at === 0 ? undefined : command[at - 1];
    const after = command[at + dir.length];
    const startsPath = before === undefined || ARGV_PATH_DELIMITERS.has(before);
    const endsPath =
      after === undefined || after === "/" || after === "\\" || ARGV_PATH_DELIMITERS.has(after);
    if (startsPath && endsPath) return true;
  }
  return false;
}

/**
 * True if this daemon's resolved cwd, or a path in its own argv (Gradle carries its project
 * directory in a `-Dorg.gradle.project...` system property; Kotlin and the others only ever show
 * it via cwd), falls under any directory an agent has ever owned. A daemon with nothing resolved
 * in `pidCwd` — lsof never ran, failed, or timed out — is judged on argv alone.
 */
function isUnderAgentOwnedDir(
  row: ProcessSampleRow,
  agentOwnedDirs: readonly string[],
  pidCwd: ReadonlyMap<number, string>,
): boolean {
  if (agentOwnedDirs.length === 0) return false;
  const cwd = pidCwd.get(row.pid);
  return agentOwnedDirs.some(
    (dir) =>
      (cwd !== undefined && isPathUnderDir(cwd, dir)) || argvNamesPathUnder(row.command, dir),
  );
}

/**
 * Why this sweep's reading says somebody is using the daemon, if it does. `busy`: its tree is
 * above the idle CPU threshold, so somebody is building. `serving-clients`: a dev server with an
 * ESTABLISHED TCP client, or whose connections nobody could check (`tcpConnected` undefined);
 * either way it may be serving Tyler's phone.
 */
function inUseThisSweep(
  kind: ReapableBuildDaemonKind,
  treeCpu: number,
  tcpConnected: boolean | undefined,
  config: BuildDaemonReaperConfig,
): "busy" | "serving-clients" | undefined {
  if (treeCpu > config.idleCpuPercent) return "busy";
  if (CLIENT_SERVING_KINDS.has(kind) && tcpConnected !== false) return "serving-clients";
  return undefined;
}

/**
 * The facts that together mean "nobody is using this, and it was an agent's". Not idleness —
 * that's measured over time below; this is the structural half, re-checked on every sweep.
 */
function isAbandoned(
  row: ProcessSampleRow,
  attributedPids: ReadonlySet<number>,
  ownerUid: number | undefined,
  agentOwnedDirs: readonly string[],
  pidCwd: ReadonlyMap<number, string>,
): boolean {
  // Reparented to init: the shell, Gradle client, or agent that launched it is gone. A daemon
  // serving a build in progress still has its launcher as a parent.
  if (row.ppid !== 1) return false;
  // A live agent's tree owns it. Can't happen while ppid is 1, and cheap insurance if the
  // attribution walk ever learns to reach further.
  if (attributedPids.has(row.pid)) return false;
  // Another user's process, or a platform where we can't tell whose it is. Both refuse.
  if (ownerUid === undefined || row.uid !== ownerUid) return false;
  // Tied to an agent either directly (the marker) or by location (its cwd or argv falls under a
  // directory an agent has owned). Neither: left alone rather than assumed abandoned — it may be
  // Tyler's own terminal or IDE build, same uid and all.
  return row.command.includes(AGENT_MARKER) || isUnderAgentOwnedDir(row, agentOwnedDirs, pidCwd);
}

export function evaluateBuildDaemonReapCandidates(
  input: EvaluateBuildDaemonReapCandidatesInput,
): EvaluateBuildDaemonReapCandidatesResult {
  const memory: BuildDaemonReaperMemory = new Map();
  const candidates: BuildDaemonReapCandidate[] = [];
  const sightings: BuildDaemonSighting[] = [];
  const idleThresholdMs = input.config.idleMinutes * 60_000;
  const agentOwnedDirs = usableAgentOwnedDirs(
    input.agentOwnedDirs ?? [],
    input.homeDir ?? homedir(),
  );
  const pidCwd = input.pidCwd ?? new Map<number, string>();
  // Worker JVMs, test executors and R8 workers are the daemon's children, not itself: a daemon
  // that reads idle on its own row while they burn CPU is still serving a build.
  const rowsByPid = new Map(input.rows.map((r) => [r.pid, r] as const));
  const childrenByPpid = buildChildrenByPpid(input.rows);
  const treeCpuPercent = (pid: number): number =>
    collectDescendants(pid, rowsByPid, childrenByPpid).reduce((sum, r) => sum + r.cpuPercent, 0);

  for (const row of input.rows) {
    const signature: BuildDaemonSignature | undefined = matchBuildDaemonSignature(row.command);
    const treeCpu = treeCpuPercent(row.pid);
    const sight = (verdict: BuildDaemonVerdict, idleSweeps = 0): void => {
      sightings.push({
        pid: row.pid,
        verdict,
        kind: signature?.kind,
        rssBytes: row.rssKb * 1024,
        cpuPercent: treeCpu,
        idleSweeps,
      });
    };
    if (!signature) {
      if (row.ppid === 1 && isOrphanBuildDaemonCommand(row.command)) {
        sight("not-on-allowlist");
      }
      continue;
    }

    const previous = input.previous?.get(row.pid);
    if (previous?.handled !== undefined) {
      memory.set(row.pid, previous);
      sight("handled");
      continue;
    }
    // Dropping the pid from memory rather than resetting it in place is deliberate: a daemon
    // that stops looking abandoned has to re-earn its evidence from a first sighting.
    if (!isAbandoned(row, input.attributedPids, input.ownerUid, agentOwnedDirs, pidCwd)) {
      if (row.ppid === 1) sight("not-abandoned");
      continue;
    }

    if (!previous) {
      // First sighting carries no idle evidence at all: `cpuPercent` is still `ps`'s decayed
      // lifetime average this sweep (process-cpu-rate.ts), which for a daemon that compiled
      // hard an hour ago and has slept since reads as busy — and for the reverse case, reads
      // idle. Only a rate between two sweeps means anything.
      memory.set(row.pid, {
        kind: signature.kind,
        firstSeenAtMs: input.nowMs,
        idleSinceMs: undefined,
        idleSweeps: 0,
      });
      sight("first-sighting");
      continue;
    }

    const inUse = inUseThisSweep(
      signature.kind,
      treeCpu,
      input.pidTcpConnected?.get(row.pid),
      input.config,
    );
    if (inUse) {
      // The idle clock restarts from zero, not from where it was.
      memory.set(row.pid, {
        kind: signature.kind,
        firstSeenAtMs: previous.firstSeenAtMs,
        idleSinceMs: undefined,
        idleSweeps: 0,
      });
      sight(inUse);
      continue;
    }

    const idleSinceMs = previous.idleSinceMs ?? input.nowMs;
    const idleSweeps = previous.idleSweeps + 1;
    memory.set(row.pid, {
      kind: signature.kind,
      firstSeenAtMs: previous.firstSeenAtMs,
      idleSinceMs,
      idleSweeps,
    });

    // Both gates, not either: the sweep count is what makes this evidence rather than one
    // sample, and the wall-clock duration is what a stalled or restarted sweep loop can't fake.
    const idleMs = input.nowMs - idleSinceMs;
    if (idleSweeps < input.config.minIdleSweeps || idleMs < idleThresholdMs) {
      sight("idle-accumulating", idleSweeps);
      continue;
    }

    sight("candidate", idleSweeps);
    candidates.push({
      pid: row.pid,
      kind: signature.kind,
      label: signature.label,
      rssBytes: row.rssKb * 1024,
      idleMs,
      idleSweeps,
    });
  }

  candidates.sort((a, b) => b.rssBytes - a.rssBytes);
  return { candidates: candidates.slice(0, input.config.maxPerSweep), memory, sightings };
}

/**
 * Which ppid-1 candidates are worth spending an lsof call on: same-uid, on the allowlist, not
 * already tied to a live agent tree, not already carrying the marker (which needs no cwd to
 * attribute), and not already `handled` in the previous sweep's memory (a pid the reaper is done
 * with, or gave up on, never needs its cwd refreshed). Kept separate from `isAbandoned` so the
 * caller can resolve cwds for exactly this set in one batched call before evaluating candidates.
 */
export function selectBuildDaemonPidsNeedingCwd(
  rows: readonly ProcessSampleRow[],
  attributedPids: ReadonlySet<number>,
  ownerUid: number | undefined,
  previous: BuildDaemonReaperMemory | undefined,
): number[] {
  if (ownerUid === undefined) return [];
  return rows
    .filter(
      (row) =>
        row.ppid === 1 &&
        row.uid === ownerUid &&
        !attributedPids.has(row.pid) &&
        !row.command.includes(AGENT_MARKER) &&
        previous?.get(row.pid)?.handled === undefined &&
        matchBuildDaemonSignature(row.command) !== undefined,
    )
    .map((row) => row.pid);
}

/**
 * Which ppid-1 candidates need the ESTABLISHED-connection check: same-uid, client-serving kinds
 * (Metro), not in a live agent tree, and not already handled. Marker or not: the marker says
 * whose it was, not whether Tyler's phone is connected to it now.
 */
export function selectBuildDaemonPidsNeedingConnectionCheck(
  rows: readonly ProcessSampleRow[],
  attributedPids: ReadonlySet<number>,
  ownerUid: number | undefined,
  previous: BuildDaemonReaperMemory | undefined,
): number[] {
  if (ownerUid === undefined) return [];
  return rows
    .filter((row) => {
      if (row.ppid !== 1 || row.uid !== ownerUid || attributedPids.has(row.pid)) return false;
      if (previous?.get(row.pid)?.handled !== undefined) return false;
      const signature = matchBuildDaemonSignature(row.command);
      return signature !== undefined && CLIENT_SERVING_KINDS.has(signature.kind);
    })
    .map((row) => row.pid);
}

/**
 * Records that the reaper is done with `pid`, so later sweeps skip it. One decision per process:
 * a daemon is signalled once, a dry run reports it once, and a pid that came back EPERM is never
 * asked again.
 */
export function markBuildDaemonHandled(
  memory: BuildDaemonReaperMemory,
  pid: number,
  reason: BuildDaemonHandledReason,
): void {
  const state = memory.get(pid);
  if (state) memory.set(pid, { ...state, handled: reason });
}

export type ProcessSignalOutcome = "sent" | "gone" | "not-permitted" | "failed";

/**
 * Injectable seam for process signalling, mirroring process-sampler.ts's ProcessSampler: tests
 * drive the whole reap path without a real pid ever receiving a signal.
 */
export interface ProcessSignaller {
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): ProcessSignalOutcome;
  isRunning(pid: number): boolean;
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

export function createSystemProcessSignaller(): ProcessSignaller {
  return {
    signal(pid, signal) {
      // The last gate before a real signal. `process.kill` treats 0 as "this process group" and
      // a negative pid as "that process group"; pid 1 is init. None of those are ever a build
      // daemon, and a parse slip upstream must not turn into one of them.
      if (!Number.isInteger(pid) || pid <= 1) return "failed";
      try {
        process.kill(pid, signal);
        return "sent";
      } catch (error) {
        const code = errnoCode(error);
        if (code === "ESRCH") return "gone";
        if (code === "EPERM") return "not-permitted";
        return "failed";
      }
    },
    isRunning(pid) {
      if (!Number.isInteger(pid) || pid <= 1) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM means it exists and isn't ours to signal — still running, as far as this asks.
        return errnoCode(error) === "EPERM";
      }
    },
  };
}

const CWD_RESOLVE_TIMEOUT_MS = 5_000;

/**
 * Injectable seam for resolving a batch of pids' current working directories, mirroring
 * ProcessSignaller above: tests drive cwd-based attribution without a real lsof ever running.
 */
export interface BuildDaemonCwdResolver {
  /**
   * A pid missing from the result was not resolved — the call failed, timed out, lsof isn't
   * installed, or the pid had already exited — and must be judged on the marker and argv alone,
   * never assumed abandoned because its cwd is unknown.
   */
  resolve(pids: readonly number[]): Promise<ReadonlyMap<number, string>>;
}

/**
 * Parses `lsof -Fpn` output: one `p<pid>` line per process, followed by the `n<path>` line for
 * its matched fd (here, always `cwd`, since the caller passes `-d cwd`). An `n` line before any
 * `p` line is unpairable and dropped rather than guessed at.
 */
export function parseLsofCwdOutput(output: string): Map<number, string> {
  const result = new Map<number, string>();
  let currentPid: number | undefined;
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      const parsed = Number.parseInt(value, 10);
      currentPid = Number.isNaN(parsed) ? undefined : parsed;
    } else if (tag === "n" && currentPid !== undefined) {
      result.set(currentPid, value);
    }
  }
  return result;
}

/**
 * Injectable seam for asking which dev-server pids have an ESTABLISHED TCP connection, so tests
 * drive the Metro rule without a real lsof.
 */
export interface BuildDaemonConnectionChecker {
  /**
   * `true` or `false` for every asked pid when the check ran; an empty map when it failed, timed
   * out, or lsof isn't installed. A pid missing from the result is spared.
   */
  check(pids: readonly number[]): Promise<ReadonlyMap<number, boolean>>;
}

/** The pids in `lsof -Fp` output: one `p<pid>` line per process, then its `f`/`n` lines. */
export function parseLsofPidOutput(output: string): Set<number> {
  const pids = new Set<number>();
  for (const line of output.split("\n")) {
    if (line[0] !== "p") continue;
    const pid = Number.parseInt(line.slice(1), 10);
    if (!Number.isNaN(pid)) pids.add(pid);
  }
  return pids;
}

/**
 * One batched, bounded `lsof -a -p <pids> -iTCP -sTCP:ESTABLISHED` call. lsof exits 1 with
 * nothing on stderr when a listed pid has no such connection or has exited, so that counts as an
 * answer; a timeout, a missing lsof, or anything on stderr (`-w` silences warnings) is a failure,
 * and a failure answers nothing.
 */
export function createSystemBuildDaemonConnectionChecker(
  options: { lsofPath?: string } = {},
): BuildDaemonConnectionChecker {
  const lsof = options.lsofPath ?? "lsof";
  return {
    async check(pids) {
      if (pids.length === 0) return new Map();
      const args = ["-w", "-a", "-p", pids.join(","), "-iTCP", "-sTCP:ESTABLISHED", "-Fp"];
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(lsof, args, { timeout: CWD_RESOLVE_TIMEOUT_MS }));
      } catch (error) {
        // `code` is the exit status for a process that ran, and an errno string (ENOENT) for one
        // that never started.
        const failure = error as {
          code?: unknown;
          killed?: boolean;
          stdout?: unknown;
          stderr?: unknown;
        };
        const noMatches =
          failure.code === 1 &&
          !failure.killed &&
          typeof failure.stdout === "string" &&
          failure.stderr === "";
        if (!noMatches) return new Map();
        stdout = failure.stdout as string;
      }
      const connected = parseLsofPidOutput(stdout);
      return new Map(pids.map((pid) => [pid, connected.has(pid)] as const));
    },
  };
}

/**
 * One batched `lsof` call for every candidate pid, bounded by a timeout so a wedged lsof (or a
 * huge pid list) can never hold up a sweep. macOS/POSIX only, matching build-daemon-signatures.ts
 * — Windows daemons have no `ownerUid` (`process.getuid` is undefined there), so `isAbandoned`
 * already refuses every row before a resolver would ever be asked to run.
 */
export function createSystemBuildDaemonCwdResolver(): BuildDaemonCwdResolver {
  return {
    async resolve(pids) {
      if (pids.length === 0) return new Map();
      try {
        const args = ["-a", ...pids.flatMap((pid) => ["-p", String(pid)]), "-d", "cwd", "-Fpn"];
        const { stdout } = await execFileAsync("lsof", args, { timeout: CWD_RESOLVE_TIMEOUT_MS });
        return parseLsofCwdOutput(stdout);
      } catch (error) {
        // lsof exits non-zero when any listed pid has already exited, even if it resolved the
        // rest — Node still attaches the partial stdout to the rejection, so recover what's
        // there instead of throwing every pid in the batch away over one that raced us.
        const partialStdout = (error as NodeJS.ErrnoException & { stdout?: unknown })?.stdout;
        return typeof partialStdout === "string" ? parseLsofCwdOutput(partialStdout) : new Map();
      }
    },
  };
}
