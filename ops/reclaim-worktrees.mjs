// Reclaim Paseo worktrees the done janitor would reclaim, using its own safety check.
// Dry run by default; pass --apply to archive. Skips a worktree with a live agent
// (not archived, not closed) or a pinned workspace, exactly as `paseo doctor` does.
import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { connectToDaemon } from "/Users/tylerthackray/paseo-worktrees/bozeo/packages/cli/dist/utils/client.js";
import { checkWorktreeDeletionSafety } from "/Users/tylerthackray/paseo-worktrees/bozeo/packages/server/dist/server/server/done-janitor-worktree.js";

const apply = process.argv.includes("--apply");
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const inside = (root, p) => p === root || p.startsWith(root + "/");

const root = path.join(os.homedir(), ".paseo", "worktrees");
const dirs = [];
for (const project of readdirSync(root)) {
  let names = [];
  try { names = readdirSync(path.join(root, project)); } catch { continue; }
  for (const name of names) {
    const dir = path.join(root, project, name);
    if (existsSync(path.join(dir, ".git"))) dirs.push(real(dir));
  }
}

const c = await connectToDaemon({ host: "127.0.0.1:6767" });
const agents = (await c.fetchAgents({})).entries.map((e) => e.agent);
const wsPayload = await c.fetchWorkspaces({});
const workspaces = wsPayload.entries ?? wsPayload.workspaces ?? [];

const safe = [];
const kept = {};
for (const dir of dirs) {
  const live = agents.some((a) => !a.archivedAt && a.status !== "closed" && inside(dir, real(a.cwd)));
  if (live) { kept["live agent"] = (kept["live agent"] ?? 0) + 1; continue; }
  const ws = workspaces.map((w) => w.workspace ?? w).filter((w) => w.cwd && real(w.cwd) === dir);
  if (ws.some((w) => w.pinned)) { kept.pinned = (kept.pinned ?? 0) + 1; continue; }
  const s = await checkWorktreeDeletionSafety({ worktreePath: dir, baseBranch: ws[0]?.baseBranch ?? null });
  if (!s.safe) { const r = s.reason.replace(/\d+/g, "N").slice(0, 70); kept[r] = (kept[r] ?? 0) + 1; continue; }
  safe.push(dir);
}

console.log(`${dirs.length} worktrees; ${safe.length} safe to reclaim`);
for (const [r, n] of Object.entries(kept)) console.log(`  kept ${n}: ${r}`);

if (apply) {
  let done = 0; const failed = [];
  for (const dir of safe) {
    try {
      const r = await c.archivePaseoWorktree({ worktreePath: dir, scope: "worktree" });
      if (r?.error) failed.push(`${dir}: ${r.error.message ?? JSON.stringify(r.error)}`);
      else done++;
    } catch (e) { failed.push(`${dir}: ${e.message}`); }
  }
  console.log(`archived ${done}; failed ${failed.length}`);
  for (const f of failed) console.log("  " + f);
} else {
  for (const d of safe) console.log("  " + d.replace(root + "/", ""));
}
await c.close();
process.exit(0);
