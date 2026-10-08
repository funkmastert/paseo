import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { Logger } from "pino";

import { findExecutable } from "../../executable-resolution/executable-resolution.js";
import { execCommand, spawnProcess } from "../../utils/spawn.js";
import { terminateWithTreeKill, type ProcessTerminator } from "../../utils/tree-kill.js";
import type { ManagedProcessRegistry } from "../managed-processes/managed-processes.js";
import { createExternalProcessEnv, type ProcessEnvRecord } from "../paseo-env.js";
import type { ResolvedKnowledgeBaseConfig } from "./config.js";

/**
 * The Basic Memory sidecar (docs/knowledge-base.md, KTD-1, KTD-3). The daemon runs
 * `basic-memory mcp` as a separate local process and speaks MCP to it over stdio; it never
 * imports or ships Basic Memory. Basic Memory indexes the notes directory and answers searches.
 * It never writes a note: the environment below switches off every path that would.
 */

/** The release `paseo kb setup` installs (KTD-4). Another version runs, with a warning. */
export const BASIC_MEMORY_VERSION = "0.23.2";
/** The one Basic Memory project the sidecar registers and restricts `mcp` to. */
export const BASIC_MEMORY_PROJECT_NAME = "knowledge";

/** A Python cold start plus the first index of the notes directory. */
const STARTUP_TIMEOUT_MS = 60_000;
/** `--version` and `project` commands. A fresh config directory runs migrations first. */
const CLI_TIMEOUT_MS = 60_000;
const RESTART_BASE_MS = 2_000;
const RESTART_MAX_MS = 5 * 60_000;
/** A server up at least this long before it exits has its backoff reset. */
const STABLE_UPTIME_MS = 60_000;
/** On stdin EOF Basic Memory stops its watcher and closes its database; signals come after. */
const STDIN_CLOSE_GRACE_MS = 3_000;
const TERMINATE_GRACE_MS = 5_000;
const TERMINATE_FORCE_MS = 1_000;
const STDERR_TAIL_LINES = 20;
const STDERR_TAIL_MAX_CHARS = 4_000;

const MISSING_HINT =
  'Basic Memory is not installed. Run "paseo kb setup", or set knowledgeBase.basicMemory.command to its path.';

export type BasicMemorySidecarStatus =
  | { state: "disabled" }
  | { state: "missing"; command: string; hint: string }
  | { state: "starting"; since: number }
  | {
      state: "running";
      since: number;
      pid: number | null;
      version: string | null;
      stderrTail: string[];
    }
  | {
      state: "backoff";
      error: string;
      stderrTail: string[];
      attempt: number;
      delayMs: number;
      retryAt: number;
    };

/** Time seam for the restart backoff. Startup and stop timeouts use real timers. */
export interface BasicMemorySidecarClock {
  now(): number;
  /** Runs `callback` after `delayMs`; the returned function cancels it. */
  schedule(callback: () => void, delayMs: number): () => void;
}

const systemClock: BasicMemorySidecarClock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

export interface BasicMemorySidecarOptions {
  logger: Logger;
  /** What the child inherits before the lockdown variables. Defaults to `process.env`. */
  baseEnv?: ProcessEnvRecord;
  managedProcesses?: ManagedProcessRegistry;
  terminateProcess?: ProcessTerminator;
  clock?: BasicMemorySidecarClock;
  /**
   * Searched for a bare command name after PATH. Defaults to uv's tool directory, which a daemon
   * started from the desktop app often lacks on PATH.
   */
  fallbackBinDirs?: string[];
  startupTimeoutMs?: number;
}

export interface BasicMemoryToolRequest {
  name: string;
  arguments: Record<string, unknown>;
}

/** Thrown by `callTool` while the sidecar is not `running`. */
export class BasicMemoryUnavailableError extends Error {
  constructor(readonly status: BasicMemorySidecarStatus) {
    super(`Basic Memory is ${status.state}`);
    this.name = "BasicMemoryUnavailableError";
  }
}

