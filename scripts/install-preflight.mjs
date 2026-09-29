#!/usr/bin/env node
// Read-only checks for the /install command (.claude/commands/install.md). It never writes a
// file, never runs a Paseo CLI command, and never prints a config value other than
// `daemon.listen`, because config.json can hold API keys and the daemon password hash. Nor does
// it print another process's command line, which can hold a token: only pids and executable
// names.
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
import { canonicalPath, isSameOrInside, parseJsonQuietly, pathKey } from "./install-lib.mjs";

const REPO_ROOT = canonicalPath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const IS_WINDOWS = process.platform === "win32";
// Written by install.md Step 4. Its presence means an earlier /install run from this checkout.
const PREVIOUS_ENV_FILE = path.join(REPO_ROOT, ".dev", "install.env");
// Names the env file clears before any CLI call, so the new daemon never inherits them.
const CLEARED_ENV = /^(?:PASEO_|CLAUDE|ANTHROPIC_)|^(?:GIT_EDITOR|PORT)$/;

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

/** BOZEO_* values from an earlier run's env file; the file is read, never sourced. */
function previousRun() {
  let text;
  try {
    text = readFileSync(PREVIOUS_ENV_FILE, "utf8");
  } catch {
    return undefined;
  }
  const values = {};
  for (const row of text.split(/\r?\n/)) {
    const match = /^(BOZEO_(?:HOME|PORT|REPO))='([^']*)'$/.exec(row.trim());
    if (match) values[match[1]] = match[2];
  }
  return {
    file: PREVIOUS_ENV_FILE,
    home: values.BOZEO_HOME,
    port: values.BOZEO_PORT,
    repo: values.BOZEO_REPO,
  };
}

