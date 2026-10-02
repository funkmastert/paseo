// node --test ops/disk-guard.test.mjs
// Runs disk-guard.mjs inside a sandbox: temp git repos, a temp cache root, Gradle home, XCTestDevices
// set and $TMPDIR, stub xcrun/report/notify commands, and faked free space. Never touches a real cache.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const GUARD = path.join(import.meta.dirname, "disk-guard.mjs");
// Scratch lives under ~/.cache on this machine, never /tmp.
const SCRATCH = path.join(os.homedir(), ".cache");
const H = 3600_000;
const sha = (p) => createHash("sha256").update(p).digest("hex");
const md5 = (s) => createHash("md5").update(s).digest("hex");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=someone@example.com", "-c", "user.name=t", ...args], { stdio: "pipe", encoding: "utf8" });
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const UDID = (n) => `${String(n).padStart(8, "0")}-AAAA-4BBB-8CCC-DDDDDDDDDDDD`;

function ago(p, ms) {
  const t = (Date.now() - ms) / 1000;
  if (lstatSync(p).isSymbolicLink()) lutimesSync(p, t, t);
  else utimesSync(p, t, t);
}

/** Set every mtime under dir (and dir) back by ms. */
function ageTree(dir, ms) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (lstatSync(p).isDirectory()) ageTree(p, ms);
    else ago(p, ms);
  }
  ago(dir, ms);
}

function writeExec(p, text) {
  writeFileSync(p, text);
  chmodSync(p, 0o755);
}

const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const WRAPPER = "distributionBase=GRADLE_USER_HOME\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-9.7.1-bin.zip\n";

function sandbox() {
  mkdirSync(SCRATCH, { recursive: true });
  const root = realpathSync(mkdtempSync(path.join(SCRATCH, "disk-guard-test-")));
  roots.push(root);
  const sb = {
    root,
    repoA: path.join(root, "repoA"),
    repoB: path.join(root, "repoB"),
    cache: path.join(root, "cache"),
    known: path.join(root, "known.json"),
    tmpdir: path.join(root, "tmp"),
    gradle: path.join(root, "gradle"),
    xctest: path.join(root, "xctest"),
    consumers: path.join(root, "consumers"),
    report: path.join(root, "report.mjs"),
    xcrun: path.join(root, "xcrun"),
    notify: path.join(root, "notify"),
  };
  for (const d of [sb.cache, sb.tmpdir, sb.gradle, sb.xctest, sb.consumers]) mkdirSync(d);
  for (const r of [sb.repoA, sb.repoB]) {
    mkdirSync(r);
    git(r, "init", "-q");
    git(r, "commit", "-q", "--allow-empty", "-m", "init");
  }
  mkdirSync(path.join(sb.repoA, "android/gradle/wrapper"), { recursive: true });
  writeFileSync(path.join(sb.repoA, "android/gradle/wrapper/gradle-wrapper.properties"), WRAPPER);
  git(sb.repoA, "add", ".");
  git(sb.repoA, "commit", "-q", "-m", "wrapper");
  writeFileSync(
    sb.report,
    `import { appendFileSync, existsSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(`${root}/report.calls`)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (existsSync(${JSON.stringify(`${root}/report.out`)})) process.stdout.write(readFileSync(${JSON.stringify(`${root}/report.out`)}, "utf8"));
if (existsSync(${JSON.stringify(`${root}/report.fail`)})) { console.error("daemon unreachable"); process.exit(1); }
`,
  );
  writeExec(
    sb.xcrun,
    `#!/bin/sh
echo "$*" >> "${root}/xcrun.calls"
if [ "$*" = "simctl list devices unavailable -j" ]; then
  if [ -f "${root}/simctl.json" ]; then cat "${root}/simctl.json"; else echo '{"devices":{}}'; fi
fi
`,
  );
  writeExec(sb.notify, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${root}/notify.calls"\n`);
  // The real ps, minus any real xcodebuild on this machine (an agent's test run), which would skip the clone rules.
  sb.ps = path.join(root, "ps");
  writeExec(sb.ps, `#!/bin/sh\nout=$(/bin/ps "$@") || exit $?\nprintf '%s\\n' "$out" | awk -v root="${root}" 'index($0, "xcodebuild") == 0 || index($0, root) > 0'\n`);
  sb.env = (extra = {}) => ({
    ...process.env,
    DISK_GUARD_CACHE: sb.cache,
    DISK_GUARD_REPOS: [sb.repoA, sb.repoB].join(":"),
    DISK_GUARD_KNOWN: sb.known,
    DISK_GUARD_TMPDIR: sb.tmpdir,
    DISK_GUARD_GRADLE_HOME: sb.gradle,
    DISK_GUARD_XCTEST_DEVICES: sb.xctest,
    DISK_GUARD_MOBILE_REPORT: sb.report,
    DISK_GUARD_XCRUN: sb.xcrun,
    DISK_GUARD_NOTIFY: sb.notify,
    DISK_GUARD_CONSUMER_ROOTS: sb.consumers,
    DISK_GUARD_FREE_GB: "100",
    DISK_GUARD_PS: sb.ps,
    ...extra,
  });
  sb.run = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [GUARD, ...args], { encoding: "utf8", env: sb.env(extra) });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return r.stdout;
  };
  sb.calls = (name) => read(path.join(root, `${name}.calls`));
  return sb;
}