/** `<notesDir>/.bozeo/basic-memory`. Basic Memory ignores dot-directories when it indexes. */
export function basicMemoryConfigDir(notesDir: string): string {
  return path.join(notesDir, ".bozeo", "basic-memory");
}

export interface BuildBasicMemoryEnvInput {
  baseEnv: ProcessEnvRecord;
  configDir: string;
  semanticSearch: boolean;
}

/**
 * The child's environment: the daemon's external-command environment (daemon secrets stripped),
 * without any inherited `BASIC_MEMORY_*` setting, plus the KTD-3 lockdown. Every Basic Memory
 * config field reads `BASIC_MEMORY_<FIELD>`, so an inherited cloud key or project home would
 * otherwise reach it.
 */
export function buildBasicMemoryEnv(input: BuildBasicMemoryEnvInput): ProcessEnvRecord {
  const inherited: ProcessEnvRecord = {};
  for (const [key, value] of Object.entries(input.baseEnv)) {
    if (!key.toUpperCase().startsWith("BASIC_MEMORY_")) inherited[key] = value;
  }
  return createExternalProcessEnv(inherited, {
    BASIC_MEMORY_CONFIG_DIR: input.configDir,
    // A fresh config seeds a "main" project at BASIC_MEMORY_HOME (default ~/basic-memory) and
    // creates the directory. Keep it inside the config directory.
    BASIC_MEMORY_HOME: path.join(input.configDir, "default-project"),
    BASIC_MEMORY_FORCE_LOCAL: "true",
    BASIC_MEMORY_CLOUD_MODE: "false",
    BASIC_MEMORY_AUTO_UPDATE: "false",
    // Also turns off the CLI's analytics events.
    BASIC_MEMORY_NO_PROMOS: "true",
    BASIC_MEMORY_ENSURE_FRONTMATTER_ON_SYNC: "false",
    // Without it, indexing writes a permalink into any note whose frontmatter lacks one (or
    // whose permalink another file claims) and reformats that note's frontmatter.
    BASIC_MEMORY_DISABLE_PERMALINKS: "true",
    BASIC_MEMORY_SEMANTIC_SEARCH_ENABLED: input.semanticSearch ? "true" : "false",
    // FastMCP checks PyPI for a newer release on every start unless told not to.
    FASTMCP_CHECK_FOR_UPDATES: "off",
    FASTMCP_SHOW_SERVER_BANNER: "false",
    HF_HUB_DISABLE_TELEMETRY: "1",
  });
}

async function exists(candidate: string): Promise<boolean> {
  return existsSync(candidate);
}

/**
 * The configured command as a path, or null when it is not installed. Resolution never runs the
 * candidate: Basic Memory run without its isolated environment writes `~/.basic-memory` and
 * creates `~/basic-memory`.
 */
export async function resolveBasicMemoryExecutable(
  command: string,
  fallbackBinDirs: readonly string[],
): Promise<string | null> {
  const found = await findExecutable(command, undefined, exists);
  if (found || command.includes("/") || command.includes("\\")) return found;
  for (const dir of fallbackBinDirs) {
    const candidate = await findExecutable(path.join(dir, command), undefined, exists);
    if (candidate) return candidate;
  }
  return null;
}

function defaultFallbackBinDirs(): string[] {
  return [path.join(os.homedir(), ".local", "bin")];
}

/** The version from `basic-memory --version` ("Basic Memory version: 0.23.2"), or null. */
export function parseBasicMemoryVersion(stdout: string): string | null {
  const marker = "version:";
  const at = stdout.indexOf(marker);
  if (at < 0) return null;
  const version =
    stdout
      .slice(at + marker.length)
      .trim()
      .split(/\s/)[0] ?? "";
  return version.length > 0 ? version : null;
}

function isMissingCommandError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "ENOEXEC";
}

