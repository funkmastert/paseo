#!/usr/bin/env node
// Read-only checks for the /install command (.claude/commands/install.md). It never writes a
// file, never runs a Paseo CLI command, and never prints a config value other than
// `daemon.listen`, because config.json can hold API keys and the daemon password hash.
//
//   node scripts/install-preflight.mjs                       survey for an existing install
//   node scripts/install-preflight.mjs --check-port <port> --check-dir <dir> [--check-dir <dir>]
//                                                            re-check a chosen port and new dirs
//
// `--default-port <port>` replaces 6767 everywhere. It exists so this can be tested beside a
// live daemon without probing it.

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WINDOWS = process.platform === "win32";

function parseArgs(argv) {
  const args = { defaultPort: 6767, checkPort: undefined, checkDirs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--default-port") args.defaultPort = Number(argv[++i]);
    else if (arg === "--check-port") args.checkPort = Number(argv[++i]);
    else if (arg === "--check-dir") args.checkDirs.push(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ["defaultPort", "checkPort"]) {
    const port = args[key];
    if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
      throw new Error(`invalid port for ${key}`);
    }
  }
  return args;
}

function line(label, value) {
  console.log(`${label.padEnd(14)} ${value}`);
}

function expandHome(raw) {
  if (raw === "~" || raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(1));
  return raw;
}

function knownHomes() {
  const homes = [{ dir: path.join(os.homedir(), ".paseo"), source: "default" }];
  const fromEnv = process.env.PASEO_HOME?.trim();
  if (fromEnv) {
    const dir = path.resolve(expandHome(fromEnv));
    const existing = homes.find((home) => home.dir === dir);
    if (existing) existing.source = "default, and PASEO_HOME";
    else homes.push({ dir, source: "PASEO_HOME from your shell" });
  }
  return homes;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readJsonQuietly(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function tcpPort(listen) {
  const match = /^(?:tcp:\/\/)?(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):(\d+)$/.exec(
    listen ?? "",
  );
  return match ? Number(match[1]) : undefined;
}

function inspectHome(home, defaultPort) {
  if (!existsSync(home.dir)) return { ...home, exists: false };
  const pidInfo = readJsonQuietly(path.join(home.dir, "paseo.pid"));
  const configPath = path.join(home.dir, "config.json");
  const config = existsSync(configPath) ? readJsonQuietly(configPath) : undefined;
  const pid = Number.isInteger(pidInfo?.pid) ? pidInfo.pid : undefined;
  const configListen =
    typeof config?.daemon?.listen === "string" ? config.daemon.listen : undefined;
  const listen = pidInfo?.listen ?? configListen ?? `127.0.0.1:${defaultPort}`;
  return {
    ...home,
    exists: true,
    hasConfig: existsSync(configPath),
    configReadable: config !== undefined,
    pid,
    pidAlive: pid !== undefined && isAlive(pid),
    configListen,
    listen,
  };
}

function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(1500, () => done(true));
    socket.once("connect", () => done(true));
    socket.once("error", (error) => done(error.code !== "ECONNREFUSED"));
  });
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 15_000 });
  return result.status === 0 ? result.stdout : undefined;
}

function commandOf(pid) {
  if (IS_WINDOWS) return undefined;
  return run("ps", ["-o", "command=", "-p", String(pid)])?.trim() || undefined;
}

function listenerPid(port) {
  if (IS_WINDOWS) {
    const out = run("netstat", ["-ano", "-p", "TCP"]);
    const row = out?.split(/\r?\n/).find((text) => new RegExp(`:${port}\\s.*LISTENING`).test(text));
    return row ? Number(row.trim().split(/\s+/).at(-1)) : undefined;
  }
  const out = run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]);
  const pidLine = out?.split("\n").find((text) => text.startsWith("p"));
  return pidLine ? Number(pidLine.slice(1)) : undefined;
}

