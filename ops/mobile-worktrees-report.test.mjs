// node --test ops/mobile-worktrees-report.test.mjs
// Runs mobile-worktrees-report.mjs against a temp repo with a bare remote and a temp worktree root,
// with the agent list from a file instead of the daemon. Uses the done janitor's safety check from
// the bozeo checkout's dist, as the report does.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const REPORT = path.join(import.meta.dirname, "mobile-worktrees-report.mjs");
const H = 3600_000;
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=someone@example.com", "-c", "user.name=t", ...args], { stdio: "pipe", encoding: "utf8" });

let root, repo, wts, agentsFile;

function worktree(name, { idleMs = 50 * H } = {}) {
  const wt = path.join(wts, name);
  git(repo, "worktree", "add", "-q", wt);
  const gitdir = path.join(repo, ".git/worktrees", name);
  const t = (Date.now() - idleMs) / 1000;
  for (const f of ["index", "HEAD", "logs/HEAD"]) if (existsSync(path.join(gitdir, f))) utimesSync(path.join(gitdir, f), t, t);
  return wt;
}

before(() => {
  mkdirSync(path.join(os.homedir(), ".cache"), { recursive: true });
  root = realpathSync(mkdtempSync(path.join(os.homedir(), ".cache", "mobile-report-test-")));
  repo = path.join(root, "repo");
  wts = path.join(root, "worktrees");
  mkdirSync(wts);
  execFileSync("git", ["init", "-q", "--bare", path.join(root, "origin.git")]);
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  git(repo, "remote", "add", "origin", path.join(root, "origin.git"));
  git(repo, "push", "-q", "origin", "HEAD:refs/heads/main");
  for (const name of ["wt-safe", "wt-cwd", "wt-argv", "wt-agent"]) worktree(name);
  worktree("wt-recent", { idleMs: 1 * H });
  const dirty = worktree("wt-dirty");
  writeFileSync(path.join(dirty, "notes.txt"), "wip");
  const unpushed = worktree("wt-unpushed");
  git(unpushed, "commit", "-q", "--allow-empty", "-m", "local only");
  const t = (Date.now() - 50 * H) / 1000;
  for (const f of ["index", "HEAD", "logs/HEAD"]) utimesSync(path.join(repo, ".git/worktrees/wt-unpushed", f), t, t);
  agentsFile = path.join(root, "agents.json");
  writeFileSync(
    agentsFile,
    JSON.stringify([
      { id: "a1", status: "idle", cwd: path.join(wts, "wt-agent") },
      { id: "a2", status: "closed", cwd: path.join(wts, "wt-safe") },
    ]),
  );
});

after(() => rmSync(root, { recursive: true, force: true }));

function report(args = [], extra = {}) {
  const r = spawnSync(process.execPath, [REPORT, ...args], {
    encoding: "utf8",
    env: { ...process.env, MOBILE_REPORT_ROOT: wts, MOBILE_REPORT_AGENTS: agentsFile, ...extra },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const verdict = (out, name) => {
  const line = out.split("\n").find((l) => l.includes(` ${name} `));
  return line && `${line.slice(0, 6).trim()}: ${line.trim().split(/\s{2,}/).at(-1)}`;
};

async function withProcess({ cwd, argv = [] }, fn) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...argv], { cwd, stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 400));
    return await fn();
  } finally {
    child.kill();
  }
}

test("only a pushed, clean, idle worktree nothing uses is removable", async () => {
  await withProcess({ cwd: path.join(wts, "wt-cwd") }, () =>
    withProcess({ argv: [`${path.join(wts, "wt-argv")}/apps/mobile`] }, () => {
      const out = report();
      assert.match(verdict(out, "wt-safe"), /^remove: clean, pushed or merged, quiet 50h$/);
      assert.match(verdict(out, "wt-cwd"), /^keep: in use \(pid \d+ cwd\)$/);
      assert.match(verdict(out, "wt-argv"), /^keep: in use \(pid \d+ argv\)$/);
      assert.equal(verdict(out, "wt-agent"), "keep: live agent inside");
      assert.equal(verdict(out, "wt-recent"), "keep: touched 1h ago");
      assert.match(verdict(out, "wt-dirty"), /^keep: it has 1 uncommitted or untracked file/);
      assert.match(verdict(out, "wt-unpushed"), /^keep: wt-unpushed has 1 commit\(s\) neither/);
      assert.match(out, /1 removable, /);
    }),
  );
});

test("a failed process probe keeps every worktree, even with --apply", () => {
  for (const probe of ["MOBILE_REPORT_PS", "MOBILE_REPORT_LSOF"]) {
    const out = report(["--apply"], { [probe]: "/usr/bin/false" });
    assert.equal(verdict(out, "wt-safe"), "keep: process probe failed");
    assert.match(out, /0 removable, /);
    assert.ok(existsSync(path.join(wts, "wt-safe")), probe);
  }
});

test("--apply removes the safe worktree and keeps its branch", async () => {
  await withProcess({ cwd: path.join(wts, "wt-cwd") }, () =>
    withProcess({ argv: [path.join(wts, "wt-argv")] }, () => {
      const out = report(["--apply"]);
      assert.match(out, /^removed wt-safe$/m);
      assert.ok(!existsSync(path.join(wts, "wt-safe")));
      assert.match(git(repo, "branch", "--list", "wt-safe"), /wt-safe/);
      for (const name of ["wt-cwd", "wt-argv", "wt-agent", "wt-recent", "wt-dirty", "wt-unpushed"]) assert.ok(existsSync(path.join(wts, name)), name);
    }),
  );
});
