import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  type EgressScopeDependencies,
  JevEgressScopeChecker,
  type JevExclusionConfig,
  type JevGitResult,
} from "./egress-scope.js";

// The docs/jev.md defaults. Roots by index: 0 ~/mobile-worktrees, 2 ~/backend-net, 4 ~/ts-monorepo*.
const COMPANY: JevExclusionConfig = {
  excludeCwds: [
    "~/mobile-worktrees",
    "~/.paseo/worktrees/1rlfnz6g",
    "~/backend-net",
    "~/bn-worktrees",
    "~/ts-monorepo*",
    "~/wonderly-orchestration",
  ],
  excludeRemotes: ["github.com/wonderlydotcom/", "git.wonderly.info/"],
  excludeTextMarkers: ["wonderlydotcom", "git.wonderly.info", "wonderly"],
};
const NOTHING: JevExclusionConfig = { excludeCwds: [], excludeRemotes: [], excludeTextMarkers: [] };
const REMOTES_ONLY: JevExclusionConfig = { ...COMPANY, excludeCwds: [], excludeTextMarkers: [] };
const MARKERS_ONLY: JevExclusionConfig = { ...COMPANY, excludeCwds: [], excludeRemotes: [] };
const ROOTS_ONLY: JevExclusionConfig = { ...COMPANY, excludeRemotes: [], excludeTextMarkers: [] };
const NOT_EXCLUDED = { excluded: false };

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) {
  delete GIT_ENV[name];
}

let tmp: string;
let home: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "init.defaultBranch=main", ...args], {
    cwd,
    env: GIT_ENV,
    stdio: "pipe",
  });
}

function dir(...segments: string[]): string {
  const path = join(tmp, ...segments);
  mkdirSync(path, { recursive: true });
  return path;
}

function makeRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q");
  git(path, "commit", "-q", "--allow-empty", "-m", "init");
  return path;
}

function checker(deps: Partial<EgressScopeDependencies> = {}): JevEgressScopeChecker {
  return new JevEgressScopeChecker({ homeDir: home, platform: "linux", ...deps });
}

function excludedBy(signal: string) {
  return { excluded: true, signal };
}

/** A git whose one repository is `top`, with `remoteOutput` as its `git remote -v` answer. */
function fakeGit(top: string, remoteOutput: JevGitResult) {
  return async (args: string[]): Promise<JevGitResult> =>
    args.includes("rev-parse")
      ? { exitCode: 0, stdout: `${top}\n.git\n`, stderr: "" }
      : remoteOutput;
}

/** `git remote -v` as git prints it for one remote with one URL. */
function remoteList(url: string, name = "origin"): JevGitResult {
  return { exitCode: 0, stdout: `${name}\t${url} (fetch)\n${name}\t${url} (push)\n`, stderr: "" };
}

