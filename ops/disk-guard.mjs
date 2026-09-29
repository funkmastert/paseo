// Disk guard: a deterministic stopgap for the one disk sink the daemon's disk rung can't see.
//  1. Every run: delete WonderlyMobileCore per-worktree build caches whose worktree no longer exists.
//     The mobile repo's scripts/mobilecore-xcode.sh names each ~/Library/Caches/WonderlyMobileCore/
//     worktrees/<sha256(pwd -P of the worktree)> and never removes it; 168 GB piled up by 2026-09-25.
//     Fails closed: if any repo in MOBILE_REPOS can't be listed, the sweep deletes nothing, because
//     a partial listing makes every cache of the missing repo look orphaned.
//     A cache is kept while its lease dir was touched in the last 2 hours, or while its owner.json
//     names a process that is still running (pid and start time both match, so a reused pid doesn't count).
//     Every removal is logged on its own line: path, last-known worktree, size, lease state.
//  2. Only if free space is under CRITICAL_GB: one macOS notification per 6 hours, because then it
//     genuinely can't fix itself.
// Worktree reclaim under disk pressure is the daemon's job (disk rung 1 and the done janitor), not this script's.
//
//   node disk-guard.mjs            the LaunchAgent loop (sh.bozeo.disk-guard), one sweep every 30 min
//   node disk-guard.mjs --dry-run  one sweep that deletes nothing and prints one line per cache
//   node disk-guard.mjs --once     one real sweep, then exit
// Test overrides: DISK_GUARD_CACHE, DISK_GUARD_REPOS (colon-separated), DISK_GUARD_KNOWN.
// Log: ~/Library/Logs/Bozeo/disk-guard.log.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const CRITICAL_GB = 15;
const SWEEP_MS = 30 * 60_000;
const LEASE_FRESH_MS = 2 * 3600_000;
const CACHE = process.env.DISK_GUARD_CACHE ?? path.join(HOME, "Library/Caches/WonderlyMobileCore/worktrees");
const MOBILE_REPOS = process.env.DISK_GUARD_REPOS
  ? process.env.DISK_GUARD_REPOS.split(":").filter(Boolean)
  : [path.join(HOME, "mobile-worktrees/main"), path.join(HOME, "mobile")];
// hash -> worktree path, so a removal line can say whose cache it was after the worktree is gone.
const KNOWN = process.env.DISK_GUARD_KNOWN ?? path.join(HOME, "bozeo-ops/disk-guard.known.json");
const DRY_RUN = process.argv.includes("--dry-run");
const ONCE = DRY_RUN || process.argv.includes("--once");
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const firstLine = (e) => String(e?.message ?? e).split("\n")[0];
let lastCriticalNotice = 0;

const freeGB = () => {
  const s = statfsSync("/");
  return (s.bavail * s.bsize) / 1024 ** 3;
};

