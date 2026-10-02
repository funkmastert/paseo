// Disk guard: deterministic cleanup of the disk sinks the daemon's disk rung can't see.
// Every sweep:
//  1. Gradle. build-cache-1 entries unused for 6 h (Gradle marks an entry used by touching its mtime;
//     a miss only rebuilds, and an open file survives unlink). caches/<version> dirs that no tracked
//     gradle-wrapper.properties in any live mobile worktree names, no running process names, and that
//     have no file written in 7 days; skipped whenever the wrapper set can't be read completely.
//     daemon/*/daemon-<pid>.out.log older than 7 days. Builds pushed ~/.gradle/caches/build-cache-1 to
//     53 GB in one day on 2026-10-01; Gradle's own cleanup waits 7 days.
//  2. WonderlyMobileCore per-worktree build caches whose worktree no longer exists. The mobile repo's
//     scripts/mobilecore-xcode.sh names each ~/Library/Caches/WonderlyMobileCore/worktrees/
//     <sha256(pwd -P of the worktree)> and never removes it; 168 GB piled up by 2026-09-25.
//     Fails closed: if any repo in MOBILE_REPOS can't be listed, the sweep deletes no cache, because
//     a partial listing makes every cache of the missing repo look orphaned.
//     A cache is kept while its lease dir was touched in the last 2 hours, or while its owner.json
//     names a process that is still running (pid and start time both match, so a reused pid doesn't count).
//  3. Wonderly iOS build dirs in $TMPDIR (`wonderly-ios-derived-*`, `wonderly-ios-packages-*`,
//     `wonderly-ios-device-derived-*`), 0.5-2.5 GiB each, removed only when no file inside was written
//     in the last 6 h, no running process's command line names the dir, and lsof finds no open file in it.
// Below TIGHT_GB free ("tight") a sweep also runs, cheapest to redo first:
//  4. `xcrun simctl delete unavailable`, unless xcodebuild runs.
//  5. ~/Library/Developer/XCTestDevices clones (canonical UDID dirs) unchanged for a day, that no
//     process names, while no xcodebuild runs at all.
//  6. Orphaned caches as in 2, then WonderlyMobileCore caches of live worktrees idle 24 h (no git
//     activity, no process with the worktree or the cache in argv or cwd, no live lease, no cache
//     file written), oldest first, until free space reaches TARGET_GB. Primary checkouts are never
//     evicted.
//  7. Only if still under TARGET_GB, at most hourly: mobile-worktrees-report.mjs --apply removes
//     ~/mobile-worktrees checkouts that are pushed or merged, clean, idle 48 h and not in use. Last,
//     because a removed worktree also loses its ignored local config. Branches are kept. Their
//     caches go as orphans next sweep.
// Below CRITICAL_GB ("critical") step 6's idle threshold drops to 6 h, and a sweep that ends still
// critical sends one macOS notification per 6 hours naming the top 5 consumers. The daemon has no push
// an ops script can call, so it is a local notification.
// Fails closed everywhere: a probe that can't answer keeps the item; a listing that can't be
// completed skips its rule. Every removal is logged on its own line with its size and reason
// (build-cache entries and daemon logs as one line per sweep: thousands of small files). du bills
// APFS clones in full, so removals also log `freed`, the change in free space they made.
// Worktree reclaim for Paseo worktrees is the daemon's job (disk rung 1 and the done janitor).
//
//   node disk-guard.mjs              the LaunchAgent loop (sh.bozeo.disk-guard): every 30 min, every 10 while tight
//   node disk-guard.mjs --dry-run    one sweep that deletes nothing and prints one line per item
//   node disk-guard.mjs --dry-run --assume-free=20   the same, deciding as if that many GB were free
//   node disk-guard.mjs --once       one real sweep, then exit
//   node disk-guard.mjs --gradle-only  one real sweep of the Gradle rules only, then exit
// Test overrides: DISK_GUARD_CACHE, _REPOS (colon-separated), _KNOWN, _TMPDIR, _GRADLE_HOME,
// _XCTEST_DEVICES, _MOBILE_REPORT, _XCRUN, _NOTIFY, _CONSUMER_ROOTS (colon-separated); setting any one
// requires all of them, so a test can't reach a real cache through one it forgot. DISK_GUARD_FREE_GB
// (+ _FREE_STEP_GB per removal) fakes free space inside that sandbox; DISK_GUARD_PS/_LSOF swap the probes.
// Log: ~/Library/Logs/Bozeo/disk-guard.log.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const H = 3600_000;
const TIGHT_GB = 50;
const CRITICAL_GB = 25;
const TARGET_GB = 60;
const SWEEP_MS = 30 * 60_000;
const TIGHT_SWEEP_MS = 10 * 60_000;
const LEASE_FRESH_MS = 2 * H;
const TMP_BUILD_FRESH_MIN = 360; // 6 h
const BUILD_CACHE_UNUSED_MS = 6 * H;
const GRADLE_VERSION_IDLE_MIN = 7 * 24 * 60;
const DAEMON_LOG_MAX_AGE_MS = 7 * 24 * H;
const CLONE_IDLE_MIN = 24 * 60;
const IDLE_CACHE_MS = { tight: 24 * H, critical: 6 * H };
const NOTIFY_EVERY_MS = 6 * H;
// The report walks every mobile worktree (about 80 s of du), and only frees worktrees idle 48 h.
const MOBILE_REPORT_EVERY_MS = H;