function commandOutput(error: unknown): string {
  const { stdout, stderr } = (error ?? {}) as { stdout?: unknown; stderr?: unknown };
  return `${typeof stdout === "string" ? stdout : ""}\n${typeof stderr === "string" ? stderr : ""}`;
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

class StderrTail {
  private text = "";

  append(chunk: Buffer): void {
    this.text = (this.text + chunk.toString("utf8")).slice(-STDERR_TAIL_MAX_CHARS);
  }

  lines(): string[] {
    return this.text
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .slice(-STDERR_TAIL_LINES);
  }
}

/**
 * MCP over a child the daemon spawned itself, so the spawn goes through `spawnProcess` (Windows
 * quoting, external env, priority) and the stop through tree-kill. Closing the transport does not
 * stop the process; the sidecar does that.
 */
class ChildProcessTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly readBuffer = new ReadBuffer();

  constructor(private readonly child: ChildProcess) {}

  async start(): Promise<void> {
    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.readBuffer.append(chunk);
      this.drain();
    });
    this.child.stdout?.on("error", (error) => this.onerror?.(error));
    this.child.stdin?.on("error", (error) => this.onerror?.(error));
    this.child.once("close", () => this.onclose?.());
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new Error("Basic Memory is not accepting input");
    }
    await new Promise<void>((resolve) => {
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once("drain", resolve);
    });
  }

  async close(): Promise<void> {
    this.readBuffer.clear();
  }

  private drain(): void {
    for (;;) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) return;
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}

interface SidecarProcess {
  child: ChildProcess;
  client: Client;
  stderr: StderrTail;
  exit: Promise<void>;
  exited: boolean;
  runningSince: number | null;
  managedRecord: Promise<{ id: string } | null>;
}

function sameLaunch(a: ResolvedKnowledgeBaseConfig, b: ResolvedKnowledgeBaseConfig): boolean {
  return (
    samePath(a.notesDir, b.notesDir) &&
    a.basicMemory.command === b.basicMemory.command &&
    a.basicMemory.semanticSearch === b.basicMemory.semanticSearch
  );
}

/**
 * Starts, supervises and stops `basic-memory mcp` (the lifecycle diagram in the plan's KTD-3):
 * disabled, missing (not installed; waits for the next config apply), starting, running, and
 * backoff (2 s doubling to 5 min, reset after 60 s up). Every start failure goes through
 * backoff, and a missing binary never loops.
 */
export class BasicMemorySidecar {
  private readonly logger: Logger;
  private readonly baseEnv: ProcessEnvRecord;
  private readonly managedProcesses: ManagedProcessRegistry | undefined;
  private readonly terminateProcess: ProcessTerminator;
  private readonly clock: BasicMemorySidecarClock;
  private readonly fallbackBinDirs: string[];
  private readonly startupTimeoutMs: number;
  private readonly listeners = new Set<(status: BasicMemorySidecarStatus) => void>();
  private status: BasicMemorySidecarStatus = { state: "disabled" };
  private config: ResolvedKnowledgeBaseConfig | null = null;
  /** Bumped by every apply and stop; async work from an older generation drops its result. */
  private generation = 0;
  private restarts = 0;
  private current: SidecarProcess | null = null;
  private cancelRestart: (() => void) | null = null;
  private stopped = false;
  private warnedVersion: string | null = null;

  constructor(options: BasicMemorySidecarOptions) {
    this.logger = options.logger.child({ module: "basic-memory-sidecar" });
    this.baseEnv = options.baseEnv ?? process.env;
    this.managedProcesses = options.managedProcesses;
    this.terminateProcess = options.terminateProcess ?? terminateWithTreeKill;
    this.clock = options.clock ?? systemClock;
    this.fallbackBinDirs = options.fallbackBinDirs ?? defaultFallbackBinDirs();
    this.startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  }

  getStatus(): BasicMemorySidecarStatus {
    return this.status;
  }