/** Live worktrees of every repo, keyed by the mobile script's hash, plus the repos that failed to list. */
function listLiveWorktrees() {
  const live = new Map();
  const failed = [];
  for (const repo of MOBILE_REPOS) {
    let out;
    try {
      out = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
        encoding: "utf8",
        timeout: 60_000,
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
        found.set(createHash("sha256").update(real).digest("hex"), { repo, worktree: real });
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

/** The lstart of a running pid, null if no such process. Throws if ps itself fails. */
function processStart(pid) {
  try {
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
  const age = `lease mtime ${new Date(mtimeMs).toISOString()} (${((Date.now() - mtimeMs) / 3600_000).toFixed(1)} h)`;
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
  if (owner) return { keep: true, text: `${age}, ${owner} alive` };
  if (Date.now() - mtimeMs < LEASE_FRESH_MS) return { keep: true, text: `${age}, fresh` };
  return { keep: false, text: `${age}, no live owner` };
}

function size(dir) {
  try {
    const kb = Number(execFileSync("du", ["-sk", dir], { encoding: "utf8", timeout: 5 * 60_000, stdio: ["ignore", "pipe", "ignore"] }).split("\t")[0]);
    return `${(kb / 1024 ** 2).toFixed(2)} GB`;
  } catch (e) {
    return `size unknown (${firstLine(e)})`;
  }
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

// The only delete in this file. A dry run never calls it; the throw makes that checkable.
function removeCache(dir) {
  if (DRY_RUN) throw new Error(`dry run reached removeCache(${dir})`);
  rmSync(dir, { recursive: true, force: true });
}

function sweepCaches() {
  if (!existsSync(CACHE)) {
    if (DRY_RUN) log(`no cache root at ${CACHE}`);
    return { total: 0, live: 0, leased: 0, removed: 0 };
  }
  const entries = readdirSync(CACHE).filter((h) => /^[0-9a-f]{64}$/.test(h));
  const { live, failed } = listLiveWorktrees();
  const known = readKnown();
  const say = (h, owner, lease, sz, decision) =>
    log(`${h.slice(0, 12)} -> ${owner} -> ${sz} -> ${lease} -> ${decision}`);
  if (failed.length) {
    log(`could not list ${failed.join("; ")}; deleting nothing this sweep`);
    if (DRY_RUN) {
      for (const h of entries) {
        const o = live.get(h);
        say(h, o ? `${o.repo}: ${o.worktree}` : `unattributed (last known ${known[h] ?? "unknown"})`, leaseState(path.join(CACHE, h)).text, size(path.join(CACHE, h)), "skip:listing-incomplete");
      }
    }
    return { total: entries.length, removed: 0, skipped: true };
  }
  let removed = 0;
  let leased = 0;
  for (const h of entries) {
    const dir = path.join(CACHE, h);
    const o = live.get(h);
    if (o) {
      if (DRY_RUN) say(h, `${o.repo}: ${o.worktree}`, leaseState(dir).text, size(dir), "keep:live");
      continue;
    }
    const lease = leaseState(dir);
    const last = known[h] ?? "unknown";
    if (lease.keep) {
      leased++;
      if (DRY_RUN) say(h, `ORPHAN (last known ${last})`, lease.text, size(dir), "keep:lease");
      continue;
    }
    const sz = size(dir);
    if (DRY_RUN) {
      say(h, `ORPHAN (last known ${last})`, lease.text, sz, "DELETE");
      continue;
    }
    removeCache(dir);
    removed++;
    log(`removed ${dir} | worktree ${last} | ${sz} | ${lease.text}`);
  }
  if (!DRY_RUN) {
    const next = {};
    for (const h of entries) {
      const w = live.get(h)?.worktree ?? known[h];
      if (w && existsSync(path.join(CACHE, h))) next[h] = w;
    }
    writeKnown(next);
  }
  return { total: entries.length, live: entries.filter((h) => live.has(h)).length, leased, removed };
}

function sweep() {
  const before = freeGB();
  const r = sweepCaches();
  const after = freeGB();
  const tag = DRY_RUN ? "dry run: " : "";
  log(`${tag}${r.total} caches, ${r.skipped ? "sweep skipped" : `${r.live} live, ${r.leased} leased, ${r.removed} removed`}; free ${before.toFixed(1)} -> ${after.toFixed(1)} GB`);
  if (!DRY_RUN && after < CRITICAL_GB && Date.now() - lastCriticalNotice > 6 * 3600_000) {
    lastCriticalNotice = Date.now();
    log(`CRITICAL: ${after.toFixed(1)} GB free after cleanup`);
    try {
      execFileSync("osascript", ["-e", `display notification "Only ${after.toFixed(0)} GB free after automatic cleanup. See ~/Library/Logs/Bozeo/disk-guard.log" with title "Bozeo: disk still low"`]);
    } catch {}
  }
}

if (ONCE) {
  sweep();
} else {
  log("disk guard started");
  for (;;) {
    try {
      sweep();
    } catch (e) {
      log(`sweep failed: ${firstLine(e)}`);
    }
    await new Promise((r) => setTimeout(r, SWEEP_MS));
  }
}
