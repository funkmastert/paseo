/**
 * The filesystem seam the artifact janitor works through: scan a set root, measure a directory,
 * read free space, delete a directory. Injectable for the same reason process-sampler.ts and
 * build-daemon-reaper.ts's ProcessSignaller are — so the whole selection and removal path can be
 * driven in tests without a real path ever being deleted.
 *
 * The system implementation is where every path guard actually executes. Nothing above this file
 * builds a path to delete; it names a set root and an entry name, and this refuses anything that
 * does not resolve to a directory sitting exactly one level inside that root.
 */

import { execFile } from "node:child_process";
import { lstat, readdir, realpath, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { evaluateRemovableArtifactPath, isDeviceUdidDirectoryName } from "./test-artifact-sets.js";
import type { TestArtifactEntry, TestArtifactSkip } from "./test-artifact-selection.js";

const execFileAsync = promisify(execFile);

/** `du` over a simulator clone walks ~100k inodes; long enough to finish, short enough to bound. */
const DU_TIMEOUT_MS = 30_000;

export interface TestArtifactScan {
  /** The set root after `realpath`. Undefined when the root does not exist — the normal case. */
  resolvedRootPath: string | undefined;
  entries: TestArtifactEntry[];
  /** Everything in the root the scan would not hand on, and why. Reported, never deleted. */
  skipped: TestArtifactSkip[];
}

export interface TestArtifactFileSystem {
  scan(rootPath: string): Promise<TestArtifactScan>;
  /** Bytes on disk, or undefined when it could not be measured. Undefined is never "0". */
  measureSizeBytes(path: string): Promise<number | undefined>;
  /** Free bytes on the volume holding `path`, or undefined on a host that cannot report it. */
  readFreeBytes(path: string): Promise<number | undefined>;
  /** Removes exactly `<resolvedRootPath>/<entryName>`, or throws without touching anything. */
  remove(input: { resolvedRootPath: string; entryName: string }): Promise<void>;
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

/**
 * One level, `lstat` only, no recursion. A symlink is never followed and never becomes an entry:
 * `lstat().isDirectory()` is false for one, so a symlink pointing at the home directory is
 * reported as "not a directory" rather than scanned or deleted.
 */
async function scanArtifactRoot(rootPath: string): Promise<TestArtifactScan> {
  let resolvedRootPath: string;
  try {
    resolvedRootPath = await realpath(rootPath);
  } catch (error) {
    // ENOENT is the ordinary answer on a machine with no Xcode, or none that ever ran tests.
    if (errnoCode(error) === "ENOENT")
      return { resolvedRootPath: undefined, entries: [], skipped: [] };
    throw error;
  }

  const names = await readdir(resolvedRootPath);
  const entries: TestArtifactEntry[] = [];
  const skipped: TestArtifactSkip[] = [];
  for (const name of names) {
    if (!isDeviceUdidDirectoryName(name)) {
      // `device_set.plist`, `.DS_Store`, and anything a person put here by hand.
      skipped.push({ name, reason: "not named by a device UDID" });
      continue;
    }
    const path = join(resolvedRootPath, name);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(path);
    } catch {
      // Vanished between readdir and lstat: a clone Xcode is cleaning up as we look at it.
      continue;
    }
    if (!stats.isDirectory()) {
      skipped.push({ name, reason: "not a directory" });
      continue;
    }
    entries.push({
      name,
      path,
      mtimeMs: stats.mtimeMs,
      ...(stats.birthtimeMs > 0 ? { birthtimeMs: stats.birthtimeMs } : {}),
    });
  }
  return { resolvedRootPath, entries, skipped };
}

/**
 * `du -sk`, not a JS tree walk: a simulator clone is around 100k files and the janitor only ever
 * measures directories that already passed every abandonment rule.
 *
 * The number is an upper bound on what deleting will actually free. These clones are APFS
 * copy-on-write clones of the template device, so most of their blocks are shared with a
 * simulator that is staying — `du` bills the shared blocks to whichever tree it walked. Reporting
 * the larger number is the honest direction to be wrong in for a budget whose job is to stop a
 * sweep going too far.
 */
async function measureWithDu(path: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync("du", ["-s", "-k", path], {
      timeout: DU_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const kibibytes = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
    return Number.isFinite(kibibytes) ? kibibytes * 1024 : undefined;
  } catch {
    return undefined;
  }
}

export function createSystemTestArtifactFileSystem(): TestArtifactFileSystem {
  return {
    scan: scanArtifactRoot,
    measureSizeBytes: measureWithDu,
    async readFreeBytes(path) {
      try {
        const stats = await statfs(path);
        return stats.bsize * stats.bavail;
      } catch {
        return undefined;
      }
    },
    /**
     * The last gate before anything is deleted, and the only place in the feature that calls
     * `rm`. It re-derives the path from the root and the name rather than trusting one it was
     * handed, `realpath`s it, and refuses unless the result is exactly one level inside the
     * resolved root under a canonical UDID name. A symlink, a `..`, a renamed entry and a root
     * that moved underneath the sweep all fail here.
     *
     * `recursive` without `force`: a target that is already gone throws rather than being
     * reported as a successful reclaim.
     */
    async remove({ resolvedRootPath, entryName }) {
      const target = join(resolvedRootPath, entryName);
      const stats = await lstat(target);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`Refusing to remove ${target}: not a directory`);
      }
      const resolvedEntryPath = await realpath(target);
      const verdict = evaluateRemovableArtifactPath({
        resolvedRootPath,
        entryName,
        resolvedEntryPath,
      });
      if (!verdict.removable) {
        throw new Error(`Refusing to remove ${target}: ${verdict.reason}`);
      }
      await rm(verdict.path, { recursive: true, force: false });
    },
  };
}
