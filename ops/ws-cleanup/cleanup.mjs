// Workspace cleanup. Dry run unless --apply.
// Never touches: pinned workspaces, workspaces with a running agent, the orchestrator's own workspace,
// the fork integration checkout. Archiving a workspace also archives its (idle) agents. Only a
// Paseo-owned worktree (~/.paseo/worktrees) has its directory deleted by archive; before that, HEAD
// gets a backup ref and untracked + ignored files (minus build dirs) are tarred to ./backup/.
// External worktrees keep their directory, except this orchestrator's own merged tracks under
// ~/paseo-worktrees, which are removed with `git worktree remove`.
import { connectToDaemon } from "/Users/tylerthackray/paseo-worktrees/bozeo/packages/cli/dist/utils/client.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const APPLY = process.argv.includes("--apply");
const HOME = os.homedir();
const STAMP = "ws-cleanup-2026-09-29";
const BACKUP = path.join(HOME, "bozeo-ops/ws-cleanup/backup");
const SELF = process.env.SELF_AGENT_ID ?? "";
const KEEP_DIRS = [path.join(HOME, "paseo-worktrees/bozeo")];
const IDLE_H = 72, EMPTY_IDLE_H = 24;
const TEMP_TITLE = /^(Remediate|Judge|Stop orphaned|Address token audit)/;
const BUILD_DIRS = ["node_modules", ".gradle", "build", "DerivedData", "dist", ".expo", "target", ".next", "Pods", ".turbo", ".cache"];
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const inside = (r, p) => p === r || p.startsWith(r + "/");
const git = (cwd, args) => { try { return execFileSync("git", ["--no-optional-locks", "-C", cwd, ...args], { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
const OWNED = real(path.join(HOME, ".paseo/worktrees"));
const MINE = real(path.join(HOME, "paseo-worktrees"));

const c = await connectToDaemon({ host: "127.0.0.1:6767" });
const { entries } = await c.fetchWorkspaces({});
const agents = (await c.fetchAgents({})).entries.map((e) => e.agent).filter((a) => !a.archivedAt);
const now = Date.now();
const plan = [];
for (const w of entries) {
  const dir = w.workspaceDirectory; const exists = !!dir && existsSync(dir); const rdir = exists ? real(dir) : dir;
  const here = agents.filter((a) => a.workspaceId === w.id);
  const live = here.filter((a) => ["running", "initializing"].includes(a.status));
  // Activity = the newest of every signal we have. A workspace with no signal at all counts as active (fail safe).
  const sig = [Date.parse(w.activityAt ?? 0) || 0, Date.parse(w.statusEnteredAt ?? 0) || 0, ...here.map((a) => Date.parse(a.updatedAt ?? 0) || 0)];
  if (exists) {
    try { sig.push(statSync(dir).mtimeMs); } catch {}
    const ct = git(dir, ["log", "-1", "--format=%ct"]); if (ct) sig.push(Number(ct) * 1000);
  }
  const lastMs = Math.max(...sig);
  const idleH = lastMs ? (now - lastMs) / 3.6e6 : 0;
  const title = w.title || w.name || "";
  const isGit = exists && git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";
  const isWorktree = isGit && w.workspaceKind === "worktree";
  const dirty = isGit ? (git(dir, ["status", "--porcelain"]) ?? "x").split("\n").filter(Boolean).length : 0;
  const unpushed = isGit ? Number(git(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes"]) ?? 1) : 0;
  let merged = false;
  if (isWorktree && dirty === 0 && unpushed === 0) {
    for (const b of ["origin/multi-account-orchestrator", "origin/HEAD", "origin/main", "origin/master", "origin/develop"]) {
      if (git(dir, ["rev-parse", "--verify", "-q", b]) && git(dir, ["merge-base", "--is-ancestor", "HEAD", b]) !== null) { merged = true; break; }
    }
  }
  const owned = exists && inside(OWNED, rdir);
  const mineTrack = exists && isWorktree && inside(MINE, rdir) && !KEEP_DIRS.map(real).includes(rdir);
  const temp = TEMP_TITLE.test(title) || (here.length > 0 && here.every((a) => a.labels?.["paseo.remediation"]));
  let v = null, why = "";
  if (w.pinnedAt) why = "pinned";
  else if (here.some((a) => a.id === SELF)) why = "orchestrator's own";
  else if (live.length) why = `${live.length} running`;
  else if (exists && KEEP_DIRS.map(real).includes(rdir)) why = "fork integration checkout";
  else if (!exists) { v = "archive"; why = "directory gone"; }
  else if (temp) { v = "archive"; why = "self-heal temp workspace, nothing running"; }
  else if (merged && mineTrack) { v = "archive+remove"; why = `merged track (${Math.round(idleH)}h idle)`; }
  else if (merged && owned && idleH > 24) { v = "archive"; why = `merged, idle ${Math.round(idleH)}h`; }
  else if (here.length === 0 && idleH > EMPTY_IDLE_H && !isGit) { v = "archive"; why = `no agents, idle ${Math.round(idleH / 24)}d`; }
  else if (idleH > IDLE_H) { v = "archive"; why = `idle ${Math.round(idleH / 24)}d${dirty || unpushed ? `, ${dirty} dirty/${unpushed} unpushed` : ", clean+pushed"}`; }
  else why = `active ${Math.round(idleH)}h ago`;
  plan.push({ id: w.id, project: w.projectDisplayName, kind: w.workspaceKind, title, dir, owned, mineTrack, dirty, unpushed, merged, agents: here.length, v, why });
}
const act = plan.filter((p) => p.v), keep = plan.filter((p) => !p.v);
console.log(`${APPLY ? "APPLYING" : "DRY RUN"}: ${act.length} to archive, ${keep.length} kept of ${plan.length}\n`);
for (const p of act) console.log(`  ${p.v.padEnd(15)} ${p.id.slice(4, 12)} ${(p.project || "").slice(0, 16).padEnd(16)} ${p.title.slice(0, 34).padEnd(34)} ${p.owned ? "[dir deleted]" : p.v === "archive+remove" ? "[worktree removed]" : "[dir kept]"} ${p.why}`);
console.log("\nKEPT:"); for (const p of keep) console.log(`  ${p.id.slice(4, 12)} ${(p.project || "").slice(0, 16).padEnd(16)} ${p.title.slice(0, 34).padEnd(34)} ${p.why}`);
const log = [];
if (APPLY) {
  mkdirSync(BACKUP, { recursive: true });
  for (const p of act) {
    try {
      if (p.owned || p.v === "archive+remove") {
        const slug = path.basename(p.dir);
        const head = git(p.dir, ["rev-parse", "HEAD"]);
        if (head) git(p.dir, ["update-ref", `refs/backup/${STAMP}/${slug}`, head]);
        const files = (git(p.dir, ["ls-files", "--others", "-z"]) ?? "").split("\0").filter(Boolean)
          .filter((f) => !BUILD_DIRS.some((b) => f === b || f.startsWith(b + "/") || f.includes("/" + b + "/")));
        if (files.length) {
          const list = path.join(BACKUP, `${slug}.files`); writeFileSync(list, files.join("\n"));
          execFileSync("tar", ["-czf", path.join(BACKUP, `${slug}.tgz`), "-C", p.dir, "-T", list], { timeout: 300000 });
          const mb = statSync(path.join(BACKUP, `${slug}.tgz`)).size / 1e6;
          if (mb > 500) { log.push(`HELD ${p.id}: backup ${mb.toFixed(0)} MB, too big to trust; not archived`); continue; }
        }
        log.push(`backup ${slug}: ref refs/backup/${STAMP}/${slug}=${head?.slice(0, 10)}, ${files.length} untracked/ignored file(s)`);
      }
      const r = await c.archiveWorkspace(p.id);
      if (r?.error) { log.push(`FAIL ${p.id}: ${r.error}`); continue; }
      if (p.v === "archive+remove" && existsSync(p.dir)) {
        const common = git(p.dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
        execFileSync("git", ["-C", path.dirname(common), "worktree", "remove", "--force", p.dir], { timeout: 120000 });
      }
      log.push(`archived ${p.id} ${p.title}${p.v === "archive+remove" ? " + worktree removed" : ""}`);
    } catch (e) { log.push(`FAIL ${p.id}: ${String(e.message).split("\n")[0]}`); }
  }
  const after = await c.fetchWorkspaces({});
  for (const ep of after.emptyProjects ?? []) {
    try { await c.removeProject(ep.projectId); log.push(`removed empty project ${ep.projectDisplayName}`); }
    catch (e) { log.push(`FAIL project ${ep.projectDisplayName}: ${String(e.message).split("\n")[0]}`); }
  }
  console.log("\n" + log.join("\n"));
}
writeFileSync(path.join(HOME, `bozeo-ops/ws-cleanup/${APPLY ? "applied" : "plan"}.json`), JSON.stringify({ at: new Date().toISOString(), plan, log }, null, 1));
await c.close(); process.exit(0);