function cacheDir(sb, hash, lease) {
  const dir = path.join(sb.cache, hash);
  mkdirSync(path.join(dir, "build"), { recursive: true });
  writeFileSync(path.join(dir, "build", "blob"), "x".repeat(4096));
  if (lease) addLease(dir, lease);
  return hash;
}

function addLease(dir, { ageMs, owner }) {
  mkdirSync(path.join(dir, "lease"));
  if (owner) writeFileSync(path.join(dir, "lease", "owner.json"), JSON.stringify({ schemaVersion: 1, wrapper: owner }));
  ago(path.join(dir, "lease"), ageMs);
}

/** A linked worktree of repoA whose git and cache have been idle for idleMs. */
function idleWorktree(sb, name, idleMs, { cacheAgeMs = idleMs } = {}) {
  const wt = path.join(sb.root, name);
  git(sb.repoA, "worktree", "add", "-q", wt);
  const gitdir = path.join(sb.repoA, ".git/worktrees", name);
  for (const f of ["index", "HEAD", "logs/HEAD"]) if (existsSync(path.join(gitdir, f))) ago(path.join(gitdir, f), idleMs);
  const h = cacheDir(sb, sha(wt));
  ageTree(path.join(sb.cache, h), cacheAgeMs);
  return { wt, h, dir: path.join(sb.cache, h) };
}

const myStart = () => execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8" }).trim().split(/\s+/).join(" ");
const decisionOf = (out, needle) =>
  out
    .split("\n")
    .find((l) => l.includes(needle))
    ?.split(" -> ")
    .at(-1);

async function withProcess(opts, fn) {
  const child = spawn(opts.cmd ?? process.execPath, opts.args ?? ["-e", "setInterval(() => {}, 1000)", "--", ...(opts.argv ?? [])], { cwd: opts.cwd, stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 400));
    return await fn(child);
  } finally {
    child.kill();
  }
}

// ---------------------------------------------------------------------------------------- arguments

test("a partial sandbox, an unknown flag, or --assume-free without --dry-run refuses to run", () => {
  const sb = sandbox();
  const partial = spawnSync(process.execPath, [GUARD, "--once"], { encoding: "utf8", env: { ...process.env, DISK_GUARD_CACHE: sb.cache } });
  assert.equal(partial.status, 2);
  assert.match(partial.stderr, /partial test sandbox .*DISK_GUARD_GRADLE_HOME/);
  const freeOnly = spawnSync(process.execPath, [GUARD, "--once"], { encoding: "utf8", env: { ...process.env, DISK_GUARD_FREE_GB: "10" } });
  assert.equal(freeOnly.status, 2);
  for (const args of [["--dryrun"], ["--assume-free=20"], ["--dry-run", "--assume-free=lots"]]) {
    const r = spawnSync(process.execPath, [GUARD, ...args], { encoding: "utf8", env: sb.env() });
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /bad arguments/);
  }
});

// ---------------------------------------------------- orphaned caches (the rules from before 2026-10-01)

