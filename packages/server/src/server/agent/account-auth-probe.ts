/**
 * Confirms or clears a `suspect` account (account-auth-health.ts) by running the Claude CLI
 * itself against that account's config dir. The CLI only refreshes a token that is (nearly)
 * expired, and refreshes it lazily on its own schedule (docs/providers.md) — this forces that to
 * happen now, on demand, instead of waiting for the next agent turn or the keepalive's own run.
 *
 * Execution note's spike: a non-billing `claude -p /context --no-session-persistence` was the
 * candidate for "forces the refresh without spending a turn," but confirming that needs an
 * account whose access token is expired-but-refreshable sitting in a scratch config dir, and
 * fabricating that credential safely (without touching `~/.claude`, `~/.claude-leader` or
 * `~/.claude-personal`) is not possible from here. This uses the keepalive's already-proven
 * command instead (`~/bozeo-ops/claude-token-keepalive.mjs`): a one-line, one-turn Haiku prompt,
 * which forces the same refresh and costs one tiny turn on an account already known to be
 * `suspect` — never on a healthy one, at most once per 15 minutes, and never while an agent is
 * running on it.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAuthShapedError } from "./account-failover-detector.js";

export type AccountAuthProbeResult = "success" | "auth_failure" | "inconclusive";

export interface ProbeProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export type RunProbeProcess = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number },
) => Promise<ProbeProcessResult>;

const PROBE_ARGS = ["-p", "reply ok", "--model", "haiku", "--max-turns", "1"];
const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_INTERVAL_MS = 15 * 60_000;

async function spawnProbeProcess(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number },
): Promise<ProbeProcessResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { env: options.env, cwd: options.cwd, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const settle = (result: ProbeProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // `settled` above makes this the only resolve; close and error both land here.
      // eslint-disable-next-line promise/no-multiple-resolved
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (exitCode) => {
      settle({ stdout, stderr, exitCode, timedOut });
    });
    child.on("error", (err) => {
      settle({ stdout, stderr: stderr || String(err), exitCode: null, timedOut: false });
    });
  });
}

export interface AccountAuthProbeOptions {
  runProcess?: RunProbeProcess;
  binary?: string;
  timeoutMs?: number;
  minIntervalMs?: number;
  scratchDir?: () => string;
}

export interface AccountAuthProbeInput {
  providerId: string;
  configDir: string;
  /** The probe must never run while a turn is in flight on this account. */
  hasRunningAgent: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs at most once per account per `minIntervalMs` (default 15 minutes), skipping entirely
 * while that account has a running agent. Returns `null` when skipped for either reason — callers
 * must not treat a skip as evidence of anything.
 */
export class AccountAuthProbe {
  private readonly runProcess: RunProbeProcess;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly scratchDir: () => string;
  private lastRunMs = new Map<string, number>();

  constructor(options: AccountAuthProbeOptions = {}) {
    this.runProcess = options.runProcess ?? spawnProbeProcess;
    this.binary = options.binary ?? "claude";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS;
    this.scratchDir =
      options.scratchDir ?? (() => mkdtempSync(join(tmpdir(), "paseo-account-auth-probe-")));
  }

  async run(input: AccountAuthProbeInput, nowMs: number): Promise<AccountAuthProbeResult | null> {
    if (input.hasRunningAgent) return null;
    const last = this.lastRunMs.get(input.providerId);
    if (last !== undefined && nowMs - last < this.minIntervalMs) return null;
    this.lastRunMs.set(input.providerId, nowMs);

    const result = await this.runProcess(this.binary, PROBE_ARGS, {
      env: { ...process.env, ...input.env, CLAUDE_CONFIG_DIR: input.configDir },
      cwd: this.scratchDir(),
      timeoutMs: this.timeoutMs,
    });

    if (result.timedOut) return "inconclusive";
    if (isAuthShapedError(`${result.stdout}\n${result.stderr}`)) return "auth_failure";
    if (result.exitCode === 0) return "success";
    return "inconclusive";
  }
}
