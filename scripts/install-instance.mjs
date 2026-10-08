#!/usr/bin/env node
// The checks and the one write behind the /install command's env file
// (scripts/install-env.sh, .claude/commands/install.md). Prints paths and `daemon.listen`, never
// another value from config.json.
//
//   check-env                   validate BOZEO_SRC/REPO/HOME/PORT/PROTECT from the environment;
//                               print the canonical SRC, REPO and HOME, one per line
//   same-path <a> <b>           exit 0 when both are the same path once canonical
//   config-listen <home> <host> exit 0 when <home>/config.json exists and its daemon.listen is <host>
//   guard <home> <host>         read `paseo daemon status --json` on stdin; exit 0 when the
//                               daemon for <home> is running on <host>
//   new-home <home> <host> [--machine-jobs off]
//                               create <home> (it must not exist) and its config.json, so no CLI
//                               ever sees the home with the default 127.0.0.1:6767 listen
//
// Exit codes: 0 ok, 1 refused (a STOP line on stderr says why), 2 bad arguments.

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalPath, isSameOrInside, parseJsonQuietly, samePath } from "./install-lib.mjs";

const DEFAULT_PORT = 6767;

// Jobs that watch or act on the whole machine (disk, CPU, swap, simulators, other agents'
// processes) or start agents on their own. An isolated instance runs beside a daemon that
// already does this for the machine; two would each act and each escalate. The list matches
// the scratch-daemon recipe. Every key is live: set `enabled: true` and `paseo daemon reload`.
const MACHINE_JOBS_OFF = {
  agents: {
    resourceMonitor: { enabled: false, reaper: { enabled: false }, saturation: { enabled: false } },
    processPriority: { enabled: false },
    deviceLeases: { enabled: false },
    artifactJanitor: { enabled: false, diskGuard: { enabled: false } },
    tokenAudit: { enabled: false, escalation: { enabled: false } },
    doneJanitor: { enabled: false },
    accountFailover: { enabled: false },
    remediation: {
      remedies: { enabled: false },
      escalation: { enabled: false },
      notify: { enabled: false },
      stalledAgents: { enabled: false },
      disk: { enabled: false },
      workSnapshots: { enabled: false },
    },
  },
  worktrees: { diskSweeper: { enabled: false } },
  // Off by default anyway (KTD-14); listed so an instance built with --machine-jobs off is
  // explicit about it, matching the agents.* jobs above.
  knowledgeBase: { enabled: false },
};

function stop(message) {
  console.error(`STOP: ${message}`);
  return 1;
}

function isAbsoluteInput(value) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function parseProtect(raw) {
  const homes = [];
  const ports = [];
  for (const entry of (raw ?? "").split("|")) {
    const value = entry.trim();
    if (value === "") continue;
    if (/^\d+$/.test(value)) ports.push(Number(value));
    else homes.push(value);
  }
  return { homes, ports };
}

/** The raw BOZEO_* values, or the problems that make them unusable. */
function readEnvValues(env) {
  const problems = [];
  const raw = {};
  for (const name of ["BOZEO_SRC", "BOZEO_REPO", "BOZEO_HOME"]) {
    const value = env[name] ?? "";
    if (value === "") problems.push(`${name} is not set; source the env file /install wrote`);
    else if (value.includes("~")) problems.push(`${name} contains '~'; use an absolute path`);
    else if (!isAbsoluteInput(value)) problems.push(`${name} is not an absolute path: ${value}`);
    else raw[name] = value;
  }
  const portText = env.BOZEO_PORT ?? "";
  const port = /^\d+$/.test(portText) ? Number(portText) : Number.NaN;
  if (!(port > 0 && port < 65536)) problems.push(`BOZEO_PORT is not a port: ${portText}`);
  return { problems, raw, port };
}

/** Where the new instance must not go, with every path compared in canonical form. */
function placementProblems({ src, repo, home, port }, protect) {
  const problems = [];
  const userHome = os.homedir();
  const isolated = protect.homes.length > 0 || protect.ports.length > 0;
  // With anything to protect this is an isolated instance: the default home and port belong to
  // the desktop app and to any later Paseo, even when nothing uses them yet.
  const guarded = [];
  for (const candidate of isolated ? [...protect.homes, path.join(userHome, ".paseo")] : []) {
    if (!guarded.some((known) => samePath(known, candidate))) guarded.push(candidate);
  }
  for (const existing of guarded) {
    if (isSameOrInside(home, existing) || isSameOrInside(existing, home)) {
      problems.push(`BOZEO_HOME ${home} is, contains or is inside the existing home ${existing}`);
    }
    if (isSameOrInside(repo, existing)) {
      problems.push(`BOZEO_REPO ${repo} is inside the existing home ${existing}`);
    }
  }
  if (protect.ports.includes(port)) {
    problems.push(`BOZEO_PORT ${port} belongs to an existing install`);
  }
  if (isolated && port === DEFAULT_PORT) {
    problems.push(`BOZEO_PORT ${port} is the default port; an isolated instance needs another`);
  }
  if (samePath(home, userHome)) problems.push("BOZEO_HOME is your home directory itself");
  if (isSameOrInside(home, path.join(userHome, ".claude"))) {
    problems.push(`BOZEO_HOME ${home} is inside ~/.claude`);
  }
  if (isSameOrInside(home, repo) || isSameOrInside(home, src)) {
    problems.push(`BOZEO_HOME ${home} is inside a checkout`);
  }
  return problems;
}

