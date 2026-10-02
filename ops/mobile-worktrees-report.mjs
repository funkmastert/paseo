// Read-only report over ~/mobile-worktrees: which checkouts could go without losing anything.
// Safe = the done janitor's own check (linked worktree, clean tree, every commit pushed or merged)
// AND no live agent inside AND no process with it in argv or cwd AND not touched for 48h. Pass
// --apply to `git worktree remove` the safe ones (branches are kept; git itself refuses a dirty tree).
// disk-guard.mjs runs it with --apply when free space is tight. If ps or lsof can't answer, nothing
// is safe.
// Test overrides: MOBILE_REPORT_ROOT (the directory to report on), MOBILE_REPORT_AGENTS (a JSON
// file of agents instead of asking the daemon), MOBILE_REPORT_PS / MOBILE_REPORT_LSOF. Setting any
// of them requires both ROOT and AGENTS, so a test can't act on the real ~/mobile-worktrees.
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { checkWorktreeDeletionSafety } from "/Users/tylerthackray/paseo-worktrees/bozeo/packages/server/dist/server/server/done-janitor-worktree.js";
import { fetchAll } from "./retire-merged-paseo-worktrees.mjs";

const apply = process.argv.includes("--apply");
const OVERRIDES = ["MOBILE_REPORT_ROOT", "MOBILE_REPORT_AGENTS", "MOBILE_REPORT_PS", "MOBILE_REPORT_LSOF"];
if (OVERRIDES.some((v) => process.env[v] !== undefined) && !(process.env.MOBILE_REPORT_ROOT && process.env.MOBILE_REPORT_AGENTS)) {
  console.error("mobile-worktrees-report: test overrides need both MOBILE_REPORT_ROOT and MOBILE_REPORT_AGENTS; refusing to run");
  process.exit(2);
}
const QUIET_MS = 48 * 3600 * 1000;
const root = process.env.MOBILE_REPORT_ROOT ?? path.join(os.homedir(), "mobile-worktrees");
const PS = process.env.MOBILE_REPORT_PS ?? "ps";
const LSOF = process.env.MOBILE_REPORT_LSOF ?? "lsof";
const inside = (r, p) => p === r || p.startsWith(r + "/");

async function loadAgents() {
  if (process.env.MOBILE_REPORT_AGENTS) return JSON.parse(readFileSync(process.env.MOBILE_REPORT_AGENTS, "utf8"));
  const { connectToDaemon } = await import("/Users/tylerthackray/paseo-worktrees/bozeo/packages/cli/dist/utils/client.js");
  const c = await connectToDaemon({ host: "127.0.0.1:6767" });
  const agents = (await fetchAll((o) => c.fetchAgents(o))).map((e) => e.agent);
  await c.close();
  return agents;
}
const agents = await loadAgents();

/** Every process's argv and cwd, or null if ps or lsof can't answer. */
function processSnapshot() {
  try {
    const opts = { encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] };
    const procs = execFileSync(PS, ["-axwwo", "pid=,command="], opts)
      .split("\n")
      .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
      .filter((m) => m && Number(m[1]) !== process.pid)
      .map((m) => ({ pid: Number(m[1]), command: m[2] }));
    const cwds = [];
    let pid = null;
    for (const line of execFileSync(LSOF, ["-a", "-d", "cwd", "-Fpn"], opts).split("\n")) {
      if (line[0] === "p") pid = Number(line.slice(1));
      else if (line[0] === "n" && pid !== process.pid) cwds.push({ pid, cwd: line.slice(1) });
    }
    return procs.length && cwds.length ? { procs, cwds } : null;
  } catch {
    return null;
  }
}

