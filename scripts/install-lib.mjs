// Shared by the /install scripts (.claude/commands/install.md). Library only: importing it runs
// nothing, so a script that imports it through a symlinked path still does its work.

import { realpathSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------------------------
// Paths
//
// Every comparison between two paths goes through `canonicalPath` + `pathKey`. Plain string
// equality let `<home>/`, `<home>/./` and a case variant of an existing home pass as a new one,
// and Step 7 then rewrote that home's config.json.

function isCaseInsensitive(platform) {
  return platform === "darwin" || platform === "win32";
}

/** Git Bash writes `C:\Users\x` as `/c/Users/x`; Node on Windows reads that as `C:\c\Users\x`. */
function fromMsysPath(raw, platform) {
  if (platform !== "win32") return raw;
  const match = /^\/([A-Za-z])(?:\/(.*))?$/.exec(raw);
  return match ? `${match[1]}:/${match[2] ?? ""}` : raw;
}

/**
 * The real, absolute form of a path that may not exist yet: symlinks in its existing part are
 * resolved, `.`/`..`/doubled separators are gone, there is no trailing separator, and on
 * Windows the separators are `/` so the value is safe in JSON and in Git Bash alike.
 */
export function canonicalPath(input, platform = process.platform) {
  if (typeof input !== "string" || input === "" || /[\r\n]/.test(input) || input.includes("\0")) {
    throw new Error("not a usable path");
  }
  let head = path.resolve(fromMsysPath(input, platform));
  const rest = [];
  for (;;) {
    try {
      head = realpathSync.native(head);
      break;
    } catch {
      const parent = path.dirname(head);
      if (parent === head) break;
      rest.unshift(path.basename(head));
      head = parent;
    }
  }
  const joined = rest.length > 0 ? path.join(head, ...rest) : head;
  return platform === "win32" ? joined.replace(/\\/g, "/") : joined;
}

/** What two canonical paths are compared by: case-folded where the file system usually is. */
export function pathKey(canonical, platform = process.platform) {
  const slashed = canonical.replace(/\\/g, "/");
  return isCaseInsensitive(platform) ? slashed.toLowerCase() : slashed;
}

export function samePath(a, b, platform = process.platform) {
  return (
    pathKey(canonicalPath(a, platform), platform) === pathKey(canonicalPath(b, platform), platform)
  );
}

/** True when `child` is `parent` or anywhere below it. */
export function isSameOrInside(child, parent, platform = process.platform) {
  const childKey = pathKey(canonicalPath(child, platform), platform);
  const parentKey = pathKey(canonicalPath(parent, platform), platform);
  if (childKey === parentKey) return true;
  return childKey.startsWith(parentKey.endsWith("/") ? parentKey : `${parentKey}/`);
}

// ---------------------------------------------------------------------------------------------
// JSON
//
// config.json can hold API keys. V8's JSON.parse errors quote the input around the fault, so a
// parse error's message is never shown. `jsonErrorLine` finds the line of the first fault
// itself, which is all a report needs.

/** 1-based line of the first JSON syntax error in `text`, or undefined when it parses. */
export function jsonErrorLine(text) {
  let i = 0;
  const fail = () => {
    throw new JsonFault(i);
  };
  const skipSpace = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i += 1;
  };
  const literal = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

  function string() {
    i += 1;
    while (i < text.length) {
      const char = text[i];
      if (char === '"') {
        i += 1;
        return;
      }
      if (char === "\\") {
        const escape = text[i + 1];
        if (escape !== undefined && '"\\/bfnrt'.includes(escape)) i += 2;
        else if (escape === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) i += 6;
        else fail();
        continue;
      }
      if (char < " ") fail();
      i += 1;
    }
    fail();
  }

  function value() {
    skipSpace();
    const char = text[i];
    if (char === "{") {
      i += 1;
      skipSpace();
      if (text[i] === "}") {
        i += 1;
        return;
      }
      for (;;) {
        skipSpace();
        if (text[i] !== '"') fail();
        string();
        skipSpace();
        if (text[i] !== ":") fail();
        i += 1;
        value();
        skipSpace();
        if (text[i] === ",") i += 1;
        else if (text[i] === "}") {
          i += 1;
          return;
        } else fail();
      }
    }
    if (char === "[") {
      i += 1;
      skipSpace();
      if (text[i] === "]") {
        i += 1;
        return;
      }
      for (;;) {
        value();
        skipSpace();
        if (text[i] === ",") i += 1;
        else if (text[i] === "]") {
          i += 1;
          return;
        } else fail();
      }
    }
    if (char === '"') return string();
    literal.lastIndex = i;
    const match = literal.exec(text);
    if (!match) fail();
    i += match[0].length;
  }

  try {
    value();
    skipSpace();
    if (i < text.length) fail();
    return undefined;
  } catch (error) {
    if (!(error instanceof JsonFault)) throw error;
    return text.slice(0, error.offset).split("\n").length;
  }
}

class JsonFault extends Error {
  constructor(offset) {
    super("json fault");
    this.offset = offset;
  }
}

/**
 * `{ value }` when `text` is JSON, else `{ errorLine }`. Never throws and never returns the
 * parse error's message.
 */
export function parseJsonQuietly(text) {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { errorLine: jsonErrorLine(text) ?? 1 };
  }
}

// ---------------------------------------------------------------------------------------------
// Merging the account-pool block into config.json

const ATOMIC_PATHS = [/^agentModelPolicy$/, /^agents\.providers\.[^.]+$/, /^plugins\.[^.]+$/];

export function isPlainObject(value) {
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
    } else if (samePath(dir, defaultDir)) {
      problems.push(`agents.providers.${id}.env.CLAUDE_CONFIG_DIR is ~/.claude itself`);
    }
  }
  return problems;
}
