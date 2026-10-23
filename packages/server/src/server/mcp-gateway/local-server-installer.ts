import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { findExecutable } from "../../executable-resolution/executable-resolution.js";
import { spawnProcess } from "../../utils/spawn.js";
import { terminateWithTreeKill, type ProcessTerminator } from "../../utils/tree-kill.js";
import { McpGatewayActionError } from "./action-failure.js";
import type { LocalServerPreset } from "./local-server-presets.js";

/** Under the client's wait for the setup RPC, so the form hears the failure rather than a timeout. */
const NPM_INSTALL_TIMEOUT_MS = 150_000;
const STDERR_TAIL_CHARS = 600;
/** How long a timed-out npm gets to stop on SIGTERM, and then on SIGKILL, before the directory is cleared. */
const TERMINATE_GRACE_MS = 2_000;
const TERMINATE_FORCE_MS = 5_000;
/** Written last, after npm exits 0 and the entry exists: the only proof an install finished. */
const INSTALL_COMPLETE_MARKER = ".paseo-install-complete";

export interface LocalServerLaunchSpec {
  /** Absolute path of the runtime that starts the server. */
  command: string;
  args: string[];
  /** Non-secret environment the server needs on top of the SDK's minimal one. */
  env: Record<string, string>;
}

export interface InstallCommand {
  args: string[];
  cwd: string;
  timeout: number;
}

/** A command that exited non-zero or ran out of time, carrying the stderr a person can act on. */
export class NpmCommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "NpmCommandError";
  }
}

/** Runs `npm <args>` in `cwd`; rejects with the failure's stderr when npm exits non-zero. */
export type NpmRunner = (command: InstallCommand) => Promise<void>;

export interface InstallLocalServerInput {
  paseoHome: string;
  preset: LocalServerPreset;
  runNpm?: NpmRunner;
}

function installDirectory(paseoHome: string, preset: LocalServerPreset): string {
  return path.join(paseoHome, "mcp-gateway", "local-servers", `${preset.id}-${preset.version}`);
}

export interface RunWithDeadlineInput extends InstallCommand {
  executable: string;
  /** Replaceable in tests; defaults to killing the whole process tree. */
  terminate?: ProcessTerminator;
}

/**
 * Runs a command and settles once it has fully stopped. A non-zero exit rejects with the stderr
 * tail. On timeout the whole process tree is killed first: on Windows `npm.cmd` is a shell around
 * npm, and killing only the shell leaves npm writing into a directory the caller is about to clear.
 */
export function runWithDeadline(input: RunWithDeadlineInput): Promise<void> {
  const child = spawnProcess(input.executable, input.args, {
    cwd: input.cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_CHARS);
  });
  const terminate = input.terminate ?? terminateWithTreeKill;
  return new Promise<void>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      const detail = `did not finish within ${input.timeout / 1000} s`;
      const lastOutput = stderr.trim();
      function rejectTimedOut(): void {
        reject(
          new NpmCommandError(
            detail,
            lastOutput ? `${detail} (last output: ${lastOutput})` : detail,
          ),
        );
      }
      terminate(child, {
        gracefulTimeoutMs: TERMINATE_GRACE_MS,
        forceTimeoutMs: TERMINATE_FORCE_MS,
      }).then(rejectTimedOut, rejectTimedOut);
    }, input.timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      // The timeout path rejects only after the tree is dead.
      if (timedOut) return;
      if (code === 0) {
        resolve();
        return;
      }
      reject(new NpmCommandError(`exited with ${code ?? signal}`, stderr));
    });
  });
}

async function runNpmFromPath(command: InstallCommand): Promise<void> {
  const npm = await findExecutable("npm");
  if (!npm) {
    throw new McpGatewayActionError(
      "install_failed",
      "npm was not found on this host, so the local server could not be installed",
    );
  }
  await runWithDeadline({ ...command, executable: npm });
}

