// Wakes the Bozeo orchestrator once when there is budget to resume the held JEV work.
// Both worker accounts hit their weekly cap on 2026-09-30, and the held work (briefs in
// ~/bozeo-ops/briefs/held/, plan in ~/bozeo-ops/jev-build-STATE.md) waits for a reset rather
// than eating the leader account the whole fleet collapsed onto. Checking costs no tokens; only
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
const prompt = `Budget watch: ${why}. Readings: ${readings}. Resume the held JEV work per the latest BUDGET entries in ~/bozeo-ops/jev-build-STATE.md (briefs in ~/bozeo-ops/briefs/held/): re-measure pace first, then stagger — fixers (stalls, tools, ui) before the savings/read-check/dashboard builders.`;
execFileSync(process.execPath, ["/Users/tylerthackray/paseo-worktrees/bozeo/packages/cli/bin/paseo", "send", "--no-wait", "--host", "127.0.0.1:6767", ORCHESTRATOR, prompt], {
  env: { ...process.env, PASEO_AGENT_ID: "" },
  stdio: "inherit",
  timeout: 60_000,
});
writeFileSync(MARKER, `${stamp} ${why}\n`);
console.log(`${stamp} FIRED: ${why}`);
