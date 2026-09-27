// CPU guard: keep Tyler's Mac responsive while agents work. Stopgap until the daemon lowers
// agent priority itself (then delete this and LaunchAgent sh.bozeo.cpu-guard).
//
// Every 20s: every process under an agent CLI (a child of the daemon worker that is a provider
// CLI) is reniced to NICE, so agents take only CPU nothing interactive wants. Processes inherit
// niceness, so reniced CLIs start their future tools low too. Never kills or pauses anything.
//
// When the 1-minute load is over LOAD_FACTOR x cores, it records the top CPU users grouped by
// agent (CLI pid + working directory) to ~/Library/Logs/Bozeo/cpu-guard.log, so there is
// evidence of what pinned the machine even after a reboot.
import { execFileSync } from "node:child_process";
import os from "node:os";

const NICE = 10;
const LOAD_FACTOR = 2;
const SWEEP_MS = 20_000;
const EVIDENCE_EVERY_MS = 60_000;
const AGENT_CLI = /\/\.local\/share\/claude\/versions\/|\/claude(\s|$)|codex|opencode|copilot/;
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
let lastEvidence = 0;

const run = (cmd, args, timeout = 15_000) =>
  execFileSync(cmd, args, { encoding: "utf8", timeout, maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] });

function daemonWorkerPid() {
  try {
    return Number(run("lsof", ["-nP", "-iTCP:6767", "-sTCP:LISTEN", "-t"]).trim().split("\n")[0]) || null;
  } catch {
    return null;
  }
}

function cwdOf(pid) {
  try {
    const out = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], 5_000);
    return (/^n(.+)$/m.exec(out)?.[1] ?? "?").replace(os.homedir(), "~");
  } catch {
    return "?";
  }
}

function sweep() {
  const worker = daemonWorkerPid();
  if (!worker) return;
  // One ps call, niced itself so it still runs when the machine is saturated.
  const rows = run("nice", ["-n", "5", "ps", "-axo", "pid=,ppid=,nice=,%cpu=,command="])
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+([\d.]+)\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], nice: +m[3], cpu: +m[4], cmd: m[5] }));
  const children = new Map();
  for (const r of rows) (children.get(r.ppid) ?? children.set(r.ppid, []).get(r.ppid)).push(r);
  const clis = (children.get(worker) ?? []).filter((r) => AGENT_CLI.test(r.cmd));

  const trees = [];
  for (const cli of clis) {
    const members = [];
    const stack = [cli];
    while (stack.length) {
      const p = stack.pop();
      members.push(p);
      for (const c of children.get(p.pid) ?? []) stack.push(c);
    }
    trees.push({ cli, members, cpu: members.reduce((s, m) => s + m.cpu, 0) });
  }

  const toRenice = trees.flatMap((t) => t.members).filter((m) => m.nice < NICE).map((m) => String(m.pid));
  for (let i = 0; i < toRenice.length; i += 200) {
    try {
      run("renice", ["-n", String(NICE), "-p", ...toRenice.slice(i, i + 200)]);
    } catch {
      // A process can exit between ps and renice; the rest still apply next sweep.
    }
  }

  const load = os.loadavg()[0];
  const cores = os.cpus().length;
  if (load > LOAD_FACTOR * cores && Date.now() - lastEvidence > EVIDENCE_EVERY_MS) {
    lastEvidence = Date.now();
    const agentCpu = trees.reduce((s, t) => s + t.cpu, 0);
    const top = trees.sort((a, b) => b.cpu - a.cpu).slice(0, 6);
    log(`HIGH LOAD ${load.toFixed(1)} on ${cores} cores; ${clis.length} agent CLIs using ${Math.round(agentCpu)}% CPU in total`);
    for (const t of top) {
      const heavy = t.members.sort((a, b) => b.cpu - a.cpu).slice(0, 3).map((m) => `${Math.round(m.cpu)}% ${m.cmd.slice(0, 70)}`);
      log(`  cli ${t.cli.pid} ${cwdOf(t.cli.pid)}: ${Math.round(t.cpu)}% over ${t.members.length} procs | ${heavy.join(" ; ")}`);
    }
    const others = rows.filter((r) => !trees.some((t) => t.members.includes(r))).sort((a, b) => b.cpu - a.cpu).slice(0, 4);
    log(`  top non-agent: ${others.map((r) => `${Math.round(r.cpu)}% ${r.cmd.slice(0, 60)}`).join(" ; ")}`);
  }
}

log("cpu guard started");
for (;;) {
  try {
    sweep();
  } catch (e) {
    log(`sweep failed: ${e.message.split("\n")[0]}`);
  }
  await new Promise((r) => setTimeout(r, SWEEP_MS));
}
