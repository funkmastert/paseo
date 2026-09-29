#!/usr/bin/env node
// Adds the account-pool block to a Paseo config.json for the /install command
// (.claude/commands/install.md). It only ever adds keys that are missing.
//
//   node scripts/install-merge-config.mjs --config <abs config.json> --patch <abs patch.json> [--write]
//
// Without --write it changes nothing and prints the key paths it would add. With --write it
// backs the file up to config.json.bak-<timestamp> and writes it atomically. A symlinked
// config.json is written through to its target; a dangling link or a read-only file is refused.
//
// config.json can hold API keys and the daemon password hash, so this prints key paths and
// plugin ids only, never a value from the existing file. `agentModelPolicy` and each
// `agents.providers.<id>` / `plugins.<id>` entry is added whole or not at all: a user's own
// policy or provider is never merged into or replaced. A key that is already set to something
// else is a conflict, and any conflict means nothing is written.
//
// Exit codes: 0 ok (or nothing to add), 1 bad input, 3 conflicts.

import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkConfigDirs, isPlainObject, parseJsonQuietly, planMerge } from "./install-lib.mjs";

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

function readJson(file, label) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${label} at ${file}: ${error.code ?? "error"}`, { cause: error });
  }
  const { value, errorLine } = parseJsonQuietly(text);
  if (errorLine !== undefined)
    throw new Error(`${label} at ${file} is not valid JSON at line ${errorLine}`);
  if (!isPlainObject(value)) throw new Error(`${label} at ${file} is not a JSON object`);
  return value;
}

/**
 * The file to read and replace. A symlinked config.json (a dotfiles repo, say) is written
 * through to its target, so the link keeps working; a dangling link or a file the user cannot
 * write is refused, never silently replaced.
 */
function resolveConfigTarget(config) {
  let link;
  try {
    link = lstatSync(config);
  } catch (error) {
    if (error.code === "ENOENT") return { file: config, exists: false };
    throw new Error(`cannot inspect ${config}: ${error.code ?? "error"}`, { cause: error });
  }
  let file = config;
  if (link.isSymbolicLink()) {
    try {
      file = realpathSync(config);
    } catch (error) {
      throw new Error(
        `${config} is a symlink whose target cannot be resolved (${error.code ?? "error"}); fix the link first`,
        { cause: error },
      );
    }
  }
  if (!statSync(file).isFile()) throw new Error(`${file} is not a regular file`);
  for (const [target, what] of [
    [file, "file"],
    [path.dirname(file), "directory"],
  ]) {
    try {
      accessSync(target, constants.W_OK);
    } catch {
      throw new Error(
        `the ${what} ${target} is not writable; ask the user before changing its permissions`,
      );
    }
  }
  return { file, exists: true, linkedFrom: file === config ? undefined : config };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const patch = readJson(args.patch, "patch");
  const { file, exists, linkedFrom } = resolveConfigTarget(args.config);
  const config = exists ? readJson(file, "config.json") : {};

  const dirProblems = checkConfigDirs(patch, os.homedir());
  for (const problem of dirProblems) console.log(`invalid   ${problem}`);
  if (dirProblems.length > 0) return 1;

  const { merged, added, same, conflicts } = planMerge(config, patch);
  console.log(`config    ${file}${exists ? "" : " (does not exist yet; would be created)"}`);
  if (linkedFrom) console.log(`link      ${linkedFrom} points here; the link is kept`);
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

  const mode = exists ? statSync(file).mode & 0o777 : 0o600;
  if (exists) {
    const backup = `${file}.bak-${timestamp(new Date())}`;
    copyFileSync(file, backup);
    chmodSync(backup, mode);
    console.log(`backup    ${backup}`);
  }
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, { mode, flag: "wx" });
  renameSync(temp, file);
  console.log(`result    wrote ${added.length} key path(s) to ${file}`);
  return 0;
}

// No main-module guard: the logic lives in install-lib.mjs, so this file always runs. A guard
// compared the realpath of this module with argv[1] and made a run through a symlinked path a
// silent no-op.
try {
  process.exitCode = main();
} catch (error) {
  console.error(`error     ${error.message}`);
  process.exitCode = 1;
}
