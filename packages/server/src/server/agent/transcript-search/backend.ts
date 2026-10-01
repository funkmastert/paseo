/**
 * Three search backends, tried in order: a real `rg` on PATH, the Claude Code CLI binary invoked
 * with argv0 `rg` (Claude Code's own executable is a full ripgrep when launched that way — the
 * same trick a `rg` shell function commonly wraps around it), then a streaming Node line scanner.
 * Nothing here fails when neither ripgrep path is available; it falls back to Node.
 *
 * A user-supplied regex only ever runs on the main thread when ripgrep (either form) is doing the
 * matching — ripgrep's own regex engine is linear-time, no catastrophic backtracking. When the
 * Node fallback has to run a regex itself, it runs in a worker with a deadline instead, so a
 * pathological pattern can be killed instead of wedging the daemon's event loop.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import {
  executableExists,
  findExecutable,
} from "../../../executable-resolution/executable-resolution.js";

export interface CompiledQuery {
  pattern: string;
  regex: boolean;
  caseInsensitive: boolean;
}

export interface LineMatch {
  lineNumber: number;
  line: string;
}

export interface FileSearchResult {
  matches: LineMatch[];
  /** True when there were more matches than `maxMatches` allowed. */
  truncated: boolean;
}

/** Runs one subprocess to completion and collects stdout. Swapped out in tests. */
export interface ProcessRunner {
  run(
    cmd: string,
    args: string[],
    options?: { argv0?: string },
  ): Promise<{ stdout: string; exitCode: number | null }>;
}

export const defaultProcessRunner: ProcessRunner = {
  run(cmd, args, options) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "ignore"],
        ...(options?.argv0 ? { argv0: options.argv0 } : {}),
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.once("error", reject);
      child.once("close", (exitCode) => resolve({ stdout, exitCode }));
    });
  },
};

export interface RipgrepInvocation {
  /** The executable to spawn: `rg` itself, or the Claude Code binary standing in for it. */
  command: string;
  /** Set to `rg` when `command` is really the Claude binary, so it recognizes the alias. */
  argv0?: string;
}

export type BackendChoice =
  | { label: "ripgrep"; invocation: RipgrepInvocation }
  | { label: "ripgrep (claude)"; invocation: RipgrepInvocation }
  | { label: "node" };

/** Resolves the Claude Code binary the daemon would otherwise launch for the claude provider. */
export interface ClaudeBinaryResolver {
  resolve(): Promise<string | null>;
}

export const defaultClaudeBinaryResolver: ClaudeBinaryResolver = {
  async resolve() {
    // The common `rg` shell function wrapping Claude Code checks this env var first; honor it
    // the same way before falling back to the normal PATH lookup the claude provider itself uses.
    const execPath = process.env.CLAUDE_CODE_EXECPATH;
    if (execPath && executableExists(execPath)) return execPath;
    return await findExecutable("claude");
  },
};

let cachedBackend: BackendChoice | null = null;

/** Probes once per process and caches the answer. */
export async function detectBackend(
  runner: ProcessRunner = defaultProcessRunner,
  claudeBinary: ClaudeBinaryResolver = defaultClaudeBinaryResolver,
): Promise<BackendChoice> {
  if (cachedBackend) return cachedBackend;
  cachedBackend = await probeBackend(runner, claudeBinary);
  return cachedBackend;
}

/** Test seam: force the next `detectBackend()` to re-probe. */
export function resetBackendDetectionForTests(): void {
  cachedBackend = null;
}

async function probeBackend(
  runner: ProcessRunner,
  claudeBinary: ClaudeBinaryResolver,
): Promise<BackendChoice> {
  if (await probe(runner, "rg", {})) {
    return { label: "ripgrep", invocation: { command: "rg" } };
  }
  const claudePath = await claudeBinary.resolve();
  if (claudePath && (await probe(runner, claudePath, { argv0: "rg" }))) {
    return { label: "ripgrep (claude)", invocation: { command: claudePath, argv0: "rg" } };
  }
  return { label: "node" };
}

async function probe(
  runner: ProcessRunner,
  command: string,
  options: { argv0?: string },
): Promise<boolean> {
  try {
    const { exitCode } = await runner.run(command, ["--version"], options);
    return exitCode === 0;
  } catch {
    return false;
  }
}

/** Parses `rg --line-number --no-heading` output: `<line>:<text>` per matched line. */
export function parseRipgrepOutput(stdout: string): LineMatch[] {
  const matches: LineMatch[] = [];
  for (const raw of stdout.split("\n")) {
    if (!raw) continue;
    const sep = raw.indexOf(":");
    if (sep < 0) continue;
    const lineNumber = Number(raw.slice(0, sep));
    if (!Number.isFinite(lineNumber)) continue;
    matches.push({ lineNumber, line: raw.slice(sep + 1) });
  }
  return matches;
}