const base = {};
test("orphans: setup", () => {
  const sb = sandbox();
  base.sb = sb;
  base.wt1 = path.join(sb.root, "wt1");
  base.wtGone = path.join(sb.root, "wt-gone");
  git(sb.repoA, "worktree", "add", "-q", base.wt1);
  git(sb.repoA, "worktree", "add", "-q", base.wtGone);
  base.ids = {
    liveA: cacheDir(sb, sha(sb.repoA)),
    liveWt1: cacheDir(sb, sha(base.wt1)),
    liveB: cacheDir(sb, sha(sb.repoB)),
    gone: cacheDir(sb, sha(base.wtGone)),
    orphan: cacheDir(sb, sha("/never/existed")),
    freshLease: cacheDir(sb, sha("/fresh/lease"), { ageMs: 10 * 60_000 }),
    liveOwner: cacheDir(sb, sha("/live/owner"), { ageMs: 3 * H, owner: { pid: process.pid, startIdentity: myStart(), command: "node" } }),
    reusedPid: cacheDir(sb, sha("/reused/pid"), { ageMs: 3 * H, owner: { pid: process.pid, startIdentity: "Thu Jan  1 00:00:00 1970", command: "x" } }),
    staleLease: cacheDir(sb, sha("/stale/lease"), { ageMs: 3 * H }),
  };
  mkdirSync(path.join(sb.cache, "not-a-hash"));
});

const present = () => new Set(readdirSync(base.sb.cache));

test("dry run reports every cache and deletes nothing", () => {
  const { sb, ids } = base;
  const snapshot = present();
  const out = sb.run(["--dry-run"]);
  assert.deepEqual(present(), snapshot);
  const decision = (h) => decisionOf(out, ` ${h.slice(0, 12)} -> `);
  for (const k of ["liveA", "liveWt1", "liveB", "gone"]) assert.equal(decision(ids[k]), "keep:live", k);
  assert.equal(decision(ids.freshLease), "keep:lease");
  assert.equal(decision(ids.liveOwner), "keep:lease");
  for (const k of ["orphan", "reusedPid", "staleLease"]) assert.equal(decision(ids[k]), "DELETE", k);
  assert.ok(!existsSync(sb.known), "a dry run writes no state");
});

test("a repo that fails to list stops every cache deletion", () => {
  const { sb } = base;
  const snapshot = present();
  const repos = [path.join(sb.root, "missing-repo"), sb.repoB].join(":");
  const out = sb.run(["--once"], { DISK_GUARD_REPOS: repos });
  assert.match(out, /could not list .*missing-repo.*deleting nothing this sweep/);
  assert.deepEqual(present(), snapshot);
  const dry = sb.run(["--dry-run"], { DISK_GUARD_REPOS: repos });
  const perCache = dry.split("\n").filter((l) => / [0-9a-f]{12} -> /.test(l));
  assert.equal(perCache.length, 9);
  assert.ok(perCache.every((l) => l.endsWith("skip:listing-incomplete")), dry);
  assert.deepEqual(present(), snapshot);
});

test("both repos failing stops every cache deletion, even when critical", () => {
  const { sb } = base;
  const snapshot = present();
  const out = sb.run(["--once"], { DISK_GUARD_REPOS: [path.join(sb.root, "nope1"), path.join(sb.root, "nope2")].join(":"), DISK_GUARD_FREE_GB: "10" });
  assert.match(out, /deleting nothing this sweep/);
  assert.deepEqual(present(), snapshot);
});

test("a real sweep removes exactly the orphans and logs each one", () => {
  const { sb, ids, wtGone } = base;
  const removedIn = (out) => out.split("\n").filter((l) => l.includes(" removed /"));
  // First sweep, while wt-gone still exists: removes the three plain orphans and records wt-gone's path.
  const first = sb.run(["--once"]);
  assert.equal(removedIn(first).length, 3, first);
  for (const k of ["orphan", "reusedPid", "staleLease"]) {
    assert.ok(removedIn(first).some((l) => l.includes(`removed ${path.join(sb.cache, ids[k])} | worktree unknown | `) && / \| freed [0-9.-]+ GB$/.test(l)), k);
  }
  assert.match(first, /4 live, 2 leased, 3 removed, 0 idle evicted/);
  assert.ok(present().has(ids.gone));

  rmSync(wtGone, { recursive: true, force: true });
  const second = sb.run(["--once"]);
  assert.equal(removedIn(second).length, 1, second);
  assert.match(removedIn(second)[0], new RegExp(`removed ${path.join(sb.cache, ids.gone)} \\| worktree ${wtGone} \\| [0-9.]+ GB \\| absent \\| freed `));
  assert.match(second, /3 live, 2 leased, 1 removed/);

  const left = present();
  for (const k of ["liveA", "liveWt1", "liveB", "freshLease", "liveOwner"]) assert.ok(left.has(ids[k]), k);
  for (const k of ["gone", "orphan", "reusedPid", "staleLease"]) assert.ok(!left.has(ids[k]), k);
  assert.ok(left.has("not-a-hash"));
});