const env = process.env;
const SANDBOX_VARS = [
  "DISK_GUARD_CACHE",
  "DISK_GUARD_REPOS",
  "DISK_GUARD_KNOWN",
  "DISK_GUARD_TMPDIR",
  "DISK_GUARD_GRADLE_HOME",
  "DISK_GUARD_XCTEST_DEVICES",
  "DISK_GUARD_MOBILE_REPORT",
  "DISK_GUARD_XCRUN",
  "DISK_GUARD_NOTIFY",
  "DISK_GUARD_CONSUMER_ROOTS",
];
// A stub ps or lsof could hide a live process, so they count as sandbox vars too; an empty value counts as unset.
const SANDBOXED = [...SANDBOX_VARS, "DISK_GUARD_FREE_GB", "DISK_GUARD_FREE_STEP_GB", "DISK_GUARD_PS", "DISK_GUARD_LSOF"].some((v) => env[v] !== undefined);
if (SANDBOXED) {
  const missing = SANDBOX_VARS.filter((v) => !env[v]);
  if (missing.length) {
    console.error(`disk guard: partial test sandbox (missing ${missing.join(", ")}); refusing to run`);
    process.exit(2);
  }
}
const list = (v) => v.split(":").filter(Boolean);
const CACHE = env.DISK_GUARD_CACHE ?? path.join(HOME, "Library/Caches/WonderlyMobileCore/worktrees");
const MOBILE_REPOS = env.DISK_GUARD_REPOS !== undefined ? list(env.DISK_GUARD_REPOS) : [path.join(HOME, "mobile-worktrees/main"), path.join(HOME, "mobile")];
// hash -> worktree path, so a removal line can say whose cache it was after the worktree is gone.
const KNOWN = env.DISK_GUARD_KNOWN ?? path.join(HOME, "bozeo-ops/disk-guard.known.json");
const TMPDIR = env.DISK_GUARD_TMPDIR ?? os.tmpdir();
const GRADLE_HOME = env.DISK_GUARD_GRADLE_HOME ?? path.join(HOME, ".gradle");
const XCTEST_DEVICES = env.DISK_GUARD_XCTEST_DEVICES ?? path.join(HOME, "Library/Developer/XCTestDevices");
const MOBILE_REPORT = env.DISK_GUARD_MOBILE_REPORT ?? path.join(HOME, "bozeo-ops/mobile-worktrees-report.mjs");
const XCRUN = env.DISK_GUARD_XCRUN ?? "xcrun";
const NOTIFY = env.DISK_GUARD_NOTIFY ?? null;
// Sized one level down for the critical notification. Never ~/Library/Caches whole (Adobe lives there, and
// so does WonderlyMobileCore, which is sized per worktree); never the clone sets, which du overstates.
const CONSUMER_ROOTS = env.DISK_GUARD_CONSUMER_ROOTS
  ? list(env.DISK_GUARD_CONSUMER_ROOTS)
  : [
      path.join(HOME, ".gradle/caches"),
      CACHE,
      path.join(HOME, "mobile-worktrees"),
      path.join(HOME, "paseo-worktrees"),
      path.join(HOME, "Library/Developer/Xcode/DerivedData"),
    ];
const CONSUMER_ITEMS = SANDBOXED ? [] : [path.join(HOME, "Library/Caches/Adobe"), path.join(HOME, ".npm"), path.join(HOME, "npm-cache")];
// Counted, not sized: du bills every APFS clone in full.
const CLONE_ROOTS = SANDBOXED ? [XCTEST_DEVICES] : [XCTEST_DEVICES, path.join(HOME, "Library/Developer/CoreSimulator/Devices")];
const PS = env.DISK_GUARD_PS ?? "ps";
const LSOF = env.DISK_GUARD_LSOF ?? "lsof";
// Our own git reads must not refresh an index: that would make an idle worktree look active.
const GIT_ENV = { ...env, GIT_OPTIONAL_LOCKS: "0" };

const args = process.argv.slice(2);
const unknown = args.filter((a) => !["--dry-run", "--once", "--gradle-only"].includes(a) && !a.startsWith("--assume-free="));
const assumeArg = args.find((a) => a.startsWith("--assume-free="));
const ASSUME_FREE_GB = assumeArg ? Number(assumeArg.slice("--assume-free=".length)) : null;
const DRY_RUN = args.includes("--dry-run");
if (unknown.length || (assumeArg && (!DRY_RUN || !Number.isFinite(ASSUME_FREE_GB)))) {
  // A typo must not fall through to the real loop.
  console.error(`disk guard: bad arguments ${args.join(" ")}; usage: [--dry-run [--assume-free=<GB>]] | --once | --gradle-only`);
  process.exit(2);
}
const GRADLE_ONLY = args.includes("--gradle-only");
const ONCE = DRY_RUN || GRADLE_ONLY || args.includes("--once");
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const firstLine = (e) => String(e?.message ?? e).split("\n")[0];
const hours = (ms) => (ms / H).toFixed(1);
const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const fmtKB = (kb) => (kb == null ? "size unknown" : `${(kb / 1024 ** 2).toFixed(2)} GB`);
const keep = (text) => ({ keep: true, text });
// Rules that couldn't run this sweep (a listing or probe failed, so they kept everything). Named in the
// summary line and the critical notification: a rule that fails closed every sweep is otherwise a silent no-op.
let failures = [];
/** Log and record that a rule couldn't run; it removed 0. */
const cantRun = (rule, why) => {
  log(`${rule}: ${why}; skipping`);
  failures.push(`${rule} (${why})`);
  return 0;
};
/** Log why a rule did nothing; it removed 0. */
const skipped = (msg) => {
  log(msg);
  return 0;
};
let lastCriticalNotice = 0;
let lastMobileReport = 0;
let removals = 0;

const FAKE_FREE = env.DISK_GUARD_FREE_GB !== undefined ? { base: Number(env.DISK_GUARD_FREE_GB), step: Number(env.DISK_GUARD_FREE_STEP_GB ?? 0) } : null;
const freeGB = () => {
  if (ASSUME_FREE_GB != null) return ASSUME_FREE_GB;
  if (FAKE_FREE) return FAKE_FREE.base + FAKE_FREE.step * removals;
  const s = statfsSync("/");
  return (s.bavail * s.bsize) / 1024 ** 3;
};
const modeFor = (free) => (free < CRITICAL_GB ? "critical" : free < TIGHT_GB ? "tight" : "normal");

// The only delete in this file. A dry run never calls it; the throw makes that checkable.
function removePath(p) {
  if (DRY_RUN) throw new Error(`dry run reached removePath(${p})`);
  rmSync(p, { recursive: true, force: true });
  removals++;
}

/** Remove p and say how much free space that made: du overstates clones, the volume doesn't. */
function removeMeasured(p) {
  const before = freeGB();
  removePath(p);
  return `freed ${(freeGB() - before).toFixed(2)} GB`;
}