function checkEnv(env) {
  const { problems, raw, port } = readEnvValues(env);
  if (problems.length > 0) return { problems };
  let paths;
  try {
    paths = {
      src: canonicalPath(raw.BOZEO_SRC),
      repo: canonicalPath(raw.BOZEO_REPO),
      home: canonicalPath(raw.BOZEO_HOME),
    };
  } catch (error) {
    return { problems: [`a BOZEO_* path is unusable: ${error.message}`] };
  }
  return {
    problems: placementProblems({ ...paths, port }, parseProtect(env.BOZEO_PROTECT)),
    ...paths,
  };
}

function readConfigListen(home) {
  const file = path.join(home, "config.json");
  if (!existsSync(file)) return { missing: true };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return { unreadable: error.code ?? "error" };
  }
  const { value, errorLine } = parseJsonQuietly(text);
  if (errorLine !== undefined) return { errorLine };
  return { listen: typeof value?.daemon?.listen === "string" ? value.daemon.listen : undefined };
}

function configListen(home, host) {
  const found = readConfigListen(home);
  if (found.missing) {
    return stop(`${home}/config.json does not exist; create the home first (install.md Step 7)`);
  }
  if (found.unreadable) return stop(`${home}/config.json cannot be read (${found.unreadable})`);
  if (found.errorLine !== undefined) {
    return stop(`${home}/config.json is not valid JSON at line ${found.errorLine}`);
  }
  if (found.listen !== host) {
    return stop(`${home}/config.json has daemon.listen ${found.listen ?? "(unset)"}, not ${host}`);
  }
  return 0;
}

async function guard(home, host) {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let status = {};
  try {
    status = JSON.parse(raw) ?? {};
  } catch {}
  const { localDaemon, listen } = status;
  const homeMatches = typeof status.home === "string" && samePath(status.home, home);
  if (localDaemon === "running" && listen === host && homeMatches) return 0;
  return stop(
    `expected a running daemon for ${home} on ${host}; daemon status says ${localDaemon ?? "unknown"} on ${listen ?? "unknown"} for ${status.home ?? "unknown"}`,
  );
}

function mergeInto(target, source) {
  for (const [key, value] of Object.entries(source)) {
    target[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? mergeInto(target[key] ?? {}, value)
        : value;
  }
  return target;
}

function newHome(homeArg, host, machineJobsOff) {
  const home = canonicalPath(homeArg);
  let exists = true;
  try {
    lstatSync(home);
  } catch (error) {
    if (error.code !== "ENOENT") return stop(`cannot inspect ${home}: ${error.code ?? "error"}`);
    exists = false;
  }
  if (exists) return stop(`${home} already exists; /install only creates a new home`);
  if (!/^127\.0\.0\.1:\d+$/.test(host)) return stop(`listen ${host} is not 127.0.0.1:<port>`);

  // The daemon's own default config (packages/server/src/server/persisted-config.ts), with the
  // chosen listen in place of 127.0.0.1:6767.
  const config = {
    version: 1,
    daemon: {
      listen: host,
      cors: { allowedOrigins: ["https://app.paseo.sh"] },
      relay: { enabled: false },
    },
    app: { baseUrl: "https://app.paseo.sh" },
  };
  if (machineJobsOff) mergeInto(config, MACHINE_JOBS_OFF);

  mkdirSync(path.dirname(home), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  const file = path.join(home, "config.json");
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log(`created   ${home}`);
  console.log(`wrote     ${file}: daemon.listen ${host}, relay off`);
  if (machineJobsOff) {
    const agents = Object.keys(MACHINE_JOBS_OFF.agents).map((key) => `agents.${key}`);
    console.log(`off       ${[...agents, "worktrees.diskSweeper", "knowledgeBase"].join(", ")}`);
  }
  return 0;
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "check-env") {
    const { problems, src, repo, home } = checkEnv(process.env);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`STOP: ${problem}`);
      return 1;
    }
    console.log(src);
    console.log(repo);
    console.log(home);
    return 0;
  }
  if (command === "same-path" && rest.length === 2) return samePath(rest[0], rest[1]) ? 0 : 1;
  if (command === "config-listen" && rest.length === 2) return configListen(rest[0], rest[1]);
  if (command === "guard" && rest.length === 2) return guard(rest[0], rest[1]);
  if (command === "new-home" && (rest.length === 2 || rest.length === 4)) {
    const [home, host, flag, value] = rest;
    if (rest.length === 4 && !(flag === "--machine-jobs" && value === "off")) {
      console.error("usage: new-home <home> <host> [--machine-jobs off]");
      return 2;
    }
    return newHome(home, host, rest.length === 4);
  }
  console.error(
    "usage: install-instance.mjs check-env | same-path <a> <b> | config-listen <home> <host> | guard <home> <host> | new-home <home> <host> [--machine-jobs off]",
  );
  return 2;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`STOP: ${error.message}`);
  process.exitCode = 1;
}
