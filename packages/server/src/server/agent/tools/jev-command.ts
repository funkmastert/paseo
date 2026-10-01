import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import type { CommandGate } from "../../jev/contract.js";
import { createExternalProcessEnv } from "../../paseo-env.js";
import { lowerAgentProcessPriority } from "../../../utils/process-priority.js";
import type { DeviceLaunchGate } from "../device-lease-manager.js";

/**
 * `ask_jev`'s `command` (docs/jev.md, "The tools"). It runs only for an agent whose own Bash would
 * run it unasked and unsandboxed, only after the catastrophe gate and the device cap say a Bash
 * call would run it, with the agent's own Bash environment, and never on Windows, where the gate
 * cannot read the shell. Refusing here costs the agent one retry in Bash, which is itself gated;
 * running an unchecked command would let a JEV tool do what Bash would not.
 *
 * The daemon cannot make the command a child of the agent's CLI, so it runs as the daemon's child
 * at the agents' nice and low-priority disk I/O, and `onSpawn` charges its process tree to the
 * agent in the resource monitor, where saturation remedies can act on it.
 */

export const JEV_COMMAND_TIMEOUT_MS = 60_000;
/** Each stream is cut here before the state budget applies; the budget then refuses what is left. */
export const JEV_COMMAND_OUTPUT_CAP = 200_000;
/** After bash exits, how long a background job's inherited pipes get to flush before they are cut. */
const EXIT_DRAIN_MS = 250;
/** After the group is killed, how long before a process that left it stops holding the call. */
const KILL_FALLBACK_MS = 2_000;

export const JEV_COMMAND_WINDOWS_REASON = "command is not supported on Windows; run it with Bash";
export const JEV_COMMAND_NO_GATE_REASON = "command needs the catastrophe gate; run it with Bash";
export const JEV_COMMAND_BASH_DENIED_REASON =
  "your denied tools include Bash, so ask_jev does not run commands for you";
export const JEV_COMMAND_GATE_ERROR_REASON =
  "the catastrophe gate could not check this command; run it with Bash";
export const JEV_COMMAND_DEVICE_GATE_ERROR_REASON =
  "the device cap could not check this command; run it with Bash";
export const JEV_COMMAND_ATTENDED_REASON =
  "your mode asks before running commands, and ask_jev cannot ask for you; run it with Bash";
export const JEV_COMMAND_SANDBOXED_REASON =
  "your Bash runs in a sandbox ask_jev cannot reproduce; run it with Bash";
export const JEV_COMMAND_NO_ENV_REASON =
  "ask_jev cannot rebuild your Bash environment; run it with Bash";

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
  agentId: string;
  /** The caller agent's recorded cwd. */
  cwd: string;
  gate: CommandGate | null;
  /** The device cap's launch gate, which the agent's own Bash goes through. Null: no cap here. */
  deviceGate: DeviceLaunchGate | null;
  /**
   * The environment the agent's own Bash gets (`resolveCommandEnv`): its launch env over the
   * daemon's. The JEV key is stripped again here. Null when it cannot be rebuilt: refused, never
   * the daemon's own environment instead.
   */
  env: NodeJS.ProcessEnv | null;
  bashDenied: boolean;
  /**
   * The caller's current mode runs commands without asking (`isUnattended`). The daemon cannot
   * ask a person on the agent's behalf, so an attended agent's command is refused.
   */
  unattended: boolean;
  /** The caller's Bash runs in a provider sandbox, which a daemon-run command would escape. */
  sandboxed: boolean;
  /** Charges the spawned process tree to the agent; returns the release. */
  onSpawn?: (pid: number) => () => void;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function runJevCommand(input: RunJevCommandInput): Promise<JevCommandResult> {
  const platform = input.platform ?? process.platform;
  if (platform === "win32") return { kind: "refused", reason: JEV_COMMAND_WINDOWS_REASON };
  if (input.bashDenied) return { kind: "refused", reason: JEV_COMMAND_BASH_DENIED_REASON };
  if (!input.unattended) return { kind: "refused", reason: JEV_COMMAND_ATTENDED_REASON };
  if (input.sandboxed) return { kind: "refused", reason: JEV_COMMAND_SANDBOXED_REASON };
  if (!input.env) return { kind: "refused", reason: JEV_COMMAND_NO_ENV_REASON };
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
  // The Bash hook fails open on its own errors because refusing there blocks the agent; here a
  // refusal costs a retry in Bash, which the cap checks again.
  if (input.deviceGate) {
    try {
      const launch = await input.deviceGate.gateLaunch({
        agentId: input.agentId,
        command: input.command,
      });
      if (launch.decision !== "allow") return { kind: "refused", reason: launch.message };
    } catch {
      return { kind: "refused", reason: JEV_COMMAND_DEVICE_GATE_ERROR_REASON };
    }
  }
  const output = await spawnBash({
    argv: jevCommandArgv(input.command, { platform }),
    command: input.command,
    cwd: input.cwd,
    env: createExternalProcessEnv(input.env, { CI: "1" }),
    timeoutMs: input.timeoutMs ?? JEV_COMMAND_TIMEOUT_MS,
    signal: input.signal,
    onSpawn: input.onSpawn,
  });
  return { kind: "ran", output };
}