function sizeKB(dir) {
  try {
    return Number(execFileSync("du", ["-sk", dir], { encoding: "utf8", timeout: 5 * 60_000, stdio: ["ignore", "pipe", "ignore"] }).split("\t")[0]);
  } catch {
    return null;
  }
}

/** Whether any file under dir was written in the last `minutes`; an error keeps (fail closed). */
function recentFile(dir, minutes, label) {
  try {
    const out = execFileSync("find", [dir, "-type", "f", "-mmin", `-${minutes}`, "-print", "-quit"], {
      encoding: "utf8",
      timeout: 2 * 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim() ? keep(`file written within ${label}`) : { keep: false };
  } catch (e) {
    return keep(`unreadable: ${firstLine(e)}`);
  }
}

/** Every process's argv and cwd, once. ok:false if ps or lsof can't answer; callers then keep everything. */
function processSnapshot() {
  let ps;
  try {
    ps = execFileSync(PS, ["-axwwo", "pid=,command="], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return { ok: false, text: `ps failed: ${firstLine(e)}` };
  }
  const procs = [];
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[1]) !== process.pid) procs.push({ pid: Number(m[1]), command: m[2] });
  }
  if (!procs.length) return { ok: false, text: "ps listed no processes" };
  let out;
  try {
    out = execFileSync(LSOF, ["-a", "-d", "cwd", "-Fpn"], { encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return { ok: false, text: `lsof failed: ${firstLine(e)}` };
  }
  const cwds = [];
  let pid = null;
  for (const line of out.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && pid !== process.pid) cwds.push({ pid, cwd: line.slice(1) });
  }
  if (!cwds.length) return { ok: false, text: "lsof listed no working directories" };
  return { ok: true, procs, cwds };
}

/** Whether text names p as a whole path: `/a/wt` is not named by `/a/wt-2`. */
function namesPath(text, p) {
  for (let i = text.indexOf(p); i !== -1; i = text.indexOf(p, i + 1)) {
    const next = text[i + p.length];
    if (next === undefined || !/[\w.-]/.test(next)) return true;
  }
  return false;
}

/** Which process has one of paths in its argv or its cwd at or under it, or null. */
function usedBy(snap, paths) {
  for (const p of paths) {
    const proc = snap.procs.find((x) => namesPath(x.command, p));
    if (proc) return `pid ${proc.pid} argv`;
    const cwd = snap.cwds.find((x) => x.cwd === p || x.cwd.startsWith(`${p}/`));
    if (cwd) return `pid ${cwd.pid} cwd`;
  }
  return null;
}

const xcodebuildPid = (snap) => snap.procs.find((p) => /(^|\/)xcodebuild(\s|$)/.test(p.command))?.pid;

/** Live worktrees of every repo, keyed by the mobile script's hash, plus the repos that failed to list. */
function listLiveWorktrees() {
  const live = new Map();
  const failed = MOBILE_REPOS.length ? [] : ["no mobile repos configured"];
  for (const repo of MOBILE_REPOS) {
    let out;
    try {
      out = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
        encoding: "utf8",
        timeout: 60_000,
        env: GIT_ENV,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      failed.push(`${repo} (${firstLine(e)})`);
      continue;
    }
    const found = new Map();
    try {
      for (const line of out.split("\n")) {
        if (!line.startsWith("worktree ")) continue;
        const p = line.slice(9);
        if (!existsSync(p)) continue;
        const real = realpathSync(p);
        found.set(createHash("sha256").update(real).digest("hex"), { repo, worktree: real, listed: p });
      }
    } catch (e) {
      failed.push(`${repo} (${firstLine(e)})`);
      continue;
    }
    // A repo always lists at least its main worktree; an empty listing is a failure, not "no worktrees".
    if (found.size === 0) {
      failed.push(`${repo} (listed no worktrees)`);
      continue;
    }
    for (const [h, v] of found) live.set(h, v);
  }
  return { live, failed };
}

// ---------------------------------------------------------------------------------------------- Gradle

const GRADLE_ENTRY = /^[0-9a-f]{32}$/;
const GRADLE_VERSION = /^\d+\.\d+(\.\d+)*(-[0-9A-Za-z.+-]+)?$/;
const DAEMON_LOG = /^daemon-\d+\.out\.log$/;

/** Rule 1a: build-cache-1 entries Gradle hasn't used in 6 h. One line per sweep, not per entry. */
function sweepBuildCache() {
  const dir = path.join(GRADLE_HOME, "caches/build-cache-1");
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (e.code !== "ENOENT") cantRun("gradle build-cache-1", `could not list ${dir}: ${firstLine(e)}`);
    return { removed: 0, bytes: 0 };
  }
  const now = Date.now();
  const stale = [];
  let fresh = 0;
  let unreadable = 0;
  for (const name of names) {
    if (!GRADLE_ENTRY.test(name)) continue;
    const p = path.join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      unreadable++;
      continue;
    }
    if (!st.isFile()) continue;
    if (now - st.mtimeMs < BUILD_CACHE_UNUSED_MS) fresh++;
    else stale.push({ p, bytes: st.blocks * 512, mtimeMs: st.mtimeMs });
  }
  const oldest = stale.length ? `, oldest ${hours(now - Math.min(...stale.map((s) => s.mtimeMs)))} h` : "";
  const total = stale.reduce((n, s) => n + s.bytes, 0);
  if (DRY_RUN) {
    log(
      `gradle build-cache-1: ${stale.length} entries unused 6 h+ (${gb(total)}${oldest}) -> ${stale.length ? "DELETE" : "none"}; ` +
        `${fresh} used within 6 h -> keep${unreadable ? `; ${unreadable} unreadable -> keep` : ""}`,
    );
    return { removed: 0, bytes: 0 };
  }
  let removed = 0;
  let bytes = 0;
  const before = freeGB();
  for (const s of stale) {
    // Re-stat: a build may have used the entry since the scan.
    try {
      const st = lstatSync(s.p);
      if (!st.isFile() || Date.now() - st.mtimeMs < BUILD_CACHE_UNUSED_MS) continue;
    } catch {
      continue;
    }
    removePath(s.p);
    removed++;
    bytes += s.bytes;
  }
  if (removed) log(`removed ${removed} gradle build-cache-1 entries | ${gb(bytes)} | unused 6 h+${oldest} | freed ${(freeGB() - before).toFixed(2)} GB`);
  return { removed, bytes };
}

