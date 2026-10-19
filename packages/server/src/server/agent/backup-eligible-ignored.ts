/**
 * Whether an ignored path should be captured by a work snapshot instead of unconditionally
 * keeping its worktree forever: it matches a configured pattern
 * (`agents.doneJanitor.backupIgnoredPaths`), and every file under it (recursively, for a
 * directory) is small enough and does not look like a secret. See docs/done-janitor.md,
 * "Unbacked ignored files".
 *
 * The same predicate decides two things that must never disagree: what the snapshotter actually
 * stages into a worktree's backup, and what the done janitor's plan-time check may treat as
 * "pending backup" rather than an unconditional keep. Sharing one function is what makes the
 * plan-time deferral safe -- whatever this says can be backed up is exactly what the snapshotter
 * will back up when it runs.
 */

import type { Dirent, Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { globToRegExp, isSecretShapedPath } from "../jev/secret-paths.js";
import { looksLikeSecret } from "./snapshot-secret-filter.js";

/** Used when `agents.doneJanitor.maxBackupIgnoredFileBytes` is unset. */
export const DEFAULT_MAX_BACKUP_IGNORED_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Resolves `agents.doneJanitor.backupIgnoredPaths` the same way
 * `resolveRegenerableIgnoredPaths` (workspace-sweep-detector.ts) resolves its sibling config key:
 * each pattern is a path suffix, or a simple glob with `*` standing for any run of characters
 * within one path segment, and a pattern that could match a secret -- whatever its extension --
 * is rejected rather than risk the janitor pushing a secret into a snapshot's backup. Unlike the
 * regenerable list, a pattern here may match a directory: `.worker-logs/` has to.
 */
export function resolveBackupIgnoredPaths(
  patterns: readonly string[] | undefined,
  onRejectedPattern: (pattern: string) => void,
): string[] {
  if (!patterns || patterns.length === 0) return [];
  const accepted: string[] = [];
  for (const pattern of patterns) {
    const sample = pattern.replace(/\*/gu, "x");
    const trimmed = pattern.trim().replace(/\/$/u, "");
    // A pattern here may name a directory, unlike `resolveRegenerableIgnoredPaths`'s: a trailing
    // slash is not itself a wildcard-only last segment.
    const lastSegment = trimmed.split("/").pop() ?? "";
    if (
      lastSegment.replace(/\*/gu, "") === "" ||
      isSecretShapedPath(pattern) ||
      isSecretShapedPath(sample)
    ) {
      onRejectedPattern(pattern);
      continue;
    }
    accepted.push(pattern);
  }
  return accepted;
}

function matchesAnyPattern(path: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0 || isSecretShapedPath(path)) return false;
  const withoutTrailingSlash = path.endsWith("/") ? path.slice(0, -1) : path;
  return patterns.some(
    (pattern) =>
      globToRegExp(pattern, "u").test(path) ||
      globToRegExp(pattern, "u").test(withoutTrailingSlash),
  );
}

export interface BackupEligibleIgnoredOptions {
  worktreePath: string;
  /** As `WorktreeCoverage.ignored` lists it: a directory ends with `/`. */
  entry: string;
  patterns: readonly string[];
  maxFileBytes: number;
}

/**
 * Whether `entry` matches a configured pattern and, recursively for a directory, holds nothing
 * too large or secret-shaped to back up. A symlink, an unreadable entry, or anything over the cap
 * makes the whole entry ineligible: a partial backup of a directory is not a backup of it.
 */
export async function isBackupEligibleIgnoredPath(
  options: BackupEligibleIgnoredOptions,
): Promise<boolean> {
  const { worktreePath, entry, patterns, maxFileBytes } = options;
  if (!matchesAnyPattern(entry, patterns)) return false;
  return entry.endsWith("/")
    ? directoryWithinCap(worktreePath, entry.slice(0, -1), maxFileBytes)
    : fileWithinCap(worktreePath, entry, maxFileBytes);
}

async function directoryWithinCap(
  worktreePath: string,
  relativeDir: string,
  maxFileBytes: number,
): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(worktreePath, relativeDir), { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) return false;
    const child = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!(await directoryWithinCap(worktreePath, child, maxFileBytes))) return false;
    } else if (entry.isFile()) {
      if (!(await fileWithinCap(worktreePath, child, maxFileBytes))) return false;
    } else {
      return false;
    }
  }
  return true;
}

async function fileWithinCap(
  worktreePath: string,
  relativePath: string,
  maxFileBytes: number,
): Promise<boolean> {
  const absolutePath = join(worktreePath, relativePath);
  let stats: Stats;
  try {
    stats = await lstat(absolutePath);
  } catch {
    return false;
  }
  if (!stats.isFile() || stats.size > maxFileBytes) return false;
  return !(await looksLikeSecret(absolutePath, relativePath, stats));
}