export async function searchWithRipgrep(
  filePath: string,
  query: CompiledQuery,
  maxMatches: number,
  invocation: RipgrepInvocation,
  runner: ProcessRunner = defaultProcessRunner,
): Promise<FileSearchResult> {
  const args = ["--line-number", "--no-heading", "--max-count", String(maxMatches + 1)];
  if (!query.regex) args.push("--fixed-strings");
  if (query.caseInsensitive) args.push("--ignore-case");
  args.push("--", query.pattern, filePath);
  const { stdout, exitCode } = await runner.run(
    invocation.command,
    args,
    invocation.argv0 ? { argv0: invocation.argv0 } : undefined,
  );
  // 0: matches found. 1: no matches (not an error). Anything else: treat as a failed run.
  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error(`rg exited with code ${exitCode}`);
  }
  const parsed = parseRipgrepOutput(stdout);
  const truncated = parsed.length > maxMatches;
  return { matches: parsed.slice(0, maxMatches), truncated };
}

function compileMatcher(query: CompiledQuery): (line: string) => boolean {
  if (query.regex) {
    const re = new RegExp(query.pattern, query.caseInsensitive ? "i" : "");
    return (line) => re.test(line);
  }
  if (query.caseInsensitive) {
    const needle = query.pattern.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
  return (line) => line.includes(query.pattern);
}

export async function searchWithNode(
  filePath: string,
  query: CompiledQuery,
  maxMatches: number,
): Promise<FileSearchResult> {
  const isMatch = compileMatcher(query);
  const found: LineMatch[] = [];
  let truncated = false;
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber += 1;
    if (!isMatch(line)) continue;
    if (found.length >= maxMatches) {
      truncated = true;
      rl.close();
      break;
    }
    found.push({ lineNumber, line });
  }
  return { matches: found, truncated };
}

export const DEFAULT_REGEX_WORKER_TIMEOUT_MS = 10_000;

export type NodeRegexSearchOutcome =
  | ({ status: "ok" } & FileSearchResult)
  | { status: "timed_out" }
  | { status: "error"; message: string };

// Runs the regex match on a worker thread so a pathological pattern (catastrophic backtracking)
// can be killed with Worker#terminate() instead of hanging the daemon's own event loop — a
// synchronous RegExp#test() on the main thread cannot be interrupted once it starts.
const REGEX_SEARCH_WORKER_SOURCE = String.raw`
  const fs = require("node:fs");
  const readline = require("node:readline");
  const { parentPort, workerData } = require("node:worker_threads");
  const { filePath, pattern, flags, maxMatches } = workerData;
  (async () => {
    const re = new RegExp(pattern, flags);
    const matches = [];
    let truncated = false;
    let lineNumber = 0;
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      lineNumber += 1;
      if (!re.test(line)) continue;
      if (matches.length >= maxMatches) {
        truncated = true;
        rl.close();
        break;
      }
      matches.push({ lineNumber, line });
    }
    parentPort.postMessage({ status: "ok", matches, truncated });
  })().catch((error) => {
    parentPort.postMessage({ status: "error", message: error instanceof Error ? error.message : String(error) });
  });
`;

export async function searchWithNodeRegexWorker(
  filePath: string,
  query: CompiledQuery,
  maxMatches: number,
  timeoutMs: number = DEFAULT_REGEX_WORKER_TIMEOUT_MS,
): Promise<NodeRegexSearchOutcome> {
  return new Promise((resolve) => {
    const worker = new Worker(REGEX_SEARCH_WORKER_SOURCE, {
      eval: true,
      workerData: {
        filePath,
        pattern: query.pattern,
        flags: query.caseInsensitive ? "i" : "",
        maxMatches,
      },
    });
    let settled = false;
    const settle = (outcome: NodeRegexSearchOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Fire-and-forget: termination races the worker's own exit; neither needs awaiting here.
      void worker.terminate();
      // Reached from the timer, the worker's message, and its error event; the `settled` guard
      // above makes exactly one of those the winner, so this never double-resolves.
      // eslint-disable-next-line promise/no-multiple-resolved
      resolve(outcome);
    };
    const timer = setTimeout(() => settle({ status: "timed_out" }), timeoutMs);
    worker.once(
      "message",
      (
        message:
          | { status: "ok"; matches: LineMatch[]; truncated: boolean }
          | { status: "error"; message: string },
      ) => settle(message),
    );
    worker.once("error", (error) => settle({ status: "error", message: error.message }));
  });
}