  onStatusChange(listener: (status: BasicMemorySidecarStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Brings the sidecar in line with `config`, at startup and on every config reload. Resolves
   * once the attempt it started is running, in backoff or missing; the daemon does not await it.
   * The same config again is a no-op, except from `missing`, where it looks for the binary again.
   */
  async applyConfig(config: ResolvedKnowledgeBaseConfig): Promise<void> {
    if (this.stopped) return;
    if (!config.enabled) {
      if (this.status.state === "disabled") return;
      this.config = null;
      await this.halt();
      this.setStatus({ state: "disabled" });
      return;
    }
    if (this.config && sameLaunch(this.config, config) && this.status.state !== "missing") {
      return;
    }
    await this.halt();
    this.config = config;
    this.restarts = 0;
    await this.launch(this.generation);
  }

  /** Daemon shutdown. Stops the child and every pending restart; later applies are ignored. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.config = null;
    await this.halt();
    this.setStatus({ state: "disabled" });
  }

  /** One MCP tool call on the running server. Throws `BasicMemoryUnavailableError` otherwise. */
  async callTool(
    request: BasicMemoryToolRequest,
    options: { timeoutMs: number },
  ): Promise<unknown> {
    const running = this.current;
    if (this.status.state !== "running" || !running) {
      throw new BasicMemoryUnavailableError(this.status);
    }
    return await running.client.callTool(request, undefined, { timeout: options.timeoutMs });
  }

  private setStatus(status: BasicMemorySidecarStatus): void {
    this.status = status;
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch (error) {
        this.logger.warn({ err: error }, "Basic Memory status listener failed");
      }
    }
  }

  /** Starts a new generation: cancels a pending restart and stops the child, if any. */
  private async halt(): Promise<void> {
    this.generation += 1;
    this.cancelRestart?.();
    this.cancelRestart = null;
    const running = this.current;
    this.current = null;
    if (running) await this.terminate(running);
  }

  private async launch(generation: number): Promise<void> {
    const config = this.config;
    if (!config || generation !== this.generation) return;
    this.setStatus({ state: "starting", since: this.clock.now() });

    const command = await resolveBasicMemoryExecutable(
      config.basicMemory.command,
      this.fallbackBinDirs,
    );
    if (generation !== this.generation) return;
    if (!command) {
      this.setMissing(config);
      return;
    }

    const notesDir = path.resolve(config.notesDir);
    const configDir = basicMemoryConfigDir(notesDir);
    const env = buildBasicMemoryEnv({
      baseEnv: this.baseEnv,
      configDir,
      semanticSearch: config.basicMemory.semanticSearch,
    });
    try {
      await mkdir(configDir, { recursive: true });
      // The index and the embedding model cache are rebuilt from the notes; keep them out of git.
      await writeFile(path.join(configDir, ".gitignore"), "*\n");
      const version = await this.readVersion(command, env, configDir);
      if (generation !== this.generation) return;
      await this.ensureProject({ command, env, configDir, notesDir });
      if (generation !== this.generation) return;
      await this.startServer({ generation, command, env, configDir, version });
    } catch (error) {
      if (generation !== this.generation) return;
      if (isMissingCommandError(error)) {
        await this.halt();
        this.setMissing(config);
        return;
      }
      await this.failStart(generation, error);
    }
  }

  private setMissing(config: ResolvedKnowledgeBaseConfig): void {
    this.logger.warn({ command: config.basicMemory.command }, "Basic Memory is not installed");
    this.setStatus({ state: "missing", command: config.basicMemory.command, hint: MISSING_HINT });
  }

  private async runCli(
    command: string,
    args: string[],
    env: ProcessEnvRecord,
    configDir: string,
  ): Promise<string> {
    const { stdout } = await execCommand(command, args, {
      env,
      cwd: configDir,
      timeout: CLI_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      priority: "background",
    });
    return stdout;
  }

  private async readVersion(
    command: string,
    env: ProcessEnvRecord,
    configDir: string,
  ): Promise<string | null> {
    const version = parseBasicMemoryVersion(
      await this.runCli(command, ["--version"], env, configDir),
    );
    if (version !== BASIC_MEMORY_VERSION && this.warnedVersion !== version) {
      this.warnedVersion = version;
      this.logger.warn(
        { version, expected: BASIC_MEMORY_VERSION },
        "Basic Memory is not the pinned version; run paseo kb setup",
      );
    }
    return version;
  }

  /**
   * Registers the notes directory as the Basic Memory project. "Already exists" is success, as
   * long as the registration points here: a notes folder moved on disk carries its config
   * directory with it, still naming the old path, which Basic Memory would recreate and index.
   */
  private async ensureProject(input: {
    command: string;
    env: ProcessEnvRecord;
    configDir: string;
    notesDir: string;
  }): Promise<void> {
    const { command, env, configDir, notesDir } = input;
    const add = ["project", "add", BASIC_MEMORY_PROJECT_NAME, notesDir];
    let output: string;
    try {
      output = await this.runCli(command, add, env, configDir);
    } catch (error) {
      // 0.23.2 exits 0 when the project exists; a release that exits non-zero says the same.
      if (!commandOutput(error).includes("already exists")) throw error;
      output = commandOutput(error);
    }
    if (!output.includes("already exists")) return;
    const registered = await readRegisteredProjectPath(configDir);
    if (registered === null || samePath(registered, notesDir)) return;
    this.logger.info(
      { registered, notesDir },
      "Basic Memory project points at an old notes path; registering it again",
    );
    await this.runCli(command, ["project", "remove", BASIC_MEMORY_PROJECT_NAME], env, configDir);
    await this.runCli(command, add, env, configDir);
  }

  private async startServer(input: {
    generation: number;
    command: string;
    env: ProcessEnvRecord;
    configDir: string;
    version: string | null;
  }): Promise<void> {
    const { generation, command, env, configDir, version } = input;
    const args = ["mcp", "--project", BASIC_MEMORY_PROJECT_NAME];
    const child = spawnProcess(command, args, {
      env,
      cwd: configDir,
      stdio: ["pipe", "pipe", "pipe"],
      priority: "background",
    });
    const stderr = new StderrTail();
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
    const running: SidecarProcess = {
      child,
      client: new Client({ name: "paseo-knowledge-base", version: "1.0.0" }),
      stderr,
      exited: false,
      exit: Promise.resolve(),
      runningSince: null,
      managedRecord: this.recordManagedProcess(child, command, args),
    };
    running.exit = new Promise<void>((resolve) => {
      child.once("exit", (code, signal) => {
        running.exited = true;
        resolve();
        this.handleExit(running, generation, code, signal);
      });
    });
    this.current = running;

    const spawnFailure = new Promise<never>((_resolve, reject) => {
      child.once("error", reject);
    });
    const exitedEarly = running.exit.then(() => {
      throw new Error("Basic Memory exited before it finished starting");
    });
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Basic Memory did not start within ${this.startupTimeoutMs} ms`)),
        this.startupTimeoutMs,
      );
    });
    try {
      await Promise.race([
        running.client.connect(new ChildProcessTransport(child)),
        spawnFailure,
        exitedEarly,
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
      // The losing branches settle later; nothing awaits them.
      spawnFailure.catch(() => undefined);
      exitedEarly.catch(() => undefined);
      timedOut.catch(() => undefined);
    }
    if (generation !== this.generation || this.current !== running) return;
    running.runningSince = this.clock.now();
    this.setStatus({
      state: "running",
      since: running.runningSince,
      pid: child.pid ?? null,
      version,
      stderrTail: stderr.lines(),
    });
  }

  private handleExit(
    running: SidecarProcess,
    generation: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    // Stopped on purpose, or still starting (the start path reports that failure itself).
    if (this.current !== running || running.runningSince === null) return;
    this.current = null;
    void running.client.close().catch(() => undefined);
    void this.removeManagedProcess(running);
    this.scheduleRestart({
      generation,
      error: `Basic Memory exited (${signal ?? `code ${code}`})`,
      stderrTail: running.stderr.lines(),
      runningSince: running.runningSince,
    });
  }

  private async failStart(generation: number, error: unknown): Promise<void> {
    const running = this.current;
    this.current = null;
    if (running) await this.terminate(running);
    if (generation !== this.generation) return;
    this.scheduleRestart({
      generation,
      error: getErrorMessage(error),
      stderrTail: running ? running.stderr.lines() : commandOutput(error).trim().split("\n"),
      runningSince: null,
    });
  }

  private scheduleRestart(input: {
    generation: number;
    error: string;
    stderrTail: string[];
    runningSince: number | null;
  }): void {
    const now = this.clock.now();
    if (input.runningSince !== null && now - input.runningSince >= STABLE_UPTIME_MS) {
      this.restarts = 0;
    }
    const delayMs = Math.min(RESTART_BASE_MS * 2 ** this.restarts, RESTART_MAX_MS);
    this.restarts += 1;
    const stderrTail = input.stderrTail.filter((line) => line.length > 0).slice(-STDERR_TAIL_LINES);
    this.logger.warn(
      { error: input.error, stderr: stderrTail.join("\n"), delayMs },
      "Basic Memory stopped; restarting",
    );
    this.setStatus({
      state: "backoff",
      error: input.error,
      stderrTail,
      attempt: this.restarts,
      delayMs,
      retryAt: now + delayMs,
    });
    this.cancelRestart = this.clock.schedule(() => {
      this.cancelRestart = null;
      if (input.generation !== this.generation || this.stopped) return;
      void this.launch(input.generation);
    }, delayMs);
  }

  private async terminate(running: SidecarProcess): Promise<void> {
    // A child that failed to spawn has no pid and never emits "exit".
    if (!running.exited && running.child.pid !== undefined) {
      try {
        running.child.stdin?.end();
      } catch {
        // Already closed.
      }
      let grace: NodeJS.Timeout | undefined;
      const graceElapsed = new Promise<"grace">((resolve) => {
        grace = setTimeout(() => resolve("grace"), STDIN_CLOSE_GRACE_MS);
      });
      const outcome = await Promise.race([
        running.exit.then(() => "exited" as const),
        graceElapsed,
      ]);
      clearTimeout(grace);
      if (outcome === "grace") {
        const result = await this.terminateProcess(running.child, {
          gracefulTimeoutMs: TERMINATE_GRACE_MS,
          forceTimeoutMs: TERMINATE_FORCE_MS,
        });
        if (result === "kill-timeout") {
          this.logger.warn({ pid: running.child.pid }, "Basic Memory did not exit after SIGKILL");
        }
      }
    }
    await running.client.close().catch(() => undefined);
    await this.removeManagedProcess(running);
  }

  private async recordManagedProcess(
    child: ChildProcess,
    command: string,
    args: string[],
  ): Promise<{ id: string } | null> {
    const pid = child.pid;
    if (!this.managedProcesses || typeof pid !== "number" || pid <= 0) return null;
    try {
      return await this.managedProcesses.record({
        owner: { provider: "knowledge-base", kind: "basic-memory" },
        pid,
        command,
        args,
      });
    } catch (error) {
      this.logger.warn({ err: error, pid }, "Failed to record the Basic Memory process");
      return null;
    }
  }

  private async removeManagedProcess(running: SidecarProcess): Promise<void> {
    const record = await running.managedRecord;
    if (!record) return;
    try {
      await this.managedProcesses?.remove(record.id);
    } catch (error) {
      this.logger.warn({ err: error, id: record.id }, "Failed to remove the Basic Memory record");
    }
  }
}

/** The path Basic Memory's own config.json registers for the project, or null if unreadable. */
async function readRegisteredProjectPath(configDir: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(configDir, "config.json"), "utf8"));
    const projects = (parsed as { projects?: Record<string, { path?: unknown }> }).projects;
    const registered = projects?.[BASIC_MEMORY_PROJECT_NAME]?.path;
    return typeof registered === "string" && registered.length > 0 ? registered : null;
  } catch {
    return null;
  }
}