/** A process naming dir as a whole path in its argv (`/a/wt` is not named by `/a/wt-2`), or with its cwd inside dir. */
function usedBy(snap, dir) {
  const names = (text) => {
    for (let i = text.indexOf(dir); i !== -1; i = text.indexOf(dir, i + 1)) {
      const next = text[i + dir.length];
      if (next === undefined || !/[\w.-]/.test(next)) return true;
    }
    return false;
  };
  const proc = snap.procs.find((p) => names(p.command));
  if (proc) return `pid ${proc.pid} argv`;
  const cwd = snap.cwds.find((c) => inside(dir, c.cwd));
  return cwd ? `pid ${cwd.pid} cwd` : null;
}

function lastTouched(dir) {
  // The worktree's own gitdir index/HEAD mtimes, read before any git command can refresh them.
  const dotGit = path.join(dir, ".git");
  let gitDir = dotGit;
  try {
    const t = readFileSync(dotGit, "utf8");
    const m = /^gitdir: (.+)$/m.exec(t);
    if (m) gitDir = path.resolve(dir, m[1].trim());
  } catch {}
  let latest = 0;
  for (const f of ["index", "HEAD", "logs/HEAD"]) {
    try { latest = Math.max(latest, statSync(path.join(gitDir, f)).mtimeMs); } catch {}
  }
  return latest;
}

const snap = processSnapshot();
const rows = [];
for (const name of readdirSync(root).sort()) {
  const dir = path.join(root, name);
  if (!existsSync(path.join(dir, ".git"))) { rows.push({ name, verdict: "keep", why: "not a git checkout" }); continue; }
  const touched = lastTouched(dir);
  const live = agents.some((a) => !a.archivedAt && a.status !== "closed" && inside(dir, a.cwd));
  const user = snap && usedBy(snap, dir);
  const safety = await checkWorktreeDeletionSafety({ worktreePath: dir, baseBranch: null });
  let branch = "";
  try { branch = execFileSync("git", ["--no-optional-locks", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
  const ageH = Math.round((Date.now() - touched) / 3600000);
  let verdict = "remove", why = "clean, pushed or merged, quiet " + ageH + "h";
  if (live) { verdict = "keep"; why = "live agent inside"; }
  else if (!touched) { verdict = "keep"; why = "git activity unreadable"; }
  else if (!snap) { verdict = "keep"; why = "process probe failed"; }
  else if (user) { verdict = "keep"; why = `in use (${user})`; }
  else if (!safety.safe) { verdict = "keep"; why = safety.reason; }
  else if (Date.now() - touched < QUIET_MS) { verdict = "keep"; why = `touched ${ageH}h ago`; }
  rows.push({ name, branch, verdict, why, ageH });
}

let sizes = {};
try {
  const out = execFileSync("du", ["-sk", ...rows.map((r) => path.join(root, r.name))], { encoding: "utf8", maxBuffer: 1 << 24 });
  for (const line of out.trim().split("\n")) { const [kb, p] = line.split("\t"); sizes[path.basename(p)] = Number(kb) / 1048576; }
} catch {}

let removable = 0;
for (const r of rows) {
  if (r.verdict === "remove") removable += sizes[r.name] ?? 0;
  console.log(`${r.verdict.padEnd(6)} ${(sizes[r.name] ?? 0).toFixed(1).padStart(5)}G  ${r.name.padEnd(42)} ${String(r.branch).padEnd(40)} ${r.why}`);
}
console.log(`\n${rows.filter((r) => r.verdict === "remove").length} removable, ${removable.toFixed(1)} GB; ${rows.filter((r) => r.verdict === "keep").length} kept`);

if (apply) {
  for (const r of rows.filter((x) => x.verdict === "remove")) {
    const dir = path.join(root, r.name);
    // The snapshot is minutes old by now: look again right before removing.
    const now = processSnapshot();
    const user = now ? usedBy(now, dir) : "process probe failed";
    if (user) { console.log("kept", r.name, `now in use (${user})`); continue; }
    try {
      execFileSync("git", ["-C", dir, "worktree", "remove", dir], { stdio: "pipe" });
      console.log("removed", r.name);
    } catch (e) {
      console.log("git refused", r.name, String(e.stderr ?? e.message).trim().split("\n")[0]);
    }
  }
}
process.exit(0);
