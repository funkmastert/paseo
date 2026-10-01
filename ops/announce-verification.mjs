#!/usr/bin/env node
// Says "Verification ready for <leader session>" out loud, so Tyler knows which session has
// something waiting on his device. Every agent runs this once, when a feature or fix is ready for
// him to verify on a device (fleet rule "VERIFICATION READY" in daemon.appendSystemPrompt).
//
// The name is the calling agent's LEADER session: follow paseo.parent-agent-id from $PASEO_AGENT_ID
// up to the root, take the root's workspace title (what the sidebar shows), and shorten it the
// way Tyler asked ("Bozeo: pool, failover, janitors, orchestration" -> "Bozeo: pool"). One
// announcement per leader per 2 minutes, so a leader and its child finishing together say it once.
// Never fails the caller: any error falls back to a generic line, and it always exits 0.
//   announce-verification.mjs [--title "<name>"] [--dry-run]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const titleArg = args.includes("--title") ? args[args.indexOf("--title") + 1] : undefined;
const QUIET_MS = 120_000;
const STATE_DIR = path.join(os.homedir(), ".cache", "bozeo-announce");

const TRAILING_FILLER = /^(and|or|on|in|of|for|to|the|a|an|with|at|after|from|by|into|via)$/i;

export function shortTitle(title) {
  let t = String(title ?? "")
    .replace(/^\s*(\[[^\]]*\]\s*)+/, "") // "[MOVED -> …] Real title"
    .split(/,|\(|\n/)[0] // up to the first comma or parenthesis
    .trim();
  // "Yonderly files — Android": a short dash clause is usually the platform, which is what
  // tells two sessions apart, so keep it; a long one is a subtitle and goes.
  const [head, ...rest] = t.split(/\s[-–—]\s/);
  const tail = rest.join(" ").trim();
  t = tail && tail.split(/\s+/).length <= 2 ? `${head} ${tail}` : head;
  let words = t.replace(/[.:;\s]+$/, "").split(/\s+/).filter(Boolean);
  if (words.length > 4) words = words.slice(0, 4);
  while (words.length > 1 && TRAILING_FILLER.test(words[words.length - 1])) words.pop();
  t = words.join(" ");
  if (t.length > 40) t = t.slice(0, 40).replace(/\s+\S*$/, "");
  return t;
}

async function leaderTitle() {
  const selfId = process.env.PASEO_AGENT_ID;
  if (!selfId) return undefined;
  const { connectToDaemon } = await import("/Users/tylerthackray/paseo-worktrees/bozeo/packages/cli/dist/utils/client.js");
  const c = await connectToDaemon({ host: process.env.PASEO_HOST || "127.0.0.1:6767" });
  try {
    const agents = new Map((await c.fetchAgents({})).entries.map((e) => [e.agent.id, e.agent]));
    let agent = agents.get(selfId);
    for (let hops = 0; agent && hops < 20; hops++) {
      const parent = agent.labels?.["paseo.parent-agent-id"];
      if (!parent || !agents.has(parent)) break;
      agent = agents.get(parent);
    }
    if (!agent) return undefined;
    const workspaces = (await c.fetchWorkspaces({})).entries ?? [];
    const ws = workspaces.find((w) => w.id === agent.workspaceId);
    return { key: agent.id, title: ws?.title || ws?.name || agent.title };
  } finally {
    await c.close().catch(() => {});
  }
}

function speak(text) {
  if (process.platform === "darwin") {
    execFileSync("afplay", ["/System/Library/Sounds/Glass.aiff"], { stdio: "ignore", timeout: 10_000 });
    execFileSync("say", [text], { stdio: "ignore", timeout: 30_000 });
  } else if (process.platform === "win32") {
    const ps = `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak(${JSON.stringify(text)})`;
    execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: "ignore", timeout: 30_000 });
  } else {
    execFileSync("spd-say", ["--wait", text], { stdio: "ignore", timeout: 30_000 });
  }
}

async function main() {
  let key = "unknown";
  let name = titleArg;
  if (!name) {
    const leader = await leaderTitle().catch(() => undefined);
    if (leader) ({ key, title: name } = leader);
  } else {
    key = `title:${name}`;
  }
  const short = shortTitle(name);
  const text = short ? `Verification ready for ${short}` : "Verification ready";
  mkdirSync(STATE_DIR, { recursive: true });
  const stamp = path.join(STATE_DIR, key.replace(/[^A-Za-z0-9_.-]/g, "_"));
  let last = 0;
  try { last = Number(readFileSync(stamp, "utf8")) || 0; } catch {}
  if (Date.now() - last < QUIET_MS) {
    console.log(`announce: skipped (announced for this session ${Math.round((Date.now() - last) / 1000)}s ago): ${text}`);
    return;
  }
  console.log(`announce: ${text}${dryRun ? " (dry run)" : ""}`);
  if (dryRun) return;
  writeFileSync(stamp, String(Date.now()));
  speak(text);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => console.log(`announce: ${e.message}`)).finally(() => process.exit(0));
}
