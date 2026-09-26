/**
 * Snapshots a worktree's uncommitted and unpushed work without touching it. See
 * docs/work-snapshots.md.
 *
 * The snapshot is a commit built through a temporary `GIT_INDEX_FILE`: HEAD's tree, plus every
 * tracked change, plus untracked files that are not ignored. It is stored at
 * `refs/backup/<date>/<slug>` in the repository's common dir, so it outlives the worktree. The
 * agent's index, HEAD, working tree and branch refs are never written: the only writes are git
 * objects, the one backup ref, and, offsite, a branch on a personal GitHub remote or a bundle file.
 *
 * Nothing here throws. A git failure is a `failed` result with the reason.
 */

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
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
import { runGitCommand, type RunGitCommand } from "../../utils/run-git-command.js";

const BACKUP_REF_PREFIX = "refs/backup/";
const GIT_TIMEOUT_MS = 60_000;
const PUSH_TIMEOUT_MS = 120_000;
/** Untracked paths per `git add`, so a huge scratch directory cannot overflow argv. */
const ADD_BATCH = 200;
const MAX_SLUG_LENGTH = 120;

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
}

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
  /** Offsite results by snapshot commit, so a reused snapshot is not pushed or bundled again. */
  private readonly offsiteByCommit = new Map<string, WorktreeSnapshotOffsite>();

  constructor(options: GitWorktreeSnapshotterOptions) {
    this.options = options;
    this.runGit = options.runGit ?? runGitCommand;
    this.now = options.now ?? Date.now;
  }

  async snapshot(request: WorktreeSnapshotRequest): Promise<WorktreeSnapshotResult> {
    return (await this.snapshotWithDetail(request)).result;
  }

  /** Reads what is at risk. Writes nothing, so it is what a dry run calls. */
  async assess(cwd: string): Promise<WorktreeAssessment> {
    if (!existsSync(cwd)) return { kind: "unreadable", error: "the directory does not exist" };
    const top = await this.tryGit(cwd, ["rev-parse", "--show-toplevel"]);
    if (!top) return { kind: "unreadable", error: "it is not inside a git repository" };
    const worktreePath = top.trim();
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
    const { tree, skippedFiles } = await this.writeSnapshotTree(
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
      { worktreePath, ref, commit, reused, offsite, reason: request.reason },
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
        offsite,
      },
      branch,
      head,
      tree,
      reused,
    };
  }

  /** HEAD's tree plus the working tree's changes, written through an index nobody else reads. */
  private async writeSnapshotTree(
    worktreePath: string,
    head: string | null,
    maxUntrackedFileBytes: number,
  ): Promise<{ tree: string; skippedFiles: string[] }> {
    const indexFile = join(tmpdir(), `paseo-snapshot-index-${process.pid}-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await this.git(worktreePath, head ? ["read-tree", head] : ["read-tree", "--empty"], env);
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
      for (const file of untracked) {
        let size: number;
        try {
          size = lstatSync(join(worktreePath, file)).size;
        } catch {
          continue; // Gone since it was listed.
        }
        if (size > maxUntrackedFileBytes) skippedFiles.push(file);
        else keep.push(file);
      }
      for (let index = 0; index < keep.length; index += ADD_BATCH) {
        await this.git(worktreePath, ["add", "--", ...keep.slice(index, index + ADD_BATCH)], env);
      }
      const tree = (await this.git(worktreePath, ["write-tree"], env)).trim();
      return { tree, skippedFiles };
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
   * A personal GitHub origin gets the snapshot as branch `backup/<date>/<slug>`; anything else,
   * or no origin, gets a bundle file. The push goes to the URL rather than the remote name, so no
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
    const { worktreePath, ref, config } = input;
    const url = (await this.tryGit(worktreePath, ["config", "--get", "remote.origin.url"]))?.trim();
    let offsite: WorktreeSnapshotOffsite | null = null;
    if (url && isPersonalGitHubRemote(url, config.personalOwners)) {
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
    offsite ??= await this.writeBundle(worktreePath, ref, config);
    if (offsite.kind !== "none") this.offsiteByCommit.set(input.commit, offsite);
    return offsite;
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
  return lines.join("\n");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