/** Gradle versions named by a tracked gradle-wrapper.properties in any live mobile worktree. ok:false if any part can't be read. */
function wrapperVersions() {
  const { live, failed } = listLiveWorktrees();
  if (failed.length) return { ok: false, text: `could not list ${failed.join("; ")}` };
  const versions = new Map();
  for (const { worktree } of live.values()) {
    let files;
    try {
      files = execFileSync("git", ["-C", worktree, "ls-files", "-z", "--", "*gradle-wrapper.properties"], {
        encoding: "utf8",
        timeout: 60_000,
        env: GIT_ENV,
        stdio: ["ignore", "pipe", "pipe"],
      })
        .split("\0")
        .filter(Boolean);
    } catch (e) {
      return { ok: false, text: `git ls-files failed in ${worktree}: ${firstLine(e)}` };
    }
    for (const f of files) {
      const file = path.join(worktree, f);
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch (e) {
        if (e.code === "ENOENT") continue; // deleted in this worktree
        return { ok: false, text: `${file}: ${firstLine(e)}` };
      }
      const m = /^distributionUrl\s*=.*?[/=]gradle-([0-9][^/]*?)-(bin|all)\.zip\s*$/m.exec(text);
      if (!m) return { ok: false, text: `no readable distributionUrl in ${file}` };
      if (!versions.has(m[1])) versions.set(m[1], file);
    }
  }
  if (!versions.size) return { ok: false, text: "no gradle wrapper in any live worktree" };
  return { ok: true, versions };
}

/** Whether a command line names Gradle version ver (a distribution, a daemon, or that version's dirs). */
function namesGradleVersion(command, ver) {
  return [`gradle-${ver}`, `GradleDaemon ${ver}`, `/caches/${ver}`, `/daemon/${ver}`].some((token) => {
    for (let i = command.indexOf(token); i !== -1; i = command.indexOf(token, i + 1)) {
      const next = command[i + token.length];
      if (next === undefined || !/[\w.]/.test(next)) return true;
    }
    return false;
  });
}

function gradleVersionDecision(dir, ver, wrappers) {
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    return keep(`stat failed: ${firstLine(e)}`);
  }
  if (!st.isDirectory()) return keep("not a directory");
  if (!wrappers.ok) return keep(`wrapper set unknown: ${wrappers.text}`);
  if (wrappers.versions.has(ver)) return keep(`wrapper ${wrappers.versions.get(ver)}`);
  const snap = processSnapshot();
  if (!snap.ok) return keep(snap.text);
  const user = snap.procs.find((p) => namesGradleVersion(p.command, ver));
  if (user) return keep(`named by pid ${user.pid}`);
  const recent = recentFile(dir, GRADLE_VERSION_IDLE_MIN, "7 d");
  if (recent.keep) return recent;
  return { keep: false, text: "no live wrapper uses it, no process names it, nothing written in 7 d" };
}

/** Rule 1b: caches/<version> dirs for Gradle versions nothing live uses. */
function sweepGradleVersions() {
  const caches = path.join(GRADLE_HOME, "caches");
  let names;
  try {
    names = readdirSync(caches);
  } catch (e) {
    if (e.code !== "ENOENT") cantRun("gradle versions", `could not list ${caches}: ${firstLine(e)}`);
    return { removed: 0 };
  }
  const dirs = names.filter((n) => GRADLE_VERSION.test(n));
  if (!dirs.length) return { removed: 0 };
  const wrappers = wrapperVersions();
  if (!wrappers.ok) failures.push(`gradle versions (wrapper set unknown: ${wrappers.text})`);
  let removed = 0;
  for (const ver of dirs) {
    const dir = path.join(caches, ver);
    const d = gradleVersionDecision(dir, ver, wrappers);
    if (DRY_RUN) {
      log(`gradle ${dir} -> ${fmtKB(sizeKB(dir))} -> ${d.keep ? `keep:${d.text}` : "DELETE"}`);
      continue;
    }
    if (d.keep) continue;
    const sz = fmtKB(sizeKB(dir));
    const freed = removeMeasured(dir);
    removed++;
    log(`removed ${dir} | ${sz} | ${d.text} | ${freed}`);
  }
  return { removed };
}

/** Rule 1c: Gradle daemon logs older than 7 days. One line per sweep. */
function sweepDaemonLogs() {
  const root = path.join(GRADLE_HOME, "daemon");
  let vers;
  try {
    vers = readdirSync(root);
  } catch (e) {
    if (e.code !== "ENOENT") cantRun("gradle daemon logs", `could not list ${root}: ${firstLine(e)}`);
    return { removed: 0, bytes: 0 };
  }
  const now = Date.now();
  const old = [];
  let recent = 0;
  for (const v of vers) {
    const dir = path.join(root, v);
    let files;
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!DAEMON_LOG.test(f)) continue;
      const p = path.join(dir, f);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (now - st.mtimeMs < DAEMON_LOG_MAX_AGE_MS) recent++;
      else old.push({ p, bytes: st.blocks * 512 });
    }
  }
  const total = old.reduce((n, o) => n + o.bytes, 0);
  if (DRY_RUN) {
    log(`gradle daemon logs: ${old.length} older than 7 d (${gb(total)}) -> ${old.length ? "DELETE" : "none"}; ${recent} newer -> keep`);
    return { removed: 0, bytes: 0 };
  }
  for (const o of old) removePath(o.p);
  if (old.length) log(`removed ${old.length} gradle daemon logs | ${gb(total)} | older than 7 d`);
  return { removed: old.length, bytes: total };
}

function sweepGradle() {
  const entries = sweepBuildCache();
  const versions = sweepGradleVersions();
  const logs = sweepDaemonLogs();
  return { entries: entries.removed, versions: versions.removed, logs: logs.removed, bytes: entries.bytes + logs.bytes };
}