/**
 * `/bin/bash -c <command>`, behind the platform's low-priority disk I/O launcher when it has one:
 * `taskpolicy -d utility` on macOS and `ionice -c 2 -n 7` on Linux. Both exec in place, so the
 * pid is bash's and the process group is the command's.
 */
export function jevCommandArgv(
  command: string,
  options: { platform: NodeJS.Platform; hasTool?: (tool: string) => boolean },
): string[] {
  const hasTool = options.hasTool ?? hasLauncher;
  const bash = ["/bin/bash", "-c", command];
  if (options.platform === "darwin" && hasTool(TASKPOLICY)) {
    return [TASKPOLICY, "-d", "utility", ...bash];
  }
  if (options.platform === "linux" && hasTool("ionice")) {
    return ["ionice", "-c", "2", "-n", "7", ...bash];
  }
  return bash;
}

const TASKPOLICY = "/usr/sbin/taskpolicy";

function hasLauncher(tool: string): boolean {
  if (tool.startsWith("/")) return existsSync(tool);
  return ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].some((dir) => existsSync(`${dir}/${tool}`));
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
  argv: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  onSpawn: ((pid: number) => () => void) | undefined;
}): Promise<JevCommandOutput> {
  return new Promise((resolve) => {
    const stdout = new CappedText();
    const stderr = new CappedText();
    let note: string | null = null;
    let settled = false;
    let release: (() => void) | null = null;
    // The timeout, the post-exit drain and the post-kill fallback; all cleared on finish.
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let draining = false;
    let killed = false;
    // Its own process group, so a timeout kills the whole pipeline, not only bash.
    const child = spawn(input.argv[0]!, input.argv.slice(1), {
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
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      for (const pending of timers) clearTimeout(pending);
      input.signal?.removeEventListener("abort", onAbort);
      // What bash left behind in its group goes with it, and a process that left the group with
      // setsid stops holding the call: its end of the pipes is cut, not waited for.
      killGroup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      release?.();
      release = null;
      const err = stderr.finish();
      // `settled` above makes this the only resolve; close, exit, error, timeout and abort land here.
      // eslint-disable-next-line promise/no-multiple-resolved
      resolve({
        command: input.command,
        exit_code: exitCode,
        stdout: stdout.finish(),
        stderr: note ? `${err}${err ? "\n" : ""}${note}` : err,
      });
    };
    const kill = (why: string) => {
      note = why;
      killGroup();
      if (killed) return;
      killed = true;
      timers.add(setTimeout(() => finish(null), KILL_FALLBACK_MS));
    };
    if (child.pid !== undefined) {
      lowerAgentProcessPriority(child.pid);
      try {
        release = input.onSpawn?.(child.pid) ?? null;
      } catch {
        release = null;
      }
    }
    timers.add(
      setTimeout(() => {
        kill(`[killed after ${Number((input.timeoutMs / 1000).toFixed(1))} s]`);
      }, input.timeoutMs),
    );
    const onAbort = () => kill("[killed: the tool call was cancelled]");
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    // Streams can error once destroyed; the output is already final then.
    child.stdout?.on("error", () => undefined);
    child.stderr?.on("error", () => undefined);
    child.on("error", (error) => {
      note = `[could not start bash: ${error.message}]`;
      finish(null);
    });
    // `close` waits for every holder of the pipes, which a background job can keep forever;
    // `exit` is bash itself. Whichever is first wins, after a short drain for `exit`.
    child.on("exit", (code) => {
      if (draining) return;
      draining = true;
      timers.add(setTimeout(() => finish(note ? null : code), EXIT_DRAIN_MS));
    });
    child.on("close", (code) => finish(note ? null : code));
  });
}
