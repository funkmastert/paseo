import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  canonicalJevPath,
  createJevGitRunner,
  JEV_FILE_MAX_BYTES,
  JevFileScope,
  isSecretShapedPath,
  jevGitEnv,
  readCallerDenials,
  SECRET_PATHSPEC_GLOBS,
  type JevFileAccessOptions,
} from "./jev-file-state.js";

let root: string;
let home: string;
let project: string;
let paseoHome: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, LC_ALL: "C" } });
}

function write(file: string, content: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

async function open(options: Partial<JevFileAccessOptions> = {}): Promise<JevFileScope> {
  const opened = await JevFileScope.open({ cwd: project, homeDir: home, paseoHome, ...options });
  if (!opened.ok) throw new Error(`scope refused: ${opened.reason}`);
  return opened.scope;
}

beforeEach(() => {
  // Scratch lives under ~/.cache, never /tmp (docs/jev.md tests run beside a live fleet).
  const cache = path.join(os.homedir(), ".cache");
  mkdirSync(cache, { recursive: true });
  root = mkdtempSync(path.join(cache, "jev-file-state-"));
  home = path.join(root, "home");
  project = path.join(home, "project");
  paseoHome = path.join(home, ".paseo");
  mkdirSync(project, { recursive: true });
  git(project, "init", "-q");
  write(path.join(project, ".gitignore"), "ignored.txt\nbuild-out/\n");
  write(path.join(project, "src", "a.ts"), "export const a = 1;\n");
  write(path.join(project, "src", "b.ts"), "export const b = 2;\n");
  write(path.join(project, "src", "nested", "c.ts"), "export const c = 3;\n");
  write(path.join(project, "README.md"), "# readme\n");
  write(path.join(project, "ignored.txt"), "ignored\n");
  write(path.join(project, "build-out", "x.js"), "x\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("opening a scope", () => {
  test("refuses $HOME, an ancestor of it, and the filesystem root", async () => {
    for (const cwd of [home, root, path.parse(root).root]) {
      const opened = await JevFileScope.open({ cwd, homeDir: home, paseoHome });
      expect(opened.ok).toBe(false);
      if (!opened.ok) expect(opened.reason).toMatch(/home directory/);
    }
  });

  test("refuses outright when Read is denied", async () => {
    const opened = await JevFileScope.open({
      cwd: project,
      homeDir: home,
      paseoHome,
      denials: { all: true, patterns: [] },
    });
    expect(opened).toEqual({
      ok: false,
      reason: expect.stringMatching(/denied tools include Read/),
    });
  });

  test("a missing cwd is refused", async () => {
    const opened = await JevFileScope.open({
      cwd: path.join(project, "gone"),
      homeDir: home,
      paseoHome,
    });
    expect(opened.ok).toBe(false);
  });
});

describe("prune", () => {
  test("keeps an ordinary file, relative to cwd", async () => {
    const scope = await open();
    const { files, skipped } = await scope.prune(["src/a.ts"], 10);
    expect(skipped).toEqual([]);
    expect(files.map((file) => file.path)).toEqual(["src/a.ts"]);
  });

  test("refuses paths outside cwd, directly and through a symlink", async () => {
    write(path.join(home, "outside.txt"), "secret-ish\n");
    symlinkSync(path.join(home, "outside.txt"), path.join(project, "link.txt"));
    const scope = await open();
    const { files, skipped } = await scope.prune(
      ["../outside.txt", path.join(home, "outside.txt"), "link.txt"],
      10,
    );
    expect(files).toEqual([]);
    expect(skipped.map((skip) => skip.reason)).toEqual([
      "outside your working directory",
      "outside your working directory",
      "outside your working directory",
    ]);
  });

  test("refuses a denied root even when it is inside cwd", async () => {
    const inside = path.join(home, ".config", "tool");
    mkdirSync(inside, { recursive: true });
    write(path.join(inside, "settings.ts"), "export {};\n");
    const opened = await JevFileScope.open({ cwd: inside, homeDir: home, paseoHome });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const { files, skipped } = await opened.scope.prune(["settings.ts"], 10);
    expect(files).toEqual([]);
    expect(skipped[0]?.reason).toMatch(/private directory/);
  });

  test("refuses every ~/.claude* directory and PASEO_HOME", async () => {
    const claude = path.join(home, ".claude-work", "proj");
    write(path.join(claude, "notes.md"), "notes\n");
    write(path.join(paseoHome, "state.md"), "state\n");
    for (const [cwd, file] of [
      [claude, "notes.md"],
      [paseoHome, "state.md"],
    ] as const) {
      const opened = await JevFileScope.open({ cwd, homeDir: home, paseoHome });
      if (!opened.ok) throw new Error(opened.reason);
      const { skipped } = await opened.scope.prune([file], 10);
      expect(skipped[0]?.reason).toMatch(/private directory/);
    }
  });

  test("refuses a named path git ignores", async () => {
    const scope = await open();
    const { files, skipped } = await scope.prune(["ignored.txt", "build-out/x.js"], 10);
    expect(files).toEqual([]);
    expect(skipped.map((skip) => skip.reason)).toEqual([
      "ignored by git; Read it if you need it",
      "ignored by git; Read it if you need it",
    ]);
  });

  test("skips secret-shaped, binary, lock, empty and oversized files with reasons", async () => {
    write(path.join(project, ".env"), "TOKEN=abc\n");
    write(path.join(project, "certs", "server.pem"), "pem\n");
    write(path.join(project, "logo.png"), "png\n");
    write(path.join(project, "package-lock.json"), "{}\n");
    write(path.join(project, "empty.ts"), "");
    write(path.join(project, "big.ts"), "x".repeat(JEV_FILE_MAX_BYTES + 1));
    const scope = await open();
    const { files, skipped } = await scope.prune(
      [".env", "certs/server.pem", "logo.png", "package-lock.json", "empty.ts", "big.ts"],
      10,
    );
    expect(files).toEqual([]);
    expect(skipped.map((skip) => skip.reason)).toEqual([
      expect.stringMatching(/secret-shaped/),
      expect.stringMatching(/secret-shaped/),
      "binary or lock file",
      "binary or lock file",
      "empty",
      expect.stringMatching(/^over 60,000 bytes/),
    ]);
  });

  test("a hard link to a file outside cwd is refused (L7)", async () => {
    write(path.join(home, "private.txt"), "private\n");
    linkSync(path.join(home, "private.txt"), path.join(project, "linked.txt"));
    const scope = await open();
    const { files, skipped } = await scope.prune(["linked.txt"], 10);
    expect(files).toEqual([]);
    expect(skipped[0]?.reason).toMatch(/hard link/);
  });

  test("a symlink onto a secret-shaped name is refused by its real name", async () => {
    write(path.join(project, ".env.local"), "TOKEN=abc\n");
    symlinkSync(path.join(project, ".env.local"), path.join(project, "harmless.txt"));
    const scope = await open();
    const { skipped } = await scope.prune(["harmless.txt"], 10);
    expect(skipped[0]?.reason).toMatch(/secret-shaped/);
  });

  test("honours the agent's own read rules", async () => {
    const scope = await open({
      denials: {
        all: false,
        patterns: ["./src/nested/**", "*.md", "//" + project.slice(1) + "/src/b.ts"],
      },
    });
    const { files, skipped } = await scope.prune(
      ["src/a.ts", "src/b.ts", "src/nested/c.ts", "README.md"],
      10,
    );
    expect(files.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(skipped.every((skip) => skip.reason === "your own read rules deny it")).toBe(true);
  });

  test("caps the list and names the rest", async () => {
    for (let i = 0; i < 5; i += 1)
      write(path.join(project, "many", `f${i}.ts`), `export const v${i} = ${i};\n`);
    const scope = await open();
    const names = Array.from({ length: 5 }, (_, i) => `many/f${i}.ts`);
    const { files, skipped } = await scope.prune(names, 3);
    expect(files).toHaveLength(3);
    expect(skipped).toEqual([
      { path: "many/f3.ts", reason: "over the 3 file cap; narrow the pattern" },
      { path: "many/f4.ts", reason: "over the 3 file cap; narrow the pattern" },
    ]);
  });
});

describe("read", () => {
  test("reads a pruned file", async () => {
    const scope = await open();
    const [ref] = (await scope.prune(["src/a.ts"], 1)).files;
    const read = await scope.read(ref!);
    expect(read).toMatchObject({ path: "src/a.ts", content: "export const a = 1;\n" });
  });

  test("refuses a file swapped for another between the check and the read", async () => {
    const scope = await open();
    const [ref] = (await scope.prune(["src/a.ts"], 1)).files;
    write(path.join(project, "src", "a.next"), "other\n");
    renameSync(path.join(project, "src", "a.next"), path.join(project, "src", "a.ts"));
    expect(await scope.read(ref!)).toEqual({
      path: "src/a.ts",
      reason: "changed while being read; Read it instead",
    });
  });

  test("refuses a file swapped for a symlink out of cwd", async () => {
    write(path.join(home, "private.txt"), "private\n");
    const scope = await open();
    const [ref] = (await scope.prune(["src/a.ts"], 1)).files;
    rmSync(path.join(project, "src", "a.ts"));
    symlinkSync(path.join(home, "private.txt"), path.join(project, "src", "a.ts"));
    expect(await scope.read(ref!)).toEqual({
      path: "src/a.ts",
      reason: "changed while being read; Read it instead",
    });
  });

  test("skips a file with a NUL byte as binary", async () => {
    write(path.join(project, "data.ts"), Buffer.from([0x61, 0x00, 0x62]));
    const scope = await open();
    const [ref] = (await scope.prune(["data.ts"], 1)).files;
    expect(await scope.read(ref!)).toEqual({ path: "data.ts", reason: "binary" });
  });
});

describe("expand", () => {
  test("globs expand over git's view: tracked and untracked, never ignored", async () => {
    git(project, "add", "src/a.ts");
    const scope = await open();
    const { paths } = await scope.expand(["**/*.ts", "**/*.js"], { recursive: false });
    expect(paths).toEqual(["src/a.ts", "src/b.ts", "src/nested/c.ts"]);
  });

  test("a directory means its files, or everything below it when recursive", async () => {
    const scope = await open();
    expect((await scope.expand(["src"], { recursive: false })).paths).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect((await scope.expand(["src/"], { recursive: true })).paths).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/nested/c.ts",
    ]);
  });

  test("a glob that leaves cwd is refused", async () => {
    const scope = await open();
    const { paths, skipped } = await scope.expand(["../**/*.ts", "/etc/*"], { recursive: false });
    expect(paths).toEqual([]);
    expect(skipped.map((skip) => skip.reason)).toEqual([
      "globs must be relative to your working directory",
      "globs must be relative to your working directory",
    ]);
  });

  test("outside git, the walk skips dot-directories and build output", async () => {
    const plain = path.join(home, "plain");
    write(path.join(plain, "keep.ts"), "k\n");
    write(path.join(plain, "node_modules", "dep.ts"), "d\n");
    write(path.join(plain, "dist", "out.ts"), "o\n");
    write(path.join(plain, ".cache", "hidden.ts"), "h\n");
    write(path.join(plain, "lib", "deep.ts"), "l\n");
    const opened = await JevFileScope.open({ cwd: plain, homeDir: home, paseoHome });
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.scope.gitTop).toBeNull();
    const { paths } = await opened.scope.expand(["**/*.ts"], { recursive: false });
    expect(paths).toEqual(["keep.ts", "lib/deep.ts"]);
  });
});