// ------------------------------------------------------------------------------- WonderlyMobileCore

/** The lstart of a running pid, null if no such process. Throws if ps itself fails. */
function processStart(pid) {
  try {
    // Always the real ps: a stubbed one exiting 1 would read as "no such process".
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
    return out.trim().split(/\s+/).slice(0, 5).join(" ") || null;
  } catch (e) {
    if (e.status === 1) return null;
    throw e;
  }
}

/** Why a cache's lease keeps it, or null. The mobile supervisor records wrapper/supervisor/xcode as {pid, startIdentity}. */
function leaseState(dir) {
  const lease = path.join(dir, "lease");
  let mtimeMs;
  try {
    mtimeMs = statSync(lease).mtimeMs;
  } catch {
    return { keep: false, text: "absent" };
  }
  const age = `lease mtime ${new Date(mtimeMs).toISOString()} (${hours(Date.now() - mtimeMs)} h)`;
  let owner = null;
  try {
    const meta = JSON.parse(readFileSync(path.join(lease, "owner.json"), "utf8"));
    for (const name of ["wrapper", "supervisor", "xcode"]) {
      const rec = meta?.[name];
      if (!Number.isInteger(rec?.pid) || rec.pid <= 0 || typeof rec.startIdentity !== "string") continue;
      let start;
      try {
        start = processStart(rec.pid);
      } catch (e) {
        // Can't tell whether the owner is alive: keep the cache.
        return { keep: true, text: `${age}, owner probe failed: ${firstLine(e)}` };
      }
      if (start && start === rec.startIdentity.trim().split(/\s+/).join(" ")) {
        owner = `${name} pid ${rec.pid}`;
        break;
      }
    }
  } catch {}
  if (owner) return { keep: true, text: `${age}, ${owner} alive`, mtimeMs };
  if (Date.now() - mtimeMs < LEASE_FRESH_MS) return { keep: true, text: `${age}, fresh`, mtimeMs };
  return { keep: false, text: `${age}, no live owner`, mtimeMs };
}

/** Newest mtime of the worktree's own index, HEAD and HEAD log: the last time git did anything there. */
function gitActivity(worktree) {
  let gitDir = path.join(worktree, ".git");
  try {
    const st = lstatSync(gitDir);
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, "utf8"));
      if (!m) return { ok: false, text: `unreadable ${gitDir}` };
      gitDir = path.resolve(worktree, m[1].trim());
    } else if (!st.isDirectory()) {
      return { ok: false, text: `${gitDir} is neither a file nor a directory` };
    }
  } catch (e) {
    return { ok: false, text: `cannot read ${gitDir}: ${firstLine(e)}` };
  }
  let ms = 0;
  for (const f of ["index", "HEAD", "logs/HEAD"]) {
    try {
      ms = Math.max(ms, statSync(path.join(gitDir, f)).mtimeMs);
    } catch {}
  }
  return ms > 0 ? { ok: true, ms } : { ok: false, text: `no git activity marker in ${gitDir}` };
}

function readKnown() {
  try {
    return JSON.parse(readFileSync(KNOWN, "utf8"));
  } catch {
    return {};
  }
}

function writeKnown(known) {
  try {
    writeFileSync(`${KNOWN}.tmp`, JSON.stringify(known, null, 1));
    renameSync(`${KNOWN}.tmp`, KNOWN);
  } catch (e) {
    log(`could not save ${KNOWN}: ${firstLine(e)}`);
  }
}

const cacheLine = (h, owner, lease, sz, decision) => log(`${h.slice(0, 12)} -> ${owner} -> ${sz} -> ${lease} -> ${decision}`);

/** Whether a live worktree's cache may be evicted: idle past idleMs by every signal we have. */
function idleCacheDecision(dir, o, idleMs, primaries, snap) {
  if (primaries.has(o.worktree)) return keep("primary checkout");
  try {
    if (!lstatSync(dir).isDirectory()) return keep("not a directory");
  } catch (e) {
    return keep(`stat failed: ${firstLine(e)}`);
  }
  const lease = leaseState(dir);
  if (lease.keep) return keep("lease");
  const act = gitActivity(o.worktree);
  if (!act.ok) return keep(act.text);
  const idleFor = Date.now() - act.ms;
  if (idleFor < idleMs) return keep(`git active ${hours(idleFor)} h ago`);
  if (!snap.ok) return keep(snap.text);
  const user = usedBy(snap, [...new Set([o.worktree, o.listed, dir])]);
  if (user) return keep(`in use (${user})`);
  const recent = recentFile(dir, Math.round(idleMs / 60_000), `${hours(idleMs)} h`);
  if (recent.keep) return recent;
  return { keep: false, lastMs: Math.max(act.ms, lease.mtimeMs ?? 0), text: `idle ${hours(idleFor)} h: no git activity, no process, no lease, no cache write` };
}

/** Tight/critical: evict idle live-worktree caches, oldest first, until free reaches TARGET_GB. */
function evictIdleCaches(hashes, live, mode) {
  const idleMs = IDLE_CACHE_MS[mode];
  const primaries = new Set(
    MOBILE_REPOS.map((r) => {
      try {
        return realpathSync(r);
      } catch {
        return r;
      }
    }),
  );
  const snap = processSnapshot();
  if (!snap.ok) failures.push(`idle cache eviction (${snap.text})`);
  const candidates = [];
  for (const h of hashes) {
    const dir = path.join(CACHE, h);
    const o = live.get(h);
    const d = idleCacheDecision(dir, o, idleMs, primaries, snap);
    if (d.keep) {
      if (DRY_RUN) cacheLine(h, `${o.repo}: ${o.worktree}`, leaseState(dir).text, fmtKB(sizeKB(dir)), `keep:${d.text}`);
      continue;
    }
    candidates.push({ h, dir, o, ...d });
  }
  candidates.sort((a, b) => a.lastMs - b.lastMs);
  // Credit du sizes too: if a snapshot holds the freed blocks, statfs alone would evict every candidate.
  let projected = freeGB();
  let evicted = 0;
  for (const c of candidates) {
    const kb = sizeKB(c.dir);
    const owner = `${c.o.repo}: ${c.o.worktree}`;
    if (freeGB() >= TARGET_GB || projected >= TARGET_GB) {
      if (DRY_RUN) cacheLine(c.h, owner, leaseState(c.dir).text, fmtKB(kb), `keep:free target ${TARGET_GB} GB reached`);
      continue;
    }
    if (DRY_RUN) {
      cacheLine(c.h, owner, leaseState(c.dir).text, fmtKB(kb), `DELETE (${c.text})`);
      projected += (kb ?? 0) / 1024 ** 2;
      continue;
    }
    // Re-check just before deleting: a build may have started since the scan.
    const again = idleCacheDecision(c.dir, c.o, idleMs, primaries, processSnapshot());
    if (again.keep) {
      log(`kept ${c.dir} | worktree ${c.o.worktree} | ${again.text} (changed since the scan)`);
      continue;
    }
    const freed = removeMeasured(c.dir);
    evicted++;
    projected += (kb ?? 0) / 1024 ** 2;
    log(`removed ${c.dir} | worktree ${c.o.worktree} | ${fmtKB(kb)} | ${mode}: ${again.text} | ${freed}`);
  }
  return { evicted, projected };
}