const NOT_A_REPOSITORY: JevGitResult = {
  exitCode: 128,
  stdout: "",
  stderr: "fatal: not a git repository (or any of the parent directories): .git",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "jev-egress-"));
  home = dir("home");
  // The checker's own git must not read this machine's global or system config.
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe("check: paths", () => {
  test("a symlink from a safe directory into a root is excluded by its real path", async () => {
    const project = dir("home", "mobile-worktrees", "app");
    const link = join(dir("safe"), "link");
    symlinkSync(project, link, "junction");

    expect(await checker().check({ cwds: [link] }, COMPANY)).toEqual(excludedBy("cwd:0"));
  });

  test("a symlink from a root out to a safe place is excluded by its lexical path", async () => {
    const target = dir("safe", "target");
    writeFileSync(join(target, "notes.md"), "notes");
    symlinkSync(target, join(dir("home", "mobile-worktrees"), "out"), "junction");
    const file = join(home, "mobile-worktrees", "out", "notes.md");

    expect(await checker().check({ cwds: [], files: [file] }, COMPANY)).toEqual(
      excludedBy("cwd:0"),
    );
  });

  test("`../../mobile-worktrees/x` from a safe cwd is excluded", async () => {
    const scope = {
      cwds: [],
      files: ["../../mobile-worktrees/x"],
      baseCwd: dir("home", "safe", "sub"),
    };

    expect(await checker().check(scope, COMPANY)).toEqual(excludedBy("cwd:0"));
  });

  test("roots compare case-insensitively on darwin and case-sensitively on linux", async () => {
    const scope = { cwds: ["~/Mobile-Worktrees/app"] };

    expect(await checker({ platform: "darwin" }).check(scope, COMPANY)).toEqual(
      excludedBy("cwd:0"),
    );
    expect(await checker({ platform: "linux" }).check(scope, COMPANY)).toEqual(NOT_EXCLUDED);
  });

  test("roots match whole segments, and a trailing * matches siblings by prefix", async () => {
    const check = checker();

    expect(await check.check({ cwds: ["~/backend-net2"] }, COMPANY)).toEqual(NOT_EXCLUDED);
    expect(await check.check({ cwds: ["~/backend-net/src"] }, COMPANY)).toEqual(
      excludedBy("cwd:2"),
    );
    expect(await check.check({ cwds: ["~/ts-monorepo-2/x"] }, COMPANY)).toEqual(
      excludedBy("cwd:4"),
    );
    expect(await check.check({ cwds: ["~/ts-monorepo"] }, COMPANY)).toEqual(excludedBy("cwd:4"));
    expect(await check.check({ cwds: ["~/ts-mono"] }, COMPANY)).toEqual(NOT_EXCLUDED);
  });

  test("a bare * root matches the children of its parent, not the parent", async () => {
    const config = { ...NOTHING, excludeCwds: ["~/scratch/*"] };
    const check = checker();

    expect(await check.check({ cwds: ["~/scratch/a"] }, config)).toEqual(excludedBy("cwd:0"));
    expect(await check.check({ cwds: ["~/scratch"] }, config)).toEqual(NOT_EXCLUDED);
  });

  test("a nonexistent file under a root is excluded", async () => {
    dir("home", "mobile-worktrees");
    const scope = { cwds: [], files: ["~/mobile-worktrees/not/yet/there.ts"] };

    expect(await checker().check(scope, COMPANY)).toEqual(excludedBy("cwd:0"));
  });

  test("a relative path with no baseCwd is excluded", async () => {
    const check = checker();

    expect(await check.check({ cwds: [], files: ["src/index.ts"] }, COMPANY)).toEqual(
      excludedBy("relative-no-base"),
    );
    expect(await check.check({ cwds: ["src"] }, NOTHING)).toEqual(excludedBy("relative-no-base"));
  });

  test("a realpath error other than ENOENT excludes", async () => {
    const locked = dir("safe", "locked");
    const check = checker({
      realpath: async (p) => {
        if (p === locked) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        return realpath(p);
      },
    });

    expect(await check.check({ cwds: [locked] }, COMPANY)).toEqual(excludedBy("error"));
  });

  test("a relative root fails closed", async () => {
    const config = { ...NOTHING, excludeCwds: ["mobile-worktrees"] };

    expect(await checker().check({ cwds: [dir("safe")] }, config)).toEqual(excludedBy("error"));
  });

  test("on darwin a /System/Volumes/Data path matches the root under /Users it firmlinks to", async () => {
    const root = dir("home", "backend-net");
    const viaDataVolume = `/System/Volumes/Data${join(root, "app")}`;
    const config = { ...NOTHING, excludeCwds: [root] };
    const runGit = async () => NOT_A_REPOSITORY;

    expect(
      await checker({ platform: "darwin", runGit }).check({ cwds: [viaDataVolume] }, config),
    ).toEqual(excludedBy("cwd:0"));
    expect(
      await checker({ platform: "linux", runGit }).check({ cwds: [viaDataVolume] }, config),
    ).toEqual(NOT_EXCLUDED);
  });

  test("on darwin a root spelled through /System/Volumes/Data matches the /Users path", async () => {
    const root = dir("home", "backend-net");
    const config = { ...NOTHING, excludeCwds: [`/System/Volumes/Data${root}`] };
    const runGit = async () => NOT_A_REPOSITORY;

    expect(
      await checker({ platform: "darwin", runGit }).check({ cwds: [join(root, "app")] }, config),
    ).toEqual(excludedBy("cwd:0"));
  });

  test("a changed config is not answered from the roots cache", async () => {
    const check = checker();
    const scope = { cwds: ["~/b/x"] };

    expect(await check.check(scope, { ...NOTHING, excludeCwds: ["~/a"] })).toEqual(NOT_EXCLUDED);
    expect(await check.check(scope, { ...NOTHING, excludeCwds: ["~/a", "~/b"] })).toEqual(
      excludedBy("cwd:1"),
    );
  });
});