// --------------------------------------------------------------------------------------- tmp builds

function tmpBuildDir(parent, name, { stale = false } = {}) {
  const dir = path.join(parent, name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "blob");
  writeFileSync(file, "x".repeat(4096));
  if (stale) ago(file, 7 * H);
  return dir;
}

test("a stale tmp build dir with no live process or open file is removed", () => {
  const sb = sandbox();
  const dir = tmpBuildDir(sb.tmpdir, "wonderly-ios-derived-abc123", { stale: true });
  const out = sb.run(["--once"]);
  assert.ok(!existsSync(dir));
  assert.match(out, /1 tmp builds, 1 removed/);
  assert.ok(out.split("\n").some((l) => l.includes(`removed ${dir} | `) && l.includes("| no file written in 6 h, no live process, no open file | freed")), out);
});

test("a fresh tmp build dir is kept", () => {
  const sb = sandbox();
  const dir = tmpBuildDir(sb.tmpdir, "wonderly-ios-packages-xyz");
  const out = sb.run(["--dry-run"]);
  assert.ok(existsSync(dir));
  assert.equal(decisionOf(out, `${dir} -> `), "keep:file written within 6 h");
});

test("a tmp build dir named in a running process's argv is kept", async () => {
  const sb = sandbox();
  const dir = tmpBuildDir(sb.tmpdir, "wonderly-ios-device-derived-live", { stale: true });
  await withProcess({ argv: [dir] }, () => {
    const out = sb.run(["--once"]);
    assert.ok(existsSync(dir));
    assert.match(out, /1 tmp builds, 0 removed/);
    assert.equal(decisionOf(sb.run(["--dry-run"]), `${dir} -> `), "keep:named in a running process");
  });
});

test("a tmp build dir with an open file is kept", () => {
  const sb = sandbox();
  const dir = tmpBuildDir(sb.tmpdir, "wonderly-ios-derived-openfile", { stale: true });
  const fd = openSync(path.join(dir, "blob"), "r");
  try {
    assert.equal(decisionOf(sb.run(["--dry-run"]), `${dir} -> `), "keep:open file in directory");
    sb.run(["--once"]);
    assert.ok(existsSync(dir));
  } finally {
    closeSync(fd);
  }
});

test("an unreadable tmp build dir is kept", () => {
  const sb = sandbox();
  const dir = tmpBuildDir(sb.tmpdir, "wonderly-ios-packages-locked", { stale: true });
  chmodSync(dir, 0o000);
  try {
    assert.match(decisionOf(sb.run(["--dry-run"]), `${dir} -> `), /^keep:unreadable:/);
    sb.run(["--once"]);
  } finally {
    chmodSync(dir, 0o755);
  }
  assert.ok(existsSync(dir));
});

// ------------------------------------------------------------------------------------------- Gradle

test("gradle build-cache-1: entries unused for 6 h go, everything else stays", () => {
  const sb = sandbox();
  const bc = path.join(sb.gradle, "caches/build-cache-1");
  mkdirSync(bc, { recursive: true });
  const stale = path.join(bc, md5("stale"));
  const fresh = path.join(bc, md5("fresh"));
  const hexDir = path.join(bc, md5("a dir"));
  const part = path.join(bc, `${md5("partial")}.part`);
  for (const f of [stale, fresh, part, path.join(bc, "build-cache-1.lock"), path.join(bc, "gc.properties")]) writeFileSync(f, "x".repeat(1000));
  mkdirSync(hexDir);
  for (const p of [stale, part, hexDir, path.join(bc, "build-cache-1.lock"), path.join(bc, "gc.properties")]) ago(p, 7 * H);
  const before = readdirSync(bc).sort();

  const dry = sb.run(["--dry-run"]);
  assert.match(dry, /gradle build-cache-1: 1 entries unused 6 h\+ \([0-9.]+ GB, oldest 7\.0 h\) -> DELETE; 1 used within 6 h -> keep/);
  assert.deepEqual(readdirSync(bc).sort(), before);

  const out = sb.run(["--gradle-only"]);
  assert.match(out, /removed 1 gradle build-cache-1 entries \| [0-9.]+ GB \| unused 6 h\+, oldest 7\.0 h \| freed /);
  assert.deepEqual(
    readdirSync(bc).sort(),
    before.filter((n) => n !== path.basename(stale)),
  );
});

