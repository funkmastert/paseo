// Failover watch: a deterministic stand-in for the daemon's account failover until the
// flexible-placement build is running. Delete it and its LaunchAgent (sh.bozeo.failover-watch)
// once `agents.accountFailover.collapseToSharedAccount` exists in the running daemon.
//
// Rules — docs/account-failover.md on that branch, plus Tyler's 2026-09-24 asks:
//  - An account is dead when its five_hour or weekly window is at 100%, and usable when both are
//    under 90%. Model-specific windows (weekly_model_*) are ignored.
//  - Isolation is a preference, not a rule. Leaders (no paseo.parent-agent-id label) go to the
//    leader account first; children go to workers by priority first; either falls back to any
//    usable account, so leaders and workers can share one when that is all there is.
//  - An agent on a dead account whose last turn was cut off (status `error`) moves and is resumed.
//    A turn still "running" with no progress for 15 minutes is dead: it is interrupted, then moved.
//    An idle leader moves without a prompt, so it can answer Tyler. An idle child stays until asked.
//  - Idle agents are never moved back when a worker regains budget: every move rebuilds the
//    agent's prompt cache, and new spawns already land on the worker by themselves.
//  - "already holds agent ... for session" means that session lives under another record: skip it.
//  - Daemon restart (e.g. a Bozeo relaunch): agents that were running when the daemon went down and
//    are idle or errored when it comes back get a resume prompt, 3 per sweep. Same account and model,
//    so their cache survives. Stand-in for restart recovery (W1.2) until that ships.
// Nothing here notifies anyone; it logs to ~/Library/Logs/Bozeo/failover-watch.log.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectToDaemon } from "/Users/tylerthackray/paseo-worktrees/bozeo/packages/cli/dist/utils/client.js";

const HOME = os.homedir();
const STATE_PATH = path.join(HOME, "bozeo-ops", "failover-watch.state.json");
const SWEEP_MS = 60_000;
const STALL_MS = 15 * 60_000;
const DEAD_PCT = 100;
const USABLE_PCT = 90;
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const RESUMES_PER_SWEEP = 3;
const restartPrompt =
  "The Paseo daemon restarted (Bozeo was relaunched) while you were mid-turn, which cut your turn off. Your worktree and conversation are intact. Re-check `git status`, then continue your task from where you stopped. An interrupted tool call is not a stop instruction: retry it and carry on.";
const resumePrompt = (from, to) =>
  `Your Claude account (\`${from}\`) ran out of budget mid-task, so you were moved to \`${to}\`. Your worktree and conversation are intact. Re-check \`git status\`, then continue your task from where you stopped. An interrupted tool call is not a stop instruction: retry it and carry on.`;

const state = existsSync(STATE_PATH)
  ? JSON.parse(readFileSync(STATE_PATH, "utf8"))
  : { skip: {}, progress: {} };
state.lastRunning ??= [];
state.restartQueue ??= [];
state.daemonDown ??= false;

/** Pool entries from config: [{ id, role, priority }]. */
function readPool() {
  const config = JSON.parse(readFileSync(path.join(HOME, ".paseo", "config.json"), "utf8"));
  const providers = config.agents?.providers ?? {};
  const pool = [];
  for (const [id, entry] of Object.entries(providers)) {
    const ap = entry?.params?.accountPool;
    if (ap?.role === "leader" || ap?.role === "worker") pool.push({ id, role: ap.role, priority: ap.priority ?? 0 });
  }
  if (!pool.some((p) => p.role === "leader")) pool.push({ id: "claude", role: "leader", priority: 0 });
  return pool;
}

function accountHealth(usage) {
  const health = new Map();
  for (const p of usage.providers ?? []) {
    const windows = (p.windows ?? []).filter((w) => w.id === "five_hour" || w.id === "weekly");
    const worst = Math.max(0, ...windows.map((w) => w.usedPct ?? 0));
    health.set(p.providerId ?? p.provider ?? p.id, { worst, dead: worst >= DEAD_PCT, usable: windows.length > 0 && worst < USABLE_PCT });
  }
  return health;
}

function pickTarget(isLeader, pool, health, exclude) {
  const usable = pool.filter((p) => p.id !== exclude && health.get(p.id)?.usable);
  const leaders = usable.filter((p) => p.role === "leader");
  const workers = usable.filter((p) => p.role === "worker").sort((a, b) => a.priority - b.priority);
  const order = isLeader ? [...leaders, ...workers] : [...workers, ...leaders];
  return order[0]?.id ?? null;
}

