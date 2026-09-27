// Move agents stranded on an exhausted Claude account to one that can run them, then resume them.
// A deterministic stopgap for the pool's flexible-placement and failover-return logic, which is
// built but not yet in the running daemon.
//
// The daemon refuses to move an agent mid-turn, so each move waits for its turn to end. A turn
// that stays "running" with no progress for STALL_MS after its move is due is dead (its account
// can't serve it); only then is it interrupted, which loses nothing.
//
// Usage: node rehome.mjs <plan.json>   plan: [{ id, to, notBefore?: ISO, label, resume?: false }]
// An id may appear twice (move now, move back later); entries run in order per id.
import { readFileSync, writeFileSync } from "node:fs";
import { connectToDaemon } from "/Users/tylerthackray/paseo-worktrees/bozeo/packages/cli/dist/utils/client.js";

const planPath = process.argv[2];
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const STALL_MS = 15 * 60_000;
const DEADLINE = Date.now() + 8 * 3600_000;
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const resumePrompt = (to) =>
  `Your Claude account ran out of budget mid-task and you were moved to the \`${to}\` account. Your worktree and conversation are intact. Re-check \`git status\`, then continue your task from where you stopped. An interrupted tool call is not a stop instruction: retry it and carry on.`;

const state = new Map(plan.map((p, i) => [i, { done: false, lastUpdated: null, stalledSince: null, failures: 0 }]));

while (Date.now() < DEADLINE && [...state.values()].some((s) => !s.done)) {
  let c;
  try {
    c = await connectToDaemon({ host: "127.0.0.1:6767" });
    const agents = new Map((await c.fetchAgents({})).entries.map((e) => [e.agent.id, e.agent]));
    for (const [i, p] of plan.entries()) {
      const s = state.get(i);
      if (s.done) continue;
      // An earlier entry for the same agent goes first.
      if (plan.some((q, j) => j < i && q.id === p.id && !state.get(j).done)) continue;
      if (p.notBefore && Date.now() < Date.parse(p.notBefore)) continue;
      const a = agents.get(p.id);
      if (!a || a.archivedAt) {
        log(`${p.label}: gone or archived; skipping`);
        s.done = true;
        continue;
      }
      if (a.provider === p.to) {
        log(`${p.label}: already on ${p.to}`);
        s.done = true;
        continue;
      }
      if (a.status === "running") {
        if (a.updatedAt !== s.lastUpdated) {
          s.lastUpdated = a.updatedAt;
          s.stalledSince = Date.now();
        } else if (Date.now() - s.stalledSince > STALL_MS) {
          log(`${p.label}: dead turn on ${a.provider} (no progress for 15 min); interrupting`);
          await c.cancelAgent(p.id).catch((e) => log(`${p.label}: interrupt failed: ${e.message}`));
        }
        continue;
      }
      // One agent's refusal must not stall the rest of the plan.
      try {
        await c.moveAgentToProvider(p.id, p.to);
        if (p.resume !== false) await c.sendAgentMessage(p.id, resumePrompt(p.to));
        log(`${p.label}: moved ${a.provider} -> ${p.to}${p.resume !== false ? " and resumed" : ""}`);
        s.done = true;
      } catch (e) {
        s.failures += 1;
        log(`${p.label}: move failed (${s.failures}/3): ${e.message}`);
        if (s.failures >= 3) s.done = true;
      }
    }
  } catch (e) {
    log(`retrying after error: ${e.message}`);
  } finally {
    await c?.close().catch(() => {});
  }
  writeFileSync(planPath + ".state", JSON.stringify([...state.entries()], null, 1));
  await new Promise((r) => setTimeout(r, 15_000));
}
log([...state.values()].every((s) => s.done) ? "all rehomed" : "deadline reached with agents still pending");
process.exit(0);