function sweepCaches(mode) {
  if (!existsSync(CACHE)) {
    if (DRY_RUN) log(`no cache root at ${CACHE}`);
    return { total: 0, live: 0, leased: 0, removed: 0, evicted: 0 };
  }
  const entries = readdirSync(CACHE).filter((h) => /^[0-9a-f]{64}$/.test(h));
  const { live, failed } = listLiveWorktrees();
  const known = readKnown();
  if (failed.length) {
    log(`could not list ${failed.join("; ")}; deleting nothing this sweep`);
    failures.push(`WonderlyMobileCore caches (could not list ${failed.join("; ")})`);
    if (DRY_RUN) {
      for (const h of entries) {
        const o = live.get(h);
        const dir = path.join(CACHE, h);
        cacheLine(h, o ? `${o.repo}: ${o.worktree}` : `unattributed (last known ${known[h] ?? "unknown"})`, leaseState(dir).text, fmtKB(sizeKB(dir)), "skip:listing-incomplete");
      }
    }
    return { total: entries.length, removed: 0, skipped: true };
  }
  let removed = 0;
  let leased = 0;
  for (const h of entries) {
    if (live.has(h)) continue;
    const dir = path.join(CACHE, h);
    const lease = leaseState(dir);
    const last = known[h] ?? "unknown";
    if (lease.keep) {
      leased++;
      if (DRY_RUN) cacheLine(h, `ORPHAN (last known ${last})`, lease.text, fmtKB(sizeKB(dir)), "keep:lease");
      continue;
    }
    const sz = fmtKB(sizeKB(dir));
    if (DRY_RUN) {
      cacheLine(h, `ORPHAN (last known ${last})`, lease.text, sz, "DELETE");
      continue;
    }
    const freed = removeMeasured(dir);
    removed++;
    log(`removed ${dir} | worktree ${last} | ${sz} | ${lease.text} | ${freed}`);
  }
  const liveHashes = entries.filter((h) => live.has(h));
  let evicted = 0;
  let projectedFree = null;
  if (mode === "normal") {
    if (DRY_RUN) for (const h of liveHashes) cacheLine(h, `${live.get(h).repo}: ${live.get(h).worktree}`, leaseState(path.join(CACHE, h)).text, fmtKB(sizeKB(path.join(CACHE, h))), "keep:live");
  } else {
    ({ evicted, projected: projectedFree } = evictIdleCaches(liveHashes, live, mode));
  }
  if (!DRY_RUN) {
    const next = {};
    for (const h of entries) {
      const w = live.get(h)?.worktree ?? known[h];
      if (w && existsSync(path.join(CACHE, h))) next[h] = w;
    }
    writeKnown(next);
  }
  return { total: entries.length, live: liveHashes.length, leased, removed, evicted, projectedFree };
}

// ------------------------------------------------------------------------------- $TMPDIR iOS builds

const TMP_BUILD_PATTERNS = [/^wonderly-ios-derived-/, /^wonderly-ios-packages-/, /^wonderly-ios-device-derived-/];