function gradleVersions(sb) {
  const caches = path.join(sb.gradle, "caches");
  const dirs = {};
  for (const v of ["9.7.1", "8.0", "8.1", "7.6", "jars-9", "modules-2"]) {
    dirs[v] = path.join(caches, v);
    mkdirSync(path.join(dirs[v], "transforms"), { recursive: true });
    writeFileSync(path.join(dirs[v], "transforms", "blob"), "x".repeat(4096));
    ageTree(dirs[v], 8 * 24 * H);
  }
  writeFileSync(path.join(dirs["8.1"], "transforms", "new"), "fresh");
  return dirs;
}

test("gradle version dirs: only a version nothing live uses, unnamed and untouched for 7 d, goes", async () => {
  const sb = sandbox();
  const dirs = gradleVersions(sb);
  await withProcess({ argv: ["-cp", "/opt/gradle-7.6/lib/gradle-launcher.jar"] }, () => {
    const dry = sb.run(["--dry-run"]);
    const d = (v) => decisionOf(dry, `gradle ${dirs[v]} -> `);
    assert.match(d("9.7.1"), /^keep:wrapper .*repoA\/android\/gradle\/wrapper\/gradle-wrapper\.properties$/);
    assert.equal(d("8.0"), "DELETE");
    assert.equal(d("8.1"), "keep:file written within 7 d");
    assert.match(d("7.6"), /^keep:named by pid \d+$/);
    assert.equal(d("jars-9"), undefined);
    assert.equal(d("modules-2"), undefined);
    for (const p of Object.values(dirs)) assert.ok(existsSync(p));

    const out = sb.run(["--gradle-only"]);
    assert.match(out, new RegExp(`removed ${dirs["8.0"]} \\| [0-9.]+ GB \\| no live wrapper uses it, no process names it, nothing written in 7 d \\| freed `));
    for (const [v, p] of Object.entries(dirs)) assert.equal(existsSync(p), v !== "8.0", v);
  });
});

test("gradle version dirs: an incomplete wrapper set or a failed probe keeps every version", () => {
  const sb = sandbox();
  const dirs = gradleVersions(sb);
  const cases = [
    [{ DISK_GUARD_REPOS: [sb.repoA, path.join(sb.root, "missing")].join(":") }, /^keep:wrapper set unknown: could not list .*missing/],
    [{ DISK_GUARD_PS: "/usr/bin/false" }, /^keep:ps failed/],
    [{ DISK_GUARD_LSOF: "/usr/bin/false" }, /^keep:lsof failed/],
  ];
  for (const [extra, expected] of cases) {
    assert.match(decisionOf(sb.run(["--dry-run"], extra), `gradle ${dirs["8.0"]} -> `), expected);
    sb.run(["--gradle-only"], extra);
    assert.ok(existsSync(dirs["8.0"]), JSON.stringify(extra));
  }
  // A tracked wrapper without a readable distributionUrl makes the set unknown.
  mkdirSync(path.join(sb.repoB, "gradle/wrapper"), { recursive: true });
  writeFileSync(path.join(sb.repoB, "gradle/wrapper/gradle-wrapper.properties"), "distributionBase=GRADLE_USER_HOME\n");
  git(sb.repoB, "add", ".");
  git(sb.repoB, "commit", "-q", "-m", "broken wrapper");
  assert.match(decisionOf(sb.run(["--dry-run"]), `gradle ${dirs["8.0"]} -> `), /^keep:wrapper set unknown: no readable distributionUrl/);
  sb.run(["--gradle-only"]);
  assert.ok(existsSync(dirs["8.0"]));
});

test("gradle daemon logs older than 7 days go; other daemon files stay", () => {
  const sb = sandbox();
  const dir = path.join(sb.gradle, "daemon/9.7.1");
  mkdirSync(dir, { recursive: true });
  const files = ["daemon-123.out.log", "daemon-124.out.log", "registry.bin", "registry.bin.lock", "daemon-125.out.log.bak"];
  for (const f of files) writeFileSync(path.join(dir, f), "log");
  for (const f of ["daemon-123.out.log", "registry.bin", "registry.bin.lock", "daemon-125.out.log.bak"]) ago(path.join(dir, f), 8 * 24 * H);
  assert.match(sb.run(["--dry-run"]), /gradle daemon logs: 1 older than 7 d \([0-9.]+ GB\) -> DELETE; 1 newer -> keep/);
  assert.equal(readdirSync(dir).length, 5);
  assert.match(sb.run(["--gradle-only"]), /removed 1 gradle daemon logs \| [0-9.]+ GB \| older than 7 d/);
  assert.deepEqual(readdirSync(dir).sort(), files.filter((f) => f !== "daemon-123.out.log").sort());
});

