/**
 * `account.claude.sign_in.*` (docs/rpc-namespacing.md): starts `claude auth login` for one pooled
 * Claude account, so the Electron desktop banner's Sign in button has something to call. The
 * request carries only a provider id -- the daemon resolves that entry's own `CLAUDE_CONFIG_DIR`
 * and email from its own config, so a principal cannot direct the login at an arbitrary account
 * or binary.
 */
import { spawn } from "node:child_process";
import type { Logger } from "pino";
import { deriveClaudeProviderEntries } from "../../../services/quota-fetcher/manifest.js";
import { defaultClaudeDir, expandHome } from "../../agent-account-failover-monitor.js";
import { resolveAccountPoolEntries } from "../../agent/account-pool-providers.js";
import { lastKnownClaudeEmail } from "../../agent/providers/claude/account-auth.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
} from "../../agent/provider-launch-config.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";

export interface ResolvedSignInLaunch {
  available: boolean;
  command: string;
}

/** The slice of a spawned process this controller needs: just enough to notice it exit. */
export interface SpawnedLoginProcess {
  on(event: "exit", callback: (code: number | null) => void): void;
}

export type SpawnLoginProcess = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => SpawnedLoginProcess;

async function defaultResolveLaunch(): Promise<ResolvedSignInLaunch> {
  const launch = await resolveProviderLaunch({ defaultBinary: "claude" });
  const availability = await checkProviderLaunchAvailable(launch, { command: "claude" });
  return {
    available: availability.available,
    command: availability.resolvedPath ?? launch.command,
  };
}

function defaultSpawnLogin(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawn(command, args, { env, detached: true, stdio: "ignore" });
}

function signInArgv(email: string | null): string[] {
  return email ? ["auth", "login", "--email", email] : ["/login"];
}

export interface AccountSignInSessionOptions {
  readDaemonConfig: () => { providers?: Record<string, unknown> };
  host: { emit: (message: SessionOutboundMessage) => void };
  logger: Logger;
  /** Called once the login process exits, so the next sweep force-reads that provider's usage. */
  onLoginExited?: (providerId: string) => void;
  spawnLogin?: SpawnLoginProcess;
  resolveLaunch?: () => Promise<ResolvedSignInLaunch>;
}

type SignInRequest = Extract<SessionInboundMessage, { type: "account.claude.sign_in.request" }>;

export class AccountSignInSession {
  private readonly options: AccountSignInSessionOptions;
  /** One login per provider at a time; a second request while this is set returns
   * `already_running` and spawns nothing. */
  private running = new Set<string>();

  constructor(options: AccountSignInSessionOptions) {
    this.options = options;
  }

  async handleAccountClaudeSignInRequest(msg: SignInRequest): Promise<void> {
    const { providerId, requestId } = msg;
    const respond = (outcome: "started" | "already_running" | "failed", error: string | null) => {
      this.options.host.emit({
        type: "account.claude.sign_in.response",
        payload: { providerId, outcome, error, requestId },
      });
    };

    const providers = this.options.readDaemonConfig().providers;
    const entry = resolveAccountPoolEntries(providers).find(
      (candidate) => candidate.providerId === providerId && candidate.enabled,
    );
    if (!entry) {
      respond("failed", `Unknown or disabled pooled account: ${providerId}`);
      return;
    }

    if (this.running.has(providerId)) {
      respond("already_running", null);
      return;
    }

    const resolveLaunch = this.options.resolveLaunch ?? defaultResolveLaunch;
    const launch = await resolveLaunch();
    if (!launch.available) {
      respond("failed", "No claude binary resolved on this host");
      return;
    }

    const dirs = new Map(
      deriveClaudeProviderEntries(providers).map((candidate) => [
        candidate.providerId,
        candidate.claudeHome,
      ]),
    );
    const configDir = expandHome(dirs.get(providerId) ?? defaultClaudeDir(providerId));
    if (!configDir) {
      respond("failed", `No config directory resolved for ${providerId}`);
      return;
    }
    const email = entry.expectedEmail ?? lastKnownClaudeEmail(configDir) ?? null;

    const spawnLogin = this.options.spawnLogin ?? defaultSpawnLogin;
    this.running.add(providerId);
    const child = spawnLogin(launch.command, signInArgv(email), {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
    });
    child.on("exit", () => {
      this.running.delete(providerId);
      this.options.onLoginExited?.(providerId);
    });

    respond("started", null);
  }
}