describe("caller denials", () => {
  test("reads the label, disallowed tools, permission rules and both denyRead lists", () => {
    const denials = readCallerDenials({
      toolsDeniedLabel: "Edit, Bash",
      providerOptions: {
        disallowedTools: ["Read(./secrets/**)"],
        sandbox: { filesystem: { denyRead: ["~/.ssh"] } },
        settings: {
          permissions: { deny: ["Read(*.pem)", "WebFetch"] },
          sandbox: { filesystem: { denyRead: ["/opt/private"] } },
        },
      },
    });
    expect(denials.bashDenied).toBe(true);
    expect(denials.read.all).toBe(false);
    expect(denials.read.patterns.sort()).toEqual(
      ["./secrets/**", "*.pem", "/opt/private", "~/.ssh"].sort(),
    );
  });

  test("a bare Read denies every read, and a scoped Bash rule refuses commands", () => {
    expect(
      readCallerDenials({ toolsDeniedLabel: "Read", providerOptions: undefined }).read.all,
    ).toBe(true);
    expect(
      readCallerDenials({
        toolsDeniedLabel: undefined,
        providerOptions: { disallowedTools: ["Bash(git push:*)"] },
      }).bashDenied,
    ).toBe(true);
  });
});

test("secret-shaped names", () => {
  for (const name of [
    ".env",
    "config/.env.production",
    "prod.env",
    "id_rsa.pub",
    "home/.docker/config.json",
    "credentials.json",
    "app/google-services.json",
    "keystore.properties",
  ]) {
    expect(isSecretShapedPath(name), name).toBe(true);
  }
  for (const name of ["src/env.ts", "config.json", "docs/credential-rotation.md", "keys.ts"]) {
    expect(isSecretShapedPath(name), name).toBe(false);
  }
});

