// Keeps each pool Claude account's OAuth token fresh while nothing runs on it.
// The daemon's usage fetcher reads the Keychain token but never refreshes it (the Claude CLI owns
// refresh, docs/providers.md), so an account idle for ~8 hours - e.g. both workers capped for the
// week on 2026-09-30 - shows "Usage unavailable" (the usage API answers 401) and the pool can't
// see when it resets. Every run: for each account in agents.providers with an accountPool role,
// if its token has expired or expires within LEAD_MIN and no agent is running on it, run a
// one-line `claude -p` with that CLAUDE_CONFIG_DIR, which refreshes the token first. The CLI only
// refreshes a token that is (nearly) expired, so this acts late and often rather than early. On a
// capped account the call fails on the cap and costs nothing; otherwise it is one tiny Haiku turn.
// A running agent's own CLI refreshes its token, so a busy account's valid token is not raced.
// launchd runs it every 15 minutes (sh.bozeo.claude-token-keepalive), so a lapse lasts at most one run.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectToDaemon } from "/Users/tylerthackray/paseo-worktrees/bozeo/packages/cli/dist/utils/client.js";

const LEAD_MIN = Number(process.env.KEEPALIVE_LEAD_MIN ?? 10);
const HOME = os.homedir();
const CLAUDE = path.join(HOME, ".local/bin/claude");
const SCRATCH = path.join(HOME, ".cache/claude-token-keepalive");
const config = JSON.parse(readFileSync(path.join(HOME, ".paseo/config.json"), "utf8"));
const accounts = Object.entries(config.agents?.providers ?? {})
  .filter(([, p]) => p?.params?.accountPool?.role && p?.env?.CLAUDE_CONFIG_DIR)
  .map(([id, p]) => ({ id, dir: p.env.CLAUDE_CONFIG_DIR }));

const expiresAt = (dir) => {
  const service = `Claude Code-credentials-${createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 8)}`;
  try {
    const raw = execFileSync("security", ["find-generic-password", "-a", os.userInfo().username, "-w", "-s", service], { encoding: "utf8", timeout: 10_000 });
    return JSON.parse(raw).claudeAiOauth?.expiresAt ?? null;
  } catch {
    return null;
  }
};

const c = await connectToDaemon({ host: "127.0.0.1:6767" });
const running = new Set(
  (await c.fetchAgents({})).entries
    .map((e) => e.agent)
    .filter((a) => !a.archivedAt && ["running", "initializing"].includes(a.status))
    .map((a) => a.provider),
);
await c.close();

mkdirSync(SCRATCH, { recursive: true });
const stamp = new Date().toISOString();
for (const { id, dir } of accounts) {
  const before = expiresAt(dir);
  const minsLeft = before === null ? null : Math.round((before - Date.now()) / 60_000);
  if (before === null) { console.log(`${stamp} ${id}: no Keychain token, skipped`); continue; }
  if (minsLeft > LEAD_MIN) continue;
  // A live agent refreshes its own token before it expires, so only a token that is still valid
  // is left to it. An expired one means nothing on the account is calling the API (an agent can
  // sit in "running" for hours on a capped account), so refresh it anyway.
  if (minsLeft > 0 && running.has(id)) { console.log(`${stamp} ${id}: ${minsLeft} min left, an agent is running on it, skipped`); continue; }
  spawnSync(CLAUDE, ["-p", "reply ok", "--model", "haiku", "--max-turns", "1"], {
    cwd: SCRATCH,
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    input: "",
    timeout: 120_000,
    stdio: ["pipe", "ignore", "ignore"],
  });
  const after = expiresAt(dir);
  const refreshed = after !== null && after > before;
  console.log(`${stamp} ${id}: ${minsLeft} min left -> ${refreshed ? `refreshed (${Math.round((after - Date.now()) / 60_000)} min)` : "NOT refreshed"}`);
}
process.exit(0);
