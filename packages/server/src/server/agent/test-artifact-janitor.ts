/**
 * The artifact janitor. Stops killed test runs from leaving simulator clones on disk forever,
 * in the three places that actually prevent it (docs/artifact-janitor.md):
 *
 *   1. a cleanup obligation, registered when the launch gate sees a test run start and claimed
 *      when the agent that took it on is gone;
 *   2. a periodic sweep for residue nobody has an obligation over — the 591 GB case, where the
 *      process that made it died weeks ago;
 *   3. a disk guard, which refuses a test launch on a volume with no room left.
 *
 * Off by default, with a dry run that does the entire selection and reports every path, size and
 * reason without deleting anything — the discipline build-daemon-reaper.ts set, held higher here
 * because that one only ever sent a signal.
 *
 * It rides AgentResourceMonitor's sweep rather than running a timer of its own, the same way the
 * device cap does: one `ps` a minute on a machine that is already struggling.
 */

import { randomUUID } from "node:crypto";
import { collectDeviceIdReferences } from "./device-detection.js";
import type { ProcessSampleRow } from "./process-sampler.js";
import {
  createSystemTestArtifactFileSystem,
  type TestArtifactFileSystem,
} from "./test-artifact-fs.js";
import {
  evaluateTestArtifactCandidates,
  markTestArtifactHandled,
  type TestArtifactCandidate,
  type TestArtifactJanitorConfig as SelectionConfig,
  type TestArtifactMemory,
  type TestRunObligation,
} from "./test-artifact-selection.js";
import {
  resolveTestArtifactSetRoot,
  TEST_ARTIFACT_SETS,
  type TestArtifactSet,
  type TestArtifactSetId,
} from "./test-artifact-sets.js";

const GIBIBYTE = 1024 ** 3;

/**
 * Twelve hours of being untouched before a directory nobody claims is taken. Long enough that a
 * test run somebody started before lunch is never in scope, and short enough that a night of
 * killed runs is cleaned up by morning. The residue this was written for was weeks old.
 */
const DEFAULT_MIN_AGE_HOURS = 12;
const DEFAULT_MIN_SWEEPS = 3;
/** xcodebuild's own cleanup runs as the process winds down; do not race it. */
const DEFAULT_OBLIGATION_GRACE_MINUTES = 10;
const DEFAULT_OBLIGATION_TTL_HOURS = 24;
const DEFAULT_MAX_PER_SWEEP = 8;
/**
 * A sweep may reclaim a lot, but not everything at once: an unbounded first sweep on a machine
 * with 591 GB of residue would spend minutes inside `rm` and give nobody a chance to look at the
 * dry run first. Eight directories a minute clears that backlog in under half an hour anyway.
 */
const DEFAULT_MAX_BYTES_PER_SWEEP = 100 * GIBIBYTE;
/**
 * The disk floor for a test launch. One parallel `xcodebuild test` run clones one simulator per
 * worker, and the clones measured here ran about 4 GB each, so a four-way run can put ~16 GB on
 * disk before a single test has finished — plus whatever DerivedData grows by. 20 GiB is one
 * run's worth of room. Below it, macOS is already evicting purgeable space to keep going, and
 * the failure mode of carrying on is a full volume, which takes down every agent on the machine
 * rather than the one that asked. This machine sat at 30.7 GiB free of 926 GiB while this was
 * written, so the guard is not theoretical.
 */
const DEFAULT_MIN_FREE_DISK_BYTES = 20 * GIBIBYTE;

export interface TestArtifactDiskGuardConfig {
  enabled?: boolean;
  dryRun?: boolean;
  minFreeBytes?: number;
}

export interface TestArtifactJanitorConfigInput {
  enabled?: boolean;
  dryRun?: boolean;
  minAgeHours?: number;
  minSweeps?: number;
  obligationGraceMinutes?: number;
  obligationTtlHours?: number;
  maxPerSweep?: number;
  maxBytesPerSweep?: number;
  /** Independent of `enabled`: refusing a launch deletes nothing, so it is its own opt-in. */
  diskGuard?: TestArtifactDiskGuardConfig;
}

