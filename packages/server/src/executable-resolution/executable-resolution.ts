import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { execCommand } from "../utils/spawn.js";
import { isWindowsCommandScript } from "../utils/windows-command.js";
import { windowsExecutableResolution } from "./windows.js";

export { quoteWindowsArgument, quoteWindowsCommand } from "../utils/windows-command.js";

type Which = (command: string, options: { all: true }) => Promise<string[]>;

const require = createRequire(import.meta.url);
const which = require("which") as Which;
const PROBE_TIMEOUT_MS = 2000;

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

async function enumerateCandidates(name: string): Promise<string[]> {
  if (process.platform !== "win32" && existsSync("/usr/bin/which")) {
    return enumerateCandidatesViaSystemWhich(name);
  }
  return enumerateCandidatesViaLibrary(name);
}

const SYSTEM_WHICH_TIMEOUTS_MS = [3000, 6000];

interface SystemWhichDeps {
  exec: (command: string, args: string[], options: object) => Promise<{ stdout: string }>;
  fallback: (name: string) => Promise<string[]>;
}

function wasKilled(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { killed?: unknown }).killed === true
  );
}

/**
 * `which -a` through the system binary. Under heavy load the subprocess can miss its timeout
 * and be SIGKILLed; that says nothing about the command, so it is retried once with more time and
 * then answered by the in-process PATH search instead of failing the lookup.
 */
export async function enumerateCandidatesViaSystemWhich(
  name: string,
  deps: SystemWhichDeps = { exec: execCommand, fallback: enumerateCandidatesViaLibrary },
): Promise<string[]> {
  for (const timeout of SYSTEM_WHICH_TIMEOUTS_MS) {
    try {
      const { stdout } = await deps.exec("/usr/bin/which", ["-a", name], {
        timeout,
        killSignal: "SIGKILL",
      });
      return Array.from(new Set(stdout.trim().split("\n").filter(Boolean)));
    } catch (error) {
      // which exits 1 for a missing command. A failed lookup is not evidence of absence.
      if (error instanceof Error && "code" in error && error.code === 1) return [];
      if (!wasKilled(error)) throw error;
    }
  }
  return deps.fallback(name);
}

async function enumerateCandidatesViaLibrary(name: string): Promise<string[]> {
  let candidates: string[];
  try {
    candidates = await which(name, { all: true });
  } catch (error) {
    // `which` throws ENOENT when the command is absent from PATH.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    return true;
  });
}

export async function probeExecutable(
  executablePath: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    await execCommand(executablePath, ["--version"], {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      shell: isWindowsCommandScript(executablePath),
    });
    return true;
  } catch (error) {
    return classifyProbeError(error);
  }
}

function classifyProbeError(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException & {
    killed?: boolean;
  };
  if (err.killed) {
    return true;
  }
  if (typeof err.code === "number") {
    return true;
  }
  if (
    err.code === "ENOENT" ||
    err.code === "EACCES" ||
    err.code === "ENOEXEC" ||
    err.code === "UNKNOWN"
  ) {
    return false;
  }
  return false;
}

/**
 * Check a literal executable path. PATH search is handled by findExecutable().
 */
export function executableExists(
  executablePath: string,
  exists: typeof existsSync = existsSync,
): string | null {
  if (process.platform === "win32") {
    return windowsExecutableResolution.exists(executablePath, { exists });
  }
  return exists(executablePath) ? executablePath : null;
}

export type ExecutableProbe = (executablePath: string, timeoutMs: number) => Promise<boolean>;

/**
 * `probe` defaults to running `<candidate> --version` with the daemon's environment. Pass another
 * when that run has side effects: Basic Memory writes a config and creates `~/basic-memory`
 * from it unless its isolated environment is set (knowledge-base/basic-memory-sidecar.ts).
 */
export async function findExecutable(
  name: string,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  probe: ExecutableProbe = probeExecutable,
): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }

  if (process.platform === "win32") {
    return windowsExecutableResolution.find(trimmed, {
      enumeratePathCandidates: enumerateCandidates,
      probeExecutable: probe,
      exists: existsSync,
      probeTimeoutMs,
    });
  }

  if (hasPathSeparator(trimmed)) {
    return (await probe(trimmed, probeTimeoutMs)) ? trimmed : null;
  }

  const candidates = await enumerateCandidates(trimmed);
  for (const candidate of candidates) {
    if (await probe(candidate, probeTimeoutMs)) {
      return candidate;
    }
  }
  return null;
}

export async function isCommandAvailable(command: string): Promise<boolean> {
  return (await findExecutable(command)) !== null;
}
