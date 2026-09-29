#!/usr/bin/env node
// Adds the account-pool block to a Paseo config.json for the /install command
// (.claude/commands/install.md). It only ever adds keys that are missing.
//
//   node scripts/install-merge-config.mjs --config <abs config.json> --patch <abs patch.json> [--write]
//
// Without --write it changes nothing and prints the key paths it would add. With --write it
// backs the file up to config.json.bak-<timestamp> and writes it atomically.
//
// config.json can hold API keys and the daemon password hash, so this prints key paths and
// plugin ids only, never a value from the existing file. `agentModelPolicy` and each
// `agents.providers.<id>` / `plugins.<id>` entry is added whole or not at all: a user's own
// policy or provider is never merged into or replaced. A key that is already set to something
// else is a conflict, and any conflict means nothing is written.
//
// Exit codes: 0 ok (or nothing to add), 1 bad input, 3 conflicts.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMainModule } from "./is-main-module.mjs";

const ATOMIC_PATHS = [/^agentModelPolicy$/, /^agents\.providers\.[^.]+$/, /^plugins\.[^.]+$/];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAtomic(keyPath) {
  return ATOMIC_PATHS.some((pattern) => pattern.test(keyPath));
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Returns { merged, added, same, conflicts }; never mutates its inputs. */
export function planMerge(config, patch) {
  const added = [];
  const same = [];
  const conflicts = [];

  function walk(target, source, prefix) {
    const out = { ...target };
    for (const [key, value] of Object.entries(source)) {
      const keyPath = prefix ? `${prefix}.${key}` : key;
      if (!(key in target) && isPlainObject(value) && !isAtomic(keyPath)) {
        // A new container: list what goes into it, such as each provider id.
        out[key] = walk({}, value, keyPath);
      } else if (!(key in target)) {
        out[key] = value;
        added.push(keyPath);
      } else if (!isAtomic(keyPath) && isPlainObject(target[key]) && isPlainObject(value)) {
        out[key] = walk(target[key], value, keyPath);
      } else if (deepEqual(target[key], value)) {
        same.push(keyPath);
      } else {
        conflicts.push(keyPath);
      }
    }
    return out;
  }

  const merged = walk(config, patch, "");
  return { merged, added, same, conflicts };
}

/** Pool CLAUDE_CONFIG_DIR values that would sign in to the wrong place. */
export function checkConfigDirs(patch, homeDir) {
  const problems = [];
  const providers = patch?.agents?.providers;
  if (!isPlainObject(providers)) return problems;
  const defaultDir = path.resolve(homeDir, ".claude");
  for (const [id, entry] of Object.entries(providers)) {
    const dir = entry?.env?.CLAUDE_CONFIG_DIR;
    if (dir === undefined) continue;
    if (typeof dir !== "string" || dir.includes("~") || !path.isAbsolute(dir)) {
      problems.push(`agents.providers.${id}.env.CLAUDE_CONFIG_DIR is not an absolute path`);
    } else if (path.resolve(dir) === defaultDir) {
      problems.push(`agents.providers.${id}.env.CLAUDE_CONFIG_DIR is ~/.claude itself`);
    }
  }
  return problems;
}

function timestamp(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

function parseArgs(argv) {
  const args = { write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write") args.write = true;
    else if (arg === "--config") args.config = argv[++i];
    else if (arg === "--patch") args.patch = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.config || !args.patch) throw new Error("--config and --patch are required");
  for (const key of ["config", "patch"]) {
    if (args[key].includes("~") || !path.isAbsolute(args[key])) {
      throw new Error(`--${key} must be an absolute path without ~`);
    }
  }
  return args;
}

function parseQuietly(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readJson(file, label) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${label} at ${file}: ${error.code ?? "error"}`, { cause: error });
  }
  // Never echo the text or the parse error: config.json may hold secrets, and V8's JSON
  // errors quote the input.
  const value = parseQuietly(text);
  if (!isPlainObject(value)) throw new Error(`${label} at ${file} is not a JSON object`);
  return value;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const patch = readJson(args.patch, "patch");
  const exists = existsSync(args.config);
  const config = exists ? readJson(args.config, "config.json") : {};

  const dirProblems = checkConfigDirs(patch, os.homedir());
  for (const problem of dirProblems) console.log(`invalid   ${problem}`);
  if (dirProblems.length > 0) return 1;

  const { merged, added, same, conflicts } = planMerge(config, patch);
  console.log(`config    ${args.config}${exists ? "" : " (does not exist yet; would be created)"}`);
  for (const keyPath of added) console.log(`add       ${keyPath}`);
  for (const keyPath of same) console.log(`present   ${keyPath} (already set to the same value)`);
  for (const keyPath of conflicts)
    console.log(`conflict  ${keyPath} (already set to something else; not changed)`);

  const otherPlugins = isPlainObject(config.plugins)
    ? Object.keys(config.plugins).filter(
        (id) => !(isPlainObject(patch.plugins) && id in patch.plugins),
      )
    : [];
  if (added.includes("pluginsEnabled") && otherPlugins.length > 0) {
    console.log(
      `note      pluginsEnabled also starts these recorded plugins: ${otherPlugins.join(", ")}`,
    );
  }

  if (conflicts.length > 0) {
    console.log("result    conflicts: nothing written. Ask the user how to resolve each path.");
    return 3;
  }
  if (added.length === 0) {
    console.log("result    nothing to add");
    return 0;
  }
  if (!args.write) {
    console.log(`result    dry run: ${added.length} key path(s) would be added; nothing written`);
    return 0;
  }

  const mode = exists ? statSync(args.config).mode & 0o777 : 0o600;
  if (exists) {
    const backup = `${args.config}.bak-${timestamp(new Date())}`;
    copyFileSync(args.config, backup);
    chmodSync(backup, mode);
    console.log(`backup    ${backup}`);
  }
  const temp = `${args.config}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, { mode, flag: "wx" });
  renameSync(temp, args.config);
  console.log(`result    wrote ${added.length} key path(s) to ${args.config}`);
  return 0;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`error     ${error.message}`);
    process.exitCode = 1;
  }
}