/** Processes whose command line runs code from this checkout, or undefined if unknown. */
function processesFromCheckout() {
  const roots = [
    `${REPO_ROOT}${path.sep}packages${path.sep}`,
    `${REPO_ROOT}${path.sep}node_modules${path.sep}`,
  ];
  let rows;
  if (IS_WINDOWS) {
    const out = run("powershell.exe", [
      "-NoProfile",
      "-Command",
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
    ]);
    rows = out?.split(/\r?\n/);
  } else {
    rows = run("ps", ["-axo", "pid=,command="])?.split("\n");
  }
  if (!rows) return undefined;
  const own = new Set([process.pid, process.ppid]);
  return rows
    .map((row) => row.trim())
    .filter((row) => roots.some((root) => row.includes(root)))
    .filter((row) => !own.has(Number(row.split(/\s+/)[0])));
}

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function paseoOnPath() {
  const names = IS_WINDOWS ? ["paseo.cmd", "paseo.exe", "paseo"] : ["paseo"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (dir && isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** The fork's CLI has `doctor`; stock Paseo's does not. `--help` never contacts a daemon. */
function isForkCli(cli) {
  const result = spawnSync(cli, ["doctor", "--help"], {
    encoding: "utf8",
    timeout: 20_000,
    shell: IS_WINDOWS && cli.endsWith(".cmd"),
  });
  return result.status === 0;
}

function dirProblem(dir, homes) {
  if (typeof dir !== "string" || dir.includes("~") || !path.isAbsolute(dir)) {
    return "not an absolute path (write $HOME/... expanded, never ~)";
  }
  const resolved = path.resolve(dir);
  if (homes.some((home) => home.dir === resolved)) return "is an existing Paseo home";
  const claudeDir = path.join(os.homedir(), ".claude");
  if (resolved === claudeDir || resolved.startsWith(`${claudeDir}${path.sep}`))
    return "is inside ~/.claude";
  if (homes.some((home) => resolved.startsWith(`${home.dir}${path.sep}`)))
    return "is inside an existing Paseo home";
  if (resolved === REPO_ROOT || resolved.startsWith(`${REPO_ROOT}${path.sep}`))
    return "is inside this checkout";
  if (!existsSync(resolved)) return undefined;
  if (!statSync(resolved).isDirectory()) return "exists and is not a directory";
  if (readdirSync(resolved).length > 0) return "exists and is not empty";
  return undefined;
}

function reportEnv() {
  const envNames = Object.keys(process.env)
    .filter((name) => name.startsWith("PASEO_") || name === "PORT")
    .sort();
  const showValue = new Set(["PASEO_HOME", "PASEO_HOST", "PASEO_LISTEN", "PORT"]);
  if (envNames.length === 0) line("env", "no PASEO_* or PORT variables in this shell");
  for (const name of envNames) {
    line("env", showValue.has(name) ? `${name}=${process.env[name]}` : `${name} is set`);
  }
}

function reportHome(home, ports) {
  if (!home.exists) {
    line("home", `${home.dir} (${home.source}): does not exist`);
    return;
  }
  line("home", `${home.dir} (${home.source}): EXISTS`);
  if (home.pid !== undefined) {
    line("", `pid file: pid ${home.pid} ${home.pidAlive ? "running" : "not running (stale)"}`);
  }
  if (!home.hasConfig) line("", "config.json: missing");
  else if (!home.configReadable)
    line("", "config.json: present, not valid JSON (content not shown)");
  else line("", `config.json daemon.listen: ${home.configListen ?? "(unset)"}`);
  line("", `listens on: ${home.listen}`);
  const port = tcpPort(home.listen);
  if (port === undefined) {
    line("", "listen target is not TCP on this machine; ask the user if its daemon runs");
  } else if (!ports.has(port)) {
    ports.set(port, `port of ${home.dir}`);
  }
}

/** Probes each port and returns the busy ones. */
async function reportPorts(ports) {
  const busyPorts = [];
  for (const [port, why] of ports) {
    if (!(await probePort(port))) {
      line("port", `${port} (${why}): free`);
      continue;
    }
    busyPorts.push(port);
    const pid = listenerPid(port);
    const command = pid ? commandOf(pid) : undefined;
    line("port", `${port} (${why}): IN USE${pid ? ` by pid ${pid}` : ""}`);
    if (command) line("", command);
  }
  return busyPorts;
}

function reportCheckoutUse(fromCheckout) {
  if (fromCheckout === undefined) {
    line(
      "checkout use",
      "UNKNOWN: could not list processes. Ask the user whether a daemon runs from this checkout",
    );
    line("separate clone", "REQUIRED unless the user confirms nothing runs from this checkout");
    return;
  }
  if (fromCheckout.length === 0) {
    line("checkout use", "nothing runs from this checkout");
    line("separate clone", "not needed");
    return;
  }
  line("checkout use", `${fromCheckout.length} process(es) run from this checkout:`);
  for (const row of fromCheckout) line("", row);
  line("separate clone", "REQUIRED: build in a separate clone, not in this checkout");
}

function reportCli() {
  const built = existsSync(path.join(REPO_ROOT, "packages", "cli", "dist", "index.js"));
  const cli = path.join(REPO_ROOT, "packages", "cli", "bin", "paseo");
  line("cli", `this checkout's CLI: ${cli} (${built ? "built" : "not built"})`);
  const onPath = paseoOnPath();
  if (!onPath) {
    line("cli", "no paseo on PATH");
    return;
  }
  const kind = isForkCli(onPath) ? "this fork's" : "not this fork's: no doctor command";
  line("cli", `paseo on PATH: ${onPath} (${kind})`);
}

async function survey(args) {
  const homes = knownHomes().map((home) => inspectHome(home, args.defaultPort));
  line("checkout", REPO_ROOT);
  reportEnv();
  const ports = new Map([[args.defaultPort, "default port"]]);
  for (const home of homes) reportHome(home, ports);
  const busyPorts = await reportPorts(ports);
  reportCheckoutUse(processesFromCheckout());
  reportCli();

  const existingHomes = homes.filter((home) => home.exists);
  const protect = [...existingHomes.map((home) => home.dir), ...busyPorts];
  line("protect", protect.length > 0 ? `|${protect.join("|")}|` : "(none)");
  line(
    "verdict",
    protect.length > 0
      ? "EXISTING INSTALL OR BUSY PORT: offer Verify only, Isolated instance, or Stop"
      : "clear: offer Fresh install or Stop",
  );
}

async function check(args) {
  const homes = knownHomes().map((home) => inspectHome(home, args.defaultPort));
  let ok = true;
  if (args.checkPort !== undefined) {
    const port = args.checkPort;
    const owner = homes.find((home) => home.exists && tcpPort(home.listen) === port);
    let problem;
    if (port === args.defaultPort)
      problem = "is the default port that Paseo, Bozeo and the desktop app use";
    else if (owner) problem = `is the port of the existing home ${owner.dir}`;
    else if (await probePort(port)) problem = "is in use";
    line("port", `${port}: ${problem ? `NOT OK: ${problem}` : "free"}`);
    ok &&= !problem;
  }
  for (const dir of args.checkDirs) {
    const problem = dirProblem(dir, homes);
    line("dir", `${dir}: ${problem ? `NOT OK: ${problem}` : "ok (new or empty)"}`);
    ok &&= !problem;
  }
  line("result", ok ? "ok" : "NOT OK: ask the user for another value");
  return ok ? 0 : 2;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.checkPort !== undefined || args.checkDirs.length > 0) return check(args);
  await survey(args);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`error          ${error.message}`);
  process.exitCode = 1;
}