describe("check: git", () => {
  test("a worktree of a repository under a root, placed outside, is excluded by its common directory", async () => {
    const repo = makeRepo(join(home, "backend-net"));
    const worktree = join(dir("outside"), "wt");
    git(repo, "worktree", "add", "-q", worktree);

    expect(await checker().check({ cwds: [worktree] }, COMPANY)).toEqual(
      excludedBy("common-dir:2"),
    );
  });

  test("a relative common directory resolves against the directory git ran in", async () => {
    makeRepo(join(home, "backend-net"));
    const checkout = dir("outside", "checkout");
    symlinkSync(join(home, "backend-net", ".git"), join(checkout, ".git"), "junction");

    expect(await checker().check({ cwds: [dir("outside", "checkout", "src")] }, COMPANY)).toEqual(
      excludedBy("common-dir:2"),
    );
  });

  test("a clone outside a root with a company origin is excluded by its remote", async () => {
    const clone = makeRepo(join(dir("outside"), "clone"));
    git(clone, "remote", "add", "origin", "git@github.com:WonderlyDotCom/x.git");
    writeFileSync(join(clone, "README.md"), "readme");
    const check = checker();

    expect(await check.check({ cwds: [], files: [join(clone, "README.md")] }, COMPANY)).toEqual(
      excludedBy("remote:0"),
    );
    expect(await check.check({ cwds: [join(clone, "not", "yet")] }, COMPANY)).toEqual(
      excludedBy("remote:0"),
    );
  });

  test.each<[string, string | null]>([
    ["git@github.com:WonderlyDotCom/x.git", "remote:0"],
    ["https://user:token@GitHub.com/wonderlydotcom/x/", "remote:0"],
    ["ssh://git@git.wonderly.info:2222/team/mobile.git", "remote:1"],
    // An SSH host alias hides the host, not the owner: the owner part matches on any host.
    ["git@github-work:wonderlydotcom/mobile.git", "remote:0"],
    ["ssh://git@work-alias/WonderlyDotCom/mobile.git", "remote:0"],
    ["https://github.com/wonderlydotcomx/y.git", null],
    ["git@github.com:someone/wonderlydotcom.git", null],
    ["git@github-work:someone/mobile.git", null],
  ])("remote %s answers %s against excludeRemotes alone", async (url, signal) => {
    const top = dir("outside", "repo");
    const runGit = fakeGit(top, remoteList(url));

    const verdict = await checker({ runGit }).check({ cwds: [top] }, REMOTES_ONLY);

    expect(verdict).toEqual(signal === null ? NOT_EXCLUDED : excludedBy(signal));
  });

  test.each<[string, string | null]>([
    ["git@github.com:someone/wonderlydotcom.git", "remote-marker:0"],
    ["git@gitea-alias:team/wonderly-app.git", "remote-marker:2"],
    ["https://git.wonderly.info/team/x.git", "remote-marker:1"],
    ["git@github-work:someone/mobile.git", null],
  ])("remote %s answers %s against the text markers", async (url, signal) => {
    const top = dir("outside", "repo");
    const runGit = fakeGit(top, remoteList(url));

    const verdict = await checker({ runGit }).check({ cwds: [top] }, MARKERS_ONLY);

    expect(verdict).toEqual(signal === null ? NOT_EXCLUDED : excludedBy(signal));
  });

  test("a clone outside the roots whose origin uses an SSH host alias is excluded", async () => {
    const clone = makeRepo(join(dir("outside"), "alias-clone"));
    git(clone, "remote", "add", "origin", "git@github-work:wonderlydotcom/mobile.git");
    const check = checker();

    expect(await check.check({ cwds: [clone] }, REMOTES_ONLY)).toEqual(excludedBy("remote:0"));
    expect(await check.check({ cwds: [clone] }, MARKERS_ONLY)).toEqual(
      excludedBy("remote-marker:0"),
    );
  });

  test("a url.insteadOf remote is resolved the way git resolves it, from repo or global config", async () => {
    const local = makeRepo(join(dir("outside"), "insteadof-clone"));
    git(local, "config", "url.git@github.com:wonderlydotcom/.insteadOf", "wl:");
    git(local, "remote", "add", "origin", "wl:mobile.git");

    const global = makeRepo(join(dir("outside"), "global-insteadof-clone"));
    git(global, "remote", "add", "origin", "corp:mobile.git");
    const globalConfig = join(tmp, "gitconfig");
    writeFileSync(globalConfig, '[url "https://git.wonderly.info/team/"]\n\tinsteadOf = corp:\n');
    vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);

    const check = checker();
    expect(await check.check({ cwds: [local] }, REMOTES_ONLY)).toEqual(excludedBy("remote:0"));
    expect(await check.check({ cwds: [global] }, REMOTES_ONLY)).toEqual(excludedBy("remote:1"));
  });

  test("a push URL counts: pushurl and pushInsteadOf are resolved too", async () => {
    const pushurl = makeRepo(join(dir("outside"), "pushurl"));
    git(pushurl, "remote", "add", "origin", "https://github.com/someone/else.git");
    git(pushurl, "config", "remote.origin.pushurl", "git@github.com:wonderlydotcom/x.git");

    const pushInsteadOf = makeRepo(join(dir("outside"), "push-insteadof"));
    git(
      pushInsteadOf,
      "config",
      "url.git@github.com:wonderlydotcom/.pushInsteadOf",
      "https://mirror.example/",
    );
    git(pushInsteadOf, "remote", "add", "origin", "https://mirror.example/x.git");

    const check = checker();
    expect(await check.check({ cwds: [pushurl] }, REMOTES_ONLY)).toEqual(excludedBy("remote:0"));
    expect(await check.check({ cwds: [pushInsteadOf] }, REMOTES_ONLY)).toEqual(
      excludedBy("remote:0"),
    );
  });

  test("a clone of a repository under a root, cloned by path to outside, is excluded by its remote", async () => {
    const repo = makeRepo(join(home, "backend-net"));
    const clone = join(dir("outside"), "path-clone");
    git(tmp, "clone", "-q", repo, clone);

    expect(await checker().check({ cwds: [clone] }, ROOTS_ONLY)).toEqual(
      excludedBy("remote-cwd:2"),
    );
  });

  test("a relative path remote resolves against the repository's top level", async () => {
    makeRepo(join(home, "backend-net"));
    const top = dir("home", "scratch", "copy");
    const runGit = fakeGit(top, remoteList("../../backend-net"));

    expect(await checker({ runGit }).check({ cwds: [top] }, ROOTS_ONLY)).toEqual(
      excludedBy("remote-cwd:2"),
    );
  });

  test("a remote list git prints in a shape the checker cannot read is excluded", async () => {
    const top = dir("outside", "repo");
    const runGit = fakeGit(top, { exitCode: 0, stdout: "origin git@x:y.git\n", stderr: "" });

    expect(await checker({ runGit }).check({ cwds: [top] }, COMPANY)).toEqual(excludedBy("error"));
  });

  test.each<[string, JevGitResult, JevGitResult]>([
    [
      "rev-parse times out",
      { exitCode: null, stdout: "", stderr: "", timedOut: true },
      { exitCode: 1, stdout: "", stderr: "" },
    ],
    [
      "rev-parse fails for another reason",
      { exitCode: 128, stdout: "", stderr: "fatal: detected dubious ownership in repository" },
      { exitCode: 1, stdout: "", stderr: "" },
    ],
    [
      "git cannot be spawned",
      { exitCode: null, stdout: "", stderr: "spawn git ENOENT" },
      { exitCode: 1, stdout: "", stderr: "" },
    ],
    [
      "reading the remotes fails",
      { exitCode: 0, stdout: "TOP\n.git\n", stderr: "" },
      { exitCode: 128, stdout: "", stderr: "fatal: bad config line 1" },
    ],
  ])("excludes when %s", async (_case, revParse, config) => {
    const top = dir("outside", "repo");
    const runGit = async (args: string[]): Promise<JevGitResult> => {
      if (!args.includes("rev-parse")) return config;
      return { ...revParse, stdout: revParse.stdout.replace("TOP", top) };
    };

    expect(await checker({ runGit }).check({ cwds: [top] }, COMPANY)).toEqual(excludedBy("error"));
  });

  test("git answers are cached for five minutes per directory", async () => {
    const safe = dir("safe");
    const calls: string[][] = [];
    let now = 1_000_000;
    const check = checker({
      now: () => now,
      runGit: async (args) => {
        calls.push(args);
        return { exitCode: 128, stdout: "", stderr: "fatal: not a git repository" };
      },
    });

    await check.check({ cwds: [safe] }, COMPANY);
    now += 5 * 60_000 - 1;
    await check.check({ cwds: [safe] }, COMPANY);
    expect(calls).toHaveLength(1);

    now += 1;
    await check.check({ cwds: [safe] }, COMPANY);
    expect(calls).toHaveLength(2);
  });
});

