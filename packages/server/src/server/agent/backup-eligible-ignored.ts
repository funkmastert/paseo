/**
 * Whether an ignored path should be captured by a work snapshot instead of unconditionally
 * keeping its worktree forever: it matches a configured pattern
 * (`agents.doneJanitor.backupIgnoredPaths`), and every file under it (recursively, for a
 * directory) is small enough and does not look like a secret, within a total cap across every
 * eligible entry. See docs/done-janitor.md, "Unbacked ignored files".
 *
 * `selectBackupEligibleIgnored` decides two things that must never disagree: which top-level
 * entries the done janitor's plan-time check may treat as "pending backup" rather than an
 * unconditional keep, and the exact file list the snapshotter stages. Sharing one function is
 * what makes the plan-time deferral safe -- whatever this says can be backed up is exactly what
 * the snapshotter backs up when it runs, file for file.
 */

import type { Dirent, Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  globToRegExp,
  isSecretShapedPath,
  resolveIgnoredPathPatterns,
} from "../jev/secret-paths.js";
import { looksLikeSecret } from "./snapshot-secret-filter.js";

/** Used when `agents.doneJanitor.maxBackupIgnoredFileBytes` is unset. */
export const DEFAULT_MAX_BACKUP_IGNORED_FILE_BYTES = 5 * 1024 * 1024;
/** Used when `agents.doneJanitor.maxBackupIgnoredTotalBytes` is unset. */
export const DEFAULT_MAX_BACKUP_IGNORED_TOTAL_BYTES = 50 * 1024 * 1024;

/**
 * Resolves `agents.doneJanitor.backupIgnoredPaths` the same way
 * `resolveRegenerableIgnoredPaths` (workspace-sweep-detector.ts) resolves its sibling config key
 * -- both are now `resolveIgnoredPathPatterns` (jev/secret-paths.ts) -- except a pattern here may
 * match a directory: `.worker-logs/` has to.
 */
export function resolveBackupIgnoredPaths(
  patterns: readonly string[] | undefined,
  onRejectedPattern: (pattern: string) => void,
): string[] {
  return resolveIgnoredPathPatterns(patterns, onRejectedPattern, { allowDirectory: true });
}

