import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { findExecutable } from "../../executable-resolution/executable-resolution.js";
import { execCommand } from "../../utils/spawn.js";
import { McpGatewayActionError } from "./action-failure.js";
import type { LocalServerPreset } from "./local-server-presets.js";

/** Under the client's wait for the setup RPC, so the form hears the failure rather than a timeout. */
const NPM_INSTALL_TIMEOUT_MS = 150_000;
const NPM_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL_CHARS = 600;

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

async function runNpmFromPath(command: InstallCommand): Promise<void> {
  const npm = await findExecutable("npm");
  if (!npm) {
    throw new McpGatewayActionError(
      "install_failed",
      "npm was not found on this host, so the local server could not be installed",
    );
  }
  await execCommand(npm, command.args, {
    cwd: command.cwd,
    timeout: command.timeout,
    maxBuffer: NPM_MAX_BUFFER_BYTES,
  });
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

/**
 * Installs a preset's package at its exact version into a directory of the daemon's own and
 * returns how to start it. Lifecycle scripts are skipped, and a present entry file means the
 * install already happened. Throws `install_failed` with npm's stderr tail; the token is never
 * on the command line, so nothing secret can reach the message.
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
  if (!existsSync(entry)) {
    mkdirSync(directory, { recursive: true });
    // A package.json of its own keeps npm from adopting one further up the tree as the prefix.
    writeFileSync(
      path.join(directory, "package.json"),
      `${JSON.stringify({ name: `paseo-local-server-${preset.id}`, private: true }, null, 2)}\n`,
    );
    try {
      await (input.runNpm ?? runNpmFromPath)({
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
  }
  return {
    // Under the desktop app the daemon is Electron running as node, and so is its child.
    command: process.execPath,
    args: [entry, ...preset.args],
    env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
  };
}