// --------------------------------------------------------------------------------- tight / critical

function testClone(sb, n, { ageMs = 2 * 24 * H } = {}) {
  const dir = path.join(sb.xctest, UDID(n));
  mkdirSync(path.join(dir, "data/Library"), { recursive: true });
  writeFileSync(path.join(dir, "device.plist"), "<plist/>");
  writeFileSync(path.join(dir, "data/Library/blob"), "x".repeat(4096));
  if (ageMs) ageTree(dir, ageMs);
  return dir;
}

test("normal free space runs none of the tight rules", () => {
  const sb = sandbox();
  const clone = testClone(sb, 1);
  const idle = idleWorktree(sb, "wt-idle", 30 * H);
  const out = sb.run(["--once"], { DISK_GUARD_FREE_GB: "55" });
  assert.ok(existsSync(clone));
  assert.ok(existsSync(idle.dir));
  assert.equal(sb.calls("xcrun"), "");
  assert.equal(sb.calls("report"), "");
  assert.equal(sb.calls("notify"), "");
  assert.match(out, /1 live, 0 leased, 0 removed, 0 idle evicted/);
  assert.doesNotMatch(out, /tight|critical/);
});

test("tight: simulators, test clones, mobile worktrees, then idle caches, each by its own rule", async () => {
  const sb = sandbox();
  writeFileSync(
    path.join(sb.root, "simctl.json"),
    JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-0": [{ udid: UDID(90), name: "iPhone 15", isAvailable: false }],
        "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{ udid: UDID(91), name: "iPhone 17", isAvailable: true }],
      },
    }),
  );
  writeFileSync(path.join(sb.root, "report.out"), "remove   1.0G  wt-merged    b   clean, pushed or merged, quiet 50h\n\n1 removable, 1.0 GB; 3 kept\nremoved wt-merged\n");
  const clones = {
    old: testClone(sb, 1),
    fresh: testClone(sb, 2, { ageMs: 0 }),
    named: testClone(sb, 3),
  };
  const otherDir = path.join(sb.xctest, "device_set.plist.d");
  mkdirSync(otherDir);
  ageTree(otherDir, 3 * 24 * H);
  const outside = testClone({ xctest: sb.root }, 4);
  symlinkSync(outside, path.join(sb.xctest, UDID(5)));

  const w = {
    idle: idleWorktree(sb, "wt-idle", 30 * H),
    active: idleWorktree(sb, "wt-active", 2 * H, { cacheAgeMs: 30 * H }),
    cwd: idleWorktree(sb, "wt-cwd", 30 * H),
    argv: idleWorktree(sb, "wt-argv", 30 * H),
    lease: idleWorktree(sb, "wt-lease", 30 * H),
    written: idleWorktree(sb, "wt-written", 30 * H),
    eight: idleWorktree(sb, "wt-eight", 8 * H),
  };
  addLease(w.lease.dir, { ageMs: 10 * 60_000 });
  writeFileSync(path.join(w.written.dir, "build", "new"), "fresh");
  const primary = cacheDir(sb, sha(sb.repoA));
  ageTree(path.join(sb.cache, primary), 30 * H);

  await withProcess({ cwd: w.cwd.wt }, () =>
    withProcess({ argv: [`${w.argv.wt}/apps/mobile`, UDID(3)] }, () => {
      const dry = sb.run(["--dry-run"], { DISK_GUARD_FREE_GB: "40" });
      const c = (h) => decisionOf(dry, ` ${h.slice(0, 12)} -> `);
      assert.match(c(w.idle.h), /^DELETE \(idle 30\.0 h: no git activity, no process, no lease, no cache write\)$/);
      assert.match(c(w.active.h), /^keep:git active 2\.0 h ago$/);
      assert.match(c(w.cwd.h), /^keep:in use \(pid \d+ cwd\)$/);
      assert.match(c(w.argv.h), /^keep:in use \(pid \d+ argv\)$/);
      assert.equal(c(w.lease.h), "keep:lease");
      assert.equal(c(w.written.h), "keep:file written within 24.0 h");
      assert.match(c(w.eight.h), /^keep:git active 8\.0 h ago$/);
      assert.equal(c(primary), "keep:primary checkout");
      assert.equal(decisionOf(dry, `${clones.old} -> `), "DELETE");
      assert.match(decisionOf(dry, `${clones.fresh} -> `), /^keep:changed 0\.0 h ago$/);
      assert.match(decisionOf(dry, `${clones.named} -> `), /^keep:named by pid \d+$/);
      assert.equal(decisionOf(dry, `${path.join(sb.xctest, UDID(5))} -> `), "keep:not a directory");
      assert.match(dry, /simctl unavailable iPhone 15 00000090-\S+ \(iOS-17-0\) -> DELETE/);
      assert.doesNotMatch(dry, /iPhone 17/);
      assert.match(dry, /mobile worktrees: removed wt-merged/);
      assert.equal(sb.calls("xcrun"), "simctl list devices unavailable -j\n");
      assert.equal(sb.calls("report"), `[]\n`);
      assert.equal(sb.calls("notify"), "");

      const out = sb.run(["--once"], { DISK_GUARD_FREE_GB: "40" });
      assert.match(out, /40\.0 GB free: tight/);
      assert.equal(sb.calls("xcrun"), "simctl list devices unavailable -j\nsimctl list devices unavailable -j\nsimctl delete unavailable\n");
      assert.match(out, /removed 1 unavailable simulators \(simctl delete unavailable\) \| iPhone 15 /);
      assert.equal(sb.calls("report"), `[]\n["--apply"]\n`);
      assert.match(out, /mobile worktrees: removed wt-merged/);
      assert.doesNotMatch(out, /mobile worktrees: remove {3}/, "only removals and the total are logged on a real run");
      assert.ok(!existsSync(clones.old));
      assert.match(out, new RegExp(`removed ${clones.old} \\| du [0-9.]+ GB \\(clone, overstated\\) \\| no xcodebuild running, no process names it, nothing written in 1 d \\| freed `));
      for (const k of ["fresh", "named"]) assert.ok(existsSync(clones[k]), k);
      assert.ok(existsSync(otherDir));
      assert.ok(existsSync(outside), "a symlinked clone's target is never touched");
      assert.ok(!existsSync(w.idle.dir));
      assert.match(out, new RegExp(`removed ${w.idle.dir} \\| worktree ${w.idle.wt} \\| [0-9.]+ GB \\| tight: idle 30\\.0 h`));
      for (const k of ["active", "cwd", "argv", "lease", "written", "eight"]) assert.ok(existsSync(w[k].dir), k);
      assert.ok(existsSync(path.join(sb.cache, primary)));
      assert.ok(existsSync(w.idle.wt), "evicting a cache never touches the worktree");
      assert.match(out, /tight: 1 simulators, 1 test clones, 1 mobile worktrees removed/);
      assert.equal(sb.calls("notify"), "");
    }),
  );
});

