// Disk guard: a deterministic stopgap for the two disk sinks the daemon's disk rung can't see yet.
//  1. Every run: delete WonderlyMobileCore per-worktree build caches whose worktree no longer exists.
//     The mobile repo's scripts/mobilecore-xcode.sh names each ~/Library/Caches/WonderlyMobileCore/
//     worktrees/<sha256(pwd -P of the worktree)> and never removes it; 168 GB piled up by 2026-09-25.
//     A cache with a lease touched in the last 2 hours is a build in flight and is kept.
//  2. When free space is under LOW_GB: retire the orchestrator's own worktrees (~/.paseo/worktrees/
//     3jvw4yw6) that are clean, fully pushed or merged, and have no running agent
//     (retire-merged-worktrees.mjs archives their idle agents, then the daemon removes the tree).
//  3. Only if free space is still under CRITICAL_GB afterwards: one macOS notification, because
//     then it genuinely can't fix itself.
// Log: ~/Library/Logs/Bozeo/disk-guard.log. LaunchAgent: sh.bozeo.disk-guard.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync, rmSync, statSync, statfsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const NODE = process.execPath;
const LOW_GB = 40;
const CRITICAL_GB = 15;
const SWEEP_MS = 30 * 60_000;
const CACHE = path.join(HOME, "Library/Caches/WonderlyMobileCore/worktrees");
const MOBILE_REPOS = [path.join(HOME, "mobile-worktrees/main"), path.join(HOME, "mobile")];
const ORCH_WORKTREES = path.join(HOME, ".paseo/worktrees/3jvw4yw6");
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
let lastCriticalNotice = 0;

const freeGB = () => {
  const s = statfsSync("/");
  return (s.bavail * s.bsize) / 1024 ** 3;
};

function liveMobileWorktreeHashes() {
  const hashes = new Set();
  let listedAny = false;
  for (const repo of MOBILE_REPOS) {
    let out = "";
    try {
      out = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8", timeout: 60_000 });
      listedAny = true;
    } catch {
      continue;
    }
    for (const line of out.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const p = line.slice(9);
      if (!existsSync(p)) continue;
      hashes.add(createHash("sha256").update(realpathSync(p)).digest("hex"));
    }
  }
  // If no repo could be listed, every cache would look orphaned; refuse rather than wipe them all.
  return listedAny ? hashes : null;
}

function deleteOrphanedMobileCaches() {
  if (!existsSync(CACHE)) return 0;
  const live = liveMobileWorktreeHashes();
  if (!live) {
    log("could not list any mobile repo worktrees; skipping cache cleanup");
    return 0;
  }
  let removed = 0;
  for (const h of readdirSync(CACHE)) {
    if (!/^[0-9a-f]{64}$/.test(h) || live.has(h)) continue;
    const lease = path.join(CACHE, h, "lease");
    if (existsSync(lease) && Date.now() - statSync(lease).mtimeMs < 2 * 3600_000) continue;
    rmSync(path.join(CACHE, h), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

function sweep() {
  const before = freeGB();
  const orphans = deleteOrphanedMobileCaches();
  let retired = "";
  if (freeGB() < LOW_GB && existsSync(ORCH_WORKTREES)) {
    try {
      retired = execFileSync(NODE, [path.join(HOME, "bozeo-ops/retire-merged-worktrees.mjs"), ORCH_WORKTREES, "--apply"], {
        encoding: "utf8",
        timeout: 20 * 60_000,
      })
        .split("\n")
        .filter((l) => l.startsWith("retired"))
        .join("; ");
    } catch (e) {
      retired = `retire failed: ${String(e.message).split("\n")[0]}`;
    }
  }
  const after = freeGB();
  if (orphans || retired) log(`free ${before.toFixed(1)} -> ${after.toFixed(1)} GB; orphaned MobileCore caches removed: ${orphans}; ${retired || "no worktrees retired"}`);
  if (after < CRITICAL_GB && Date.now() - lastCriticalNotice > 6 * 3600_000) {
    lastCriticalNotice = Date.now();
    log(`CRITICAL: ${after.toFixed(1)} GB free after cleanup`);
    try {
      execFileSync("osascript", ["-e", `display notification "Only ${after.toFixed(0)} GB free after automatic cleanup. See ~/Library/Logs/Bozeo/disk-guard.log" with title "Bozeo: disk still low"`]);
    } catch {}
  }
}

log("disk guard started");
for (;;) {
  try {
    sweep();
  } catch (e) {
    log(`sweep failed: ${String(e.message).split("\n")[0]}`);
  }
  await new Promise((r) => setTimeout(r, SWEEP_MS));
}
