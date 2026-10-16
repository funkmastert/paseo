/**
 * Selection logic for the artifact janitor: which simulator-clone directories in an artifact
 * set are provably abandoned, and therefore safe to delete. Pure — no filesystem, no clock, no
 * deletion. test-artifact-janitor.ts calls this once per sweep and carries the returned memory
 * into the next one, the same shape build-daemon-reaper.ts uses.
 *
 * The reaper only ever signalled a process, and it still ANDed six conditions before it acted.
 * This deletes files, so every rule below is a separate way for a directory to prove somebody
 * still wants it, and any one of them holding spares it for at least another sweep. When a rule
 * cannot be evaluated — no birth time, no size, no evidence yet — the answer is always "leave
 * it and report it", never "probably fine". See docs/artifact-janitor.md.
 */

import type { TestArtifactSetId } from "./test-artifact-sets.js";

/** One directory found directly inside an artifact set root. */
export interface TestArtifactEntry {
  /** Directory name. The janitor only ever scans one level, so this is also the device UDID. */
  name: string;
  /** Already resolved and proven to live inside the set root (test-artifact-sets.ts). */
  path: string;
  /**
   * Creation time, when the platform reports one. APFS does; a filesystem that does not leaves
   * this undefined, which costs the directory its claim by obligation — a claim is only as good
   * as the proof that the run in question created it.
   */
  birthtimeMs?: number;
  /** Last modification of the directory itself. The clock every age and stability rule uses. */
  mtimeMs: number;
}

/**
 * A run that may have left residue, recorded when the launch gate saw it start. Discharged by
 * the agent finishing; what makes it interesting is the agent that never does.
 */
export interface TestRunObligation {
  id: string;
  agentId: string;
  setId: TestArtifactSetId;
  /** The command that took it on, for the log and the notification. Never used for matching. */
  command: string;
  startedAtMs: number;
}

export interface TestArtifactJanitorConfig {
  /** How long a directory nobody claims must sit untouched before the unowned sweep takes it. */
  minAgeHours: number;
  /** How many sweeps must have seen it unchanged. One sighting is not evidence. */
  minSweeps: number;
  /** How long after its agent is gone an obligation's residue is left alone. */
  obligationGraceMinutes: number;
  /** After this, an obligation is forgotten and its residue falls to the unowned rules. */
  obligationTtlHours: number;
  /** Blast radius: the most directories one sweep may remove. */
  maxPerSweep: number;
  /** Blast radius in bytes. A sweep stops once removing the next directory would exceed it. */
  maxBytesPerSweep: number;
}

export type TestArtifactClaim = "obligation" | "unowned";

/** What one sweep remembers about a directory so the next can judge it. */
export interface TestArtifactState {
  firstSeenAtMs: number;
  /** The mtime the stable run started at; a directory that changes restarts from this sweep. */
  stableSinceMs: number;
  stableMtimeMs: number;
  stableSweeps: number;
  /**
   * Why later sweeps must leave this name alone. Set once the janitor has acted on it — a
   * directory that failed to delete, or that a dry run has already reported, is still in the
   * next scan, and without this it would be reported again every sweep forever.
   */
  handled?: TestArtifactHandledReason;
}

export type TestArtifactHandledReason = "removed" | "reported" | "failed";

/** Keyed by directory name, which is the UDID and is unique within a set. */
export type TestArtifactMemory = Map<string, TestArtifactState>;

export interface TestArtifactCandidate {
  setId: TestArtifactSetId;
  name: string;
  path: string;
  claim: TestArtifactClaim;
  /** Since the directory was last modified. */
  ageMs: number;
  stableSweeps: number;
  /** Present on an obligation claim: the agent whose run created it, and what it ran. */
  obligation?: { agentId: string; command: string };
}

/** A directory the janitor looked at and deliberately did not take. Reported, never deleted. */
export interface TestArtifactSkip {
  name: string;
  reason: string;
}

