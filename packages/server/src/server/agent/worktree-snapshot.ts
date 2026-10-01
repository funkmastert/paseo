/**
 * Snapshots a worktree's uncommitted and unpushed work without touching it. See
 * docs/work-snapshots.md.
 *
 * The snapshot is a commit built through a temporary `GIT_INDEX_FILE`: HEAD's tree, plus every
 * tracked change, plus untracked files that are not ignored and do not look like secrets. It is
 * stored at `refs/backup/<date>/<slug>` in the repository's common dir, so it outlives the
 * worktree. The agent's index, HEAD, working tree and branch refs are never written: the only
 * writes are git objects, the one backup ref, and, offsite, a branch on a private personal GitHub
 * repository or a bundle file.
 *
 * Nothing here throws. A git failure is a `failed` result with the reason.
 */

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "pino";

import type {
  WorktreeSnapshotOffsite,
  WorktreeSnapshotRequest,
  WorktreeSnapshotResult,
  WorktreeSnapshotter,
} from "../remediation/contract.js";
import type { ResolvedWorkSnapshotsConfig } from "../remediation/config.js";
import { resolveGitRevParsePath } from "../../utils/git-rev-parse-path.js";
import { runGitCommand, type RunGitCommand } from "../../utils/run-git-command.js";
import {
  lookupGitHubRepoVisibility,
  parseGitHubRepository,
  type RepoVisibility,
} from "./github-repo-visibility.js";
import {
  displayPath,
  findTokenKind,
  hasSecretName,
  looksLikeSecret,
  WITHHELD_PATH,
} from "./snapshot-secret-filter.js";

const BACKUP_REF_PREFIX = "refs/backup/";
const GIT_TIMEOUT_MS = 60_000;
const PUSH_TIMEOUT_MS = 120_000;
/** Untracked paths per `git add`, so a huge scratch directory cannot overflow argv. */
const ADD_BATCH = 200;
const MAX_SLUG_LENGTH = 120;
/** How long a repository's private or public answer is trusted. */
const VISIBILITY_TTL_MS = 5 * 60_000;
/** Git output the pre-push scan reads at most; more than this is bundled unscanned. */
const PUSH_SCAN_MAX_BYTES = 32 * 1024 * 1024;
/** Findings a held-back push logs at most. */
const MAX_PUSH_FINDINGS = 20;

const BASE_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
} as const;

export type WorktreeSnapshotConfig = Pick<
  ResolvedWorkSnapshotsConfig,
  "personalOwners" | "bundleDir" | "maxUntrackedFileBytes"
>;

export interface GitWorktreeSnapshotterOptions {
  /** Read on every snapshot, so a config patch applies to the next one. */
  readConfig: () => WorktreeSnapshotConfig;
  /** Bundles go to `$PASEO_HOME/backups` unless the config names a `bundleDir`. */
  paseoHome: string;
  logger: Logger;
  now?: () => number;
  runGit?: RunGitCommand;
  /** Whether a GitHub repository is private. Defaults to asking GitHub; tests answer instead. */
  lookupRepoVisibility?: (owner: string, repo: string) => Promise<RepoVisibility>;
  /** Overrides `PUSH_SCAN_MAX_BYTES`, so a test can reach the cap. */
  pushScanMaxBytes?: number;
}

/** A path, or where in a commit, and what kind of secret was seen there. Never the secret. */
interface PushFinding {
  path: string;
  kind: string;
}

type PushScan =
  | { kind: "clean" }
  | { kind: "possible-secret"; findings: PushFinding[] }
  | { kind: "unscanned"; reason: string };

/** What a worktree holds that exists nowhere else, read without writing anything. */
export type WorktreeAssessment =
  | { kind: "unreadable"; error: string }
  | {
      kind: "assessed";
      worktreePath: string;
      /** Null on an unborn branch. */
      head: string | null;
      /** Null on a detached HEAD. */
      branch: string | null;
      dirtyFiles: number;
      unpushedCommits: number;
      atRisk: boolean;
    };

