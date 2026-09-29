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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { WorktreeSnapshotResult } from "../remediation/contract.js";
import { lookupGitHubRepoVisibility, type RepoVisibility } from "./github-repo-visibility.js";
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
  overrides: {
    personalOwners?: string[];
    maxUntrackedFileBytes?: number;
    now?: () => number;
    lookupRepoVisibility?: (owner: string, repo: string) => Promise<RepoVisibility>;
  } = {},
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
    // Never the network: tests say what GitHub would answer.
    lookupRepoVisibility: overrides.lookupRepoVisibility ?? (async () => "private"),
  });
}

// Fake tokens assembled at runtime, so no secret scanner flags this file.
const FAKE_TOKENS = [
  ["a Notion token", "ntn_" + "x".repeat(46)],
  ["an Anthropic key", ["sk", "ant", "api03"].join("-") + "-" + "y".repeat(40)],
  ["a GitHub token", ["ghp", "z".repeat(36)].join("_")],
  ["a private key", ["-----BEGIN", "OPENSSH", "PRIVATE", "KEY-----"].join(" ")],
] as const;

function writeRepoFile(name: string, content: string, mode = 0o644): void {
  writeFileSync(join(repo, name), content);
  chmodSync(join(repo, name), mode);
}

function snapshotFiles(ref: string): string[] {
  return git(repo, "ls-tree", "-r", "--name-only", ref).split("\n");
}