test("secret-shaped names match in any case, and the list covers keys, state and package-manager credentials", () => {
  for (const name of [
    "Credentials.json",
    "certs/server.PEM",
    "cfg/.ENV",
    "ID_RSA",
    ".ssh/id_ecdsa",
    "id_ecdsa.pub",
    "id_ed25519",
    "id_dsa",
    "infra/terraform.tfstate",
    "infra/terraform.tfstate.backup",
    "bundle.P12",
    "cert.pfx",
    "tls.KEY",
    ".npmrc",
    ".netrc",
    ".pypirc",
    "KubeConfig",
    "app/.Docker/Config.json",
  ]) {
    expect(isSecretShapedPath(name), name).toBe(true);
  }
});

test("every secret-shaped name has a pathspec glob, so a diff leaves out what a read refuses", () => {
  // The pathspecs are matched by git, the name check by code: one list feeds both.
  for (const glob of SECRET_PATHSPEC_GLOBS) {
    const sample = glob.replace(/\*/g, "x");
    expect(isSecretShapedPath(sample), glob).toBe(true);
    expect(isSecretShapedPath(sample.toUpperCase()), glob).toBe(true);
  }
  const globs: readonly string[] = SECRET_PATHSPEC_GLOBS;
  for (const name of ["id_ecdsa*", "id_dsa*", "*.tfstate", ".pypirc"]) {
    expect(globs.includes(name), name).toBe(true);
  }
});

