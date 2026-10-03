// Dry-run inventory of every active workspace: what it is, whether anything could be lost, and a verdict.
import { connectToDaemon } from "/Users/tylerthackray/paseo-worktrees/bozeo/packages/cli/dist/utils/client.js";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
const HOME = os.homedir();
const IDLE_H = Number(process.env.IDLE_H ?? 72);
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const inside = (r, p) => p === r || p.startsWith(r + "/");
const git = (cwd, args) => { try { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
const c = await connectToDaemon({ host: "127.0.0.1:6767" });
const { entries, emptyProjects } = await c.fetchWorkspaces({});
const agents = (await c.fetchAgents({})).entries.map((e) => e.agent).filter((a) => !a.archivedAt);
const me = process.env.SELF_AGENT_ID || "";
const now = Date.now();
const rows = [];
for (const w of entries) {
  const dir = w.workspaceDirectory;
  const exists = !!dir && existsSync(dir);
  const rdir = exists ? real(dir) : dir;
  const here = agents.filter((a) => a.cwd && inside(rdir, real(a.cwd)));
  const live = here.filter((a) => ["running", "initializing"].includes(a.status));
  const lastAgentMs = Math.max(0, ...here.map((a) => Date.parse(a.updatedAt ?? a.lastActivityAt ?? 0) || 0));
  const actMs = Math.max(Date.parse(w.activityAt ?? 0) || 0, Date.parse(w.statusEnteredAt ?? 0) || 0, lastAgentMs);
  const idleH = actMs ? (now - actMs) / 3.6e6 : Infinity;
  let dirty = null, unpushed = null, branch = null, isGit = false;
  if (exists && git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true") {
    isGit = true;
    branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const st = git(dir, ["status", "--porcelain", "--untracked-files=normal"]);
    dirty = st === null ? null : st.split("\n").filter(Boolean).length;
    const up = git(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
    unpushed = up === null ? null : Number(up);
  }
  const paseoOwned = !!dir && inside(real(`${HOME}/.paseo/worktrees`), rdir);
  const hasMe = me && here.some((a) => a.id === me);
  let verdict, why;
  if (w.pinnedAt) { verdict = "KEEP"; why = "pinned"; }
  else if (hasMe) { verdict = "KEEP"; why = "contains the orchestrator itself"; }
  else if (live.length) { verdict = "KEEP"; why = `${live.length} agent(s) running`; }
  else if (!exists) { verdict = "ARCHIVE"; why = "directory gone"; }
  else if (idleH < IDLE_H) { verdict = "KEEP"; why = `active ${idleH.toFixed(0)}h ago`; }
  else if (!isGit) { verdict = "ARCHIVE"; why = `not a git dir, idle ${Math.round(idleH / 24)}d`; }
  else if ((dirty ?? 1) > 0 || (unpushed ?? 1) > 0) { verdict = paseoOwned ? "HOLD" : "ARCHIVE-KEEPDIR"; why = `idle ${Math.round(idleH / 24)}d but ${dirty ?? "?"} dirty / ${unpushed ?? "?"} unpushed${paseoOwned ? " (dir would be deleted)" : " (dir is kept on disk)"}`; }
  else { verdict = "ARCHIVE"; why = `idle ${Math.round(idleH / 24)}d, clean, pushed`; }
  rows.push({ id: w.id, project: w.projectDisplayName, kind: w.workspaceKind, title: w.title || w.name || "", dir, paseoOwned, branch, dirty, unpushed, agents: here.length, live: live.length, idleH: Number.isFinite(idleH) ? Math.round(idleH) : null, verdict, why });
}
writeFileSync(new URL("./inventory.json", import.meta.url), JSON.stringify({ at: new Date().toISOString(), idleHours: IDLE_H, rows, emptyProjects }, null, 1));
const by = {}; for (const r of rows) (by[r.verdict] ??= []).push(r);
for (const v of ["ARCHIVE", "ARCHIVE-KEEPDIR", "HOLD", "KEEP"]) {
  const list = by[v] ?? [];
  console.log(`\n=== ${v} (${list.length})`);
  for (const r of list.sort((a, b) => (a.project || "").localeCompare(b.project || ""))) console.log(`  ${r.id.slice(4, 12)} ${(r.project || "?").slice(0, 16).padEnd(16)} ${String(r.kind).slice(0, 9).padEnd(9)} ${(r.title || "").slice(0, 38).padEnd(38)} ${r.why}`);
}
console.log(`\nempty projects: ${emptyProjects?.length ?? 0}`);
await c.close(); process.exit(0);
