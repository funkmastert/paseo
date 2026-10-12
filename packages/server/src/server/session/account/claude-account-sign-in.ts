/**
 * Starts `claude auth login` for one pooled Claude account, behind `account.claude.sign_in.*`
 * (docs/rpc-namespacing.md), so the desktop banner's Sign in button has something to call. The
 * request carries only a provider id: the daemon resolves that entry's own `CLAUDE_CONFIG_DIR` and
 * email from its own config, so a principal cannot direct the login at an arbitrary account or
 * binary.
 *
 * One instance per daemon, shared by every connection: one login per account at a time, whichever
 * client asked for it.
 */
import type { Logger } from "pino";
import { spawnProcess } from "../../../utils/spawn.js";
import { resolvePoolAccounts } from "../../agent/account-pool-providers.js";
import { resolveClaudeBinary } from "../../agent/providers/claude/agent.js";
import {
  claudeSignInArgs,
  claudeSignInCommand,
  lastKnownClaudeEmail,
} from "../../agent/providers/claude/account-auth.js";

/** The slice of a spawned login process this needs. A `ChildProcess` is one. */
export interface SpawnedLoginProcess {
  on(event: "exit" | "error", listener: (arg: unknown) => void): unknown;
  unref(): void;
  kill(): boolean;
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
  /** Called once the login process exits, so that provider's usage is read again. */
  onLoginExited?: (providerId: string) => void;
  spawnLogin?: SpawnLoginProcess;
  /** Rejects when no binary resolves. */
  resolveBinary?: () => Promise<string>;
  /** How long an abandoned login may hold its account's slot. */
  loginTimeoutMs?: number;
  now?: () => number;
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const BINARY_RECHECK_MS = 5 * 60_000;

function defaultSpawnLogin(command: string, args: string[], configDir: string) {
  return spawnProcess(command, args, {
    envOverlay: { CLAUDE_CONFIG_DIR: configDir },
    detached: true,
    stdio: "ignore",
  });
}

export class ClaudeAccountSignIn {
  private readonly options: ClaudeAccountSignInOptions;
  private readonly now: () => number;
  /** Accounts with a login in flight. */
  private running = new Set<string>();
  private binary: { resolved: Promise<string | null>; atMs: number } | null = null;

  constructor(options: ClaudeAccountSignInOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Whether a `claude` binary resolves on this host. Re-resolved every few minutes, not per call. */
  async isBinaryAvailable(): Promise<boolean> {
    return (await this.resolveBinaryCached()) !== null;
  }

  async start(providerId: string): Promise<ClaudeAccountSignInResult> {
    const account = resolvePoolAccounts(this.options.readDaemonConfig().providers).find(
      (candidate) => candidate.providerId === providerId && candidate.enabled,
    );
    if (!account) return failed(`Unknown or disabled pooled account: ${providerId}`);
    if (!account.configDir) return failed(`No config directory resolved for ${providerId}`);
    const configDir = account.configDir;
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
    this.running.add(providerId);
    const timer = setTimeout(() => {
      this.options.logger.warn({ providerId }, "Account sign-in: login abandoned; stopping it");
      child.kill();
    }, this.options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS);
    timer.unref?.();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      this.running.delete(providerId);
    };
    child.on("error", (error) => {
      this.options.logger.warn({ err: error, providerId }, "Account sign-in: login failed");
      release();
    });
    child.on("exit", () => {
      release();
      this.options.onLoginExited?.(providerId);
    });
    // Detached so it outlives a daemon restart mid-login; unref'd so it never holds the daemon up.
    child.unref();
    return { outcome: "started", error: null };
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