test("tight: idle caches go oldest first and stop at the free-space target", () => {
  const sb = sandbox();
  const w30 = idleWorktree(sb, "wt-30", 30 * H);
  const w50 = idleWorktree(sb, "wt-50", 50 * H);
  const w40 = idleWorktree(sb, "wt-40", 40 * H);
  // Each removal adds 15 GB: 40 -> 55 -> 70, so two go and the target is met.
  const out = sb.run(["--once"], { DISK_GUARD_FREE_GB: "40", DISK_GUARD_FREE_STEP_GB: "15" });
  const removed = out.split("\n").filter((l) => l.includes(" removed /"));
  assert.equal(removed.length, 2, out);
  assert.ok(removed[0].includes(w50.dir) && removed[1].includes(w40.dir), out);
  assert.ok(existsSync(w30.dir));
  assert.match(out, /2 idle evicted/);
});

test("critical: the idle threshold drops to 6 h and the top consumers are named", () => {
  const sb = sandbox();
  const w8 = idleWorktree(sb, "wt-eight", 8 * H);
  const w2 = idleWorktree(sb, "wt-two", 2 * H);
  for (const [name, kb] of [["big", 900], ["middle", 300], ["small", 40]]) {
    mkdirSync(path.join(sb.consumers, name));
    writeFileSync(path.join(sb.consumers, name, "blob"), "x".repeat(kb * 1024));
  }
  testClone(sb, 7, { ageMs: 0 });

  const dry = sb.run(["--dry-run", "--assume-free=20"]);
  assert.match(decisionOf(dry, ` ${w8.h.slice(0, 12)} -> `), /^DELETE \(idle 8\.0 h/);
  assert.match(dry, /would notify: Bozeo: disk critical: 20 GB free after cleanup\. Top: .*big .*middle .*small/);
  assert.equal(sb.calls("notify"), "");
  assert.ok(existsSync(w8.dir));

  const out = sb.run(["--once"], { DISK_GUARD_FREE_GB: "20" });
  assert.match(out, /20\.0 GB free: critical/);
  assert.ok(!existsSync(w8.dir));
  assert.match(out, new RegExp(`removed ${w8.dir} \\| worktree ${w8.wt} \\| [0-9.]+ GB \\| critical: idle 8\\.0 h`));
  assert.ok(existsSync(w2.dir));
  const [title, body] = sb.calls("notify").split("\n");
  assert.equal(title, "Bozeo: disk critical");
  assert.match(body, /^20 GB free after cleanup\. Top: .*\/consumers\/big 0\.0 GB, .*\/consumers\/middle 0\.0 GB, .*\/consumers\/small 0\.0 GB$/);
  assert.match(out, /CRITICAL: .*clone sets \(du overstates, not sized\): .*xctest 1 devices/);
});

test("tight: a process probe that fails keeps every cache and clone, and skips simctl", () => {
  const sb = sandbox();
  const clone = testClone(sb, 1);
  const idle = idleWorktree(sb, "wt-idle", 30 * H);
  for (const probe of ["DISK_GUARD_PS", "DISK_GUARD_LSOF"]) {
    const extra = { [probe]: "/usr/bin/false", DISK_GUARD_FREE_GB: "20" };
    const dry = sb.run(["--dry-run"], extra);
    assert.match(decisionOf(dry, ` ${idle.h.slice(0, 12)} -> `), /^keep:(ps|lsof) failed/);
    const out = sb.run(["--once"], extra);
    assert.match(out, /XCTestDevices: skipped, (ps|lsof) failed/);
    assert.match(out, /simctl: skipped, (ps|lsof) failed/);
    assert.ok(existsSync(clone), probe);
    assert.ok(existsSync(idle.dir), probe);
  }
  assert.equal(sb.calls("xcrun"), "");
});

test("tight: a running xcodebuild stops the clone and simulator rules", async () => {
  const sb = sandbox();
  const clone = testClone(sb, 1);
  mkdirSync(path.join(sb.root, "bin"));
  writeExec(path.join(sb.root, "bin/xcodebuild"), "#!/bin/sh\nsleep 30\n");
  await withProcess({ cmd: path.join(sb.root, "bin/xcodebuild"), args: [] }, () => {
    const out = sb.run(["--once"], { DISK_GUARD_FREE_GB: "40" });
    assert.match(out, /XCTestDevices: skipped, xcodebuild pid \d+ is running/);
    assert.match(out, /simctl: skipped, xcodebuild pid \d+ is running/);
    assert.ok(existsSync(clone));
    assert.equal(sb.calls("xcrun"), "");
  });
});

test("tight: a failing mobile worktree report is logged and the sweep goes on", () => {
  const sb = sandbox();
  writeFileSync(path.join(sb.root, "report.fail"), "");
  const idle = idleWorktree(sb, "wt-idle", 30 * H);
  const out = sb.run(["--once"], { DISK_GUARD_FREE_GB: "40" });
  assert.match(out, /mobile worktrees: report failed: daemon unreachable/);
  assert.ok(!existsSync(idle.dir), "later rules still run");
  assert.match(out, /0 mobile worktrees removed/);
});

test("a dry run at an assumed free space never changes anything", () => {
  const sb = sandbox();
  writeFileSync(path.join(sb.root, "simctl.json"), JSON.stringify({ devices: { r: [{ udid: UDID(9), name: "old", isAvailable: false }] } }));
  const clone = testClone(sb, 1);
  const idle = idleWorktree(sb, "wt-idle", 30 * H);
  const orphan = cacheDir(sb, sha("/gone"));
  const bc = path.join(sb.gradle, "caches/build-cache-1");
  mkdirSync(bc, { recursive: true });
  writeFileSync(path.join(bc, md5("old")), "x");
  ago(path.join(bc, md5("old")), 7 * H);
  const out = sb.run(["--dry-run", "--assume-free=10"]);
  assert.match(out, /dry run: 10\.0 GB free: critical/);
  for (const p of [clone, idle.dir, path.join(sb.cache, orphan), path.join(bc, md5("old"))]) assert.ok(existsSync(p), p);
  assert.equal(sb.calls("xcrun"), "simctl list devices unavailable -j\n");
  assert.equal(sb.calls("report"), "[]\n");
  assert.equal(sb.calls("notify"), "");
  assert.ok(!existsSync(sb.known));
});