describe("check: scope and agents", () => {
  test("a scope the caller could not name is excluded", async () => {
    expect(await checker().check({ cwds: [], missing: true }, NOTHING)).toEqual(
      excludedBy("missing"),
    );
  });

  test("agent ids resolving to a cwd under a root are excluded", async () => {
    const requested: string[][] = [];
    const check = checker({
      resolveAgentCwds: async (ids) => {
        requested.push(ids);
        return [dir("safe"), join(home, "mobile-worktrees", "app")];
      },
    });

    expect(await check.check({ cwds: [], agentIds: ["leader"] }, COMPANY)).toEqual(
      excludedBy("cwd:0"),
    );
    expect(requested).toEqual([["leader"]]);
  });

  test("an agent the daemon cannot resolve is excluded", async () => {
    const scope = { cwds: [], agentIds: ["gone"] };

    expect(await checker({ resolveAgentCwds: async () => null }).check(scope, COMPANY)).toEqual(
      excludedBy("agent-unknown"),
    );
    const throwing = checker({
      resolveAgentCwds: async () => {
        throw new Error("agent store unavailable");
      },
    });
    expect(await throwing.check(scope, COMPANY)).toEqual(excludedBy("error"));
    expect(await checker().check(scope, COMPANY)).toEqual(excludedBy("error"));
  });

  test("a safe scope with no hits is not excluded", async () => {
    const safeClone = makeRepo(join(dir("safe"), "clone"));
    git(safeClone, "remote", "add", "origin", "https://github.com/someone/else.git");
    const noRemotes = makeRepo(join(dir("safe"), "local"));
    const scope = {
      cwds: [dir("safe", "scratch")],
      files: ["clone/src/index.ts", join(noRemotes, "README.md")],
      baseCwd: join(tmp, "safe"),
      agentIds: ["worker"],
    };
    const check = checker({ resolveAgentCwds: async () => [join(safeClone, "src")] });

    expect(await check.check(scope, COMPANY)).toEqual(NOT_EXCLUDED);
  });

  test("empty config lists exclude nothing", async () => {
    const clone = makeRepo(join(dir("outside"), "clone"));
    git(clone, "remote", "add", "origin", "git@github.com:WonderlyDotCom/x.git");
    const scope = { cwds: ["~/mobile-worktrees", clone] };

    expect(await checker().check(scope, NOTHING)).toEqual(NOT_EXCLUDED);
  });
});

