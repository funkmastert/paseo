/**
 * Starts `claude auth login` for one pooled Claude account, behind `account.claude.sign_in.*`
 * (docs/rpc-namespacing.md), so the desktop banner's Sign in button has something to call. The
 * request carries only a provider id: the daemon resolves that entry's own `CLAUDE_CONFIG_DIR` and
 * email from its own config, so a principal cannot direct the login at an arbitrary account or
 * binary.
 *
 * One instance per daemon, shared by every connection: one login per account at a time, whichever
 * client asked for it. The login is detached so it survives a daemon restart, so each one leaves a
 * marker under `markerDir`: the next daemon finds it, holds the account's slot while the login is
 * fresh, and stops it once it is past the timeout.
 */
import { promises as fs } from "node:fs";
import { Socket } from "node:net";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { spawnProcess } from "../../../utils/spawn.js";
import {
  terminateWithTreeKill,
  type ProcessTerminator,
  type TreeKillTarget,
} from "../../../utils/tree-kill.js";
import { writeJsonFileAtomic } from "../../atomic-file.js";
import { resolvePoolAccounts } from "../../agent/account-pool-providers.js";
import {
  blocksInAppSignIn,
  type PoolAccountIdentityTracker,
} from "../../agent/pool-account-identity.js";
import { resolveClaudeBinary } from "../../agent/providers/claude/agent.js";
import {
  claudeSignInArgs,
  claudeSignInCommand,
  lastKnownClaudeEmail,
} from "../../agent/providers/claude/account-auth.js";
import {
  createPidTarget,
  createSystemManagedProcessTable,
  type ManagedProcessTable,
} from "../../managed-processes/managed-processes.js";

/** The slice of a spawned login process this needs. A `ChildProcess` is one. */
export interface SpawnedLoginProcess extends TreeKillTarget {
  on(event: "exit" | "error", listener: (arg: unknown) => void): unknown;
  once(event: "exit", listener: () => void): unknown;
  unref(): void;
}

export type SpawnLoginProcess = (
  command: string,
  args: string[],
  configDir: string,
) => SpawnedLoginProcess;

export interface ClaudeAccountSignInResult {
  outcome: "started" | "already_running" | "failed";
  error: string | null;
}