function stderrTail(error: unknown): string {
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error
      ? String((error as { stderr: unknown }).stderr ?? "")
      : "";
  const text = stderr.trim() || (error instanceof Error ? error.message : String(error));
  return text.slice(-STDERR_TAIL_CHARS);
}

function nodeIsSupported(preset: LocalServerPreset, version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  const [minMajor, minMinor] = preset.minNode;
  return major > minMajor || (major === minMajor && minor >= (minMinor ?? 0));
}

function isInstalled(directory: string, entry: string): boolean {
  return existsSync(path.join(directory, INSTALL_COMPLETE_MARKER)) && existsSync(entry);
}

/** Best effort: a leftover directory has no marker, so the next attempt clears it anyway. */
function discardInstall(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Reported failure is the install's own; this only keeps the disk tidy.
  }
}

async function installFresh(input: {
  directory: string;
  entry: string;
  preset: LocalServerPreset;
  runNpm: NpmRunner;
}): Promise<void> {
  const { directory, entry, preset, runNpm } = input;
  try {
    // Whatever is here is a half-finished earlier attempt or an unmarked tree: start clean.
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    mkdirSync(directory, { recursive: true });
    // A package.json of its own keeps npm from adopting one further up the tree as the prefix.
    writeFileSync(
      path.join(directory, "package.json"),
      `${JSON.stringify({ name: `paseo-local-server-${preset.id}`, private: true }, null, 2)}\n`,
    );
    try {
      await runNpm({
        args: [
          "install",
          "--save-exact",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--loglevel=error",
          `${preset.package}@${preset.version}`,
        ],
        cwd: directory,
        timeout: NPM_INSTALL_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof McpGatewayActionError) throw error;
      throw new McpGatewayActionError(
        "install_failed",
        `Installing ${preset.package}@${preset.version} failed: ${stderrTail(error)}`,
      );
    }
    if (!existsSync(entry)) {
      throw new McpGatewayActionError(
        "install_failed",
        `${preset.package}@${preset.version} installed without ${preset.entry.join("/")}`,
      );
    }
    writeFileSync(
      path.join(directory, INSTALL_COMPLETE_MARKER),
      `${JSON.stringify({ package: preset.package, version: preset.version })}\n`,
    );
  } catch (error) {
    discardInstall(directory);
    throw error;
  }
}

/** Installs in flight, by directory: two names on one preset share a tree and must share its install. */
const installsInFlight = new Map<string, Promise<void>>();

/**
 * Installs a preset's package at its exact version into a directory of the daemon's own and
 * returns how to start it. Lifecycle scripts are skipped. "Installed" means the completion marker
 * exists and so does the entry file; the marker is written only after npm exits 0, so an install
 * that was interrupted, timed out or raced is never mistaken for a finished one. Any failure
 * removes the directory. Throws `install_failed` with npm's stderr tail; the token is never on the
 * command line, so nothing secret can reach the message.
 */
export async function installLocalServer(
  input: InstallLocalServerInput,
): Promise<LocalServerLaunchSpec> {
  const { paseoHome, preset } = input;
  if (!nodeIsSupported(preset, process.versions.node)) {
    throw new McpGatewayActionError(
      "install_failed",
      `${preset.package} needs Node ${preset.minNode.join(".")} or newer; this host runs ${process.versions.node}`,
    );
  }
  const directory = installDirectory(paseoHome, preset);
  const entry = path.join(directory, ...preset.entry);
  if (!isInstalled(directory, entry)) {
    let pending = installsInFlight.get(directory);
    if (!pending) {
      pending = installFresh({ directory, entry, preset, runNpm: input.runNpm ?? runNpmFromPath });
      installsInFlight.set(directory, pending);
      const started = pending;
      function clear(): void {
        if (installsInFlight.get(directory) === started) installsInFlight.delete(directory);
      }
      started.then(clear, clear);
    }
    await pending;
  }
  return {
    // Under the desktop app the daemon is Electron running as node, and so is its child.
    command: process.execPath,
    args: [entry, ...preset.args],
    env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
  };
}