interface ResolvedConfig extends SelectionConfig {
  enabled: boolean;
  dryRun: boolean;
  diskGuard: { enabled: boolean; dryRun: boolean; minFreeBytes: number };
}

function resolveDiskGuardConfig(
  config: TestArtifactDiskGuardConfig | undefined,
): ResolvedConfig["diskGuard"] {
  return {
    enabled: config?.enabled ?? false,
    dryRun: config?.dryRun ?? false,
    minFreeBytes: config?.minFreeBytes ?? DEFAULT_MIN_FREE_DISK_BYTES,
  };
}

function resolveConfig(config: TestArtifactJanitorConfigInput | undefined): ResolvedConfig {
  return {
    enabled: config?.enabled ?? false,
    dryRun: config?.dryRun ?? false,
    minAgeHours: config?.minAgeHours ?? DEFAULT_MIN_AGE_HOURS,
    minSweeps: config?.minSweeps ?? DEFAULT_MIN_SWEEPS,
    obligationGraceMinutes: config?.obligationGraceMinutes ?? DEFAULT_OBLIGATION_GRACE_MINUTES,
    obligationTtlHours: config?.obligationTtlHours ?? DEFAULT_OBLIGATION_TTL_HOURS,
    maxPerSweep: config?.maxPerSweep ?? DEFAULT_MAX_PER_SWEEP,
    maxBytesPerSweep: config?.maxBytesPerSweep ?? DEFAULT_MAX_BYTES_PER_SWEEP,
    diskGuard: resolveDiskGuardConfig(config?.diskGuard),
  };
}

interface TestArtifactJanitorLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

/** One directory the sweep reclaimed, or would have. */
export interface ReclaimedTestArtifact {
  setId: TestArtifactSetId;
  label: string;
  name: string;
  path: string;
  sizeBytes: number;
  ageMs: number;
  claim: TestArtifactCandidate["claim"];
  agentId?: string;
}

export interface TestArtifactSweepResult {
  dryRun: boolean;
  reclaimed: ReclaimedTestArtifact[];
}

export type DiskGuardVerdict =
  | { ok: true }
  | { ok: false; freeBytes: number; minFreeBytes: number; message: string };

export interface TestArtifactJanitorOptions {
  /** The user's home directory. Every artifact set root is resolved below it and nowhere else. */
  homeDir: string;
  readDaemonConfig: () => { artifactJanitor?: TestArtifactJanitorConfigInput };
  /** Agents the daemon still knows about. An obligation held by anything else is unclaimed. */
  listAgentIds: () => string[];
  /** Device ids the device cap holds a lease on (docs/device-leases.md). */
  listLeasedDeviceIds: () => string[];
  logger: TestArtifactJanitorLogger;
  fileSystem?: TestArtifactFileSystem;
  now?: () => number;
}

function formatBytes(bytes: number): string {
  return bytes >= GIBIBYTE
    ? `${(bytes / GIBIBYTE).toFixed(1)} GB`
    : `${Math.round(bytes / 1_048_576)} MB`;
}

export class TestArtifactJanitor {
  private readonly homeDir: string;
  private readonly readDaemonConfig: TestArtifactJanitorOptions["readDaemonConfig"];
  private readonly listAgentIds: () => string[];
  private readonly listLeasedDeviceIds: () => string[];
  private readonly logger: TestArtifactJanitorLogger;
  private readonly fileSystem: TestArtifactFileSystem;
  private readonly now: () => number;

  /** Per artifact set, what the previous sweep saw. Never persisted: evidence has to be fresh. */
  private memory = new Map<TestArtifactSetId, TestArtifactMemory>();
  private obligations: TestRunObligation[] = [];

  constructor(options: TestArtifactJanitorOptions) {
    this.homeDir = options.homeDir;
    this.readDaemonConfig = options.readDaemonConfig;
    this.listAgentIds = options.listAgentIds;
    this.listLeasedDeviceIds = options.listLeasedDeviceIds;
    this.logger = options.logger;
    this.fileSystem = options.fileSystem ?? createSystemTestArtifactFileSystem();
    this.now = options.now ?? Date.now;
  }