describe("canonical paths (macOS firmlinks and case)", () => {
  test.skipIf(process.platform !== "darwin")(
    "the /System/Volumes/Data spelling of home is still home, and still holds the denied roots",
    async () => {
      const firmlinked = (value: string) => `/System/Volumes/Data${value}`;
      const homeRefused = await JevFileScope.open({
        cwd: firmlinked(home),
        homeDir: home,
        paseoHome,
      });
      expect(homeRefused.ok).toBe(false);
      const caseRefused = await JevFileScope.open({
        cwd: home.toUpperCase(),
        homeDir: home,
        paseoHome,
      });
      expect(caseRefused.ok).toBe(false);

      write(path.join(home, ".config", "gh", "hosts.ts"), "export const token = 1;\n");
      const configDir = path.join(home, ".config", "gh");
      const opened = await JevFileScope.open({
        cwd: firmlinked(configDir),
        homeDir: home,
        paseoHome,
      });
      if (!opened.ok) throw new Error(opened.reason);
      const { files, skipped } = await opened.scope.prune(["hosts.ts"], 10);
      expect(files).toEqual([]);
      expect(skipped[0]?.reason).toMatch(/private directory/);
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "a firmlinked project cwd still works and is still confined",
    async () => {
      const opened = await JevFileScope.open({
        cwd: `/System/Volumes/Data${project}`,
        homeDir: home,
        paseoHome,
      });
      if (!opened.ok) throw new Error(opened.reason);
      const { files } = await opened.scope.prune(["src/a.ts", "../outside.txt"], 10);
      expect(files.map((file) => file.path)).toEqual(["src/a.ts"]);
    },
  );

  test("canonicalJevPath strips the data volume and folds case where the filesystem does", () => {
    expect(canonicalJevPath("/System/Volumes/Data/Users/x/Repo", "darwin")).toBe("/users/x/repo");
    expect(canonicalJevPath("/system/volumes/data", "darwin")).toBe("/");
    expect(canonicalJevPath("/System/Volumes/Data/Users/x", "linux")).toBe(
      "/System/Volumes/Data/Users/x",
    );
    expect(canonicalJevPath("C:\\Users\\X\\Repo", "win32")).toBe("c:\\users\\x\\repo");
  });
});

describe("Paseo worktrees", () => {
  test("the file tools read a worktree under $PASEO_HOME/worktrees and still refuse the rest of $PASEO_HOME", async () => {
    const worktree = path.join(paseoHome, "worktrees", "1rlfnz6g", "feature");
    mkdirSync(worktree, { recursive: true });
    git(worktree, "init", "-q");
    write(path.join(worktree, "src", "app.ts"), "export const app = 1;\n");
    write(path.join(paseoHome, "agents", "x.json"), '{"secret":true}\n');
    symlinkSync(path.join(paseoHome, "agents"), path.join(worktree, "agents-link"));

    const opened = await JevFileScope.open({ cwd: worktree, homeDir: home, paseoHome });
    if (!opened.ok) throw new Error(opened.reason);
    const { files, skipped } = await opened.scope.prune(["src/app.ts", "agents-link/x.json"], 10);
    expect(files.map((file) => file.path)).toEqual(["src/app.ts"]);
    expect(skipped).toEqual([
      { path: "agents-link/x.json", reason: "outside your working directory" },
    ]);
    expect(opened.scope.deniedReason(path.join(worktree, "src", "app.ts"))).toBeNull();
    expect(opened.scope.deniedReason(path.join(paseoHome, "agents", "x.json"))).toMatch(
      /private directory/,
    );

    const agentsDir = await JevFileScope.open({
      cwd: path.join(paseoHome, "agents"),
      homeDir: home,
      paseoHome,
    });
    if (!agentsDir.ok) throw new Error(agentsDir.reason);
    expect((await agentsDir.scope.prune(["x.json"], 10)).skipped[0]?.reason).toMatch(
      /private directory/,
    );
  });

  test("a configured worktrees root is the one carved out", async () => {
    const custom = path.join(paseoHome, "trees");
    const worktree = path.join(custom, "repo");
    mkdirSync(worktree, { recursive: true });
    write(path.join(worktree, "a.ts"), "export const a = 1;\n");
    const opened = await JevFileScope.open({
      cwd: worktree,
      homeDir: home,
      paseoHome,
      worktreesRoot: custom,
    });
    if (!opened.ok) throw new Error(opened.reason);
    expect((await opened.scope.prune(["a.ts"], 10)).files.map((file) => file.path)).toEqual([
      "a.ts",
    ]);
    const unconfigured = await JevFileScope.open({ cwd: worktree, homeDir: home, paseoHome });
    if (!unconfigured.ok) throw new Error(unconfigured.reason);
    expect((await unconfigured.scope.prune(["a.ts"], 10)).skipped[0]?.reason).toMatch(
      /private directory/,
    );
  });
});

describe("git never runs a program a repository's config names", () => {
  // Each case is a hostile `.git/config` (and `.gitattributes`) that points git at a program
  // which leaves a marker. The file tools' git calls (rev-parse, ls-files, check-ignore) must
  // run none of them.
  let markers: string;
  let program: string;

  beforeEach(() => {
    markers = path.join(root, "markers");
    mkdirSync(markers, { recursive: true });
    program = path.join(root, "hostile.sh");
    writeFileSync(program, `#!/bin/sh\ntouch '${markers}/'"$1"\nexit 1\n`, { mode: 0o755 });
  });

  function ran(): string[] {
    return readdirSync(markers).sort();
  }

  const HOSTILE: Array<[string, (repo: string, program: string, markers: string) => void]> = [
    ["core.fsmonitor", (repo, prog) => git(repo, "config", "core.fsmonitor", `${prog} fsmonitor`)],
    [
      "core.hooksPath",
      (repo, _prog, out) => {
        const hooks = path.join(repo, "..", "hostile-hooks");
        mkdirSync(hooks, { recursive: true });
        for (const hook of ["post-index-change", "post-checkout", "reference-transaction"]) {
          writeFileSync(path.join(hooks, hook), `#!/bin/sh\ntouch '${out}/${hook}'\n`, {
            mode: 0o755,
          });
        }
        git(repo, "config", "core.hooksPath", hooks);
      },
    ],
    [
      "filter and diff drivers",
      (repo, prog) => {
        write(path.join(repo, ".gitattributes"), "*.ts filter=evil diff=evil\n");
        git(repo, "config", "filter.evil.process", `${prog} filter-process`);
        git(repo, "config", "filter.evil.clean", `${prog} filter-clean`);
        git(repo, "config", "filter.evil.smudge", `${prog} filter-smudge`);
        git(repo, "config", "diff.evil.textconv", `${prog} textconv`);
        git(repo, "config", "diff.evil.command", `${prog} diff-command`);
        git(repo, "config", "diff.external", `${prog} diff-external`);
      },
    ],
    [
      "pager and credential helper",
      (repo, prog) => {
        git(repo, "config", "core.pager", `${prog} pager`);
        git(repo, "config", "credential.helper", `!${prog} credential`);
      },
    ],
  ];

  test.skipIf(process.platform === "win32").each(HOSTILE)("%s", async (_name, configure) => {
    configure(project, program, markers);
    const scope = await open();
    await scope.expand(["**/*.ts"], { recursive: false });
    await scope.prune(["src/a.ts", "src/b.ts", "ignored.txt"], 10);
    expect(ran()).toEqual([]);
  });

  test("a user's global excludesFile still decides what is ignored", async () => {
    const fakeHome = path.join(root, "git-home");
    mkdirSync(fakeHome, { recursive: true });
    const excludes = path.join(fakeHome, "global-ignore");
    writeFileSync(excludes, "notes.local.md\n");
    writeFileSync(path.join(fakeHome, ".gitconfig"), `[core]\n\texcludesFile = ${excludes}\n`);
    write(path.join(project, "notes.local.md"), "private notes\n");
    const runGit = createJevGitRunner({
      baseEnv: { PATH: process.env["PATH"], HOME: fakeHome, XDG_CONFIG_HOME: fakeHome },
    });
    const scope = await open({ runGit });
    const { files, skipped } = await scope.prune(["notes.local.md", "src/a.ts"], 10);
    expect(files.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(skipped).toEqual([
      { path: "notes.local.md", reason: "ignored by git; Read it if you need it" },
    ]);
  });

  test("git's environment drops inherited GIT_* variables and turns transports and lazy fetch off", () => {
    const env = jevGitEnv({
      GIT_DIR: "/elsewhere/.git",
      GIT_WORK_TREE: "/elsewhere",
      GIT_SSH_COMMAND: "touch /pwned",
      GIT_EXTERNAL_DIFF: "touch /pwned",
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='touch /pwned'",
      PATH: "/usr/bin",
      PASEO_JEV_API_KEY: "sk-test",
    });
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      LC_ALL: "C",
      GIT_NO_LAZY_FETCH: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(env["GIT_ALLOW_PROTOCOL"]).toBeDefined();
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_SSH_COMMAND",
      "GIT_EXTERNAL_DIFF",
      "GIT_CONFIG_PARAMETERS",
      "PASEO_JEV_API_KEY",
    ]) {
      expect(env[key], key).toBeUndefined();
    }
  });
});