async function sweep() {
  const c = await connectToDaemon({ host: "127.0.0.1:6767" });
  try {
    const pool = readPool();
    const poolIds = new Set(pool.map((p) => p.id));
    const health = accountHealth(await c.listProviderUsage());
    const agents = (await c.fetchAgents({})).entries.map((e) => e.agent);
    const byId = new Map(agents.map((a) => [a.id, a]));

    if (state.daemonDown) {
      // First sweep after the daemon came back: queue whatever it cut off.
      state.restartQueue = state.lastRunning.filter((id) => !state.restartQueue.includes(id)).concat(state.restartQueue);
      state.daemonDown = false;
      if (state.restartQueue.length) log(`daemon is back; ${state.restartQueue.length} agent(s) were running when it went down`);
    }
    let resumed = 0;
    while (state.restartQueue.length && resumed < RESUMES_PER_SWEEP) {
      const id = state.restartQueue.shift();
      const a = byId.get(id);
      if (!a || a.archivedAt || a.status === "running" || a.status === "closed") continue;
      try {
        await c.sendAgentMessage(id, restartPrompt);
        resumed++;
        log(`${id.slice(0, 8)} "${a.title}": resumed after daemon restart`);
      } catch (e) {
        log(`${id.slice(0, 8)}: restart resume failed: ${e.message}`);
      }
    }
    state.lastRunning = agents.filter((a) => !a.archivedAt && a.status === "running").map((a) => a.id);

    for (const a of agents) {
      if (a.archivedAt || !poolIds.has(a.provider) || state.skip[a.id]) continue;
      if (a.status === "closed" || a.status === "initializing") continue;
      const isLeader = !a.labels?.["paseo.parent-agent-id"];
      const here = health.get(a.provider);

      let target = null;
      let resume = false;
      if (here?.dead) {
        if (a.status === "running") {
          const seen = state.progress[a.id];
          if (!seen || seen.updatedAt !== a.updatedAt) {
            state.progress[a.id] = { updatedAt: a.updatedAt, since: Date.now() };
          } else if (Date.now() - seen.since > STALL_MS) {
            log(`${a.id.slice(0, 8)} "${a.title}": dead turn on ${a.provider}; interrupting`);
            await c.cancelAgent(a.id).catch((e) => log(`  interrupt failed: ${e.message}`));
          }
          continue;
        }
        if (a.status === "error") {
          target = pickTarget(isLeader, pool, health, a.provider);
          resume = true;
        } else if (isLeader) {
          target = pickTarget(true, pool, health, a.provider);
        }
      }
      // Idle children are NOT returned to a worker when one regains budget: a move rebuilds the
      // agent's whole prompt cache on its next turn, and most idle children never run again.
      // New spawns already land on the worker by themselves.
      if (!target) continue;

      try {
        await c.moveAgentToProvider(a.id, target);
        if (resume) await c.sendAgentMessage(a.id, resumePrompt(a.provider, target));
        delete state.progress[a.id];
        log(`${a.id.slice(0, 8)} "${a.title}" (${isLeader ? "leader" : "child"}): ${a.provider} -> ${target}${resume ? ", resumed" : ""}`);
      } catch (e) {
        if (/already holds agent/.test(e.message)) {
          state.skip[a.id] = "session lives under another record";
          log(`${a.id.slice(0, 8)} "${a.title}": session already live elsewhere; skipping from now on`);
        } else {
          log(`${a.id.slice(0, 8)} "${a.title}": move to ${target} failed: ${e.message}`);
        }
      }
    }
  } finally {
    await c.close().catch(() => {});
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
  }
}

log("failover watch started");
for (;;) {
  try {
    await sweep();
  } catch (e) {
    if (/ECONNREFUSED|ECONNRESET|socket|closed|timed? ?out/i.test(e.message) && !state.daemonDown) {
      state.daemonDown = true;
      writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
      log(`daemon unreachable (${e.message}); ${state.lastRunning.length} agent(s) were running`);
    } else {
      log(`sweep failed: ${e.message}`);
    }
  }
  await new Promise((r) => setTimeout(r, SWEEP_MS));
}
