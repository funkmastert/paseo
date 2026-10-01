/**
 * The two search backends: ripgrep when a binary is reachable on PATH (macOS, Linux, Windows
 * alike — `rg` resolves to `rg.exe` there), a streaming Node line scanner otherwise. Nothing here
 * fails when ripgrep is missing; it falls back.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

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
  run(cmd: string, args: string[]): Promise<{ stdout: string; exitCode: number | null }>;
}

export const defaultProcessRunner: ProcessRunner = {
  run(cmd, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.once("error", reject);
      child.once("close", (exitCode) => resolve({ stdout, exitCode }));
    });
  },
};

let cachedBackend: "ripgrep" | "node" | null = null;

/** Probes once per process and caches the answer. */
export async function detectBackend(
  runner: ProcessRunner = defaultProcessRunner,
): Promise<"ripgrep" | "node"> {
  if (cachedBackend) return cachedBackend;
  cachedBackend = (await probeRipgrep(runner)) ? "ripgrep" : "node";
  return cachedBackend;
}

/** Test seam: force the next `detectBackend()` to re-probe. */
export function resetBackendDetectionForTests(): void {
  cachedBackend = null;
}

async function probeRipgrep(runner: ProcessRunner): Promise<boolean> {
  try {
    const { exitCode } = await runner.run("rg", ["--version"]);
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
  runner: ProcessRunner = defaultProcessRunner,
): Promise<FileSearchResult> {
  const args = ["--line-number", "--no-heading", "--max-count", String(maxMatches + 1)];
  if (!query.regex) args.push("--fixed-strings");
  if (query.caseInsensitive) args.push("--ignore-case");
  args.push("--", query.pattern, filePath);
  const { stdout, exitCode } = await runner.run("rg", args);
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