export interface EvaluateTestArtifactCandidatesInput {
  setId: TestArtifactSetId;
  entries: readonly TestArtifactEntry[];
  /** Obligations still on the books for this set, live and dead agents alike. */
  obligations: readonly TestRunObligation[];
  /** Agents the daemon still knows about. An obligation held by anything else is discharged. */
  liveAgentIds: ReadonlySet<string>;
  /**
   * Every device UDID any process in the `ps` sample mentions, booted or merely named
   * (device-detection.ts's collectDeviceIdReferences). The strongest veto there is: an
   * `xcodebuild` mid-run carries the UDIDs of the clones it made.
   */
  referencedDeviceIds: ReadonlySet<string>;
  /** Device ids the device cap currently has a lease on. A leased device is somebody's. */
  leasedDeviceIds: ReadonlySet<string>;
  config: TestArtifactJanitorConfig;
  previous: TestArtifactMemory | undefined;
  nowMs: number;
}

export interface EvaluateTestArtifactCandidatesResult {
  /** Oldest first, capped at `maxPerSweep`. The byte budget is spent during removal. */
  candidates: TestArtifactCandidate[];
  skipped: TestArtifactSkip[];
  memory: TestArtifactMemory;
  /** Obligations to keep for the next sweep. */
  obligations: TestRunObligation[];
}

/**
 * Clock skew between the filesystem's idea of when a directory appeared and the daemon's idea
 * of when the run started. One sweep's worth, the same slack the lease registry allows itself.
 */
const BIRTHTIME_SLACK_MS = 5_000;

function isLive(obligation: TestRunObligation, liveAgentIds: ReadonlySet<string>): boolean {
  return liveAgentIds.has(obligation.agentId);
}

/**
 * The structural half of "nobody is using this", re-checked every sweep. Time-based evidence is
 * accumulated separately below; these are the facts that make a directory residue at all.
 */
function findStructuralVeto(
  entry: TestArtifactEntry,
  input: EvaluateTestArtifactCandidatesInput,
): string | undefined {
  const deviceId = entry.name.toUpperCase();
  // Booted, or merely named by something still running — an xcodebuild mid-run, a simctl call,
  // the testmanagerd talking to it. Either way a process on this machine still knows about it.
  if (input.referencedDeviceIds.has(deviceId)) return "a running process references it";
  // The device cap has it on a lease, so an agent is holding it on purpose.
  if (input.leasedDeviceIds.has(deviceId)) return "the device cap holds a lease on it";
  // In the future, or with an unreadable clock. Nothing about its age can be trusted.
  if (entry.mtimeMs > input.nowMs + BIRTHTIME_SLACK_MS)
    return "its modification time is ahead of the clock";
  return undefined;
}

/**
 * The obligation whose run created this directory, if one did. Requires a birth time at or after
 * the run started: an obligation is a claim over what its own run made, and without a creation
 * time there is no way to tell its clones from the ones that were already there.
 */
function findOwningObligation(
  entry: TestArtifactEntry,
  obligations: readonly TestRunObligation[],
): TestRunObligation | undefined {
  if (entry.birthtimeMs === undefined) return undefined;
  return obligations.find(
    (obligation) => (entry.birthtimeMs as number) >= obligation.startedAtMs - BIRTHTIME_SLACK_MS,
  );
}

