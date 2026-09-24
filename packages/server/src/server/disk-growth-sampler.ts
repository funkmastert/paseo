import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { execCommand } from "../utils/spawn.js";
import { writeJsonFileAtomic } from "./atomic-file.js";
import { formatBytes } from "./session/doctor/helpers.js";

const MIB = 1024 * 1024;
const MINUTE_MS = 60_000;
// The periodic baseline. Without one, the first sample of an incident would have nothing to be
// compared against, and "what grew" would be a list of sizes.
const BASELINE_INTERVAL_MS = 60 * MINUTE_MS;
const DEFAULT_MIN_CHILD_BYTES = 16 * MIB;
const DEFAULT_MIN_GROWTH_BYTES = 64 * MIB;
const MAX_CHILDREN_PER_ROOT = 50;
const MAX_STORED_SAMPLES = 6;
const MAX_GROWERS = 10;
const DU_MAX_BUFFER_BYTES = 32 * MIB;
const FILE_NAME = "disk-growth.json";

/**
 * Where the disk went on the machine this fork runs on (docs/disk-pressure.md). Roots that do not
 * exist are skipped, so the macOS entries cost nothing elsewhere.
 */
export function defaultGrowthRoots(homeDir: string): string[] {
  return [
    join(homeDir, ".paseo", "worktrees"),
    join(homeDir, "mobile-worktrees"),
    join(homeDir, "paseo-worktrees"),
    join(homeDir, "Library", "Developer", "Xcode", "DerivedData"),
    join(homeDir, "Library", "Developer", "CoreSimulator"),
    join(homeDir, "Library", "Developer", "XCTestDevices"),
    join(homeDir, ".gradle"),
    "/private/tmp",
    join(homeDir, "Library", "Caches"),
    join(homeDir, ".npm"),
  ];
}

const ChildSampleSchema = z.object({ name: z.string(), bytes: z.number() });
const RootSampleSchema = z.object({
  path: z.string(),
  bytes: z.number(),
  /** The largest children, biggest first. */
  children: z.array(ChildSampleSchema),
  /** A child not listed was no larger than this. */
  childFloorBytes: z.number(),
});
const DiskGrowthSampleSchema = z.object({
  at: z.string(),
  roots: z.array(RootSampleSchema),
  unmeasured: z.array(z.object({ path: z.string(), reason: z.enum(["timeout", "failed"]) })),
});
const PersistedGrowthSchema = z.object({
  version: z.literal(1),
  samples: z.array(DiskGrowthSampleSchema),
});

export type DiskGrowthSample = z.infer<typeof DiskGrowthSampleSchema>;
type RootSample = z.infer<typeof RootSampleSchema>;

export type DuOutcome =
  | { kind: "ok"; stdout: string }
  | { kind: "timeout" }
  | { kind: "failed"; error: string };

/** Runs `du` over one root. A seam for tests; production execs the real command. */
export type DuRunner = (root: string, timeoutMs: number) => Promise<DuOutcome>;

/**
 * `du -k -d 1`: the root's total and each immediate child directory in one walk. `-d` is the
 * spelling both BSD and GNU `du` accept, and BSD refuses it together with `-a`, so files loose in
 * the root are sized separately (`sizeLooseFiles`). `du` exits nonzero on any unreadable directory
 * (`~/Library/Caches` always has some) yet still prints every size it got, so a nonzero exit with
 * output is a measurement. Only a timeout or no output at all is not.
 */
