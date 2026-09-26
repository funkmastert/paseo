import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { WorktreeSnapshotResult } from "../remediation/contract.js";
import { GitWorktreeSnapshotter, formatSnapshotDate } from "./worktree-snapshot.js";

// Real repositories under a temp dir. The snapshot's whole promise is that it never writes the
// agent's index, HEAD or branches, and only real git can prove that.
const NOW = Date.parse("2026-09-24T15:00:00.000Z");
const DATE = formatSnapshotDate(NOW);

let root: string;
let repo: string;
let remote: string;
let bundleDir: string;

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

function commit(cwd: string, file: string, content: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `edit ${file}`);
}

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function snapshotter(
  overrides: { personalOwners?: string[]; maxUntrackedFileBytes?: number; now?: () => number } = {},
): GitWorktreeSnapshotter {
  return new GitWorktreeSnapshotter({
    readConfig: () => ({
      personalOwners: overrides.personalOwners ?? ["funkmastert"],
      bundleDir,
      maxUntrackedFileBytes: overrides.maxUntrackedFileBytes ?? 1024 * 1024,
    }),
    paseoHome: join(root, "paseo-home"),
    logger: pino({ level: "silent" }),
    now: overrides.now ?? (() => NOW),
  });
}

function expectSnapshotted(
  result: WorktreeSnapshotResult,
): Extract<WorktreeSnapshotResult, { kind: "snapshotted" }> {
  if (result.kind !== "snapshotted")
    throw new Error(`expected a snapshot, got ${JSON.stringify(result)}`);
  return result;
}

function backupRefs(cwd: string): string[] {
  return git(cwd, "for-each-ref", "--format=%(refname)", "refs/backup/")
    .split("\n")
    .filter(Boolean);
}

beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_SYSTEM", "/dev/null");
  // Real path: git reports the top level resolved, and macOS tmpdir is behind a symlink.
  root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-snapshot-")));
  repo = join(root, "repo");
  remote = join(root, "remote.git");
  bundleDir = join(root, "bundles");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "init", "-q", "-b", "main", repo);
  commit(repo, "README.md", "hello\n");
  commit(repo, "gone.txt", "delete me\n");
  // A personal-GitHub origin that git rewrites to the local bare repo, so the push is real.
  git(repo, "remote", "add", "origin", "https://github.com/funkmastert/x.git");
  git(repo, "config", `url.${remote}.insteadOf`, "https://github.com/funkmastert/x.git");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("GitWorktreeSnapshotter", () => {
  test("a clean worktree whose commits are all pushed has nothing at risk", async () => {
    const result = await snapshotter().snapshot({ cwd: repo, reason: "test" });
    expect(result).toEqual({ kind: "nothing-at-risk", worktreePath: repo });
    expect(backupRefs(repo)).toEqual([]);
  });

  test("snapshots tracked edits, deletions, staged and untracked files without touching the index, HEAD or working tree", async () => {
    writeFileSync(join(repo, "README.md"), "edited\n");
    rmSync(join(repo, "gone.txt"));
    writeFileSync(join(repo, "staged.txt"), "staged\n");
    git(repo, "add", "staged.txt");
    writeFileSync(join(repo, "new.txt"), "untracked\n");
    writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
    writeFileSync(join(repo, "ignored.log"), "noise\n");
    const indexBefore = hash(join(repo, ".git", "index"));
    const headBefore = git(repo, "rev-parse", "HEAD");
    const branchBefore = git(repo, "symbolic-ref", "HEAD");
    const statusBefore = git(repo, "status", "--porcelain");

    const result = expectSnapshotted(
      await snapshotter().snapshot({ cwd: repo, reason: "stalled agent 1a2b3c4d" }),
    );

    expect(hash(join(repo, ".git", "index"))).toBe(indexBefore);
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(repo, "symbolic-ref", "HEAD")).toBe(branchBefore);
    expect(git(repo, "status", "--porcelain")).toBe(statusBefore);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("edited\n");

    expect(result.ref).toBe(`refs/backup/${DATE}/${result.ref.split("/").pop()}`);
    expect(result.dirtyFiles).toBe(5);
    expect(result.unpushedCommits).toBe(0);
    expect(git(repo, "rev-parse", `${result.ref}^`)).toBe(headBefore);
    expect(git(repo, "show", `${result.ref}:README.md`)).toBe("edited");
    expect(git(repo, "show", `${result.ref}:staged.txt`)).toBe("staged");
    expect(git(repo, "show", `${result.ref}:new.txt`)).toBe("untracked");
    const files = git(repo, "ls-tree", "-r", "--name-only", result.ref).split("\n");
    expect(files).not.toContain("gone.txt");
    expect(files).not.toContain("ignored.log");
    expect(git(repo, "log", "-1", "--format=%B", result.ref)).toContain("stalled agent 1a2b3c4d");
  });

  test("a linked worktree's own index under the common dir is untouched", async () => {
    const worktree = join(root, "linked");
    git(repo, "worktree", "add", "-q", "-b", "feature", worktree, "main");
    writeFileSync(join(worktree, "README.md"), "wip\n");
    const index = join(repo, ".git", "worktrees", "linked", "index");
    const indexBefore = hash(index);
    const mainIndexBefore = hash(join(repo, ".git", "index"));

    const result = expectSnapshotted(
      await snapshotter().snapshot({ cwd: join(worktree), reason: "test", offsite: false }),
    );

    expect(result.worktreePath).toBe(worktree);
    expect(hash(index)).toBe(indexBefore);
    expect(hash(join(repo, ".git", "index"))).toBe(mainIndexBefore);
    expect(git(worktree, "symbolic-ref", "HEAD")).toBe("refs/heads/feature");
    expect(git(worktree, "show", `${result.ref}:README.md`)).toBe("wip");
  });

  test("resolves the worktree top level from a subdirectory", async () => {
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "a.ts"), "x\n");
    const result = expectSnapshotted(
      await snapshotter().snapshot({ cwd: join(repo, "src"), reason: "test", offsite: false }),
    );
    expect(result.worktreePath).toBe(repo);
    expect(git(repo, "show", `${result.ref}:src/a.ts`)).toBe("x");
  });

  test("leaves out and lists untracked files over the size cap", async () => {
    writeFileSync(join(repo, "big.bin"), Buffer.alloc(2048));
    writeFileSync(join(repo, "small.txt"), "small\n");
    const result = expectSnapshotted(
      await snapshotter({ maxUntrackedFileBytes: 1024 }).snapshot({
        cwd: repo,
        reason: "test",
        offsite: false,
      }),
    );
    expect(result.skippedFiles).toEqual(["big.bin"]);
    const files = git(repo, "ls-tree", "-r", "--name-only", result.ref).split("\n");
    expect(files).toContain("small.txt");
    expect(files).not.toContain("big.bin");
  });

  test("a clean tree with commits on no remote is at risk", async () => {
    commit(repo, "local.txt", "one\n");
    commit(repo, "local2.txt", "two\n");
    const result = expectSnapshotted(
      await snapshotter().snapshot({ cwd: repo, reason: "test", offsite: false }),
    );
    expect(result.dirtyFiles).toBe(0);
    expect(result.unpushedCommits).toBe(2);
    expect(git(repo, "rev-parse", `${result.ref}^`)).toBe(git(repo, "rev-parse", "HEAD"));
  });

  test("with no remotes every commit counts, and the snapshot is bundled", async () => {
    const local = join(root, "local");
    git(root, "init", "-q", "-b", "main", local);
    commit(local, "a.txt", "a\n");
    commit(local, "b.txt", "b\n");

    const result = expectSnapshotted(await snapshotter().snapshot({ cwd: local, reason: "test" }));

    expect(result.unpushedCommits).toBe(2);
    expect(result.offsite.kind).toBe("bundled");
    if (result.offsite.kind !== "bundled") return;
    expect(result.offsite.path.startsWith(bundleDir)).toBe(true);
    expect(git(local, "bundle", "list-heads", result.offsite.path)).toContain(result.ref);
  });

  test("snapshots a detached HEAD with HEAD as the parent", async () => {
    commit(repo, "local.txt", "one\n");
    git(repo, "checkout", "-q", "--detach", "HEAD");
    writeFileSync(join(repo, "README.md"), "detached wip\n");
    const head = git(repo, "rev-parse", "HEAD");

    const result = expectSnapshotted(
      await snapshotter().snapshot({ cwd: repo, reason: "test", offsite: false }),
    );

    expect(git(repo, "rev-parse", `${result.ref}^`)).toBe(head);
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(() => git(repo, "symbolic-ref", "-q", "HEAD")).toThrow();
  });

  test("snapshots an unborn branch as a commit with no parent", async () => {
    const unborn = join(root, "unborn");
    git(root, "init", "-q", "-b", "main", unborn);
    writeFileSync(join(unborn, "first.txt"), "first\n");

    const result = expectSnapshotted(
      await snapshotter().snapshot({ cwd: unborn, reason: "test", offsite: false }),
    );

    expect(result.dirtyFiles).toBe(1);
    expect(result.unpushedCommits).toBe(0);
    expect(git(unborn, "rev-list", "--parents", "-n", "1", result.ref).split(" ")).toHaveLength(1);
    expect(git(unborn, "show", `${result.ref}:first.txt`)).toBe("first");
    expect(() => git(unborn, "rev-parse", "--verify", "--quiet", "HEAD")).toThrow();
  });

  test("an unborn branch with nothing in it has nothing at risk", async () => {
    const empty = join(root, "empty");
    git(root, "init", "-q", "-b", "main", empty);
    const result = await snapshotter().snapshot({ cwd: empty, reason: "test" });
    expect(result.kind).toBe("nothing-at-risk");
  });

  test("a missing directory and a directory outside any repository fail without throwing", async () => {
    const missing = await snapshotter().snapshot({ cwd: join(root, "nope"), reason: "test" });
    expect(missing).toMatchObject({ kind: "failed", worktreePath: null });
    const plain = join(root, "plain");
    mkdirSync(plain);
    const outside = await snapshotter().snapshot({ cwd: plain, reason: "test" });
    expect(outside).toMatchObject({ kind: "failed", worktreePath: null });
  });

  test("an unchanged worktree reuses its newest snapshot instead of minting another", async () => {
    writeFileSync(join(repo, "README.md"), "edited\n");
    const first = expectSnapshotted(
      await snapshotter().snapshot({ cwd: repo, reason: "test", offsite: false }),
    );
    const second = expectSnapshotted(
      await snapshotter({ now: () => NOW + 60_000 }).snapshot({
        cwd: repo,
        reason: "test",
        offsite: false,
      }),
    );
    expect(second.ref).toBe(first.ref);
    expect(second.commit).toBe(first.commit);
    expect(backupRefs(repo)).toEqual([first.ref]);

    writeFileSync(join(repo, "README.md"), "edited again\n");
    const third = expectSnapshotted(
      await snapshotter({ now: () => NOW + 120_000 }).snapshot({
        cwd: repo,
        reason: "test",
        offsite: false,
      }),
    );
    expect(third.ref).not.toBe(first.ref);
    expect(backupRefs(repo).sort()).toEqual([first.ref, third.ref].sort());
    // The earlier snapshot is still where it was.
    expect(git(repo, "show", `${first.ref}:README.md`)).toBe("edited");

    // Back to the first content: the newest snapshot differs, so a new one is minted.
    writeFileSync(join(repo, "README.md"), "edited\n");
    const fourth = expectSnapshotted(
      await snapshotter({ now: () => NOW + 180_000 }).snapshot({
        cwd: repo,
        reason: "test",
        offsite: false,
      }),
    );
    expect(backupRefs(repo)).toHaveLength(3);
    expect(fourth.ref).not.toBe(first.ref);
  });

  test("a personal GitHub origin gets the snapshot as a backup branch, with hooks skipped and no tracking ref", async () => {
    writeFileSync(join(repo, "README.md"), "edited\n");
    const hook = join(repo, ".git", "hooks", "pre-push");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);

    const result = expectSnapshotted(await snapshotter().snapshot({ cwd: repo, reason: "test" }));

    const branch = `backup/${result.ref.slice("refs/backup/".length)}`;
    expect(result.offsite).toEqual({ kind: "pushed", remote: "origin", branch });
    expect(git(remote, "rev-parse", `refs/heads/${branch}`)).toBe(result.commit);
    expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/remotes/")).not.toContain(
      "backup",
    );
    expect(existsSync(bundleDir)).toBe(false);
  });

  test.each([
    ["a company forge", "https://git.wonderly.info/wonderlydotcom/x.git"],
    ["a company GitHub org", "https://github.com/wonderlydotcom/x.git"],
    ["an ssh company GitHub org", "git@github.com:wonderlydotcom/x.git"],
  ])("%s origin is bundled and never pushed", async (_label, url) => {
    git(repo, "remote", "set-url", "origin", url);
    git(repo, "config", `url.${remote}.insteadOf`, url);
    writeFileSync(join(repo, "README.md"), "edited\n");

    const result = expectSnapshotted(await snapshotter().snapshot({ cwd: repo, reason: "test" }));

    expect(result.offsite.kind).toBe("bundled");
    if (result.offsite.kind !== "bundled") return;
    expect(result.offsite.path.startsWith(bundleDir)).toBe(true);
    expect(git(repo, "bundle", "verify", "-q", result.offsite.path)).toBe("");
    expect(git(remote, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
  });

  test("a ssh personal GitHub origin is pushed", async () => {
    const url = "git@github.com:funkmastert/x.git";
    git(repo, "remote", "set-url", "origin", url);
    git(repo, "config", `url.${remote}.insteadOf`, url);
    writeFileSync(join(repo, "README.md"), "edited\n");
    const result = expectSnapshotted(await snapshotter().snapshot({ cwd: repo, reason: "test" }));
    expect(result.offsite.kind).toBe("pushed");
  });

  test("a failed push falls back to a bundle", async () => {
    git(repo, "config", "--unset", `url.${remote}.insteadOf`);
    git(
      repo,
      "config",
      "url.file:///nonexistent/x.git.insteadOf",
      "https://github.com/funkmastert/x.git",
    );
    writeFileSync(join(repo, "README.md"), "edited\n");
    const result = expectSnapshotted(await snapshotter().snapshot({ cwd: repo, reason: "test" }));
    expect(result.offsite.kind).toBe("bundled");
  });

  test("offsite: false keeps the snapshot local", async () => {
    writeFileSync(join(repo, "README.md"), "edited\n");
    const result = expectSnapshotted(
      await snapshotter().snapshot({ cwd: repo, reason: "test", offsite: false }),
    );
    expect(result.offsite.kind).toBe("none");
    expect(git(remote, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
  });

  test("assess reads the risk and writes nothing", async () => {
    commit(repo, "local.txt", "one\n");
    writeFileSync(join(repo, "README.md"), "edited\n");
    const assessment = await snapshotter().assess(repo);
    expect(assessment).toMatchObject({
      kind: "assessed",
      worktreePath: repo,
      branch: "main",
      dirtyFiles: 1,
      unpushedCommits: 1,
      atRisk: true,
    });
    expect(backupRefs(repo)).toEqual([]);
  });
});
