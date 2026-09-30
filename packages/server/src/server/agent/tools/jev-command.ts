import { spawn } from "node:child_process";

import type { CommandGate } from "../../jev/contract.js";
import { createExternalProcessEnv } from "../../paseo-env.js";

/**
 * `ask_jev`'s `command` (docs/jev.md, "The tools"). It runs only for an agent whose own Bash would
 * run it unasked and unsandboxed, only after the catastrophe gate says a Bash call would run it,
 * and never on Windows, where the gate cannot read the shell. Refusing
 * here costs the agent one retry in Bash, which is itself gated; running an unchecked command would
 * let a JEV tool do what Bash would not.
 */

export const JEV_COMMAND_TIMEOUT_MS = 60_000;
/** Each stream is cut here before the state budget applies; the budget then refuses what is left. */
export const JEV_COMMAND_OUTPUT_CAP = 200_000;

export const JEV_COMMAND_WINDOWS_REASON = "command is not supported on Windows; run it with Bash";
export const JEV_COMMAND_NO_GATE_REASON = "command needs the catastrophe gate; run it with Bash";
export const JEV_COMMAND_BASH_DENIED_REASON =
  "your denied tools include Bash, so ask_jev does not run commands for you";
export const JEV_COMMAND_GATE_ERROR_REASON =
  "the catastrophe gate could not check this command; run it with Bash";
export const JEV_COMMAND_ATTENDED_REASON =
  "your mode asks before running commands, and ask_jev cannot ask for you; run it with Bash";
export const JEV_COMMAND_SANDBOXED_REASON =
  "your Bash runs in a sandbox ask_jev cannot reproduce; run it with Bash";

export interface JevCommandOutput {
  command: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
}

export type JevCommandResult =
  | { kind: "ran"; output: JevCommandOutput }
  | { kind: "refused"; reason: string };

export interface RunJevCommandInput {
  command: string;
  /** The caller agent's recorded cwd. */
  cwd: string;
  gate: CommandGate | null;
  bashDenied: boolean;
  /**
   * The caller's current mode runs commands without asking (`isUnattended`). The daemon cannot
   * ask a person on the agent's behalf, so an attended agent's command is refused.
   */
  unattended: boolean;
  /** The caller's Bash runs in a provider sandbox, which a daemon-run command would escape. */
  sandboxed: boolean;
  platform?: NodeJS.Platform;
  /** Defaults to the daemon's environment; the JEV key and every secret name are stripped either way. */
  baseEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function runJevCommand(input: RunJevCommandInput): Promise<JevCommandResult> {
  const platform = input.platform ?? process.platform;
  if (platform === "win32") return { kind: "refused", reason: JEV_COMMAND_WINDOWS_REASON };
  if (input.bashDenied) return { kind: "refused", reason: JEV_COMMAND_BASH_DENIED_REASON };
  if (!input.unattended) return { kind: "refused", reason: JEV_COMMAND_ATTENDED_REASON };
  if (input.sandboxed) return { kind: "refused", reason: JEV_COMMAND_SANDBOXED_REASON };
  if (!input.gate) return { kind: "refused", reason: JEV_COMMAND_NO_GATE_REASON };
  let verdict: Awaited<ReturnType<CommandGate>>;
  try {
    verdict = await input.gate({ command: input.command, cwd: input.cwd });
  } catch {
    return { kind: "refused", reason: JEV_COMMAND_GATE_ERROR_REASON };
  }
  if (!verdict || verdict.allowed !== true) {
    return { kind: "refused", reason: verdict?.reason ?? JEV_COMMAND_GATE_ERROR_REASON };
  }
  const output = await spawnBash({
    command: input.command,
    cwd: input.cwd,
    env: createExternalProcessEnv(input.baseEnv ?? process.env, { CI: "1" }),
    timeoutMs: input.timeoutMs ?? JEV_COMMAND_TIMEOUT_MS,
    signal: input.signal,
  });
  return { kind: "ran", output };
}

class CappedText {
  private text = "";
  private dropped = 0;

  push(chunk: Buffer): void {
    const value = chunk.toString("utf8");
    const room = JEV_COMMAND_OUTPUT_CAP - this.text.length;
    if (room >= value.length) {
      this.text += value;
      return;
    }
    if (room > 0) this.text += value.slice(0, room);
    this.dropped += value.length - Math.max(room, 0);
  }

  finish(): string {
    if (this.dropped === 0) return this.text;
    return `${this.text}\n[${this.dropped.toLocaleString("en-US")} more characters not kept]`;
  }
}

function spawnBash(input: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal | undefined;
}): Promise<JevCommandOutput> {
  return new Promise((resolve) => {
    const stdout = new CappedText();
    const stderr = new CappedText();
    let note: string | null = null;
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      const err = stderr.finish();
      // `settled` above makes this the only resolve; close, error, timeout and abort all land here.
      // eslint-disable-next-line promise/no-multiple-resolved
      resolve({
        command: input.command,
        exit_code: exitCode,
        stdout: stdout.finish(),
        stderr: note ? `${err}${err ? "\n" : ""}${note}` : err,
      });
    };
    // Its own process group, so a timeout kills the whole pipeline, not only bash.
    const child = spawn("/bin/bash", ["-c", input.command], {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      note = `[killed after ${Number((input.timeoutMs / 1000).toFixed(1))} s]`;
      killGroup();
    }, input.timeoutMs);
    const onAbort = () => {
      note = "[killed: the tool call was cancelled]";
      killGroup();
    };
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      note = `[could not start bash: ${error.message}]`;
      finish(null);
    });
    child.on("close", (code) => finish(note ? null : code));
  });
}
