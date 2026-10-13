/**
 * Confirms or clears a `suspect` account (account-auth-health.ts) by running the Claude CLI
 * against that account's config dir. The CLI refreshes an expired token lazily, on its next call
 * (docs/providers.md), so one call forces the refresh now: it succeeds when the refresh token
 * still works and prints the auth failure when it does not.
 *
 * The call is one tiny Haiku turn, so it is billed: it runs only on a `suspect` account, at most
 * once per account per 15 minutes, and never while an agent is running on the account.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCommand } from "../../utils/spawn.js";
import { isAuthShapedError } from "./account-failover-detector.js";
import type { AccountAuthProbeEvidence, AccountAuthProbeResult } from "./account-auth-health.js";
import { resolveClaudeBinary } from "./providers/claude/agent.js";

export interface ProbeProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface ProbeProcessOptions {
  envOverlay: Record<string, string>;
  cwd: string;
  timeoutMs: number;
}

export type RunProbeProcess = (
  command: string,
  args: string[],
  options: ProbeProcessOptions,
) => Promise<ProbeProcessResult>;

// `--no-session-persistence` keeps each run from writing a transcript into the account's dir.
const PROBE_ARGS = [
  "-p",
  "reply ok",
  "--model",
  "haiku",
  "--max-turns",
  "1",
  "--no-session-persistence",
];
const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_INTERVAL_MS = 15 * 60_000;

/** `execCommand` rejects on a non-zero exit or a timeout; both are still a result to classify. */
async function execProbeProcess(
  command: string,
  args: string[],
  options: ProbeProcessOptions,
): Promise<ProbeProcessResult> {
  try {
    const { stdout, stderr } = await execCommand(command, args, {
      envOverlay: options.envOverlay,
      cwd: options.cwd,
      timeout: options.timeoutMs,
      priority: "background",
    });
    return { stdout, stderr, exitCode: 0, timedOut: false };
  } catch (error) {
    const err = (typeof error === "object" && error !== null ? error : {}) as Record<
      string,
      unknown
    >;
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    return {
      stdout: text(err.stdout),
      stderr: text(err.stderr) || text(err.message),
      exitCode: typeof err.code === "number" ? err.code : null,
      timedOut: err.killed === true,
    };
  }
}

export interface AccountAuthProbeOptions {
  runProcess?: RunProbeProcess;
  /** Rejects when no binary resolves. */
  resolveBinary?: () => Promise<string>;
  timeoutMs?: number;
  minIntervalMs?: number;
  scratchDir?: () => string;
  /** Dates each finished probe. Default `Date.now`. */
  now?: () => number;
}

export interface AccountAuthProbeRequest {
  providerId: string;
  configDir: string;
  /** The probe must never run while a turn is in flight on this account. */
  hasRunningAgent: boolean;
}

/**
 * Runs at most once per account per `minIntervalMs` (default 15 minutes), skipping entirely
 * while that account has a running agent.
 */
export class AccountAuthProbe {
  private readonly runProcess: RunProbeProcess;
  private readonly resolveBinary: () => Promise<string>;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly makeScratchDir: () => string;
  private readonly now: () => number;
  private scratchDir: string | null = null;
  private lastRunMs = new Map<string, number>();
  private running = new Set<string>();
  private finished: AccountAuthProbeEvidence[] = [];

  constructor(options: AccountAuthProbeOptions = {}) {
    this.runProcess = options.runProcess ?? execProbeProcess;
    this.resolveBinary = options.resolveBinary ?? (() => resolveClaudeBinary());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS;
    this.makeScratchDir =
      options.scratchDir ?? (() => mkdtempSync(join(tmpdir(), "paseo-account-auth-probe-")));
    this.now = options.now ?? Date.now;
  }

  /**
   * Starts a probe in the background when one may run now, and returns whether it did. Its
   * result waits in `takeFinished()`: a suspect account is not dead to failover, so nothing has
   * to wait for the answer.
   */
  start(request: AccountAuthProbeRequest, nowMs: number): boolean {
    if (!this.claim(request, nowMs)) return false;
    void this.collect(request);
    return true;
  }

  /**
   * Dated when the CLI answered, not when it was asked: a usage read the sweep took while the
   * probe ran is older than the probe's answer, and must not outrank it.
   */
  private async collect(request: AccountAuthProbeRequest): Promise<void> {
    const result = await this.probeClaimed(request);
    this.finished.push({ providerId: request.providerId, result, atMs: this.now() });
  }

  /** Results of the probes that finished since the last call. */
  takeFinished(): AccountAuthProbeEvidence[] {
    const finished = this.finished;
    this.finished = [];
    return finished;
  }

  /** Runs one probe now. Null when skipped: a skip is evidence of nothing. */
  async run(
    request: AccountAuthProbeRequest,
    nowMs: number,
  ): Promise<AccountAuthProbeResult | null> {
    if (!this.claim(request, nowMs)) return null;
    return this.probeClaimed(request);
  }

  private claim(request: AccountAuthProbeRequest, nowMs: number): boolean {
    if (request.hasRunningAgent || this.running.has(request.providerId)) return false;
    const last = this.lastRunMs.get(request.providerId);
    if (last !== undefined && nowMs - last < this.minIntervalMs) return false;
    this.lastRunMs.set(request.providerId, nowMs);
    this.running.add(request.providerId);
    return true;
  }

  private async probeClaimed(request: AccountAuthProbeRequest): Promise<AccountAuthProbeResult> {
    try {
      return await this.probe(request.configDir);
    } catch {
      return "inconclusive";
    } finally {
      this.running.delete(request.providerId);
    }
  }

  private async probe(configDir: string): Promise<AccountAuthProbeResult> {
    let binary: string;
    try {
      binary = await this.resolveBinary();
    } catch {
      return "inconclusive";
    }
    this.scratchDir ??= this.makeScratchDir();
    const result = await this.runProcess(binary, PROBE_ARGS, {
      envOverlay: { CLAUDE_CONFIG_DIR: configDir },
      cwd: this.scratchDir,
      timeoutMs: this.timeoutMs,
    });

    if (result.timedOut) return "inconclusive";
    if (isAuthShapedError(`${result.stdout}\n${result.stderr}`)) return "auth_failure";
    if (result.exitCode === 0) return "success";
    return "inconclusive";
  }
}
