// Wakes the Bozeo orchestrator once when an account has budget again after the whole pool capped.
// Both worker accounts hit their weekly cap on 2026-09-30; agents a cap cuts off stay stranded
// until an account resets and someone resumes them (plan in ~/bozeo-ops/jev-build-STATE.md).
// Checking costs no tokens; only
// the one message it sends does. Fires when the leader's weekly window has reset (usedPct under
// 15) or a worker's weekly window is below 100, then writes a marker and never fires again.
// launchd runs it every 15 minutes (sh.bozeo.budget-resume-watch).
import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { connectToDaemon } from "/Users/tylerthackray/paseo-worktrees/bozeo/packages/cli/dist/utils/client.js";

const ORCHESTRATOR = "e8e58ad7-d139-45dd-99ea-72553a62eff6";
const MARKER = path.join(os.homedir(), "bozeo-ops", "budget-resume-watch.fired");
if (existsSync(MARKER)) process.exit(0);

const c = await connectToDaemon({ host: "127.0.0.1:6767" });
const r = await c.listProviderUsage();
await c.close();
const weekly = (id) => r.providers?.find((p) => p.providerId === id)?.windows?.find((w) => w.id === "weekly")?.usedPct;
const leader = weekly("claude");
const workers = { "claude-backup": weekly("claude-backup"), "claude-personal": weekly("claude-personal") };
const stamp = new Date().toISOString();
const readings = `claude=${leader} ${Object.entries(workers).map(([k, v]) => `${k}=${v}`).join(" ")}`;
const freeWorker = Object.entries(workers).find(([, v]) => typeof v === "number" && v < 100);
const leaderReset = typeof leader === "number" && leader < 15;
console.log(`${stamp} ${readings}`);
if (!freeWorker && !leaderReset) process.exit(0);

const why = freeWorker ? `${freeWorker[0]} has weekly budget again (${freeWorker[1]}%)` : `the leader account's weekly window reset (${leader}%)`;
const prompt = `Budget watch: ${why}. Readings: ${readings}. Agents the cap cut off are stranded until someone resumes them: list agents in error with a usage-limit lastError, resume them in waves (fixers and reviews before builders, at most 6 at once), then continue the work map in ~/bozeo-ops/jev-build-STATE.md.`;
execFileSync(process.execPath, ["/Users/tylerthackray/paseo-worktrees/bozeo/packages/cli/bin/paseo", "send", "--no-wait", "--host", "127.0.0.1:6767", ORCHESTRATOR, prompt], {
  env: { ...process.env, PASEO_AGENT_ID: "" },
  stdio: "inherit",
  timeout: 60_000,
});
writeFileSync(MARKER, `${stamp} ${why}\n`);
console.log(`${stamp} FIRED: ${why}`);
