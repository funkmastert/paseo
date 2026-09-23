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

import { ORPHAN_BUILD_DAEMON_MARKERS } from "./process-attribution.js";
import type { ProcessSampleRow } from "./process-sampler.js";

export type ReapableBuildDaemonKind = "gradle" | "kotlin";

interface ReapableBuildDaemonSignature {
  kind: ReapableBuildDaemonKind;
  label: string;
  /**
   * The daemon's JVM main class, matched as a whole argv token. Verified against a live Gradle
   * 9.7.1 daemon (`org.gradle.launcher.daemon.bootstrap.GradleDaemon` is the last token of its
   * command line) and against `kotlin-daemon-embeddable`'s jar contents, which is where the
   * Kotlin Gradle plugin's `COMPILER_DAEMON_CLASS_FQN` points. A substring match would be a
   * generic process killer wearing an allowlist: `grep GradleDaemon`, an editor with the string
   * in a file path, and this very source file all contain it.
   */
  mainClass: string;
}

/**
 * Both daemons are JVMs launched as `.../bin/java <opts> <mainClass>`, so a `java` token has to
 * precede the main class. Without it, `grep -r org.gradle...GradleDaemon .` passes the
 * whole-token test — that rule alone can't tell a daemon from something looking for one. This
 * scans for the token rather than reading argv[0], because `ps` gives one space-joined string
 * and the JVM Tyler's daemons launch from lives at
 * `/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java` — argv[0] doesn't
 * survive a whitespace split.
 */
const JVM_EXECUTABLE = "java";

/**
 * The allowlist. Nothing outside it is ever signalled — everything else the monitor finds is
 * reported exactly as before. Adding an entry means verifying the process's real command line
 * first, not guessing at a plausible marker.
 */
const REAPABLE_BUILD_DAEMONS: readonly ReapableBuildDaemonSignature[] = [
  {
    kind: "gradle",
    label: "Gradle daemon",
    mainClass: "org.gradle.launcher.daemon.bootstrap.GradleDaemon",
  },
  {
    kind: "kotlin",
    label: "Kotlin compile daemon",
    mainClass: "org.jetbrains.kotlin.daemon.KotlinCompileDaemon",
  },
];

/** The marker process-attribution.ts attributes trees by; here it's purely a veto. */
const AGENT_MARKER = "callerAgentId=";

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

function matchSignature(command: string): ReapableBuildDaemonSignature | undefined {
  const tokens = command.split(/\s+/);
  return REAPABLE_BUILD_DAEMONS.find((signature) => {
    const mainClassIndex = tokens.indexOf(signature.mainClass);
    return (
      mainClassIndex > 0 &&
      tokens.slice(0, mainClassIndex).some((token) => token.split("/").pop() === JVM_EXECUTABLE)
    );
  });
}

/**
 * The four facts that together mean "nobody is using this". Not idleness — that's measured over
 * time below; this is the structural half, re-checked on every sweep.
 */
function isAbandoned(
  row: ProcessSampleRow,
  attributedPids: ReadonlySet<number>,
  ownerUid: number | undefined,
): boolean {
  // Reparented to init: the shell, Gradle client, or agent that launched it is gone. A daemon
  // serving a build in progress still has its launcher as a parent.
  if (row.ppid !== 1) return false;
  // A live agent's tree owns it. Can't happen while ppid is 1, and cheap insurance if the
  // attribution walk ever learns to reach further.
  if (attributedPids.has(row.pid)) return false;
  // An agent launch whose agent this daemon no longer lists — archived, or started before this
  // daemon did. Attribution can't see it, so nothing here may claim it's unowned.
  if (row.command.includes(AGENT_MARKER)) return false;
  // Another user's process, or a platform where we can't tell whose it is. Both refuse.
  if (ownerUid === undefined || row.uid !== ownerUid) return false;
  return true;
}

export function evaluateBuildDaemonReapCandidates(
  input: EvaluateBuildDaemonReapCandidatesInput,
): EvaluateBuildDaemonReapCandidatesResult {
  const memory: BuildDaemonReaperMemory = new Map();
  const candidates: BuildDaemonReapCandidate[] = [];
  const sightings: BuildDaemonSighting[] = [];
  const idleThresholdMs = input.config.idleMinutes * 60_000;

  for (const row of input.rows) {
    const signature = matchSignature(row.command);
    const sight = (verdict: BuildDaemonVerdict, idleSweeps = 0): void => {
      sightings.push({
        pid: row.pid,
        verdict,
        kind: signature?.kind,
        rssBytes: row.rssKb * 1024,
        cpuPercent: row.cpuPercent,
        idleSweeps,
      });
    };
    if (!signature) {
      if (
        row.ppid === 1 &&
        ORPHAN_BUILD_DAEMON_MARKERS.some((marker) => row.command.includes(marker))
      ) {
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
    if (!isAbandoned(row, input.attributedPids, input.ownerUid)) {
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

    if (row.cpuPercent > input.config.idleCpuPercent) {
      // Busy: somebody is building. The idle clock restarts from zero, not from where it was.
      memory.set(row.pid, {
        kind: signature.kind,
        firstSeenAtMs: previous.firstSeenAtMs,
        idleSinceMs: undefined,
        idleSweeps: 0,
      });
      sight("busy");
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