async function runDu(root: string, timeoutMs: number): Promise<DuOutcome> {
  try {
    const { stdout } = await execCommand("du", ["-k", "-d", "1", root], {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: DU_MAX_BUFFER_BYTES,
    });
    return { kind: "ok", stdout };
  } catch (error) {
    const failure = error as { killed?: boolean; signal?: string; code?: unknown; stdout?: string };
    if (failure.killed || failure.signal) return { kind: "timeout" };
    if (typeof failure.code === "number" && failure.stdout) {
      return { kind: "ok", stdout: failure.stdout };
    }
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

interface DiskGrowthLogger {
  warn: (obj: object, msg?: string) => void;
}

export interface DiskGrowthSamplerOptions {
  paseoHome: string;
  homeDir: string;
  logger: DiskGrowthLogger;
  now?: () => number;
  runDu?: DuRunner;
  /** Children smaller than this are not recorded. Tests lower it. */
  minChildBytes?: number;
  /** A child or root must have grown by this much to be named. Tests lower it. */
  minGrowthBytes?: number;
}

export interface DiskGrowthSampleRequest {
  /** Undefined: the built-in list. `~` expands to the home directory. */
  roots: readonly string[] | undefined;
  timeoutMs: number;
}

export interface DiskGrowthEntry {
  path: string;
  bytes: number;
  deltaBytes: number;
}

export interface DiskGrowthReport {
  sample: DiskGrowthSample;
  /** The sample the deltas are measured from. Null on the first sample. */
  previousAt: string | null;
  /** Every measured root, biggest first. `deltaBytes` is null with no earlier measurement. */
  roots: Array<{ path: string; bytes: number; deltaBytes: number | null }>;
  /** Children that grew, biggest growth first. */
  growers: DiskGrowthEntry[];
}

/**
 * The newest sample at least `windowMs` old, so the deltas cover a whole fall window rather than
 * the gap since the last time this ran; the oldest sample when none is that old. Null: no history.
 */
export function pickReferenceSample(
  samples: readonly DiskGrowthSample[],
  nowMs: number,
  windowMs: number,
): DiskGrowthSample | null {
  if (samples.length === 0) return null;
  let oldest = samples[0];
  let reference: DiskGrowthSample | null = null;
  for (const sample of samples) {
    const at = Date.parse(sample.at);
    if (at < Date.parse(oldest.at)) oldest = sample;
    if (nowMs - at >= windowMs && (!reference || at > Date.parse(reference.at))) {
      reference = sample;
    }
  }
  return reference ?? oldest;
}

/**
 * A bounded, deterministic size sample of the places disk goes: one `du` per root, one after
 * another, each with its own timeout. It reads and remembers; it deletes nothing. The last few
 * samples live in `$PASEO_HOME/disk-growth.json` so a restart keeps the baseline.
 */
export class DiskGrowthSampler {
  private readonly filePath: string;
  private readonly homeDir: string;
  private readonly logger: DiskGrowthLogger;
  private readonly now: () => number;
  private readonly runDu: DuRunner;
  private readonly minChildBytes: number;
  private readonly minGrowthBytes: number;
  private samples: DiskGrowthSample[] | null = null;
  private inFlight: Promise<DiskGrowthReport> | null = null;

  constructor(options: DiskGrowthSamplerOptions) {
    this.filePath = join(options.paseoHome, FILE_NAME);
    this.homeDir = options.homeDir;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.runDu = options.runDu ?? runDu;
    this.minChildBytes = options.minChildBytes ?? DEFAULT_MIN_CHILD_BYTES;
    this.minGrowthBytes = options.minGrowthBytes ?? DEFAULT_MIN_GROWTH_BYTES;
  }

  /**
   * Due when there is no sample yet, or the last one is older than `sampleIntervalMinutes` while
   * a disk condition is active, or older than the hourly baseline when none is.
   */
  async isSampleDue(input: {
    conditionActive: boolean;
    sampleIntervalMinutes: number;
  }): Promise<boolean> {
    const samples = await this.load();
    const last = samples.at(-1);
    if (!last) return true;
    const intervalMs = input.sampleIntervalMinutes * MINUTE_MS;
    const gapMs = input.conditionActive ? intervalMs : Math.max(BASELINE_INTERVAL_MS, intervalMs);
    return this.now() - Date.parse(last.at) >= gapMs;
  }

  /**
   * Measures every root and returns the growth since the reference sample. `referenceWindowMs`
   * picks that sample (see `pickReferenceSample`); absent, the last sample.
   */
  sample(
    request: DiskGrowthSampleRequest & { referenceWindowMs?: number },
  ): Promise<DiskGrowthReport> {
    this.inFlight ??= this.measure(request).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async measure(
    request: DiskGrowthSampleRequest & { referenceWindowMs?: number },
  ): Promise<DiskGrowthReport> {
    const history = await this.load();
    const roots: RootSample[] = [];
    const unmeasured: DiskGrowthSample["unmeasured"] = [];
    for (const configured of request.roots ?? defaultGrowthRoots(this.homeDir)) {
      const path = this.expandHome(configured);
      const resolved = await realpath(path).catch(() => null);
      if (resolved === null) continue;
      const outcome = await this.runDu(resolved, request.timeoutMs);
      if (outcome.kind === "timeout") {
        unmeasured.push({ path, reason: "timeout" });
        continue;
      }
      const loose = outcome.kind === "ok" ? await this.sizeLooseFiles(resolved) : [];
      const parsed =
        outcome.kind === "ok" ? this.parseDu(path, resolved, outcome.stdout, loose) : null;
      if (parsed === null) {
        unmeasured.push({ path, reason: "failed" });
        continue;
      }
      roots.push(parsed);
    }

    const nowMs = this.now();
    const sample: DiskGrowthSample = { at: new Date(nowMs).toISOString(), roots, unmeasured };
    const reference = pickReferenceSample(history, nowMs, request.referenceWindowMs ?? 0);
    const report = compareSamples(sample, reference, this.minGrowthBytes);

    this.samples = [...history, sample].slice(-MAX_STORED_SAMPLES);
    await writeJsonFileAtomic(this.filePath, { version: 1, samples: this.samples }).catch(
      (error) => {
        this.logger.warn({ err: error }, "Disk growth sampler: failed to persist the sample");
      },
    );
    return report;
  }

  private expandHome(path: string): string {
    if (path === "~") return this.homeDir;
    return path.startsWith("~/") ? join(this.homeDir, path.slice(2)) : path;
  }

  /** Files directly in the root: `du -d 1` prints directories only. */
  private async sizeLooseFiles(root: string): Promise<Array<{ name: string; bytes: number }>> {
    const files: Array<{ name: string; bytes: number }> = [];
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const stats = await lstat(join(root, entry.name)).catch(() => null);
      if (stats) files.push({ name: entry.name, bytes: stats.blocks * 512 });
    }
    return files;
  }

  private parseDu(
    displayPath: string,
    resolved: string,
    stdout: string,
    looseFiles: ReadonlyArray<{ name: string; bytes: number }>,
  ): RootSample | null {
    let rootBytes: number | null = null;
    const children = looseFiles.filter((file) => file.bytes >= this.minChildBytes);
    for (const line of stdout.split("\n")) {
      const match = /^(\d+)\s+(.+)$/.exec(line);
      if (!match) continue;
      const bytes = Number.parseInt(match[1], 10) * 1024;
      const path = match[2];
      if (path === resolved) {
        rootBytes = bytes;
      } else if (dirname(path) === resolved && bytes >= this.minChildBytes) {
        children.push({ name: basename(path), bytes });
      }
    }
    if (rootBytes === null) return null;
    children.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
    const truncated = children.length > MAX_CHILDREN_PER_ROOT;
    const kept = children.slice(0, MAX_CHILDREN_PER_ROOT);
    return {
      path: displayPath,
      bytes: rootBytes,
      children: kept,
      childFloorBytes: truncated ? kept[kept.length - 1].bytes : this.minChildBytes,
    };
  }

  private async load(): Promise<DiskGrowthSample[]> {
    if (this.samples) return this.samples;
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8"));
      const parsed = PersistedGrowthSchema.safeParse(raw);
      this.samples = parsed.success ? parsed.data.samples : [];
    } catch {
      // No file, or one we cannot read: a missing baseline, not a failure.
      this.samples = [];
    }
    return this.samples;
  }
}

function compareSamples(
  sample: DiskGrowthSample,
  reference: DiskGrowthSample | null,
  minGrowthBytes: number,
): DiskGrowthReport {
  const roots: DiskGrowthReport["roots"] = [];
  const growers: DiskGrowthEntry[] = [];
  for (const root of sample.roots) {
    const before = reference?.roots.find((candidate) => candidate.path === root.path);
    roots.push({
      path: root.path,
      bytes: root.bytes,
      deltaBytes: before ? root.bytes - before.bytes : null,
    });
    if (!before) continue;
    for (const child of root.children) {
      const previousBytes =
        before.children.find((candidate) => candidate.name === child.name)?.bytes ??
        before.childFloorBytes;
      const deltaBytes = child.bytes - previousBytes;
      if (deltaBytes >= minGrowthBytes) {
        growers.push({ path: join(root.path, child.name), bytes: child.bytes, deltaBytes });
      }
    }
  }
  roots.sort((a, b) => b.bytes - a.bytes);
  growers.sort((a, b) => b.deltaBytes - a.deltaBytes || a.path.localeCompare(b.path));
  return {
    sample,
    previousAt: reference?.at ?? null,
    roots,
    growers: growers.slice(0, MAX_GROWERS),
  };
}

function abbreviateHome(path: string, homeDir: string): string {
  return path === homeDir || path.startsWith(`${homeDir}/`)
    ? `~${path.slice(homeDir.length)}`
    : path;
}

function formatDelta(deltaBytes: number): string {
  return `${deltaBytes < 0 ? "-" : "+"}${formatBytes(Math.abs(deltaBytes))}`;
}

/** The growth evidence handed to the escalation agent and shown in the push. Plain text. */
export function formatGrowthEvidence(report: DiskGrowthReport, homeDir: string): string {
  const lines: string[] = [];
  if (report.previousAt === null) {
    lines.push("Growth: no earlier sample to compare against, so these are current sizes only.");
  } else {
    lines.push(`Growth since the sample at ${report.previousAt}:`);
  }
  if (report.growers.length > 0) {
    lines.push("Top growers:");
    for (const grower of report.growers) {
      lines.push(
        `- ${abbreviateHome(grower.path, homeDir)}: ${formatDelta(grower.deltaBytes)} (now ${formatBytes(grower.bytes)})`,
      );
    }
  } else if (report.previousAt !== null) {
    lines.push("No directory grew enough to name.");
  }
  lines.push("Roots:");
  for (const root of report.roots) {
    const delta = root.deltaBytes === null ? "" : ` (${formatDelta(root.deltaBytes)})`;
    lines.push(`- ${abbreviateHome(root.path, homeDir)}: ${formatBytes(root.bytes)}${delta}`);
  }
  for (const missed of report.sample.unmeasured) {
    lines.push(
      `- ${abbreviateHome(missed.path, homeDir)}: not measured (${missed.reason === "timeout" ? "timed out" : "du failed"})`,
    );
  }
  return lines.join("\n");
}