function matchesAnyPattern(path: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  const withoutTrailingSlash = path.endsWith("/") ? path.slice(0, -1) : path;
  // A directory entry's own trailing slash can hide it from the secret-name check (the JEV
  // globs are end-anchored), so both forms are tested.
  if (isSecretShapedPath(path) || isSecretShapedPath(withoutTrailingSlash)) return false;
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
 * too large or secret-shaped to back up. A convenience wrapper over `selectBackupEligibleIgnored`
 * for a single candidate with no total cap, for a caller that only needs the yes/no.
 */
export async function isBackupEligibleIgnoredPath(
  options: BackupEligibleIgnoredOptions,
): Promise<boolean> {
  const selection = await selectBackupEligibleIgnored({
    worktreePath: options.worktreePath,
    candidates: [options.entry],
    patterns: options.patterns,
    maxFileBytes: options.maxFileBytes,
    maxTotalBytes: Number.POSITIVE_INFINITY,
  });
  return selection.entries.includes(options.entry);
}

export interface SelectBackupEligibleIgnoredOptions {
  worktreePath: string;
  /** Top-level candidates, as `WorktreeCoverage.ignored` lists them: a directory ends with `/`. */
  candidates: readonly string[];
  patterns: readonly string[];
  maxFileBytes: number;
  /** Across every eligible entry combined, not just one directory. */
  maxTotalBytes: number;
}

export interface BackupEligibleSelection {
  /** The subset of `candidates`, in order, that fit entirely within both caps. */
  entries: string[];
  /**
   * Every file (never a directory), relative to `worktreePath`, under the entries above -- the
   * exact list `writeSnapshotTree` (agent/worktree-snapshot.ts) should stage, re-checked just
   * before it does, rather than the directory name: a file created or grown after this walk is
   * not implicitly included.
   */
  files: string[];
}

/**
 * Which of `candidates` match a configured pattern and fit within the caps: a symlink, an
 * unreadable entry, a secret-shaped path (by name, by `looksLikeSecret`'s content scan, or by
 * `isSecretShapedPath` applied to every file found recursively -- not just the top-level entry),
 * or anything over `maxFileBytes` makes the whole entry ineligible, whole or nothing: a partial
 * backup of a directory is not a backup of it. Entries are evaluated in order and accepted while
 * the running total stays within `maxTotalBytes`; an entry that would push the total over is
 * skipped (later, smaller entries may still fit), never allowed to silently uncap the total.
 */
export async function selectBackupEligibleIgnored(
  options: SelectBackupEligibleIgnoredOptions,
): Promise<BackupEligibleSelection> {
  const { worktreePath, candidates, patterns, maxFileBytes, maxTotalBytes } = options;
  const entries: string[] = [];
  const files: string[] = [];
  if (patterns.length === 0) return { entries, files };
  let totalBytes = 0;
  for (const entry of candidates) {
    if (!matchesAnyPattern(entry, patterns)) continue;
    const collected = entry.endsWith("/")
      ? await collectEligibleFilesInDirectory(worktreePath, entry.slice(0, -1), maxFileBytes)
      : await collectEligibleFile(worktreePath, entry, maxFileBytes);
    if (!collected) continue;
    if (totalBytes + collected.totalBytes > maxTotalBytes) continue;
    totalBytes += collected.totalBytes;
    entries.push(entry);
    files.push(...collected.files);
  }
  return { entries, files };
}

interface CollectedFiles {
  files: string[];
  totalBytes: number;
}

async function collectEligibleFilesInDirectory(
  worktreePath: string,
  relativeDir: string,
  maxFileBytes: number,
): Promise<CollectedFiles | null> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(worktreePath, relativeDir), { withFileTypes: true });
  } catch {
    return null;
  }
  const files: string[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) return null;
    const child = `${relativeDir}/${entry.name}`;
    let collected: CollectedFiles | null;
    if (entry.isDirectory()) {
      collected = await collectEligibleFilesInDirectory(worktreePath, child, maxFileBytes);
    } else if (entry.isFile()) {
      collected = await collectEligibleFile(worktreePath, child, maxFileBytes);
    } else {
      collected = null;
    }
    if (!collected) return null;
    files.push(...collected.files);
    totalBytes += collected.totalBytes;
  }
  return { files, totalBytes };
}

/** Whether any directory on the way to `relativePath` (not the file itself) is secret-shaped. */
function hasSecretShapedAncestor(relativePath: string): boolean {
  const segments = relativePath.split("/");
  for (let length = 1; length < segments.length; length += 1) {
    if (isSecretShapedPath(segments.slice(0, length).join("/"))) return true;
  }
  return false;
}

async function collectEligibleFile(
  worktreePath: string,
  relativePath: string,
  maxFileBytes: number,
): Promise<CollectedFiles | null> {
  // Applied per file, not just to the top-level entry: a name on the JEV secret list buried
  // inside an otherwise-plain directory must disqualify it too -- its own name, or any directory
  // on the way to it (a secret-named directory pattern like `.env/` passed its own rejection
  // check, so this is the backstop for a file found underneath one by some other pattern).
  if (isSecretShapedPath(relativePath) || hasSecretShapedAncestor(relativePath)) return null;
  const absolutePath = join(worktreePath, relativePath);
  let stats: Stats;
  try {
    stats = await lstat(absolutePath);
  } catch {
    return null;
  }
  if (!stats.isFile() || stats.size > maxFileBytes) return null;
  if (await looksLikeSecret(absolutePath, relativePath, stats)) return null;
  return { files: [relativePath], totalBytes: stats.size };
}