function knownHomes(previous) {
  const homes = [];
  const add = (raw, source) => {
    let dir;
    try {
      dir = canonicalPath(raw);
    } catch {
      return;
    }
    const existing = homes.find((home) => pathKey(home.dir) === pathKey(dir));
    if (existing) existing.source += `, and ${source}`;
    else homes.push({ dir, source });
  };
  add(path.join(os.homedir(), ".paseo"), "default");
  const fromEnv = process.env.PASEO_HOME?.trim();
  if (fromEnv) add(path.resolve(expandHome(fromEnv)), "PASEO_HOME from your shell");
  if (previous?.home && path.isAbsolute(previous.home)) add(previous.home, "previous /install run");
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

/** `{ value }`, `{ errorLine }` for invalid JSON, or undefined when unreadable. */
function readJsonQuietly(file) {
  try {
    return parseJsonQuietly(readFileSync(file, "utf8"));
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
  const pidInfo = readJsonQuietly(path.join(home.dir, "paseo.pid"))?.value;
  const configPath = path.join(home.dir, "config.json");
  const configRead = existsSync(configPath) ? readJsonQuietly(configPath) : undefined;
  const config = configRead?.value;
  const pid = Number.isInteger(pidInfo?.pid) ? pidInfo.pid : undefined;
  const configListen =
    typeof config?.daemon?.listen === "string" ? config.daemon.listen : undefined;
  const listen = pidInfo?.listen ?? configListen ?? `127.0.0.1:${defaultPort}`;
  return {
    ...home,
    exists: true,
    hasConfig: existsSync(configPath),
    configReadable: config !== undefined,
    configErrorLine: configRead?.errorLine,
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

/** Executable name of a pid, plus whether it is a Paseo daemon. Never its command line. */
function processName(pid) {
  if (IS_WINDOWS) {
    const out = run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
    const name = /^"([^"]+)"/.exec(out?.trim() ?? "")?.[1];
    return name ?? "unknown";
  }
  const title = run("ps", ["-o", "command=", "-p", String(pid)])?.trim() ?? "";
  const paseo = /^Paseo (Daemon|Supervisor)\b/.exec(title);
  if (paseo) return `Paseo ${paseo[1]}`;
  const exe = run("ps", ["-o", "comm=", "-p", String(pid)])?.trim();
  return exe ? path.basename(exe) : "unknown";
}

/** The fork's supervisor and daemon replace their command line with this title. */
function isPaseoTitle(command) {
  return /^Paseo (Daemon|Supervisor)\b/.test(command);
}

/** Files a process has as cwd or mapped executable (lsof), for spotting a checkout it runs from. */
function processFiles(pid) {
  const out = run("lsof", ["-a", "-p", String(pid), "-d", "cwd,txt", "-Fn"]);
  return (out ?? "")
    .split("\n")
    .filter((text) => text.startsWith("n"))
    .map((text) => text.slice(1));
}

/** TCP ports a pid listens on. */
function listenPorts(pid) {
  const out = run("lsof", ["-a", "-nP", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"]);
  const ports = new Set();
  for (const text of (out ?? "").split("\n")) {
    const match = /^n.*:(\d+)$/.exec(text);
    if (match) ports.add(Number(match[1]));
  }
  return [...ports];
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

/** Every process as { pid, command }, or undefined if they cannot be listed. */
function listProcesses() {
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
  return rows
    .map((row) => /^\s*(\d+)\s?(.*)$/.exec(row))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), command: match[2] }));
}

/**
 * Pids that run code from this checkout, or undefined if unknown. A command line under the
 * checkout gives most of them away (plugin, terminal worker, esbuild). The supervisor and
 * daemon hide theirs behind a process title, so for those the cwd and mapped files decide.
 */
function processesFromCheckout(processes) {
  if (!processes) return undefined;
  const key = (text) => pathKey(text.replace(/\\/g, "/"));
  const root = key(REPO_ROOT);
  const roots = [`${root}/packages/`, `${root}/node_modules/`];
  const own = new Set([process.pid, process.ppid]);
  return processes
    .filter(({ pid }) => !own.has(pid))
    .filter(({ pid, command }) => {
      if (roots.some((prefix) => key(command).includes(prefix))) return true;
      if (IS_WINDOWS || !isPaseoTitle(command)) return false;
      return processFiles(pid).some((file) => {
        try {
          return isSameOrInside(file, REPO_ROOT);
        } catch {
          return false;
        }
      });
    })
    .map(({ pid }) => pid);
}

/** Ports that a running Paseo supervisor or daemon listens on, whatever its home or checkout. */
function paseoDaemonPorts(processes) {
  if (!processes || IS_WINDOWS) return [];
  const ports = new Set();
  for (const { pid, command } of processes) {
    if (isPaseoTitle(command)) for (const port of listenPorts(pid)) ports.add(port);
  }
  return [...ports];
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

/**
 * The fork's CLI has `doctor`; stock Paseo's does not. `--help` never contacts a daemon. Stock
 * Paseo prints its root help and exits 0 for an unknown command, so the exit code alone says
 * nothing: the fork's doctor description has to be in the output.
 */
function isForkCli(cli) {
  const result = spawnSync(cli, ["doctor", "--help"], {
    encoding: "utf8",
    timeout: 20_000,
    shell: IS_WINDOWS && cli.endsWith(".cmd"),
  });
  return result.status === 0 && (result.stdout ?? "").includes("Diagnose the fork");
}

function dirProblem(dir, homes) {
  if (
    typeof dir !== "string" ||
    dir.includes("~") ||
    !(path.isAbsolute(dir) || /^[A-Za-z]:[\\/]/.test(dir))
  ) {
    return "not an absolute path (write $HOME/... expanded, never ~)";
  }
  let resolved;
  try {
    resolved = canonicalPath(dir);
  } catch {
    return "not a usable path";
  }
  const existingHomes = homes.filter((home) => home.exists);
  const known = homes.find((home) => pathKey(home.dir) === pathKey(resolved));
  if (known)
    return known.exists ? "is an existing Paseo home" : `is the ${known.source} Paseo home`;
  if (isSameOrInside(resolved, path.join(os.homedir(), ".claude"))) return "is inside ~/.claude";
  if (existingHomes.some((home) => isSameOrInside(resolved, home.dir)))
    return "is inside an existing Paseo home";
  if (existingHomes.some((home) => isSameOrInside(home.dir, resolved)))
    return "contains an existing Paseo home";
  if (isSameOrInside(resolved, REPO_ROOT)) return "is inside this checkout";
  if (pathKey(resolved) === pathKey(canonicalPath(os.homedir()))) return "is your home directory";
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
  const cleared = Object.keys(process.env)
    .filter((name) => CLEARED_ENV.test(name))
    .sort();
  line(
    "cleared",
    cleared.length > 0
      ? `kept out of the new daemon (names only): ${cleared.join(" ")}`
      : "nothing to keep out of the new daemon",
  );
}

function reportPrevious(previous) {
  if (!previous) {
    line("previous run", "none");
    return;
  }
  line("previous run", `FOUND: ${previous.file}`);
  line("", `home ${previous.home ?? "(unset)"}, port ${previous.port ?? "(unset)"}`);
  line("", `built checkout ${previous.repo ?? "(unset)"}`);
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
  else if (home.configErrorLine !== undefined)
    line("", `config.json: not valid JSON at line ${home.configErrorLine} (content not shown)`);
  else if (!home.configReadable) line("", "config.json: present, cannot be read");
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
/**
 * Returns the busy ports. The process table decides first; only a port with no listener in it
 * gets a TCP probe, so a running daemon is never connected to.
 */
async function reportPorts(ports) {
  const busyPorts = [];
  for (const [port, why] of ports) {
    const pid = listenerPid(port);
    if (pid === undefined && !(await probePort(port))) {
      line("port", `${port} (${why}): free`);
      continue;
    }
    busyPorts.push(port);
    line("port", `${port} (${why}): IN USE${pid ? ` by pid ${pid} (${processName(pid)})` : ""}`);
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
  line(
    "checkout use",
    `${fromCheckout.length} process(es) run from this checkout: ${fromCheckout
      .map((pid) => `pid ${pid} (${processName(pid)})`)
      .join(", ")}`,
  );
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
  const previous = previousRun();
  const homes = knownHomes(previous).map((home) => inspectHome(home, args.defaultPort));
  const processes = listProcesses();
  line("checkout", REPO_ROOT);
  reportEnv();
  reportPrevious(previous);
  const ports = new Map([[args.defaultPort, "default port"]]);
  const previousPort = Number(previous?.port);
  if (Number.isInteger(previousPort) && previousPort > 0 && !ports.has(previousPort)) {
    ports.set(previousPort, "port of the previous /install run");
  }
  for (const home of homes) reportHome(home, ports);
  for (const port of paseoDaemonPorts(processes)) {
    if (!ports.has(port)) ports.set(port, "a running Paseo daemon");
  }
  const busyPorts = await reportPorts(ports);
  reportCheckoutUse(processesFromCheckout(processes));
  reportCli();

  const existingHomes = homes.filter((home) => home.exists);
  const protect = [...existingHomes.map((home) => home.dir), ...busyPorts];
  line("protect", protect.length > 0 ? `|${protect.join("|")}|` : "(none)");
  let verdict = "clear: offer Fresh install or Stop";
  if (protect.length > 0) {
    verdict = "EXISTING INSTALL OR BUSY PORT: offer Verify only, Isolated instance, or Stop";
  }
  if (previous) verdict = "PREVIOUS /install RUN: stop and ask the user (install.md Step 2)";
  line("verdict", verdict);
}

async function check(args) {
  const previous = previousRun();
  const homes = knownHomes(previous).map((home) => inspectHome(home, args.defaultPort));
  let ok = true;
  if (args.checkPort !== undefined) {
    const port = args.checkPort;
    const owner = homes.find((home) => home.exists && tcpPort(home.listen) === port);
    let problem;
    if (port === args.defaultPort)
      problem = "is the default port that Paseo, Bozeo and the desktop app use";
    else if (owner) problem = `is the port of the existing home ${owner.dir}`;
    else if (previous && Number(previous.port) === port)
      problem = "is the port of the previous /install run";
    else if (listenerPid(port) !== undefined || (await probePort(port))) problem = "is in use";
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
