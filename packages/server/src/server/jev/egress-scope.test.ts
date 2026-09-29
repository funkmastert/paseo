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

/** A git whose one repository is `top`, with `remoteOutput` as its `git config` answer. */
function fakeGit(top: string, remoteOutput: JevGitResult) {
  return async (args: string[]): Promise<JevGitResult> =>
    args.includes("rev-parse")
      ? { exitCode: 0, stdout: `${top}\n.git\n`, stderr: "" }
      : remoteOutput;
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
    ["https://github.com/wonderlydotcomx/y.git", null],
    ["git@github.com:someone/wonderlydotcom.git", null],
  ])("remote %s answers %s", async (url, signal) => {
    const top = dir("outside", "repo");
    const runGit = fakeGit(top, { exitCode: 0, stdout: `remote.origin.url ${url}\n`, stderr: "" });

    const verdict = await checker({ runGit }).check({ cwds: [top] }, COMPANY);

    expect(verdict).toEqual(signal === null ? NOT_EXCLUDED : excludedBy(signal));
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
      { exitCode: 3, stdout: "", stderr: "error: invalid config file" },
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