  /**
   * Layer 1. The launch gate calls this when it sees a command that clones simulators, before
   * the command runs. One obligation per agent and set, keeping the earliest start: an agent
   * that runs tests three times has one claim covering everything it made.
   *
   * This is not a lease. A lease is per device and is released the moment the device stops,
   * which is exactly the event that is *supposed* to take the clone with it — so by the time a
   * lease ends there is nothing left for it to own. An obligation outlives the device on purpose.
   */
  noteTestRunLaunch(input: { agentId: string; setId: TestArtifactSetId; command: string }): void {
    if (!resolveConfig(this.readDaemonConfig().artifactJanitor).enabled) return;
    const existing = this.obligations.find(
      (obligation) => obligation.agentId === input.agentId && obligation.setId === input.setId,
    );
    if (existing) return;
    const obligation: TestRunObligation = {
      id: randomUUID(),
      agentId: input.agentId,
      setId: input.setId,
      command: input.command,
      startedAtMs: this.now(),
    };
    this.obligations.push(obligation);
    this.logger.info(
      { agentId: input.agentId, setId: input.setId, command: input.command },
      "Artifact janitor took on a test-run cleanup obligation",
    );
  }

  /**
   * Layer 3. Free space on the volume the artifact sets live on, against the floor. Reads the
   * volume rather than any configured path, because a full volume is what breaks, not a full
   * directory. An unreadable volume is never a refusal — same rule as the device cap's memory
   * headroom, for the same reason.
   */
  async evaluateDiskGuard(): Promise<DiskGuardVerdict> {
    const config = resolveConfig(this.readDaemonConfig().artifactJanitor);
    if (!config.diskGuard.enabled) return { ok: true };
    const freeBytes = await this.fileSystem.readFreeBytes(this.homeDir);
    if (freeBytes === undefined || freeBytes >= config.diskGuard.minFreeBytes) return { ok: true };
    return {
      ok: false,
      freeBytes,
      minFreeBytes: config.diskGuard.minFreeBytes,
      message:
        `the volume has ${formatBytes(freeBytes)} free and the floor is ` +
        `${formatBytes(config.diskGuard.minFreeBytes)}`,
    };
  }

  isDiskGuardDryRun(): boolean {
    return resolveConfig(this.readDaemonConfig().artifactJanitor).diskGuard.dryRun;
  }

  /**
   * Layer 2, and where a layer-1 claim is actually discharged. Called once per resource-monitor
   * sweep with that sweep's `ps` rows, which is where every "somebody still cares about this"
   * veto comes from.
   */
  async sweep(input: { rows: readonly ProcessSampleRow[] }): Promise<TestArtifactSweepResult> {
    const config = resolveConfig(this.readDaemonConfig().artifactJanitor);
    if (!config.enabled) {
      // Turning the janitor on starts the evidence over. Sweeps observed while it was off were
      // never checked against the abandonment rules, and acting on them would skip the wait.
      this.memory.clear();
      this.obligations = [];
      return { dryRun: config.dryRun, reclaimed: [] };
    }

    const nowMs = this.now();
    const liveAgentIds = new Set(this.listAgentIds());
    const references = collectDeviceIdReferences(input.rows);
    const referencedDeviceIds = new Set(references.keys());
    const leasedDeviceIds = new Set(this.listLeasedDeviceIds().map((id) => id.toUpperCase()));

    const reclaimed: ReclaimedTestArtifact[] = [];
    let budgetBytes = config.maxBytesPerSweep;

    for (const set of TEST_ARTIFACT_SETS) {
      const taken = await this.sweepSet({
        set,
        config,
        nowMs,
        liveAgentIds,
        referencedDeviceIds,
        leasedDeviceIds,
        budgetBytes,
      });
      for (const entry of taken) budgetBytes -= entry.sizeBytes;
      reclaimed.push(...taken);
    }

    // Obligations whose agent is gone and whose residue has been dealt with are still on the
    // books; the TTL in the selection rules is what retires them, so nothing accumulates here
    // beyond a day of history.
    this.obligations = this.obligations.filter(
      (obligation) =>
        nowMs - obligation.startedAtMs < config.obligationTtlHours * 3_600_000 ||
        liveAgentIds.has(obligation.agentId),
    );

    return { dryRun: config.dryRun, reclaimed };
  }