export function evaluateTestArtifactCandidates(
  input: EvaluateTestArtifactCandidatesInput,
): EvaluateTestArtifactCandidatesResult {
  const memory: TestArtifactMemory = new Map();
  const candidates: TestArtifactCandidate[] = [];
  const skipped: TestArtifactSkip[] = [];

  const obligationTtlMs = input.config.obligationTtlHours * 3_600_000;
  const obligations = input.obligations.filter(
    (obligation) =>
      obligation.setId === input.setId && input.nowMs - obligation.startedAtMs < obligationTtlMs,
  );
  // A dead agent's claim only runs on a quiet machine. Two agents testing at once produce two
  // interleaved sets of clones in one directory, and a birth time cannot tell them apart — so
  // while anybody is still running tests into this set, nothing is claimed by obligation and
  // everything waits for the unowned rules instead.
  const anyLiveObligation = obligations.some((obligation) =>
    isLive(obligation, input.liveAgentIds),
  );
  const deadObligations = anyLiveObligation
    ? []
    : obligations.filter((obligation) => !isLive(obligation, input.liveAgentIds));

  const minAgeMs = input.config.minAgeHours * 3_600_000;
  const graceMs = input.config.obligationGraceMinutes * 60_000;

  for (const entry of input.entries) {
    const previous = input.previous?.get(entry.name);
    if (previous?.handled !== undefined) {
      memory.set(entry.name, previous);
      continue;
    }

    const veto = findStructuralVeto(entry, input);
    if (veto) {
      // Dropped from memory rather than reset in place: a directory that stops looking abandoned
      // has to re-earn its evidence from a first sighting, exactly like a busy build daemon.
      skipped.push({ name: entry.name, reason: veto });
      continue;
    }

    // A directory still being written to is a clone being made right now. Stability is measured
    // on mtime across sweeps, and any change restarts the run from zero.
    const stable =
      previous && previous.stableMtimeMs === entry.mtimeMs
        ? {
            firstSeenAtMs: previous.firstSeenAtMs,
            stableSinceMs: previous.stableSinceMs,
            stableMtimeMs: entry.mtimeMs,
            stableSweeps: previous.stableSweeps + 1,
          }
        : {
            firstSeenAtMs: previous?.firstSeenAtMs ?? input.nowMs,
            stableSinceMs: input.nowMs,
            stableMtimeMs: entry.mtimeMs,
            stableSweeps: 1,
          };
    memory.set(entry.name, stable);

    if (stable.stableSweeps < input.config.minSweeps) {
      skipped.push({
        name: entry.name,
        reason: `seen unchanged ${stable.stableSweeps} of ${input.config.minSweeps} sweeps`,
      });
      continue;
    }

    const ageMs = input.nowMs - entry.mtimeMs;
    const owner = findOwningObligation(entry, deadObligations);
    if (owner) {
      // The run that made it is gone. Still not immediate: xcodebuild's own cleanup runs as the
      // process winds down, and deleting underneath it would race something that was going to
      // do the job itself.
      if (ageMs < graceMs) {
        skipped.push({
          name: entry.name,
          reason: `its run ended less than ${input.config.obligationGraceMinutes}m ago`,
        });
        continue;
      }
      candidates.push({
        setId: input.setId,
        name: entry.name,
        path: entry.path,
        claim: "obligation",
        ageMs,
        stableSweeps: stable.stableSweeps,
        obligation: { agentId: owner.agentId, command: owner.command },
      });
      continue;
    }

    if (ageMs < minAgeMs) {
      skipped.push({
        name: entry.name,
        reason: `untouched for ${Math.round(ageMs / 3_600_000)}h of ${input.config.minAgeHours}h`,
      });
      continue;
    }
    candidates.push({
      setId: input.setId,
      name: entry.name,
      path: entry.path,
      claim: "unowned",
      ageMs,
      stableSweeps: stable.stableSweeps,
    });
  }

  // Oldest first. Size is not known yet — measuring it means walking the tree, which only the
  // survivors of every rule above are worth paying for — so "reclaim the most" is not available
  // as an ordering here the way it is for the reaper's RSS.
  candidates.sort((a, b) => b.ageMs - a.ageMs);
  return {
    candidates: candidates.slice(0, input.config.maxPerSweep),
    skipped,
    memory,
    obligations,
  };
}

/**
 * Records that the janitor is done with `name`, so later sweeps skip it. One decision per
 * directory: a dry run reports it once, a failed removal is not retried in a loop, and a
 * directory that was removed is gone from the next scan anyway.
 */
export function markTestArtifactHandled(
  memory: TestArtifactMemory,
  name: string,
  reason: TestArtifactHandledReason,
): void {
  const state = memory.get(name);
  if (state) memory.set(name, { ...state, handled: reason });
}
