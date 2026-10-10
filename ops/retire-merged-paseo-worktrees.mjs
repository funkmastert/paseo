// Retire ~/paseo-worktrees/* worktrees whose work has landed, so finished fix branches stop piling
// up in the sidebar and on disk. A worktree is retired only when ALL hold:
//   - its HEAD is fully merged into origin/multi-account-orchestrator (after a fetch);
//   - nothing is uncommitted or untracked (ignored build output like node_modules is fine), except
//     untracked test captures (packages/app/.vitest-attachments/*.png and anything under .artifacts/),
//     which are deleted first; any other dirt keeps the worktree;
//   - no unarchived agent in it is working, and none was active in the last QUIET_MIN minutes;
//   - git hasn't touched it in the last QUIET_MIN minutes (a fresh worktree still waiting for its
//     agent's first commit looks "merged" because HEAD == main).
// Retiring = archive its agents and workspace records, `git worktree remove` (never --force),
// delete the local branch and the merged remote branch. The main checkout (bozeo) is never touched.
// Dry run unless --apply. The sh.bozeo.worktree-retire LaunchAgent runs it with --apply every 30 minutes.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync, readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const apply = process.argv.includes("--apply");
const ROOT = path.join(os.homedir(), "paseo-worktrees");
const MAIN = path.join(ROOT, "bozeo");
const BASE = "origin/multi-account-orchestrator";
const QUIET_MIN = 60;
const now = Date.now();
// GIT_OPTIONAL_LOCKS=0: our own `git status` must not refresh an index and make the worktree look active.
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 120_000, env: GIT_ENV }).trim();
const gitOk = (cwd, ...args) => { try { execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore", timeout: 120_000, env: GIT_ENV }); return true; } catch { return false; } };
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const inside = (dir, p) => { const r = real(p); return r === dir || r.startsWith(dir + "/"); };

// Untracked files vitest and agents' screenshot runs leave behind. Exactly these, nothing nested deeper.
const DISPOSABLE = [/^packages\/app\/\.vitest-attachments\/[^/]+\.png$/, /^\.artifacts\/[^/].*[^/]$/];

/** {ok: true, disposable} when every status entry is an untracked test capture; else {ok: false, why}. Throws if git fails. */
export function classifyDirt(dir) {
  const out = execFileSync("git", ["-C", dir, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf8", timeout: 120_000, env: GIT_ENV });
  const disposable = [];
  for (const entry of out.split("\0").filter(Boolean)) {
    const xy = entry.slice(0, 2);
    const file = entry.slice(3);
    if (xy !== "??" || !DISPOSABLE.some((re) => re.test(file))) return { ok: false, why: `${xy} ${file}` };
    disposable.push(file);
  }
  return { ok: true, disposable };
}

/** Unlink each listed capture. Throws, before deleting anything, if one isn't a plain file or link whose directory resolves inside dir. */
export function deleteDisposable(dir, files) {
  const root = realpathSync(dir);
  const targets = files.map((file) => {
    const abs = path.join(root, file);
    const parent = realpathSync(path.dirname(abs));
    if (parent !== root && !parent.startsWith(`${root}/`)) throw new Error(`${file} resolves outside the worktree`);
    if (lstatSync(abs).isDirectory()) throw new Error(`${file} is a directory`);
    return path.join(parent, path.basename(abs));
  });
  for (const t of targets) unlinkSync(t);
}

/** Every entry of a paged directory read (fetchAgents, fetchWorkspaces): an unpaged call returns only the first 200. */
export async function fetchAll(read) {
  const entries = [];
  let cursor = null;
  for (let page = 0; page < 100; page++) {
    const res = await read({ page: cursor ? { limit: 200, cursor } : { limit: 200 } });
    entries.push(...(res.entries ?? []));
    if (!res.pageInfo) throw new Error("directory read returned no pageInfo");
    if (!res.pageInfo.hasMore) return entries;
    cursor = res.pageInfo.nextCursor;
    if (!cursor) throw new Error("directory read said hasMore without a cursor");
  }
  throw new Error("directory read ran past 100 pages");
}

async function main() {
  const { connectToDaemon } = await import("/Users/tylerthackray/paseo-worktrees/bozeo/packages/cli/dist/utils/client.js");

  git(MAIN, "fetch", "-q", "origin");
  const c = await connectToDaemon({ host: "127.0.0.1:6767" });
  const agents = (await fetchAll((o) => c.fetchAgents(o))).map((e) => e.agent).filter((a) => !a.archivedAt);
  // fetch_workspaces entries carry `id` and `workspaceDirectory` (not `cwd`).
  const workspaces = (await fetchAll((o) => c.fetchWorkspaces(o)))
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
    let dirt;
    try { dirt = classifyDirt(dir); } catch (e) { keep(`git status failed: ${String(e.message).split("\n")[0]}`); continue; }
    if (!dirt.ok) { keep(`uncommitted or untracked files (${dirt.why})`); continue; }
    const gitdir = readFileSync(path.join(dir, ".git"), "utf8").replace(/^gitdir:\s*/, "").trim();
    const lastGit = Math.max(...["index", "HEAD", "logs/HEAD"].map((f) => { try { return statSync(path.join(gitdir, f)).mtimeMs; } catch { return 0; } }));
    if (now - lastGit < QUIET_MIN * 60_000) { keep(`git active ${Math.round((now - lastGit) / 60_000)} min ago`); continue; }
    const here = agents.filter((a) => a.cwd && inside(dir, a.cwd));
    const busy = here.find((a) => ["running", "initializing"].includes(a.status) || now - Date.parse(a.updatedAt ?? 0) < QUIET_MIN * 60_000);
    if (busy) { keep(`agent ${busy.id.slice(0, 8)} is ${busy.status} / recently active`); continue; }
    const wsHere = workspaces.filter((w) => inside(dir, w.cwd));
    const captures = dirt.disposable.length ? `; ${dirt.disposable.length} untracked test capture(s)` : "";
    if (!apply) { results.push(`would retire ${name} (${branch}; ${here.length} agent(s), ${wsHere.length} workspace record(s)${captures})`); continue; }
    if (dirt.disposable.length) {
      // Delete the captures, then insist the tree is clean: anything that appeared meanwhile keeps it.
      try { deleteDisposable(dir, dirt.disposable); } catch (e) { keep(`could not delete test captures: ${e.message}`); continue; }
      let clean = false;
      try { clean = git(dir, "status", "--porcelain", "--untracked-files=all") === ""; } catch {}
      if (!clean) { keep("not clean after deleting test captures (or git status failed)"); continue; }
    }
    for (const a of here) await c.archiveAgent(a.id).catch((e) => results.push(`  archive agent ${a.id.slice(0, 8)} failed: ${e.message}`));
    for (const w of wsHere) await c.archiveWorkspace(w.id).then(() => archivedWs.add(w.id), (e) => results.push(`  archive workspace ${w.id} failed: ${e.message}`));
    if (!gitOk(MAIN, "worktree", "remove", dir)) { keep("git worktree remove refused (left in place)"); continue; }
    gitOk(MAIN, "branch", "-D", branch);
    const remoteGone = gitOk(MAIN, "push", "-q", "origin", "--delete", branch);
    results.push(`retired ${name} (${branch}; archived ${here.length} agent(s), ${wsHere.length} workspace(s)${captures ? `, deleted${captures}` : ""}; remote branch ${remoteGone ? "deleted" : "not deleted"})`);
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
}

// Imported by its test for classifyDirt/deleteDisposable; run as a script, it sweeps.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
