// Wakes the Bozeo orchestrator when the account pool comes back after every account capped.
// Agents a cap cuts off stay stranded until an account resets and someone resumes them (plan in
// ~/bozeo-ops/jev-build-STATE.md). It fires on the transition, not on a level: the pool is
// "capped" once every account's weekly window is at 95% or more, and "back" once any account is
// under 90% (95% would be budget in name only; 99% woke the orchestrator into a still-capped pool
// on 2026-10-01). The last state is kept in budget-resume-watch.state, so it re-arms itself after
// every episode. A missing reading (usage unavailable) changes nothing. Checking costs no tokens;
// only the message it sends does. launchd runs it every 15 minutes (sh.bozeo.budget-resume-watch).
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { connectToDaemon } from "/Users/tylerthackray/paseo-worktrees/bozeo/packages/cli/dist/utils/client.js";

const ORCHESTRATOR = "e8e58ad7-d139-45dd-99ea-72553a62eff6";
const ACCOUNTS = ["claude", "claude-backup", "claude-personal"];
const STATE = path.join(os.homedir(), "bozeo-ops", "budget-resume-watch.state");
const CAPPED_AT = 95;
const BACK_UNDER = 90;

// Atomic (temp file + rename) and retried: a state write that fails after a successful send would
// leave "capped" behind and send a second wake-up on the next run.
function saveState(value) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      writeFileSync(`${STATE}.tmp`, `${value}\n`);
      renameSync(`${STATE}.tmp`, STATE);
      return;
    } catch (error) {
      if (attempt === 3) console.error(`${new Date().toISOString()} STATE WRITE FAILED (${value}): ${error.message}`);
    }
  }
}

const previous = (() => {
  try {
    return readFileSync(STATE, "utf8").trim();
  } catch {
    return "ok";
  }
})();

const c = await connectToDaemon({ host: "127.0.0.1:6767" });
const r = await c.listProviderUsage();
await c.close();
const weekly = (id) => r.providers?.find((p) => p.providerId === id)?.windows?.find((w) => w.id === "weekly")?.usedPct;
const readings = Object.fromEntries(ACCOUNTS.map((id) => [id, weekly(id)]));
const line = ACCOUNTS.map((id) => `${id}=${readings[id]}`).join(" ");
const stamp = new Date().toISOString();
console.log(`${stamp} ${previous} ${line}`);

const known = ACCOUNTS.every((id) => typeof readings[id] === "number");
const back = ACCOUNTS.find((id) => typeof readings[id] === "number" && readings[id] < BACK_UNDER);
if (known && !back && ACCOUNTS.every((id) => readings[id] >= CAPPED_AT)) {
  if (previous !== "capped") saveState("capped");
  process.exit(0);
}
if (previous !== "capped" || !back) process.exit(0);

const why = `${back} has weekly budget again (${readings[back]}%)`;
const prompt = `Budget watch: ${why}. Readings: ${line}. Agents the cap cut off are stranded until someone resumes them: list agents in error with a usage-limit lastError, resume them in waves (fixers and reviews before builders, at most 6 at once), then continue the work map in ~/bozeo-ops/jev-build-STATE.md.`;
execFileSync(process.execPath, ["/Users/tylerthackray/paseo-worktrees/bozeo/packages/cli/bin/paseo", "send", "--no-wait", "--host", "127.0.0.1:6767", ORCHESTRATOR, prompt], {
  env: { ...process.env, PASEO_AGENT_ID: "" },
  stdio: "inherit",
  timeout: 60_000,
});
saveState("ok");
console.log(`${stamp} FIRED: ${why}`);