export interface ClaudeAccountSignInOptions {
  readDaemonConfig: () => { providers?: Record<string, unknown> };
  logger: Logger;
  /** Where each running login's marker is kept, under `$PASEO_HOME`. */
  markerDir: string;
  /** Standing identity problems; a drifted login is not signed in again from here. */
  accountIdentity?: Pick<PoolAccountIdentityTracker, "problemFor">;
  /** Called once the login process exits, so that provider's usage is read again. */
  onLoginExited?: (providerId: string) => void;
  spawnLogin?: SpawnLoginProcess;
  /** Rejects when no binary resolves. */
  resolveBinary?: () => Promise<string>;
  /** How long an abandoned login may hold its account's slot. */
  loginTimeoutMs?: number;
  now?: () => number;
  /** Stops a login and its children: the graceful signal first, then SIGKILL. */
  terminateProcess?: ProcessTerminator;
  /** Reads a marker's pid back, so a pid the OS reused for something else is never stopped. */
  processTable?: ManagedProcessTable;
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const BINARY_RECHECK_MS = 5 * 60_000;
const STOP_GRACE_MS = 3_000;
const STOP_FORCE_WAIT_MS = 1_000;

const LoginMarkerSchema = z.object({
  providerId: z.string().min(1),
  pid: z.number().int().positive(),
  startedAt: z.number(),
  email: z.string().min(1),
});

type LoginMarker = z.infer<typeof LoginMarkerSchema>;

/**
 * Stdin is a pipe that is never written or closed, as in the manual recipe
 * (`tail -f /dev/null | claude auth login …`): with stdin at EOF the CLI does not wait for the
 * browser callback.
 */
function defaultSpawnLogin(command: string, args: string[], configDir: string) {
  const child = spawnProcess(command, args, {
    envOverlay: { CLAUDE_CONFIG_DIR: configDir },
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  if (child.stdin instanceof Socket) {
    child.stdin.on("error", () => {});
    // The pipe is a handle of its own; `child.unref()` does not release it.
    child.stdin.unref();
  }
  return child;
}

/** Whether `commandLine` is the login for `email`, however the platform quoted its arguments. */
function isLoginFor(commandLine: string | null, email: string): boolean {
  if (!commandLine) return false;
  const normalized = commandLine.replace(/["']/g, "").replace(/\s+/g, " ").toLowerCase();
  return normalized.includes(claudeSignInArgs(email).join(" ").toLowerCase());
}

export class ClaudeAccountSignIn {
  private readonly options: ClaudeAccountSignInOptions;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly terminate: ProcessTerminator;
  private readonly processTable: ManagedProcessTable;
  /** Accounts with a login in flight, each with a token so only that login frees the slot. */
  private readonly running = new Map<string, object>();
  private binary: { resolved: Promise<string | null>; atMs: number } | null = null;
  /** The previous daemon's markers, adopted or cleared. Every start waits for it. */
  private readonly adopted: Promise<void>;

  constructor(options: ClaudeAccountSignInOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
    this.terminate = options.terminateProcess ?? terminateWithTreeKill;
    this.processTable = options.processTable ?? createSystemManagedProcessTable();
    this.adopted = this.adoptMarkers().catch((error) => {
      options.logger.warn({ err: error }, "Account sign-in: could not read login markers");
    });
  }

  /** Whether a `claude` binary resolves on this host. Re-resolved every few minutes, not per call. */
  async isBinaryAvailable(): Promise<boolean> {
    return (await this.resolveBinaryCached()) !== null;
  }

  async start(providerId: string): Promise<ClaudeAccountSignInResult> {
    await this.adopted;
    const account = resolvePoolAccounts(this.options.readDaemonConfig().providers).find(
      (candidate) => candidate.providerId === providerId && candidate.enabled,
    );
    if (!account) return failed(`Unknown or disabled pooled account: ${providerId}`);
    if (!account.configDir) return failed(`No config directory resolved for ${providerId}`);
    const configDir = account.configDir;
    const identityProblem = this.options.accountIdentity?.problemFor(providerId) ?? null;
    if (blocksInAppSignIn(identityProblem, account.expectedEmail)) {
      return failed(
        `${identityProblem.summary}. ${providerId} declares no email, so the login its config ` +
          `dir last held may not be its own, and it is not signed in again from here. Set ` +
          `params.accountPool.email, or run ${identityProblem.fixCommand} in a terminal and sign ` +
          `in as its own account.`,
      );
    }
    const email = account.expectedEmail ?? lastKnownClaudeEmail(configDir);
    if (!email) {
      return failed(
        `No email is known for ${providerId}, so the login page cannot be pre-filled. Set ` +
          `params.accountPool.email, or run ${claudeSignInCommand(configDir, null)} in a terminal.`,
      );
    }
    if (this.running.has(providerId)) return { outcome: "already_running", error: null };

    const binary = await this.resolveBinaryCached();
    if (!binary) return failed("No claude binary resolved on this host");
    // Re-checked after the await: two requests can both pass the check above before either spawns.
    if (this.running.has(providerId)) return { outcome: "already_running", error: null };

    const spawnLogin = this.options.spawnLogin ?? defaultSpawnLogin;
    let child: SpawnedLoginProcess;
    try {
      child = spawnLogin(binary, claudeSignInArgs(email), configDir);
    } catch (error) {
      this.options.logger.warn({ err: error, providerId }, "Account sign-in: login did not start");
      return failed(
        `The login did not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const startedAt = this.now();
    const markerFile =
      child.pid === undefined
        ? Promise.resolve(null)
        : this.writeMarker({ providerId, pid: child.pid, startedAt, email });
    const release = this.track({
      providerId,
      login: child,
      deadlineMs: startedAt + this.timeoutMs,
      markerFile,
    });
    child.on("error", (error) => {
      this.options.logger.warn({ err: error, providerId }, "Account sign-in: login failed");
      release();
    });
    // Detached so it outlives a daemon restart mid-login; unref'd so it never holds the daemon up.
    child.unref();
    // Awaited only once the handlers are on, so an early spawn error is never unhandled.
    await markerFile;
    return { outcome: "started", error: null };
  }

  /**
   * Holds `providerId`'s slot until `login` exits, and stops it once `deadlineMs` passes. The slot
   * is released when the stop ends, whether or not the exit is ever seen. Returns the release.
   */
  private track(input: {
    providerId: string;
    login: TreeKillTarget;
    deadlineMs: number;
    markerFile: Promise<string | null>;
  }): () => void {
    const { providerId, login, markerFile } = input;
    const token = {};
    this.running.set(providerId, token);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      if (this.running.get(providerId) === token) this.running.delete(providerId);
      void markerFile
        .then((file) => (file ? fs.rm(file, { force: true }) : undefined))
        .catch((error) => {
          this.options.logger.warn(
            { err: error, providerId },
            "Account sign-in: marker not removed",
          );
        });
    };
    const timer = setTimeout(
      () => {
        this.options.logger.warn({ providerId }, "Account sign-in: login abandoned; stopping it");
        void this.stop(login, providerId).finally(release);
      },
      Math.max(0, input.deadlineMs - this.now()),
    );
    timer.unref?.();
    login.once?.("exit", () => {
      release();
      this.options.onLoginExited?.(providerId);
    });
    return release;
  }

  private async stop(login: TreeKillTarget, providerId: string): Promise<void> {
    try {
      await this.terminate(login, {
        gracefulTimeoutMs: STOP_GRACE_MS,
        forceSignal: "SIGKILL",
        forceTimeoutMs: STOP_FORCE_WAIT_MS,
      });
    } catch (error) {
      this.options.logger.warn({ err: error, providerId }, "Account sign-in: could not stop login");
    }
  }

  private async writeMarker(marker: LoginMarker): Promise<string | null> {
    const file = path.join(
      this.options.markerDir,
      `${encodeURIComponent(marker.providerId)}.${marker.pid}.json`,
    );
    try {
      await writeJsonFileAtomic(file, marker);
      return file;
    } catch (error) {
      this.options.logger.warn(
        { err: error, providerId: marker.providerId },
        "Account sign-in: could not record the login",
      );
      return null;
    }
  }

  /**
   * The previous daemon's logins. A marker whose process is gone, or whose pid now runs something
   * other than that login, is deleted. A login past its timeout is stopped; a fresh one holds its
   * account's slot until it exits or its deadline passes.
   */
  private async adoptMarkers(): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.options.markerDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const file = path.join(this.options.markerDir, name);
      let marker: LoginMarker;
      try {
        marker = LoginMarkerSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
      } catch {
        await fs.rm(file, { force: true });
        continue;
      }
      await this.adoptMarker(file, marker);
    }
  }

  private async adoptMarker(file: string, marker: LoginMarker): Promise<void> {
    const inspection = await this.processTable.inspect(marker.pid);
    if (inspection.status === "error") {
      // Cannot tell whether it is still the login: keep the marker for the next daemon.
      this.options.logger.warn(
        { err: inspection.error, providerId: marker.providerId, pid: marker.pid },
        "Account sign-in: could not inspect a previous login",
      );
      return;
    }
    if (
      inspection.status === "not-found" ||
      !isLoginFor(inspection.snapshot.commandLine, marker.email)
    ) {
      await fs.rm(file, { force: true });
      return;
    }
    const login = createPidTarget(marker.pid);
    const deadlineMs = marker.startedAt + this.timeoutMs;
    if (this.now() >= deadlineMs) {
      this.options.logger.warn(
        { providerId: marker.providerId, pid: marker.pid },
        "Account sign-in: stopping a login a previous daemon abandoned",
      );
      await this.stop(login, marker.providerId);
      await fs.rm(file, { force: true });
      return;
    }
    this.track({
      providerId: marker.providerId,
      login,
      deadlineMs,
      markerFile: Promise.resolve(file),
    });
  }

  private resolveBinaryCached(): Promise<string | null> {
    const nowMs = this.now();
    if (!this.binary || nowMs - this.binary.atMs >= BINARY_RECHECK_MS) {
      const resolveBinary = this.options.resolveBinary ?? (() => resolveClaudeBinary());
      this.binary = { resolved: resolveBinary().catch(() => null), atMs: nowMs };
    }
    return this.binary.resolved;
  }
}

function failed(error: string): ClaudeAccountSignInResult {
  return { outcome: "failed", error };
}
