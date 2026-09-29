// node --test ops/cpu-policing/heavy.test.mjs
// Drives heavy.sh with a temp lock dir (HEAVY_LOCKDIR), never the live one.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const HEAVY = path.join(import.meta.dirname, "heavy.sh");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let root;

before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "heavy-test-"));
});
after(() => {
  try {
    chmodSync(path.join(root, "ro"), 0o755);
  } catch {}
  rmSync(root, { recursive: true, force: true });
});

function heavy(lockdir, slots, args) {
  const child = spawn(HEAVY, args, { env: { ...process.env, HEAVY_LOCKDIR: lockdir, HEAVY_SLOTS: String(slots) }, stdio: ["ignore", "pipe", "pipe"] });
  child.done = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
  return child;
}

// Payload: mark itself running, record how many are running, hold for a while, unmark.
const payload = (dir, id, holdSec) => [
  "/bin/sh",
  "-c",
  `mkdir "${dir}/run.${id}"; ls -d "${dir}"/run.* | wc -l | tr -d ' ' >> "${dir}/counts"; sleep ${holdSec}; rmdir "${dir}/run.${id}"`,
];

test("six concurrent invocations never run more than two at once", async () => {
  const dir = path.join(root, "conc");
  mkdirSync(dir);
  const locks = path.join(dir, "locks");
  const kids = Array.from({ length: 6 }, (_, i) => heavy(locks, 2, payload(dir, i, 1)));
  let peak = 0;
  const sampler = setInterval(() => {
    peak = Math.max(peak, readdirSync(dir).filter((f) => f.startsWith("run.")).length);
  }, 50);
  const results = await Promise.all(kids.map((k) => k.done));
  clearInterval(sampler);
  assert.ok(results.every((r) => r.code === 0), JSON.stringify(results));
  const counts = readFileSync(path.join(dir, "counts"), "utf8").trim().split("\n").map(Number);
  assert.equal(counts.length, 6);
  assert.ok(Math.max(...counts) <= 2, `payload saw ${Math.max(...counts)}`);
  assert.ok(peak <= 2 && peak >= 1, `sampler saw ${peak}`);
});

test("a SIGKILLed holder's slot is taken by the next waiter", async () => {
  const dir = path.join(root, "kill");
  mkdirSync(dir);
  const locks = path.join(dir, "locks");
  const a = heavy(locks, 2, ["/bin/sleep", "30"]);
  const b = heavy(locks, 2, ["/bin/sleep", "30"]);
  await sleep(1000);
  const c = heavy(locks, 2, ["/bin/sh", "-c", `touch "${dir}/c-ran"`]);
  await sleep(2000);
  assert.ok(!existsSync(path.join(dir, "c-ran")), "c must wait while both slots are held");
  const aSleep = spawnSync("pgrep", ["-P", String(a.pid)], { encoding: "utf8" }).stdout.trim();
  a.kill("SIGKILL");
  const t0 = Date.now();
  assert.equal((await c.done).code, 0);
  assert.ok(existsSync(path.join(dir, "c-ran")));
  assert.ok(Date.now() - t0 < 8000, "reclaimed within one 5 s poll");
  b.kill("SIGTERM");
  assert.equal((await b.done).code, 143, "SIGTERM goes to the command; the wrapper exits with its status");
  if (aSleep) process.kill(Number(aSleep), "SIGKILL");
});

test("the command's exit status passes through", async () => {
  const r = await heavy(path.join(root, "rc"), 2, ["/bin/sh", "-c", "exit 7"]).done;
  assert.equal(r.code, 7);
});

test("fails closed when a lock file can't be created", async () => {
  const ro = path.join(root, "ro");
  mkdirSync(ro);
  chmodSync(ro, 0o555);
  const marker = path.join(root, "ro-ran");
  const k = heavy(ro, 2, ["/bin/sh", "-c", `touch "${marker}"`]);
  let err = "";
  k.stderr.on("data", (d) => (err += d));
  const r = await k.done;
  assert.equal(r.code, 75);
  assert.match(err, /not running the command unbounded/);
  assert.ok(!existsSync(marker));
});