function snapshotMessage(ref: string): string {
  return git(repo, "log", "-1", "--format=%B", ref);
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

describe("GitWorktreeSnapshotter leaves likely secrets out of the untracked set", () => {
  async function localSnapshot() {
    return expectSnapshotted(
      await snapshotter().snapshot({ cwd: repo, reason: "test", offsite: false }),
    );
  }

  test("an owner-only file is left out, named in the message, and left on disk untouched", async () => {
    writeRepoFile("notes.txt", "private notes\n", 0o600);
    writeRepoFile("ordinary.txt", "ordinary\n");

    const result = await localSnapshot();

    expect(snapshotFiles(result.ref)).toContain("ordinary.txt");
    expect(snapshotFiles(result.ref)).not.toContain("notes.txt");
    expect(snapshotMessage(result.ref)).toContain(
      "Not snapshotted: possible secret (left on disk): notes.txt",
    );
    expect(readFileSync(join(repo, "notes.txt"), "utf8")).toBe("private notes\n");
    expect(statSync(join(repo, "notes.txt")).mode & 0o777).toBe(0o600);
    // The size-cap list stays the size-cap list.
    expect(result.skippedFiles).toEqual([]);
  });

  test(".env and .env.* are left out; .env.example, .env.sample and .env.template are kept", async () => {
    writeRepoFile(".env", "A=1\n");
    writeRepoFile(".env.local", "A=1\n");
    writeRepoFile(".env.example", "A=\n");
    writeRepoFile(".env.sample", "A=\n");
    writeRepoFile(".env.template", "A=\n");

    const result = await localSnapshot();

    const files = snapshotFiles(result.ref);
    expect(files).not.toContain(".env");
    expect(files).not.toContain(".env.local");
    expect(files).toEqual(expect.arrayContaining([".env.example", ".env.sample", ".env.template"]));
    expect(snapshotMessage(result.ref)).toContain(
      "Not snapshotted: possible secret (left on disk): .env, .env.local",
    );
  });

  test.each([
    ".notion-secret",
    "client_secret.json",
    "aws-credentials",
    "server.pem",
    "tls.key",
    "cert.p12",
    "id_ed25519",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "release.keystore",
  ])("a readable file named %s is left out", async (name) => {
    writeRepoFile(name, "nothing secret-looking inside\n");
    writeRepoFile("ordinary.txt", "ordinary\n");

    const result = await localSnapshot();

    expect(snapshotFiles(result.ref)).not.toContain(name);
    expect(snapshotFiles(result.ref)).toContain("ordinary.txt");
    expect(snapshotMessage(result.ref)).toContain(name);
  });

  test.each(FAKE_TOKENS)(
    "an ordinary file holding %s is left out, and the token never reaches the message",
    async (_label, token) => {
      mkdirSync(join(repo, "config"));
      writeRepoFile("config/settings.json", `{\n  "key": "${token}"\n}\n`);
      writeRepoFile("ordinary.txt", "ordinary\n");

      const result = await localSnapshot();

      expect(snapshotFiles(result.ref)).not.toContain("config/settings.json");
      expect(snapshotFiles(result.ref)).toContain("ordinary.txt");
      const message = snapshotMessage(result.ref);
      expect(message).toContain("config/settings.json");
      expect(message).not.toContain(token);
    },
  );

  test("an ordinary file is kept, including one whose words only look like a token prefix", async () => {
    writeRepoFile(
      "plan.md",
      `Run task-${"a".repeat(30)} next; see the disk-${"b".repeat(30)} log.\n`,
    );

    const result = await localSnapshot();

    expect(snapshotFiles(result.ref)).toContain("plan.md");
    expect(snapshotMessage(result.ref)).not.toContain("possible secret");
  });
});

describe("GitWorktreeSnapshotter pushes only to a repository GitHub says is private", () => {
  test("a public personal repository is bundled, never pushed", async () => {
    writeFileSync(join(repo, "README.md"), "edited\n");
    const result = expectSnapshotted(
      await snapshotter({ lookupRepoVisibility: async () => "public" }).snapshot({
        cwd: repo,
        reason: "test",
      }),
    );
    expect(result.offsite.kind).toBe("bundled");
    expect(git(remote, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
  });

  test("a private personal repository is pushed, after asking about owner and repository", async () => {
    writeFileSync(join(repo, "README.md"), "edited\n");
    const lookup = vi.fn(async (): Promise<RepoVisibility> => "private");
    const result = expectSnapshotted(
      await snapshotter({ lookupRepoVisibility: lookup }).snapshot({ cwd: repo, reason: "test" }),
    );
    expect(result.offsite.kind).toBe("pushed");
    expect(lookup).toHaveBeenCalledWith("funkmastert", "x");
  });

  test("an unknown visibility is bundled", async () => {
    writeFileSync(join(repo, "README.md"), "edited\n");
    const result = expectSnapshotted(
      await snapshotter({ lookupRepoVisibility: async () => "unknown" }).snapshot({
        cwd: repo,
        reason: "test",
      }),
    );
    expect(result.offsite.kind).toBe("bundled");
    expect(git(remote, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
  });

  test("a company origin is never looked up", async () => {
    const url = "https://github.com/wonderlydotcom/x.git";
    git(repo, "remote", "set-url", "origin", url);
    git(repo, "config", `url.${remote}.insteadOf`, url);
    writeFileSync(join(repo, "README.md"), "edited\n");
    const lookup = vi.fn(async (): Promise<RepoVisibility> => "private");
    const result = expectSnapshotted(
      await snapshotter({ lookupRepoVisibility: lookup }).snapshot({ cwd: repo, reason: "test" }),
    );
    expect(result.offsite.kind).toBe("bundled");
    expect(lookup).not.toHaveBeenCalled();
  });

  test("an answer is cached per repository for an hour; an unknown one is not cached", async () => {
    let now = NOW;
    const answers: RepoVisibility[] = ["unknown", "private", "public"];
    const lookup = vi.fn(async (): Promise<RepoVisibility> => answers.shift() ?? "public");
    const instance = snapshotter({ now: () => now, lookupRepoVisibility: lookup });
    const snapshotEdit = async (content: string) => {
      writeFileSync(join(repo, "README.md"), content);
      return expectSnapshotted(await instance.snapshot({ cwd: repo, reason: "test" }));
    };

    expect((await snapshotEdit("one\n")).offsite.kind).toBe("bundled");
    expect((await snapshotEdit("two\n")).offsite.kind).toBe("pushed");
    now += 30 * 60_000;
    expect((await snapshotEdit("three\n")).offsite.kind).toBe("pushed");
    expect(lookup).toHaveBeenCalledTimes(2);

    now += 31 * 60_000;
    expect((await snapshotEdit("four\n")).offsite.kind).toBe("bundled");
    expect(lookup).toHaveBeenCalledTimes(3);
  });
});

describe("lookupGitHubRepoVisibility", () => {
  const notCalled = async (): Promise<Response> => {
    throw new Error("fetch should not be called");
  };

  test("gh answers first", async () => {
    await expect(
      lookupGitHubRepoVisibility("o", "r", { runGh: async () => "true\n", fetch: notCalled }),
    ).resolves.toBe("private");
    await expect(
      lookupGitHubRepoVisibility("o", "r", { runGh: async () => "false\n", fetch: notCalled }),
    ).resolves.toBe("public");
  });

  test.each([
    ["gh is missing", async () => null],
    [
      "gh fails",
      async () => {
        throw new Error("gh: not logged in");
      },
    ],
  ] as const)("when %s, the anonymous API decides", async (_label, runGh) => {
    const respond = (status: number, body: unknown) => async () =>
      new Response(JSON.stringify(body), { status });
    await expect(
      lookupGitHubRepoVisibility("o", "r", { runGh, fetch: respond(404, {}) }),
    ).resolves.toBe("private");
    await expect(
      lookupGitHubRepoVisibility("o", "r", { runGh, fetch: respond(200, { private: false }) }),
    ).resolves.toBe("public");
    await expect(
      lookupGitHubRepoVisibility("o", "r", { runGh, fetch: respond(200, { private: true }) }),
    ).resolves.toBe("private");
    await expect(
      lookupGitHubRepoVisibility("o", "r", { runGh, fetch: respond(403, {}) }),
    ).resolves.toBe("unknown");
    await expect(
      lookupGitHubRepoVisibility("o", "r", { runGh, fetch: respond(200, {}) }),
    ).resolves.toBe("unknown");
    await expect(
      lookupGitHubRepoVisibility("o", "r", {
        runGh,
        fetch: async () => {
          throw new Error("timeout");
        },
      }),
    ).resolves.toBe("unknown");
  });

  test("an owner or repository name GitHub could not have is unknown without asking", async () => {
    const runGh = vi.fn(async () => "false\n");
    await expect(
      lookupGitHubRepoVisibility("o", "r/../../x", { runGh, fetch: notCalled }),
    ).resolves.toBe("unknown");
    expect(runGh).not.toHaveBeenCalled();
  });
});
