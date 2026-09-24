import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { extname } from "node:path";
import { promisify } from "node:util";

import { createExternalCommandProcessEnv, type ProcessEnvRecord } from "../server/paseo-env.js";
import {
  isWindowsCommandScript,
  quoteWindowsArgument,
  quoteWindowsCommand,
} from "./windows-command.js";

import { lowerAgentProcessPriority, lowerBackgroundProcessPriority } from "./process-priority.js";

const execFileAsync = promisify(execFile);

/**
 * Opt-in scheduling priority for a spawned process, per the daemon's `agents.processPriority`
 * policy (see docs/resource-monitor.md). "agent" is for agent provider processes and terminals an
 * agent owns; "background" is for the daemon's own periodic work. Unset leaves the process at the
 * daemon's priority, which is what work someone is waiting on wants.
 */
export type SpawnPriority = "agent" | "background";

const spawnPriorityScope = new AsyncLocalStorage<SpawnPriority>();

/**
 * Runs `work` with every spawn inside it defaulting to `priority`, for call sites that reach the
 * subprocess through layers (forge status polling goes through the forge adapters and their CLI
 * runners) that have no priority option to thread. An explicit `priority` on a spawn wins.
 */
/** The priority the enclosing `runWithSpawnPriority` scope gives spawns, if any. */
export function currentSpawnPriority(): SpawnPriority | undefined {
  return spawnPriorityScope.getStore();
}

export function runWithSpawnPriority<T>(priority: SpawnPriority, work: () => T): T {
  return spawnPriorityScope.run(priority, work);
}

function lowerSpawnedPriority(pid: number | undefined, priority: SpawnPriority | undefined): void {
  priority ??= currentSpawnPriority();
  if (priority === "agent") lowerAgentProcessPriority(pid);
  else if (priority === "background") lowerBackgroundProcessPriority(pid);
}

interface ExternalEnvOptions {
  baseEnv?: ProcessEnvRecord;
  envMode?: "external" | "internal";
  env?: ProcessEnvRecord;
  envOverlay?: ProcessEnvRecord;
}

export type SpawnProcessOptions = Omit<SpawnOptions, "env"> &
  ExternalEnvOptions & { priority?: SpawnPriority };

interface ExecCommandOptions extends ExternalEnvOptions {
  priority?: SpawnPriority;
  cwd?: string;
  encoding?: BufferEncoding;
  killSignal?: NodeJS.Signals;
  timeout?: number;
  maxBuffer?: number;
  shell?: boolean | string;
  signal?: AbortSignal;
}

interface ExecCommandResult {
  stdout: string;
  stderr: string;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function shouldUseWindowsShell(
  command: string,
  requestedShell?: boolean | string,
): boolean | string {
  if (isWindowsCommandScript(command)) {
    return true;
  }
  if (requestedShell !== undefined) {
    return requestedShell;
  }
  return process.platform === "win32" && !hasPathSeparator(command) && !extname(command);
}

export function spawnProcess(
  command: string,
  args: string[],
  options?: SpawnProcessOptions,
): ChildProcess {
  const { baseEnv, env, envOverlay, priority, ...spawnOptions } = options ?? {};
  const resolvedBaseEnv = env ?? baseEnv ?? process.env;
  const isWindows = process.platform === "win32";
  const shell = shouldUseWindowsShell(command, spawnOptions.shell);

  const shouldQuoteForShell = isWindows && shell !== false;
  const resolvedCommand = shouldQuoteForShell ? quoteWindowsCommand(command) : command;
  const resolvedArgs = shouldQuoteForShell ? args.map(quoteWindowsArgument) : args;
  const childEnv =
    options?.envMode === "internal"
      ? ({ ...resolvedBaseEnv, ...envOverlay } as NodeJS.ProcessEnv)
      : createExternalCommandProcessEnv(
          command,
          resolvedBaseEnv,
          ...(envOverlay ? [envOverlay] : []),
        );

  const child = spawn(resolvedCommand, resolvedArgs, {
    ...spawnOptions,
    env: childEnv,
    shell,
    signal: options?.signal,
    windowsHide: true,
  });
  lowerSpawnedPriority(child.pid, priority);
  return child;
}

export async function execCommand(
  command: string,
  args: string[],
  options?: ExecCommandOptions,
): Promise<ExecCommandResult> {
  const { baseEnv, env, envOverlay } = options ?? {};
  const resolvedBaseEnv = env ?? baseEnv ?? process.env;
  const isWindows = process.platform === "win32";
  const shell = shouldUseWindowsShell(command, options?.shell);
  const shouldQuoteForShell = isWindows && shell !== false;
  const resolvedCommand = shouldQuoteForShell ? quoteWindowsCommand(command) : command;
  const resolvedArgs = shouldQuoteForShell ? args.map(quoteWindowsArgument) : args;
  const childEnv =
    options?.envMode === "internal"
      ? ({ ...resolvedBaseEnv, ...envOverlay } as NodeJS.ProcessEnv)
      : createExternalCommandProcessEnv(
          command,
          resolvedBaseEnv,
          ...(envOverlay ? [envOverlay] : []),
        );

  const pending = execFileAsync(resolvedCommand, resolvedArgs, {
    cwd: options?.cwd,
    env: childEnv,
    encoding: options?.encoding ?? "utf8",
    killSignal: options?.killSignal,
    timeout: options?.timeout,
    maxBuffer: options?.maxBuffer,
    shell,
    windowsHide: true,
  });
  lowerSpawnedPriority(pending.child.pid, options?.priority);
  return pending as Promise<ExecCommandResult>;
}