  private async sweepSet(input: {
    set: TestArtifactSet;
    config: ResolvedConfig;
    nowMs: number;
    liveAgentIds: ReadonlySet<string>;
    referencedDeviceIds: ReadonlySet<string>;
    leasedDeviceIds: ReadonlySet<string>;
    budgetBytes: number;
  }): Promise<ReclaimedTestArtifact[]> {
    const rootPath = resolveTestArtifactSetRoot(this.homeDir, input.set);
    let scan: Awaited<ReturnType<TestArtifactFileSystem["scan"]>>;
    try {
      scan = await this.fileSystem.scan(rootPath);
    } catch (error) {
      this.logger.warn({ err: error, rootPath }, "Artifact janitor could not scan an artifact set");
      return [];
    }
    if (scan.resolvedRootPath === undefined) return [];

    const evaluation = evaluateTestArtifactCandidates({
      setId: input.set.id,
      entries: scan.entries,
      obligations: this.obligations,
      liveAgentIds: input.liveAgentIds,
      referencedDeviceIds: input.referencedDeviceIds,
      leasedDeviceIds: input.leasedDeviceIds,
      config: input.config,
      previous: this.memory.get(input.set.id),
      nowMs: input.nowMs,
    });
    const memory = evaluation.memory;
    this.memory.set(input.set.id, memory);
    if (evaluation.candidates.length === 0) return [];

    const reclaimed: ReclaimedTestArtifact[] = [];
    let budgetBytes = input.budgetBytes;
    for (const candidate of evaluation.candidates) {
      const sizeBytes = await this.fileSystem.measureSizeBytes(candidate.path);
      if (sizeBytes === undefined) {
        // A directory whose size cannot be read is a directory this sweep does not understand.
        // Leaving it costs disk; taking it would spend an unknown amount of the budget.
        this.logger.warn(
          { path: candidate.path, setId: input.set.id },
          "Artifact janitor could not measure a candidate; leaving it",
        );
        continue;
      }
      if (sizeBytes > budgetBytes) {
        // Not marked handled: the next sweep reconsiders it with a full budget.
        this.logger.info(
          { path: candidate.path, sizeBytes, budgetBytes },
          "Artifact janitor stopped at its per-sweep byte budget",
        );
        break;
      }

      const entry: ReclaimedTestArtifact = {
        setId: input.set.id,
        label: input.set.label,
        name: candidate.name,
        path: candidate.path,
        sizeBytes,
        ageMs: candidate.ageMs,
        claim: candidate.claim,
        ...(candidate.obligation ? { agentId: candidate.obligation.agentId } : {}),
      };
      const detail = {
        path: candidate.path,
        setId: input.set.id,
        sizeBytes,
        ageMs: candidate.ageMs,
        stableSweeps: candidate.stableSweeps,
        claim: candidate.claim,
        ...(candidate.obligation ? { obligation: candidate.obligation } : {}),
      };

      if (input.config.dryRun) {
        this.logger.info({ ...detail, dryRun: true }, "Artifact janitor would reclaim");
        markTestArtifactHandled(memory, candidate.name, "reported");
        budgetBytes -= sizeBytes;
        reclaimed.push(entry);
        continue;
      }

      try {
        await this.fileSystem.remove({
          resolvedRootPath: scan.resolvedRootPath,
          entryName: candidate.name,
        });
      } catch (error) {
        // Refused by the path guard, or the removal failed. Either way it is not asked again.
        markTestArtifactHandled(memory, candidate.name, "failed");
        this.logger.warn({ ...detail, err: error }, "Artifact janitor failed to reclaim");
        continue;
      }
      markTestArtifactHandled(memory, candidate.name, "removed");
      this.logger.info(detail, "Artifact janitor reclaimed");
      budgetBytes -= sizeBytes;
      reclaimed.push(entry);
    }
    return reclaimed;
  }
}
