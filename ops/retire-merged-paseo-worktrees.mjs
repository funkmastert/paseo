// Retire ~/paseo-worktrees/* worktrees whose work has landed, so finished fix branches stop piling
// up in the sidebar and on disk. A worktree is retired only when ALL hold:
//   - its HEAD is fully merged into origin/multi-account-orchestrator (after a fetch);
//   - nothing is uncommitted or untracked (ignored build output like node_modules is fine);
//   - no unarchived agent in it is working, and none was active in the last QUIET_MIN minutes;
//   - git hasn't touched it in the last QUIET_MIN minutes (a fresh worktree still waiting for its
//     agent's first commit looks "merged" because HEAD == main).
// Retiring = archive its agents and workspace records, `git worktree remove` (never --force),
// delete the local branch and the merged remote branch. The main checkout (bozeo) is never touched.
// Dry run unless --apply. disk-guard runs it with --apply every sweep.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectToDaemon } from "/Users/tylerthackray/paseo-worktrees/bozeo/packages/cli/dist/utils/client.js";

const apply = process.argv.includes("--apply");
const ROOT = path.join(os.homedir(), "paseo-worktrees");
const MAIN = path.join(ROOT, "bozeo");
const BASE = "origin/multi-account-orchestrator";
const QUIET_MIN = 60;
const now = Date.now();
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 120_000 }).trim();
const gitOk = (cwd, ...args) => { try { execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore", timeout: 120_000 }); return true; } catch { return false; } };
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const inside = (dir, p) => { const r = real(p); return r === dir || r.startsWith(dir + "/"); };

git(MAIN, "fetch", "-q", "origin");
const c = await connectToDaemon({ host: "127.0.0.1:6767" });
const agents = (await c.fetchAgents({})).entries.map((e) => e.agent).filter((a) => !a.archivedAt);
const wsResp = await c.fetchWorkspaces({});
// fetch_workspaces entries carry `id` and `workspaceDirectory` (not `cwd`).
const workspaces = (wsResp.entries ?? [])
  .filter((w) => typeof w.id === "string" && typeof w.workspaceDirectory === "string" && !w.archivingAt)
  .map((w) => ({ id: w.id, cwd: w.workspaceDirectory }));

const results = [];
const archivedWs = new Set();
for (const name of readdirSync(ROOT).sort()) {
  const dir = real(path.join(ROOT, name));
  if (dir === real(MAIN) || !existsSync(path.join(dir, ".git"))) continue;
  const keep = (why) => results.push(`keep    ${name}: ${why}`);
  let branch, head;
  try { branch = git(dir, "rev-parse", "--abbrev-ref", "HEAD"); head = git(dir, "rev-parse", "HEAD"); } catch { keep("not readable by git"); continue; }
  if (!gitOk(MAIN, "merge-base", "--is-ancestor", head, BASE)) { keep(`not merged into ${BASE}`); continue; }
  if (git(dir, "status", "--porcelain", "--untracked-files=all") !== "") { keep("uncommitted or untracked files"); continue; }
  const gitdir = readFileSync(path.join(dir, ".git"), "utf8").replace(/^gitdir:\s*/, "").trim();
  const lastGit = Math.max(...["index", "HEAD", "logs/HEAD"].map((f) => { try { return statSync(path.join(gitdir, f)).mtimeMs; } catch { return 0; } }));
  if (now - lastGit < QUIET_MIN * 60_000) { keep(`git active ${Math.round((now - lastGit) / 60_000)} min ago`); continue; }
  const here = agents.filter((a) => a.cwd && inside(dir, a.cwd));
  const busy = here.find((a) => ["running", "initializing"].includes(a.status) || now - Date.parse(a.updatedAt ?? 0) < QUIET_MIN * 60_000);
  if (busy) { keep(`agent ${busy.id.slice(0, 8)} is ${busy.status} / recently active`); continue; }
  const wsHere = workspaces.filter((w) => inside(dir, w.cwd));
  if (!apply) { results.push(`would retire ${name} (${branch}; ${here.length} agent(s), ${wsHere.length} workspace record(s))`); continue; }
  for (const a of here) await c.archiveAgent(a.id).catch((e) => results.push(`  archive agent ${a.id.slice(0, 8)} failed: ${e.message}`));
  for (const w of wsHere) await c.archiveWorkspace(w.id).then(() => archivedWs.add(w.id), (e) => results.push(`  archive workspace ${w.id} failed: ${e.message}`));
  if (!gitOk(MAIN, "worktree", "remove", dir)) { keep("git worktree remove refused (left in place)"); continue; }
  gitOk(MAIN, "branch", "-D", branch);
  const remoteGone = gitOk(MAIN, "push", "-q", "origin", "--delete", branch);
  results.push(`retired ${name} (${branch}; archived ${here.length} agent(s), ${wsHere.length} workspace(s); remote branch ${remoteGone ? "deleted" : "not deleted"})`);
}
// Workspace records left pointing at a ~/paseo-worktrees directory that no longer exists (a
// retire that lost its daemon connection, or a worktree removed by hand) are archived too.
for (const w of workspaces) {
  if (archivedWs.has(w.id) || !w.cwd.startsWith(ROOT + "/") || w.cwd === MAIN || existsSync(w.cwd)) continue;
  if (agents.some((a) => a.cwd && a.cwd.startsWith(w.cwd) && ["running", "initializing"].includes(a.status))) continue;
  if (!apply) { results.push(`would archive orphan workspace ${w.id} (${path.basename(w.cwd)} is gone)`); continue; }
  await c.archiveWorkspace(w.id).then(
    () => results.push(`archived orphan workspace ${w.id} (${path.basename(w.cwd)} is gone)`),
    (e) => results.push(`  archive orphan workspace ${w.id} failed: ${e.message}`),
  );
}
console.log(`${new Date().toISOString()} ${apply ? "APPLY" : "dry run"}`);
for (const r of results) console.log(r);
await c.close();
process.exit(0);
