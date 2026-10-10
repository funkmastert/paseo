// Retire the orchestrator's own worktrees once their work has landed: clean tree, every commit on a
// remote (the done janitor's own safety check), and no agent running in it. Archives the finished
// agents in each such worktree, then has the daemon remove it. Dry run unless --apply.
// Usage: node retire-merged-worktrees.mjs <projectDir> [--apply]
import { readdirSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { connectToDaemon } from "/Users/tylerthackray/paseo-worktrees/bozeo/packages/cli/dist/utils/client.js";
import { checkWorktreeDeletionSafety } from "/Users/tylerthackray/paseo-worktrees/bozeo/packages/server/dist/server/server/done-janitor-worktree.js";

const root = process.argv[2];
const apply = process.argv.includes("--apply");
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const inside = (r, p) => p === r || p.startsWith(r + "/");

const c = await connectToDaemon({ host: "127.0.0.1:6767" });
const agents = (await c.fetchAgents({})).entries.map((e) => e.agent).filter((a) => !a.archivedAt);
let removed = 0; const kept = [];
for (const name of readdirSync(root).sort()) {
  const dir = real(path.join(root, name));
  if (!existsSync(path.join(dir, ".git"))) continue;
  const here = agents.filter((a) => inside(dir, real(a.cwd)));
  if (here.some((a) => a.status === "running" || a.status === "initializing")) { kept.push(`${name}: agent running`); continue; }
  const s = await checkWorktreeDeletionSafety({ worktreePath: dir, baseBranch: null });
  if (!s.safe) { kept.push(`${name}: ${s.reason}`); continue; }
  if (!apply) { console.log(`would retire ${name} (${here.length} idle agent(s))`); continue; }
  for (const a of here) await c.archiveAgent(a.id).catch((e) => console.log(`  archive ${a.id.slice(0, 8)} failed: ${e.message}`));
  const r = await c.archivePaseoWorktree({ worktreePath: dir, scope: "worktree" }).catch((e) => ({ error: { message: e.message } }));
  if (r?.error) kept.push(`${name}: remove failed: ${r.error.message}`);
  else { removed++; console.log(`retired ${name} (archived ${here.length} agent(s))`); }
}
console.log(`${apply ? "retired" : "would retire"} ${apply ? removed : ""}; kept ${kept.length}:`);
for (const k of kept) console.log("  " + k);
await c.close();
process.exit(0);
