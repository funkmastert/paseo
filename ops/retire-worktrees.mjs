// Archive every non-running agent whose cwd is inside the given worktree dirs.
// Exits 2 (worktree must be kept) if any agent there is still running.
import { connectToDaemon } from "/Users/tylerthackray/paseo-worktrees/bozeo/packages/cli/dist/utils/client.js";
const dirs = process.argv.slice(2);
const c = await connectToDaemon({ host: "127.0.0.1:6767" });
const r = await c.fetchAgents({});
let archived = 0; const running = [];
for (const e of r.entries) {
  const a = e.agent;
  if (a.archivedAt || !dirs.some((d) => a.cwd === d || a.cwd.startsWith(d + "/"))) continue;
  if (a.status === "running") { running.push(a.id.slice(0, 8)); continue; }
  await c.archiveAgent(a.id); archived++;
}
console.log(`archived ${archived}; still running: ${running.join(",") || "none"}`);
process.exit(running.length ? 2 : 0);
