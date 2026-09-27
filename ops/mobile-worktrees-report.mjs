// Read-only report over ~/mobile-worktrees: which checkouts could go without losing anything.
// Safe = the done janitor's own check (linked worktree, clean tree, every commit pushed or merged)
// AND no live agent inside AND not touched for 48h. Pass --apply to `git worktree remove` the safe
// ones (branches are kept; git itself refuses a dirty tree).
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { connectToDaemon } from "/Users/tylerthackray/paseo-worktrees/bozeo/packages/cli/dist/utils/client.js";
import { checkWorktreeDeletionSafety } from "/Users/tylerthackray/paseo-worktrees/bozeo/packages/server/dist/server/server/done-janitor-worktree.js";

const apply = process.argv.includes("--apply");
const QUIET_MS = 48 * 3600 * 1000;
const root = path.join(os.homedir(), "mobile-worktrees");
const inside = (r, p) => p === r || p.startsWith(r + "/");

const c = await connectToDaemon({ host: "127.0.0.1:6767" });
const agents = (await c.fetchAgents({})).entries.map((e) => e.agent);
await c.close();

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

const rows = [];
for (const name of readdirSync(root).sort()) {
  const dir = path.join(root, name);
  if (!existsSync(path.join(dir, ".git"))) { rows.push({ name, verdict: "keep", why: "not a git checkout" }); continue; }
  const touched = lastTouched(dir);
  const live = agents.some((a) => !a.archivedAt && a.status !== "closed" && inside(dir, a.cwd));
  const safety = await checkWorktreeDeletionSafety({ worktreePath: dir, baseBranch: null });
  let branch = "";
  try { branch = execFileSync("git", ["--no-optional-locks", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
  const ageH = Math.round((Date.now() - touched) / 3600000);
  let verdict = "remove", why = "clean, pushed or merged, quiet " + ageH + "h";
  if (live) { verdict = "keep"; why = "live agent inside"; }
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
    try {
      execFileSync("git", ["-C", dir, "worktree", "remove", dir], { stdio: "pipe" });
      console.log("removed", r.name);
    } catch (e) {
      console.log("git refused", r.name, String(e.stderr ?? e.message).trim().split("\n")[0]);
    }
  }
}
process.exit(0);
