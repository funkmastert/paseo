// node --test ops/disk-guard.test.mjs
// Runs disk-guard.mjs against temp git repos and a temp cache root. Never touches the real cache.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const GUARD = path.join(import.meta.dirname, "disk-guard.mjs");
const sha = (p) => createHash("sha256").update(p).digest("hex");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });

let root, repoA, repoB, wt1, wtGone, cache, known;

function run(args, repos = [repoA, repoB]) {
  const r = spawnSync(process.execPath, [GUARD, ...args], {
    encoding: "utf8",
    env: { ...process.env, DISK_GUARD_CACHE: cache, DISK_GUARD_REPOS: repos.join(":"), DISK_GUARD_KNOWN: known },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function cacheDir(hash, lease) {
  const dir = path.join(cache, hash);
  mkdirSync(path.join(dir, "build"), { recursive: true });
  writeFileSync(path.join(dir, "build", "blob"), "x".repeat(4096));
  if (lease) {
    mkdirSync(path.join(dir, "lease"));
    if (lease.owner) writeFileSync(path.join(dir, "lease", "owner.json"), JSON.stringify({ schemaVersion: 1, wrapper: lease.owner }));
    const t = (Date.now() - lease.ageMs) / 1000;
    utimesSync(path.join(dir, "lease"), t, t);
  }
  return hash;
}

const myStart = () => execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8" }).trim().split(/\s+/).join(" ");
const H = 3600_000;
let ids;

before(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "disk-guard-test-")));
  repoA = path.join(root, "repoA");
  repoB = path.join(root, "repoB");
  wt1 = path.join(root, "wt1");
  wtGone = path.join(root, "wt-gone");
  cache = path.join(root, "cache");
  known = path.join(root, "known.json");
  for (const r of [repoA, repoB]) {
    mkdirSync(r);
    git(r, "init", "-q");
    git(r, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  }
  git(repoA, "worktree", "add", "-q", wt1);
  git(repoA, "worktree", "add", "-q", wtGone);
  mkdirSync(cache);
  ids = {
    liveA: cacheDir(sha(repoA)),
    liveWt1: cacheDir(sha(wt1)),
    liveB: cacheDir(sha(repoB)),
    gone: cacheDir(sha(wtGone)),
    orphan: cacheDir(sha("/never/existed")),
    freshLease: cacheDir(sha("/fresh/lease"), { ageMs: 10 * 60_000 }),
    liveOwner: cacheDir(sha("/live/owner"), { ageMs: 3 * H, owner: { pid: process.pid, startIdentity: myStart(), command: "node" } }),
    reusedPid: cacheDir(sha("/reused/pid"), { ageMs: 3 * H, owner: { pid: process.pid, startIdentity: "Thu Jan  1 00:00:00 1970", command: "x" } }),
    staleLease: cacheDir(sha("/stale/lease"), { ageMs: 3 * H }),
  };
  mkdirSync(path.join(cache, "not-a-hash"));
});

after(() => rmSync(root, { recursive: true, force: true }));

const present = () => new Set(readdirSync(cache));

test("dry run reports every cache and deletes nothing", () => {
  const snapshot = present();
  const out = run(["--dry-run"]);
  assert.deepEqual(present(), snapshot);
  const decision = (h) => out.split("\n").find((l) => l.includes(` ${h.slice(0, 12)} -> `))?.split(" -> ").at(-1);
  assert.equal(decision(ids.liveA), "keep:live");
  assert.equal(decision(ids.liveWt1), "keep:live");
  assert.equal(decision(ids.liveB), "keep:live");
  assert.equal(decision(ids.gone), "keep:live");
  assert.equal(decision(ids.freshLease), "keep:lease");
  assert.equal(decision(ids.liveOwner), "keep:lease");
  assert.equal(decision(ids.orphan), "DELETE");
  assert.equal(decision(ids.reusedPid), "DELETE");
  assert.equal(decision(ids.staleLease), "DELETE");
  assert.ok(!existsSync(known), "a dry run writes no state");
});

test("a repo that fails to list stops every deletion", () => {
  const snapshot = present();
  const out = run(["--once"], [path.join(root, "missing-repo"), repoB]);
  assert.match(out, /could not list .*missing-repo.*deleting nothing this sweep/);
  assert.deepEqual(present(), snapshot);
  const dry = run(["--dry-run"], [path.join(root, "missing-repo"), repoB]);
  const perCache = dry.split("\n").filter((l) => / [0-9a-f]{12} -> /.test(l));
  assert.equal(perCache.length, 9);
  assert.ok(perCache.every((l) => l.endsWith("skip:listing-incomplete")), dry);
  assert.deepEqual(present(), snapshot);
});

test("both repos failing stops every deletion", () => {
  const snapshot = present();
  const out = run(["--once"], [path.join(root, "nope1"), path.join(root, "nope2")]);
  assert.match(out, /deleting nothing this sweep/);
  assert.deepEqual(present(), snapshot);
});

test("a real sweep removes exactly the orphans and logs each one", () => {
  const removedIn = (out) => out.split("\n").filter((l) => l.includes(" removed /"));
  // First sweep, while wt-gone still exists: removes the three plain orphans and records wt-gone's path.
  const first = run(["--once"]);
  assert.equal(removedIn(first).length, 3, first);
  for (const k of ["orphan", "reusedPid", "staleLease"]) {
    assert.ok(removedIn(first).some((l) => l.includes(`removed ${path.join(cache, ids[k])} | worktree unknown | `)), k);
  }
  assert.match(first, /4 live, 2 leased, 3 removed/);
  assert.ok(present().has(ids.gone));

  rmSync(wtGone, { recursive: true, force: true });
  const second = run(["--once"]);
  assert.equal(removedIn(second).length, 1, second);
  assert.match(removedIn(second)[0], new RegExp(`removed ${path.join(cache, ids.gone)} \\| worktree ${wtGone} \\| [0-9.]+ GB \\| absent$`));
  assert.match(second, /3 live, 2 leased, 1 removed/);

  const left = present();
  for (const k of ["liveA", "liveWt1", "liveB", "freshLease", "liveOwner"]) assert.ok(left.has(ids[k]), k);
  for (const k of ["gone", "orphan", "reusedPid", "staleLease"]) assert.ok(!left.has(ids[k]), k);
  assert.ok(left.has("not-a-hash"));
});