/** A snapshot plus what the work-at-risk sweep keeps to tell an unchanged worktree from a new one. */
export interface DetailedWorktreeSnapshot {
  result: WorktreeSnapshotResult;
  branch: string | null;
  head: string | null;
  /** The snapshot's tree; null unless snapshotted. */
  tree: string | null;
  /** The newest existing snapshot already had this tree and parent, so no ref was minted. */
  reused: boolean;
}

/** Local calendar date, `YYYY-MM-DD`: the day Tyler would say the snapshot was taken. */
export function formatSnapshotDate(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A ref-safe name for a worktree path: home stripped, anything unusual folded to `-`. */
export function slugForWorktreePath(path: string): string {
  return sanitizeSlug(path.replace(/^\/(?:Users|home)\/[^/]+\//, ""));
}

function sanitizeSlug(value: string): string {
  const slug = value
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || "worktree";
}

/**
 * Whether `url` is a GitHub repository owned by one of `owners`. Only these get a pushed branch:
 * anything else may be a shared company forge, where a WIP branch would start CI and show up for
 * everyone.
 */
export function isPersonalGitHubRemote(url: string, owners: readonly string[]): boolean {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([^/]+)\//i.exec(
      url.trim(),
    );
  if (!match) return false;
  const owner = match[1].toLowerCase();
  return owners.some((candidate) => candidate.toLowerCase() === owner);
}

class GitFailure extends Error {
  constructor(
    readonly args: readonly string[],
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`git ${args[0]} failed: ${detail.split("\n").slice(0, 3).join(" | ")}`);
    this.name = "GitFailure";
  }
}

export class GitWorktreeSnapshotter implements WorktreeSnapshotter {
  private readonly options: GitWorktreeSnapshotterOptions;
  private readonly runGit: RunGitCommand;
  private readonly now: () => number;
  private readonly lookupRepoVisibility: (owner: string, repo: string) => Promise<RepoVisibility>;
  /** Offsite results by snapshot commit, so a reused snapshot is not pushed or bundled again. */
  private readonly offsiteByCommit = new Map<string, WorktreeSnapshotOffsite>();
  /** Definite answers by `owner/repo`. An unknown one is asked again next time. */
  private readonly visibilityByRepo = new Map<
    string,
    { visibility: "public" | "private"; atMs: number }
  >();

  constructor(options: GitWorktreeSnapshotterOptions) {
    this.options = options;
    this.runGit = options.runGit ?? runGitCommand;
    this.now = options.now ?? Date.now;
    this.lookupRepoVisibility =
      options.lookupRepoVisibility ?? ((owner, repo) => lookupGitHubRepoVisibility(owner, repo));
  }

  async snapshot(request: WorktreeSnapshotRequest): Promise<WorktreeSnapshotResult> {
    return (await this.snapshotWithDetail(request)).result;
  }

  /** Reads what is at risk. Writes nothing, so it is what a dry run calls. */
  async assess(cwd: string): Promise<WorktreeAssessment> {
    if (!existsSync(cwd)) return { kind: "unreadable", error: "the directory does not exist" };
    const top = await this.tryGit(cwd, ["rev-parse", "--show-toplevel"]);
    if (!top) return { kind: "unreadable", error: "it is not inside a git repository" };
    // Git for Windows reports --show-toplevel with forward slashes even on win32; resolve
    // through the native path module so worktreePath matches every other path this class
    // and its callers compare it against.
    const worktreePath = resolveGitRevParsePath(cwd, top) ?? top.trim();
    try {
      const head =
        (await this.tryGit(worktreePath, ["rev-parse", "--verify", "--quiet", "HEAD"]))?.trim() ||
        null;
      const branch =
        (await this.tryGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim() ||
        null;
      const status = await this.git(worktreePath, [
        "status",
        "--porcelain",
        "--untracked-files=normal",
      ]);
      const dirtyFiles = status.split("\n").filter((line) => line.trim().length > 0).length;
      let unpushedCommits = 0;
      if (head) {
        const remotes = (await this.git(worktreePath, ["remote"])).trim();
        // With no remote at all, nothing is anywhere else: every commit counts.
        const args = remotes
          ? ["rev-list", "--count", "HEAD", "--not", "--remotes"]
          : ["rev-list", "--count", "HEAD"];
        unpushedCommits = Number.parseInt((await this.git(worktreePath, args)).trim(), 10) || 0;
      }
      return {
        kind: "assessed",
        worktreePath,
        head,
        branch,
        dirtyFiles,
        unpushedCommits,
        atRisk: dirtyFiles > 0 || unpushedCommits > 0,
      };
    } catch (error) {
      return { kind: "unreadable", error: describeError(error) };
    }
  }

  async snapshotWithDetail(request: WorktreeSnapshotRequest): Promise<DetailedWorktreeSnapshot> {
    const assessment = await this.assess(request.cwd);
    if (assessment.kind === "unreadable") {
      return {
        result: { kind: "failed", worktreePath: null, error: assessment.error },
        branch: null,
        head: null,
        tree: null,
        reused: false,
      };
    }
    const { worktreePath, head, branch } = assessment;
    if (!assessment.atRisk) {
      return {
        result: { kind: "nothing-at-risk", worktreePath },
        branch,
        head,
        tree: null,
        reused: false,
      };
    }
    try {
      return await this.snapshotAtRisk(request, assessment);
    } catch (error) {
      this.options.logger.warn(
        { err: error, worktreePath },
        "Work snapshot: snapshot of a worktree at risk failed",
      );
      return {
        result: { kind: "failed", worktreePath, error: describeError(error) },
        branch,
        head,
        tree: null,
        reused: false,
      };
    }
  }

  private async snapshotAtRisk(
    request: WorktreeSnapshotRequest,
    assessment: Extract<WorktreeAssessment, { kind: "assessed" }>,
  ): Promise<DetailedWorktreeSnapshot> {
    const { worktreePath, head, branch } = assessment;
    const config = this.options.readConfig();
    const nowMs = this.now();
    const slug = request.slug ? sanitizeSlug(request.slug) : slugForWorktreePath(worktreePath);
    const { tree, skippedFiles, possibleSecrets } = await this.writeSnapshotTree(
      worktreePath,
      head,
      config.maxUntrackedFileBytes,
    );

    const newest = await this.findNewestSnapshot(worktreePath, slug);
    let ref: string;
    let commit: string;
    const reused = newest !== null && newest.tree === tree && newest.parent === (head ?? "");
    if (reused) {
      ref = newest.ref;
      commit = newest.commit;
    } else {
      const message = buildCommitMessage({
        worktreePath,
        branch,
        reason: request.reason,
        dirtyFiles: assessment.dirtyFiles,
        unpushedCommits: assessment.unpushedCommits,
        skippedFiles,
        possibleSecrets,
      });
      commit = (
        await this.git(
          worktreePath,
          ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", message],
          commitIdentityEnv(nowMs),
        )
      ).trim();
      ref = await this.createBackupRef(worktreePath, formatSnapshotDate(nowMs), slug, commit);
    }

    const offsite =
      request.offsite === false
        ? ({ kind: "none", reason: "offsite copy not requested" } as const)
        : await this.sendOffsite({ worktreePath, ref, commit, config });
    this.options.logger.info(
      { worktreePath, ref, commit, reused, offsite, possibleSecrets, reason: request.reason },
      reused
        ? "Work snapshot: reused the newest snapshot"
        : "Work snapshot: snapshotted a worktree",
    );
    return {
      result: {
        kind: "snapshotted",
        worktreePath,
        ref,
        commit,
        dirtyFiles: assessment.dirtyFiles,
        unpushedCommits: assessment.unpushedCommits,
        skippedFiles,
        possibleSecrets,
        offsite,
      },
      branch,
      head,
      tree,
      reused,
    };
  }

  /**
   * Seeds the temporary index with HEAD's tree, carrying the stat cache over from a copy of the
   * worktree's own index, so `add -u` below only re-hashes a file whose mtime or size actually
   * moved since git last looked at it, instead of every tracked file in the worktree.
   *
   * The copy is reset to HEAD with a one-tree `read-tree -m`, which keeps an entry's stat data only
   * where it still matches HEAD. Without the reset, a file the agent staged but never committed
   * would already be in the index, so `ls-files --others` would not list it and it would skip the
   * untracked-file filter. `read-tree -m` refuses an index with unmerged entries (a worktree
   * mid-merge); that, and a real index that can't be found or copied, falls back to a plain
   * `read-tree HEAD` — no stat cache, so `add -u` must hash everything. That plain read also seeds
   * an unborn branch's empty tree.
   */
  private async seedSnapshotIndex(
    worktreePath: string,
    indexFile: string,
    head: string | null,
  ): Promise<void> {
    if (head) {
      const realIndexPath = await this.tryGit(worktreePath, ["rev-parse", "--git-path", "index"]);
      const resolved = realIndexPath ? resolveGitRevParsePath(worktreePath, realIndexPath) : null;
      let copied = false;
      if (resolved && existsSync(resolved)) {
        try {
          copyFileSync(resolved, indexFile);
          copied = true;
        } catch {
          // Fall through to a fresh index seeded from HEAD.
        }
      }
      if (copied) {
        try {
          await this.git(worktreePath, ["read-tree", "-m", head], { GIT_INDEX_FILE: indexFile });
          return;
        } catch {
          // Unmerged entries: fall through to a fresh index seeded from HEAD.
        }
      }
    }
    await this.git(worktreePath, head ? ["read-tree", head] : ["read-tree", "--empty"], {
      GIT_INDEX_FILE: indexFile,
    });
  }

  /**
   * HEAD's tree plus the working tree's changes, written through an index nobody else reads.
   * Untracked files over the size cap or that look like secrets are left out; `add -u` still
   * stages tracked changes as they are.
   */
  private async writeSnapshotTree(
    worktreePath: string,
    head: string | null,
    maxUntrackedFileBytes: number,
  ): Promise<{ tree: string; skippedFiles: string[]; possibleSecrets: string[] }> {
    const indexFile = join(tmpdir(), `paseo-snapshot-index-${process.pid}-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await this.seedSnapshotIndex(worktreePath, indexFile, head);
      await this.git(worktreePath, ["add", "-u"], env);
      // Relative to the temporary index, so a file staged in the agent's index but new since HEAD
      // is listed here too.
      const untracked = (
        await this.git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"], env)
      )
        .split("\0")
        .filter(Boolean);
      const keep: string[] = [];
      const skippedFiles: string[] = [];
      const possibleSecrets: string[] = [];
      for (const file of untracked) {
        const path = join(worktreePath, file);
        let stats: Stats;
        try {
          stats = lstatSync(path);
        } catch {
          continue; // Gone since it was listed.
        }
        if (stats.size > maxUntrackedFileBytes) skippedFiles.push(displayPath(file));
        else if (await looksLikeSecret(path, file, stats)) possibleSecrets.push(displayPath(file));
        else keep.push(file);
      }
      for (let index = 0; index < keep.length; index += ADD_BATCH) {
        await this.git(worktreePath, ["add", "--", ...keep.slice(index, index + ADD_BATCH)], env);
      }
      const tree = (await this.git(worktreePath, ["write-tree"], env)).trim();
      return { tree, skippedFiles, possibleSecrets };
    } finally {
      rmSync(indexFile, { force: true });
      rmSync(`${indexFile}.lock`, { force: true });
    }
  }

  private async findNewestSnapshot(
    worktreePath: string,
    slug: string,
  ): Promise<{ ref: string; commit: string; tree: string; parent: string } | null> {
    const listing = await this.git(worktreePath, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(tree)%00%(parent)",
      `${BACKUP_REF_PREFIX}*/${slug}`,
    ]);
    const snapshots = listing
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref = "", commit = "", tree = "", parent = ""] = line.split("\0");
        return { ref, commit, tree, parent: parent.trim() };
      })
      .filter((entry) => entry.ref.endsWith(`/${slug}`));
    snapshots.sort((a, b) => compareSnapshotRefs(b.ref, a.ref));
    return snapshots[0] ?? null;
  }

  /**
   * `refs/backup/<date>/<slug>`, or `<date>-2`, `-3`… when that day already has a different
   * snapshot of the same worktree. An existing ref is never moved: each snapshot keeps its own.
   */
  private async createBackupRef(
    worktreePath: string,
    date: string,
    slug: string,
    commit: string,
  ): Promise<string> {
    for (let sequence = 1; sequence < 1000; sequence += 1) {
      const segment = sequence === 1 ? date : `${date}-${sequence}`;
      const ref = `${BACKUP_REF_PREFIX}${segment}/${slug}`;
      if (await this.tryGit(worktreePath, ["rev-parse", "--verify", "--quiet", ref])) continue;
      // The empty old value makes the update fail if the ref appeared in the meantime.
      await this.git(worktreePath, ["update-ref", "-m", "paseo work snapshot", ref, commit, ""]);
      return ref;
    }
    throw new Error(`no free backup ref name for ${slug} on ${date}`);
  }

  /**
   * A personal GitHub origin that GitHub says is private gets the snapshot as branch
   * `backup/<date>/<slug>`, unless what the push would send may hold a secret; anything else, or no
   * origin, gets a bundle file. The push goes to the URL rather than the remote name, so no
   * remote-tracking ref is written and the done janitor's reachability check reads as before.
   */
  private async sendOffsite(input: {
    worktreePath: string;
    ref: string;
    commit: string;
    config: WorktreeSnapshotConfig;
  }): Promise<WorktreeSnapshotOffsite> {
    const cached = this.offsiteByCommit.get(input.commit);
    if (cached) return cached;
    const { worktreePath, ref, commit, config } = input;
    const url = (await this.tryGit(worktreePath, ["config", "--get", "remote.origin.url"]))?.trim();
    let offsite: WorktreeSnapshotOffsite | null = null;
    // A bundle made because GitHub did not answer is not the last word on this snapshot: the next
    // sweep asks again, even when the worktree has not changed.
    let settled = true;
    if (url && isPersonalGitHubRemote(url, config.personalOwners)) {
      const visibility = await this.repositoryVisibility(worktreePath, url);
      settled = visibility !== "unknown";
      if (visibility === "private" && (await this.pushIsClean(worktreePath, ref, commit))) {
        const branch = `backup/${ref.slice(BACKUP_REF_PREFIX.length)}`;
        try {
          await this.git(
            worktreePath,
            ["push", "--no-verify", "--quiet", url, `${ref}:refs/heads/${branch}`],
            {},
            PUSH_TIMEOUT_MS,
          );
          offsite = { kind: "pushed", remote: "origin", branch };
        } catch (error) {
          this.options.logger.warn(
            { err: error, worktreePath, ref },
            "Work snapshot: push to the personal remote failed; bundling instead",
          );
        }
      }
    }
    offsite ??= await this.writeBundle(worktreePath, ref, config);
    if (settled && offsite.kind !== "none") this.offsiteByCommit.set(commit, offsite);
    return offsite;
  }

  private async repositoryVisibility(worktreePath: string, url: string): Promise<RepoVisibility> {
    const parsed = parseGitHubRepository(url);
    const key = parsed ? `${parsed.owner}/${parsed.repo}`.toLowerCase() : null;
    const cached = key ? this.visibilityByRepo.get(key) : undefined;
    let visibility: RepoVisibility;
    if (cached && this.now() - cached.atMs < VISIBILITY_TTL_MS) {
      visibility = cached.visibility;
    } else {
      visibility = parsed ? await this.lookupRepoVisibility(parsed.owner, parsed.repo) : "unknown";
      if (key && visibility !== "unknown") {
        this.visibilityByRepo.set(key, { visibility, atMs: this.now() });
      }
    }
    if (visibility !== "private") {
      this.options.logger.info(
        { worktreePath, repository: key, visibility },
        "Work snapshot: the personal repository is not known to be private; bundling instead of pushing",
      );
    }
    return visibility;
  }

  /** Scans what the push would send and logs why when it holds the push back. */
  private async pushIsClean(worktreePath: string, ref: string, commit: string): Promise<boolean> {
    let scan: PushScan;
    try {
      scan = await this.scanPush(worktreePath, commit);
    } catch (error) {
      scan = { kind: "unscanned", reason: describeError(error) };
    }
    if (scan.kind === "possible-secret") {
      this.options.logger.warn(
        { worktreePath, ref, findings: scan.findings },
        "Work snapshot: possible secret in what the push would send; bundling instead of pushing",
      );
    } else if (scan.kind === "unscanned") {
      this.options.logger.warn(
        { worktreePath, ref, reason: scan.reason },
        "Work snapshot: could not scan what the push would send; bundling instead of pushing",
      );
    }
    return scan.kind === "clean";
  }

  /**
   * Everything the push sends that no remote has: the snapshot and HEAD's unpushed commits. Their
   * added lines and messages are scanned for tokens and their changed paths for secret-shaped
   * names. This reads the objects actually sent, so it also covers tracked edits, committed files,
   * and untracked files past the untracked filter's 64 KB window or changed after it ran.
   */
  private async scanPush(worktreePath: string, commit: string): Promise<PushScan> {
    const maxBytes = this.options.pushScanMaxBytes ?? PUSH_SCAN_MAX_BYTES;
    const range = ["--diff-merges=first-parent", commit, "--not", "--remotes"];
    const names = await this.readForScan(
      worktreePath,
      ["log", "--format=", "--name-only", "-z", "--diff-filter=d", ...range],
      maxBytes,
    );
    const patch = await this.readForScan(
      worktreePath,
      [
        "log",
        "--patch",
        "--text",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-prefix",
        "--unified=0",
        "--format=%x1e%B",
        ...range,
      ],
      maxBytes,
    );
    if (names === null || patch === null) {
      return { kind: "unscanned", reason: `more than ${maxBytes} bytes to scan` };
    }

    const findings = new Map<string, PushFinding>();
    const note = (path: string, kind: string) => {
      if (findings.size < MAX_PUSH_FINDINGS) findings.set(`${path}\0${kind}`, { path, kind });
    };
    for (const name of names.split("\0")) {
      if (!name) continue;
      if (findTokenKind(name) !== null) note(WITHHELD_PATH, "token in the path");
      else if (hasSecretName(name)) note(name, "secret-shaped name");
    }
    let section: "message" | "header" | "hunk" = "header";
    let path = "(unknown path)";
    for (const line of patch.split("\n")) {
      let text: string | null = null;
      if (line.startsWith("\x1e")) {
        section = "message";
        text = line.slice(1);
      } else if (line.startsWith("diff --git ")) {
        section = "header";
        path = "(unknown path)";
      } else if (section === "message") {
        text = line;
      } else if (section === "header") {
        if (line.startsWith("+++ ")) path = line.slice(4);
        else if (line.startsWith("@@")) section = "hunk";
      } else if (line.startsWith("+")) {
        text = line.slice(1);
      }
      const kind = text === null ? null : findTokenKind(text);
      if (kind !== null) note(section === "message" ? "(commit message)" : displayPath(path), kind);
    }
    return findings.size === 0
      ? { kind: "clean" }
      : { kind: "possible-secret", findings: [...findings.values()] };
  }

  /** Git's stdout, or null when it is over `maxBytes`. */
  private async readForScan(cwd: string, args: string[], maxBytes: number): Promise<string | null> {
    try {
      const result = await this.runGit(["--no-optional-locks", ...args], {
        cwd,
        envOverlay: BASE_ENV,
        timeout: GIT_TIMEOUT_MS,
        maxOutputBytes: maxBytes,
      });
      return result.truncated ? null : result.stdout;
    } catch (error) {
      throw new GitFailure(args, error);
    }
  }

  private async writeBundle(
    worktreePath: string,
    ref: string,
    config: WorktreeSnapshotConfig,
  ): Promise<WorktreeSnapshotOffsite> {
    const bundleDir = config.bundleDir ?? join(this.options.paseoHome, "backups");
    const path = join(bundleDir, `${ref.slice(BACKUP_REF_PREFIX.length)}.bundle`);
    try {
      mkdirSync(dirname(path), { recursive: true });
      const remotes = (await this.git(worktreePath, ["remote"])).trim();
      // With a remote, leave out what the remote already has: restoring needs a clone of it
      // anyway, and a bundle of the whole history would be the size of the repository.
      await this.git(worktreePath, [
        "bundle",
        "create",
        "--quiet",
        path,
        ref,
        ...(remotes ? ["--not", "--remotes"] : []),
      ]);
      return { kind: "bundled", path };
    } catch (error) {
      rmSync(path, { force: true });
      return { kind: "none", reason: `bundle failed: ${describeError(error)}` };
    }
  }

  private async git(
    cwd: string,
    args: string[],
    env: Record<string, string> = {},
    timeout = GIT_TIMEOUT_MS,
  ): Promise<string> {
    try {
      const result = await this.runGit(["--no-optional-locks", ...args], {
        cwd,
        envOverlay: { ...BASE_ENV, ...env },
        timeout,
        // A background sweep nobody is waiting on: it yields to the agents and Tyler's own work.
        priority: "background",
      });
      return result.stdout;
    } catch (error) {
      throw new GitFailure(args, error);
    }
  }

  private async tryGit(cwd: string, args: string[]): Promise<string | null> {
    try {
      return await this.git(cwd, args);
    } catch {
      return null;
    }
  }
}

/** Oldest first: by the date segment, then by its `-N` sequence within a day (none is 1). */
function compareSnapshotRefs(a: string, b: string): number {
  const parse = (ref: string) => {
    const segment = ref.slice(BACKUP_REF_PREFIX.length).split("/")[0] ?? "";
    return { date: segment.slice(0, 10), sequence: Number(segment.slice(11)) || 1 };
  };
  const left = parse(a);
  const right = parse(b);
  return left.date.localeCompare(right.date) || left.sequence - right.sequence;
}

function commitIdentityEnv(nowMs: number): Record<string, string> {
  const date = `@${Math.floor(nowMs / 1000)} +0000`;
  return {
    GIT_AUTHOR_NAME: "Paseo work snapshot",
    GIT_AUTHOR_EMAIL: "paseo@localhost",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: "Paseo work snapshot",
    GIT_COMMITTER_EMAIL: "paseo@localhost",
    GIT_COMMITTER_DATE: date,
  };
}

function buildCommitMessage(input: {
  worktreePath: string;
  branch: string | null;
  reason: string;
  dirtyFiles: number;
  unpushedCommits: number;
  skippedFiles: readonly string[];
  possibleSecrets: readonly string[];
}): string {
  const lines = [
    `backup: snapshot of ${input.worktreePath}`,
    "",
    input.reason,
    `Branch ${input.branch ?? "(detached or unborn)"}, ${input.dirtyFiles} changed file(s), ${input.unpushedCommits} unpushed commit(s).`,
  ];
  if (input.skippedFiles.length > 0) {
    lines.push(`Left out, over the size cap: ${input.skippedFiles.join(", ")}`);
  }
  if (input.possibleSecrets.length > 0) {
    lines.push(
      `Not snapshotted: possible secret (left on disk): ${input.possibleSecrets.join(", ")}`,
    );
  }
  return lines.join("\n");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