describe("check: deadline and abort", () => {
  test("each git gets only the time left before the deadline", async () => {
    const top = dir("outside", "repo");
    let now = 1_000_000;
    const timeouts: number[] = [];
    const check = checker({
      now: () => now,
      runGit: async (args, options) => {
        timeouts.push(options.timeoutMs);
        if (args.includes("rev-parse")) {
          now += 1_000;
          return { exitCode: 0, stdout: `${top}\n.git\n`, stderr: "" };
        }
        now += options.timeoutMs;
        return { exitCode: null, stdout: "", stderr: "", timedOut: true };
      },
    });

    const verdict = await check.check({ cwds: [top] }, COMPANY, { deadlineAt: now + 1_500 });

    expect(timeouts).toEqual([1_500, 500]);
    expect(verdict).toEqual(excludedBy("deadline"));
  });

  test("no git is spawned once the deadline has passed", async () => {
    const top = dir("outside", "repo");
    let now = 1_000_000;
    const calls: string[][] = [];
    const check = checker({
      now: () => now,
      runGit: async (args) => {
        calls.push(args);
        now += 2_000;
        return { exitCode: 0, stdout: `${top}\n.git\n`, stderr: "" };
      },
    });

    const verdict = await check.check({ cwds: [top] }, COMPANY, { deadlineAt: now + 1_500 });

    expect(calls).toHaveLength(1);
    expect(verdict).toEqual(excludedBy("deadline"));
  });

  test("a slow git with a 1.5 s deadline answers near 1.5 s, not 4 s", async () => {
    const top = dir("outside", "repo");
    // Each call takes 2 s, the old per-call timeout, unless its timeout kills it sooner.
    const runGit = async (
      args: string[],
      options: { timeoutMs: number },
    ): Promise<JevGitResult> => {
      await sleep(Math.min(2_000, options.timeoutMs));
      if (options.timeoutMs < 2_000)
        return { exitCode: null, stdout: "", stderr: "", timedOut: true };
      return args.includes("rev-parse")
        ? { exitCode: 0, stdout: `${top}\n.git\n`, stderr: "" }
        : remoteList("https://github.com/someone/else.git");
    };
    const started = Date.now();

    const verdict = await checker({ runGit }).check({ cwds: [top] }, COMPANY, {
      deadlineAt: started + 1_500,
    });

    const elapsed = Date.now() - started;
    expect(verdict).toEqual(excludedBy("deadline"));
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(1_900);
  });

  test("a slow step that is not git still answers by the deadline", async () => {
    const check = checker({ resolveAgentCwds: () => new Promise<string[]>(() => {}) });
    const started = Date.now();

    const verdict = await check.check({ cwds: [], agentIds: ["leader"] }, COMPANY, {
      deadlineAt: started + 100,
    });

    expect(verdict).toEqual(excludedBy("deadline"));
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("an abort stops the check at once and hands git the signal", async () => {
    const top = dir("outside", "repo");
    const controller = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const runGit = async (
      _args: string[],
      options: { timeoutMs: number; signal?: AbortSignal },
    ) => {
      signals.push(options.signal);
      await sleep(2_000);
      return { exitCode: 0, stdout: `${top}\n.git\n`, stderr: "" };
    };
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();

    const verdict = await checker({ runGit }).check({ cwds: [top] }, COMPANY, {
      signal: controller.signal,
    });

    expect(verdict).toEqual(excludedBy("aborted"));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(signals).toEqual([controller.signal]);
  });

  test("an already aborted signal, a spent deadline or a deadline that is not a number spawns no git", async () => {
    const top = dir("outside", "repo");
    const calls: string[][] = [];
    const check = checker({
      runGit: async (args) => {
        calls.push(args);
        return NOT_A_REPOSITORY;
      },
    });

    expect(await check.check({ cwds: [top] }, COMPANY, { signal: AbortSignal.abort() })).toEqual(
      excludedBy("aborted"),
    );
    expect(await check.check({ cwds: [top] }, COMPANY, { deadlineAt: Date.now() - 1 })).toEqual(
      excludedBy("deadline"),
    );
    expect(await check.check({ cwds: [top] }, COMPANY, { deadlineAt: Number.NaN })).toEqual(
      excludedBy("deadline"),
    );
    expect(calls).toEqual([]);
  });

  test("the real git runs normally inside a generous deadline and a live signal", async () => {
    const clone = makeRepo(join(dir("outside"), "clone"));
    git(clone, "remote", "add", "origin", "git@github-work:wonderlydotcom/mobile.git");
    const options = { deadlineAt: Date.now() + 10_000, signal: new AbortController().signal };

    expect(await checker().check({ cwds: [clone] }, REMOTES_ONLY, options)).toEqual(
      excludedBy("remote:0"),
    );
  });
});

describe("scanText", () => {
  function body(state: unknown, criteriaTrue = "yes"): string {
    return JSON.stringify({
      state,
      questions: {
        risky: { type: "noul", instructions: "Is it risky?", criteria: { true: criteriaTrue } },
      },
    });
  }

  test("a marker inside a question's criteria excludes, case-insensitively", () => {
    const text = body("plain state", "Touches WonderlyDotCom code");

    expect(checker().scanText(text, COMPANY)).toEqual(excludedBy("marker:0"));
  });

  test("a root in ~ form or absolute form excludes", () => {
    const check = checker();

    expect(check.scanText(body("cd ~/mobile-worktrees/app"), COMPANY)).toEqual(
      excludedBy("text-root:0"),
    );
    expect(check.scanText(body(`cat ${home}/Mobile-Worktrees/app/x.kt`), COMPANY)).toEqual(
      excludedBy("text-root:0"),
    );
    expect(check.scanText(body("ls ~/ts-monorepo-2/src"), COMPANY)).toEqual(
      excludedBy("text-root:4"),
    );
  });

  test("an absolute root under home also matches its ~ form, as redaction writes it", () => {
    const config = { ...NOTHING, excludeCwds: [join(home, "work")] };

    expect(checker().scanText(body("cd ~/work/x"), config)).toEqual(excludedBy("text-root:0"));
  });

  test("a JSON-escaped Windows path excludes", () => {
    const check = checker({ homeDir: "C:\\Users\\Tyler", platform: "win32" });

    expect(
      check.scanText(body({ cwd: "C:\\Users\\Tyler\\mobile-worktrees\\app" }), COMPANY),
    ).toEqual(excludedBy("text-root:0"));
  });

  test("a remote excludes in URL and scp form", () => {
    const config = { ...COMPANY, excludeTextMarkers: [] };
    const check = checker();

    expect(check.scanText(body("https://github.com/WonderlyDotCom/x"), config)).toEqual(
      excludedBy("text-remote:0"),
    );
    expect(check.scanText(body("git@github.com:WonderlyDotCom/x.git"), config)).toEqual(
      excludedBy("text-remote:0"),
    );
  });

  describe("path spellings in shell text", () => {
    const TYLER = "/Users/tyler";
    // Markers and remotes off, so each hit names the root it came from.
    const ROOTS = { ...COMPANY, excludeRemotes: [], excludeTextMarkers: [] };

    test.each<[string, string]>([
      ["cd $HOME/backend-net && git log -p", "text-root:2"],
      ["cd ${HOME}/mobile-worktrees/app && ./gradlew test", "text-root:0"],
      ["git -C ../backend-net diff", "text-root:2"],
      ["ls /Users/$USER/ts-monorepo/apps/web", "text-root:4"],
      ["ls /Users/${USER}/bn-worktrees/x", "text-root:3"],
      ["cat ~/bn-worktrees/x/README.md", "text-root:3"],
      ["cat ~tyler/wonderly-orchestration/plan.md", "text-root:5"],
      ["cd ts-monorepo-2 && pnpm test", "text-root:4"],
      ["cd .paseo/worktrees/1rlfnz6g/fix-login", "text-root:1"],
      ["cd /System/Volumes/Data/Users/tyler/backend-net", "text-root:2"],
    ])("%s is excluded as %s", (command, signal) => {
      const check = checker({ homeDir: TYLER, platform: "darwin" });

      expect(check.scanText(body(command), ROOTS)).toEqual(excludedBy(signal));
    });

    test.each<[string, string]>([
      ["cd %USERPROFILE%\\code\\x", "win32"],
      ["cd $env:USERPROFILE\\code", "win32"],
      ["dir C:\\Users\\%USERNAME%\\code", "win32"],
      ["cd $HOME/code", "win32"],
      ["cat ~tyler/code/x", "darwin"],
      ["cat /Users/${USER}/code/x", "darwin"],
    ])("%s names the generic root ~/code on %s", (command, platform) => {
      const homeDir = platform === "win32" ? "C:\\Users\\Tyler" : TYLER;
      const check = checker({ homeDir, platform: platform as NodeJS.Platform });
      const config = { ...NOTHING, excludeCwds: ["~/code"] };

      expect(check.scanText(body(command), config)).toEqual(excludedBy("text-root:0"));
    });

    test("a generic root name is not a needle, but every spelling of its path is", () => {
      const config = { ...NOTHING, excludeCwds: ["~/code", "~/src/app", "~/.config", "~/work/*"] };
      const check = checker({ homeDir: TYLER });

      expect(check.scanText(body("cd ../code && git -C app diff"), config)).toEqual(NOT_EXCLUDED);
      expect(check.scanText(body("vim webpack.config.js; cd work"), config)).toEqual(NOT_EXCLUDED);
      expect(check.scanText(body("cd $HOME/code/x"), config)).toEqual(excludedBy("text-root:0"));
      expect(check.scanText(body("cd ${HOME}/src/app"), config)).toEqual(excludedBy("text-root:1"));
      expect(check.scanText(body("cat /Users/$USER/.config/x"), config)).toEqual(
        excludedBy("text-root:2"),
      );
      expect(check.scanText(body("ls $HOME/work/a"), config)).toEqual(excludedBy("text-root:3"));
    });

    test("an absolute root outside home is matched by its path and a distinctive name", () => {
      const config = { ...NOTHING, excludeCwds: ["/opt/acme-billing", "/opt/company"] };
      const check = checker({ homeDir: TYLER });

      expect(check.scanText(body("cd ../acme-billing"), config)).toEqual(excludedBy("text-root:0"));
      expect(check.scanText(body("ls /opt/company/x"), config)).toEqual(excludedBy("text-root:1"));
      expect(check.scanText(body("the company picnic"), config)).toEqual(NOT_EXCLUDED);
    });
  });

  test("safe text is not excluded", () => {
    expect(checker().scanText(body("cd ~/paseo && npm test"), COMPANY)).toEqual(NOT_EXCLUDED);
  });

  test("empty config lists exclude nothing", () => {
    const text = body("wonderly ~/mobile-worktrees github.com/wonderlydotcom/x");

    expect(checker().scanText(text, NOTHING)).toEqual(NOT_EXCLUDED);
  });

  test("a relative root fails closed", () => {
    const config = { ...NOTHING, excludeCwds: ["mobile-worktrees"] };

    expect(checker().scanText(body("safe"), config)).toEqual(excludedBy("error"));
  });
});

describe("check: concurrent checks share git", () => {
  test("a burst of checks in one cold directory runs each git command once", async () => {
    const top = dir("outside", "burst");
    const calls: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remote = fakeGit(top, remoteList("git@github.com:someone/app.git"));
    const runGit = async (args: string[]): Promise<JevGitResult> => {
      calls.push(args.includes("rev-parse") ? "rev-parse" : "remote");
      await gate;
      return remote(args);
    };
    const scopeChecker = checker({ runGit });
    const verdicts = Array.from({ length: 8 }, () =>
      scopeChecker.check({ cwds: [top] }, REMOTES_ONLY),
    );
    await sleep(10);
    release();
    expect(await Promise.all(verdicts)).toEqual(Array.from({ length: 8 }, () => NOT_EXCLUDED));
    expect(calls).toEqual(["rev-parse", "remote"]);
  });

  test("a shared load that fails is not cached; the next check runs git again", async () => {
    const top = dir("outside", "flaky");
    let runs = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runGit = async (args: string[]): Promise<JevGitResult> => {
      runs += 1;
      if (runs === 1) {
        await gate;
        return { exitCode: 1, stdout: "", stderr: "boom" };
      }
      return fakeGit(top, remoteList("git@github.com:someone/app.git"))(args);
    };
    const scopeChecker = checker({ runGit });
    const both = Promise.all([
      scopeChecker.check({ cwds: [top] }, REMOTES_ONLY),
      scopeChecker.check({ cwds: [top] }, REMOTES_ONLY),
    ]);
    await sleep(10);
    release();
    expect(await both).toEqual([excludedBy("error"), excludedBy("error")]);
    expect(runs).toBe(1);
    expect(await scopeChecker.check({ cwds: [top] }, REMOTES_ONLY)).toEqual(NOT_EXCLUDED);
  });
});