/** Whether any process's command line names dir, else fail-closed on a ps error. */
function tmpBuildHasLiveProcess(dir) {
  let out;
  try {
    out = execFileSync(PS, ["-axwwo", "command="], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return keep(`ps failed: ${firstLine(e)}`);
  }
  return out.split("\n").some((line) => line.includes(dir)) ? keep("named in a running process") : { keep: false };
}

/** Whether lsof reports an open file under dir, else fail-closed on an lsof error. */
function tmpBuildHasOpenFile(dir) {
  let stdout = "";
  let stderr = "";
  try {
    stdout = execFileSync(LSOF, ["+D", dir], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (e.status == null) return keep(`lsof failed: ${firstLine(e)}`);
    stdout = e.stdout?.toString() ?? "";
    stderr = e.stderr?.toString() ?? "";
  }
  if (stderr.trim()) return keep(`lsof failed: ${stderr.trim().split("\n")[0]}`);
  return stdout.trim() ? keep("open file in directory") : { keep: false };
}

/** The removal rule: stale, no live process, no open file. Fail-closed on the first probe that can't tell. */
function tmpBuildDecision(dir) {
  for (const probe of [(d) => recentFile(d, TMP_BUILD_FRESH_MIN, "6 h"), tmpBuildHasLiveProcess, tmpBuildHasOpenFile]) {
    const r = probe(dir);
    if (r.keep) return r;
  }
  return { keep: false, text: "no file written in 6 h, no live process, no open file" };
}

function sweepTmpBuilds() {
  let entries;
  try {
    entries = readdirSync(TMPDIR);
  } catch (e) {
    cantRun("tmp builds", `could not list ${TMPDIR}: ${firstLine(e)}`);
    return { total: 0, removed: 0, skipped: true };
  }
  const dirs = entries.filter((name) => TMP_BUILD_PATTERNS.some((re) => re.test(name))).map((name) => path.join(TMPDIR, name));
  let removed = 0;
  for (const dir of dirs) {
    let st;
    try {
      st = statSync(dir);
    } catch (e) {
      log(`tmp build ${dir}: keep (stat failed: ${firstLine(e)})`);
      continue;
    }
    if (!st.isDirectory()) continue;
    const decision = tmpBuildDecision(dir);
    const sz = fmtKB(sizeKB(dir));
    if (DRY_RUN) {
      log(`${dir} -> ${sz} -> ${decision.keep ? `keep:${decision.text}` : "DELETE"}`);
      continue;
    }
    if (decision.keep) continue;
    const freed = removeMeasured(dir);
    removed++;
    log(`removed ${dir} | ${sz} | ${decision.text} | ${freed}`);
  }
  return { total: dirs.length, removed };
}

// ------------------------------------------------------------------------------ tight: simulators

/** `xcrun simctl delete unavailable`, after listing what it will take. Never while xcodebuild runs. */
function deleteUnavailableSimulators() {
  const snap = processSnapshot();
  if (!snap.ok) return cantRun("simctl", snap.text);
  const xb = xcodebuildPid(snap);
  if (xb) return skipped(`simctl: skipped, xcodebuild pid ${xb} is running`);
  let devices;
  try {
    const json = JSON.parse(execFileSync(XCRUN, ["simctl", "list", "devices", "unavailable", "-j"], { encoding: "utf8", timeout: 2 * 60_000, stdio: ["ignore", "pipe", "pipe"] }));
    devices = Object.entries(json.devices ?? {}).flatMap(([runtime, list]) => list.filter((d) => d.isAvailable === false).map((d) => ({ ...d, runtime })));
  } catch (e) {
    return cantRun("simctl", `could not list unavailable devices: ${firstLine(e)}`);
  }
  if (!devices.length) {
    if (DRY_RUN) log("simctl: no unavailable devices");
    return 0;
  }
  const names = devices.map((d) => `${d.name} ${d.udid} (${d.runtime.replace("com.apple.CoreSimulator.SimRuntime.", "")})`);
  if (DRY_RUN) {
    for (const n of names) log(`simctl unavailable ${n} -> DELETE`);
    return 0;
  }
  const before = freeGB();
  try {
    execFileSync(XCRUN, ["simctl", "delete", "unavailable"], { timeout: 5 * 60_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return cantRun("simctl", `delete unavailable failed: ${firstLine(e)}`);
  }
  removals += devices.length;
  log(`removed ${devices.length} unavailable simulators (simctl delete unavailable) | ${names.join(", ")} | runtime not installed | freed ${(freeGB() - before).toFixed(2)} GB`);
  return devices.length;
}

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

function cloneDecision(dir, udid, snap) {
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    return keep(`stat failed: ${firstLine(e)}`);
  }
  if (!st.isDirectory()) return keep("not a directory");
  try {
    if (realpathSync(dir) !== dir) return keep("resolves outside the set");
  } catch (e) {
    return keep(`realpath failed: ${firstLine(e)}`);
  }
  const user = snap.procs.find((p) => p.command.includes(udid));
  if (user) return keep(`named by pid ${user.pid}`);
  const changed = Date.now() - st.mtimeMs;
  if (changed < CLONE_IDLE_MIN * 60_000) return keep(`changed ${hours(changed)} h ago`);
  const recent = recentFile(dir, CLONE_IDLE_MIN, "1 d");
  if (recent.keep) return recent;
  return { keep: false, text: "no xcodebuild running, no process names it, nothing written in 1 d" };
}

/** XCTestDevices clones a killed test run left behind. Never while any xcodebuild runs. */
function sweepTestClones() {
  let root;
  try {
    root = realpathSync(XCTEST_DEVICES);
  } catch (e) {
    if (e.code !== "ENOENT") cantRun("XCTestDevices", `could not resolve ${XCTEST_DEVICES}: ${firstLine(e)}`);
    return 0;
  }
  let names;
  try {
    names = readdirSync(root).filter((n) => UDID.test(n));
  } catch (e) {
    return cantRun("XCTestDevices", `could not list ${root}: ${firstLine(e)}`);
  }
  const snap = processSnapshot();
  if (!snap.ok) return cantRun("XCTestDevices", snap.text);
  const xb = xcodebuildPid(snap);
  if (xb) return skipped(`XCTestDevices: skipped, xcodebuild pid ${xb} is running`);
  let removed = 0;
  for (const name of names) {
    const dir = path.join(root, name);
    const d = cloneDecision(dir, name, snap);
    if (DRY_RUN) {
      log(`${dir} -> du ${fmtKB(sizeKB(dir))} (clone, overstated) -> ${d.keep ? `keep:${d.text}` : "DELETE"}`);
      continue;
    }
    if (d.keep) continue;
    // Re-check just before deleting: a test run may have started since the scan.
    const now = processSnapshot();
    if (!now.ok || xcodebuildPid(now) || now.procs.some((p) => p.command.includes(name))) {
      log(`XCTestDevices: stopping, ${now.ok ? "a test run started" : now.text}`);
      break;
    }
    const kb = sizeKB(dir);
    const freed = removeMeasured(dir);
    removed++;
    log(`removed ${dir} | du ${fmtKB(kb)} (clone, overstated) | ${d.text} | ${freed}`);
  }
  return removed;
}

// ------------------------------------------------------------------------- tight: mobile worktrees

/** mobile-worktrees-report.mjs decides; --apply removes its safe ones (git refuses a dirty tree). */
function retireMobileWorktrees() {
  const reportArgs = DRY_RUN ? [MOBILE_REPORT] : [MOBILE_REPORT, "--apply"];
  let out;
  try {
    out = execFileSync(process.execPath, reportArgs, { encoding: "utf8", timeout: 20 * 60_000, maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const partial = (e.stdout?.toString() ?? "").split("\n").filter((l) => /^(removed|git refused|kept) /.test(l));
    for (const l of partial) log(`mobile worktrees: ${l}`);
    const stderr = (e.stderr?.toString() ?? "").split("\n");
    cantRun("mobile worktree report", `failed: ${stderr.find((l) => /^\w*Error\b/.test(l)) ?? stderr.find((l) => l.trim()) ?? firstLine(e)}`);
    return partial.filter((l) => l.startsWith("removed ")).length;
  }
  const lines = out.split("\n").filter(Boolean);
  for (const l of lines) if (DRY_RUN || /^(removed|git refused|kept) /.test(l) || /removable, /.test(l)) log(`mobile worktrees: ${l}`);
  return lines.filter((l) => l.startsWith("removed ")).length;
}

// ------------------------------------------------------------------------------ critical: notify

/** The biggest directories one level under CONSUMER_ROOTS, plus CONSUMER_ITEMS whole, by du. */
function topConsumers(n = 5) {
  const rows = [];
  const du = (args) => {
    try {
      return execFileSync("du", args, { encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      return e.stdout?.toString() ?? ""; // du exits 1 on an unreadable subdir but still prints the rest
    }
  };
  for (const root of CONSUMER_ROOTS) {
    if (!existsSync(root)) continue;
    for (const line of du(["-k", "-d", "1", root]).trim().split("\n")) {
      const [kb, p] = line.split("\t");
      if (p && p !== root) rows.push({ p, kb: Number(kb) });
    }
  }
  for (const item of CONSUMER_ITEMS) {
    if (!existsSync(item)) continue;
    const [kb] = du(["-sk", item]).split("\t");
    if (Number(kb)) rows.push({ p: item, kb: Number(kb) });
  }
  // A dir that holds another measured root is already counted, finer, under that root.
  const fine = rows.filter((r) => !CONSUMER_ROOTS.some((root) => root.startsWith(`${r.p}/`)));
  fine.sort((a, b) => b.kb - a.kb);
  const known = readKnown();
  const label = (p) => (path.dirname(p) === CACHE && known[path.basename(p)] ? `MobileCore cache ${path.basename(known[path.basename(p)])}` : p.replace(HOME, "~"));
  const top = fine.slice(0, n).map((r) => `${label(r.p)} ${(r.kb / 1024 ** 2).toFixed(1)} GB`);
  const clones = [];
  for (const root of CLONE_ROOTS) {
    try {
      clones.push(`${root.replace(HOME, "~")} ${readdirSync(root).filter((x) => UDID.test(x)).length} devices`);
    } catch {}
  }
  return { top, clones };
}

function notifyCritical(free) {
  const { top, clones } = topConsumers();
  const title = "Bozeo: disk critical";
  const body = `${free.toFixed(0)} GB free after cleanup. Top: ${top.join(", ") || "unmeasured"}${failures.length ? `. Couldn't run: ${failures.join("; ")}` : ""}`;
  const detail = `${body}${clones.length ? `; clone sets (du overstates, not sized): ${clones.join(", ")}` : ""}`;
  if (DRY_RUN) return log(`would notify: ${title}: ${detail}`);
  log(`CRITICAL: ${detail}`);
  try {
    if (NOTIFY) execFileSync(NOTIFY, [title, body], { timeout: 30_000, stdio: "ignore" });
    else {
      execFileSync("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body], {
        timeout: 30_000,
        stdio: "ignore",
      });
    }
  } catch (e) {
    log(`notify failed: ${firstLine(e)}`);
  }
}

// ---------------------------------------------------------------------------------------- sweep

function sweep() {
  failures = [];
  const tag = DRY_RUN ? "dry run: " : "";
  const before = freeGB();
  const g = sweepGradle();
  const gradleText = `gradle ${g.entries} cache entries, ${g.versions} version dirs, ${g.logs} daemon logs removed`;
  if (GRADLE_ONLY) {
    log(`${tag}${gradleText}; free ${before.toFixed(1)} -> ${freeGB().toFixed(1)} GB`);
    return freeGB();
  }
  const t = sweepTmpBuilds();
  const mode = modeFor(freeGB());
  let sims = 0;
  let clones = 0;
  let worktreesText = "";
  if (mode !== "normal") {
    log(`${tag}${freeGB().toFixed(1)} GB free: ${mode} (tight below ${TIGHT_GB} GB, critical below ${CRITICAL_GB} GB, evicting to ${TARGET_GB} GB)`);
    sims = deleteUnavailableSimulators();
    clones = sweepTestClones();
  }
  const r = sweepCaches(mode);
  if (mode !== "normal") {
    // A dry run frees nothing, so ask whether the caches it would evict reach the target.
    const reached = Math.max(freeGB(), r.projectedFree ?? 0) >= TARGET_GB;
    if (reached) worktreesText = "not needed, free target reached";
    else if (ONCE || Date.now() - lastMobileReport >= MOBILE_REPORT_EVERY_MS) {
      lastMobileReport = Date.now();
      worktreesText = `${retireMobileWorktrees()} removed`;
    } else worktreesText = "not due (hourly)";
  }
  const after = freeGB();
  const tightText = mode === "normal" ? "" : `; ${mode}: ${sims} simulators, ${clones} test clones removed, mobile worktrees ${worktreesText}`;
  log(
    `${tag}${gradleText}; ${r.total} caches, ${r.skipped ? "sweep skipped" : `${r.live} live, ${r.leased} leased, ${r.removed} removed, ${r.evicted} idle evicted`}; ` +
      `${t.total} tmp builds, ${t.skipped ? "sweep skipped" : `${t.removed} removed`}${tightText}; free ${before.toFixed(1)} -> ${after.toFixed(1)} GB` +
      `${failures.length ? `; couldn't run: ${failures.join("; ")}` : ""}`,
  );
  if (after < CRITICAL_GB && (DRY_RUN || Date.now() - lastCriticalNotice > NOTIFY_EVERY_MS)) {
    if (!DRY_RUN) lastCriticalNotice = Date.now();
    notifyCritical(after);
  }
  return after;
}

if (ONCE) {
  sweep();
} else {
  log("disk guard started");
  for (;;) {
    let free = TIGHT_GB;
    try {
      free = sweep();
    } catch (e) {
      log(`sweep failed: ${firstLine(e)}`);
    }
    await new Promise((r) => setTimeout(r, free < TIGHT_GB ? TIGHT_SWEEP_MS : SWEEP_MS));
  }
}
