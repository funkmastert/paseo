import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { CommandGate } from "../../jev/contract.js";
import {
  JEV_COMMAND_ATTENDED_REASON,
  JEV_COMMAND_BASH_DENIED_REASON,
  JEV_COMMAND_GATE_ERROR_REASON,
  JEV_COMMAND_NO_GATE_REASON,
  JEV_COMMAND_OUTPUT_CAP,
  JEV_COMMAND_SANDBOXED_REASON,
  JEV_COMMAND_WINDOWS_REASON,
  JEV_COMMAND_DEVICE_GATE_ERROR_REASON,
  JEV_COMMAND_NO_ENV_REASON,
  jevCommandArgv,
  runJevCommand,
  type JevCommandResult,
  type RunJevCommandInput,
} from "./jev-command.js";
import type { DeviceLaunchGate } from "../device-lease-manager.js";
import {
  resetProcessPriorityPolicy,
  setProcessPriorityPolicy,
} from "../../../utils/process-priority.js";

let cwd: string;
const allow: CommandGate = async () => ({ allowed: true, reason: null });
const allowLaunch: DeviceLaunchGate = { gateLaunch: async () => ({ decision: "allow" }) };

/** The agent's own Bash environment, as `resolveCommandEnv` hands it over. */
function agentEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: process.env["PATH"], HOME: process.env["HOME"], ...extra };
}

function run(
  input: Partial<RunJevCommandInput> & Pick<RunJevCommandInput, "command">,
): Promise<JevCommandResult> {
  return runJevCommand({
    agentId: "agent-1",
    cwd,
    gate: allow,
    deviceGate: allowLaunch,
    env: agentEnv(),
    bashDenied: false,
    unattended: true,
    sandboxed: false,
    ...input,
  });
}

beforeEach(() => {
  const cache = path.join(os.homedir(), ".cache");
  mkdirSync(cache, { recursive: true });
  cwd = mkdtempSync(path.join(cache, "jev-command-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  resetProcessPriorityPolicy();
});

describe("refusals, before anything runs", () => {
  test("Windows refuses outright, without asking the gate", async () => {
    const gate = vi.fn(allow);
    const result = await run({
      command: "echo hi",
      cwd,
      gate,
      bashDenied: false,
      unattended: true,
      sandboxed: false,
      platform: "win32",
    });
    expect(result).toEqual({ kind: "refused", reason: JEV_COMMAND_WINDOWS_REASON });
    expect(gate).not.toHaveBeenCalled();
  });

  test("an agent whose denied tools include Bash", async () => {
    const result = await run({
      command: "echo hi",
      cwd,
      gate: allow,
      bashDenied: true,
      unattended: true,
      sandboxed: false,
    });
    expect(result).toEqual({ kind: "refused", reason: JEV_COMMAND_BASH_DENIED_REASON });
  });

  test("an agent whose mode asks first, or whose Bash is sandboxed", async () => {
    const gate = vi.fn(allow);
    const attended = await run({
      command: "echo hi",
      cwd,
      gate,
      bashDenied: false,
      unattended: false,
      sandboxed: false,
    });
    expect(attended).toEqual({ kind: "refused", reason: JEV_COMMAND_ATTENDED_REASON });
    const sandboxed = await run({
      command: "echo hi",
      cwd,
      gate,
      bashDenied: false,
      unattended: true,
      sandboxed: true,
    });
    expect(sandboxed).toEqual({ kind: "refused", reason: JEV_COMMAND_SANDBOXED_REASON });
    expect(gate).not.toHaveBeenCalled();
  });

  test("no gate wired", async () => {
    const result = await run({
      command: "echo hi",
      cwd,
      gate: null,
      bashDenied: false,
      unattended: true,
      sandboxed: false,
    });
    expect(result).toEqual({ kind: "refused", reason: JEV_COMMAND_NO_GATE_REASON });
  });

  test("the gate refuses, with its reason", async () => {
    const marker = path.join(cwd, "ran");
    const gate: CommandGate = async () => ({ allowed: false, reason: "rule: rm-disk-root" });
    const result = await run({
      command: `touch ${marker}`,
      cwd,
      gate,
      bashDenied: false,
      unattended: true,
      sandboxed: false,
    });
    expect(result).toEqual({ kind: "refused", reason: "rule: rm-disk-root" });
    expect(existsSync(marker)).toBe(false);
  });

  test("a gate that throws or rejects refuses", async () => {
    const throwing: CommandGate = () => {
      throw new Error("boom");
    };
    const rejecting: CommandGate = async () => {
      throw new Error("boom");
    };
    for (const gate of [throwing, rejecting]) {
      const result = await run({
        command: "echo hi",
        cwd,
        gate,
        bashDenied: false,
        unattended: true,
        sandboxed: false,
      });
      expect(result).toEqual({ kind: "refused", reason: JEV_COMMAND_GATE_ERROR_REASON });
    }
  });

  test("the gate sees the command and the cwd", async () => {
    const gate = vi.fn(allow);
    await run({
      command: "true",
      cwd,
      gate,
      bashDenied: false,
      unattended: true,
      sandboxed: false,
    });
    expect(gate).toHaveBeenCalledWith({ command: "true", cwd });
  });
});

describe("running", () => {
  test("captures stdout, stderr and the exit code in cwd", async () => {
    const result = await run({
      command: "pwd; echo oops >&2; exit 3",
      cwd,
      gate: allow,
      bashDenied: false,
      unattended: true,
      sandboxed: false,
    });
    expect(result.kind).toBe("ran");
    if (result.kind !== "ran") return;
    expect(result.output.exit_code).toBe(3);
    expect(result.output.stdout.trim()).toBe(cwd);
    expect(result.output.stderr.trim()).toBe("oops");
  });

  test("the JEV key and other secrets never reach the command; CI is set", async () => {
    const result = await run({
      command: "env",
      cwd,
      gate: allow,
      bashDenied: false,
      unattended: true,
      sandboxed: false,
      env: agentEnv({
        PASEO_JEV_API_KEY: "sk-or-sentinel-jev-key-000000",
        HARMLESS: "kept",
      }),
    });
    if (result.kind !== "ran") throw new Error("did not run");
    expect(result.output.stdout).not.toContain("sentinel-jev-key");
    expect(result.output.stdout).not.toContain("PASEO_JEV_API_KEY");
    expect(result.output.stdout).toContain("HARMLESS=kept");
    expect(result.output.stdout).toContain("CI=1");
  });

  test("a command past its time is killed, with a note", async () => {
    const result = await run({
      command: "sleep 5 & wait",
      cwd,
      gate: allow,
      bashDenied: false,
      unattended: true,
      sandboxed: false,
      timeoutMs: 200,
    });
    if (result.kind !== "ran") throw new Error("did not run");
    expect(result.output.exit_code).toBeNull();
    expect(result.output.stderr).toContain("[killed after 0.2 s]");
  });

  test("each stream is cut at the cap, and says how much was dropped", async () => {
    const result = await run({
      command: `head -c ${JEV_COMMAND_OUTPUT_CAP + 1000} /dev/zero | tr '\\0' 'a'`,
      cwd,
      gate: allow,
      bashDenied: false,
      unattended: true,
      sandboxed: false,
    });
    if (result.kind !== "ran") throw new Error("did not run");
    expect(result.output.stdout.startsWith("a".repeat(JEV_COMMAND_OUTPUT_CAP))).toBe(true);
    expect(result.output.stdout).toContain("[1,000 more characters not kept]");
  });

  test("a cancelled tool call kills the command", async () => {
    const controller = new AbortController();
    const pending = run({
      command: "sleep 5",
      cwd,
      gate: allow,
      bashDenied: false,
      unattended: true,
      sandboxed: false,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    if (result.kind !== "ran") throw new Error("did not run");
    expect(result.output.stderr).toContain("cancelled");
  });
});

describe("the device cap (H2)", () => {
  test("a launch the cap refuses is refused with its message, after the catastrophe gate", async () => {
    const order: string[] = [];
    const deviceGate: DeviceLaunchGate = {
      gateLaunch: vi.fn(async (input) => {
        order.push(`device:${input.agentId}:${input.command}`);
        return { decision: "deny" as const, message: "No device slot is free; 3 of 3 in use." };
      }),
    };
    const gate: CommandGate = async ({ command }) => {
      order.push(`catastrophe:${command}`);
      return { allowed: true, reason: null };
    };
    const marker = path.join(cwd, "booted");
    const result = await run({ command: `xcrun simctl boot X; touch ${marker}`, gate, deviceGate });
    expect(result).toEqual({ kind: "refused", reason: "No device slot is free; 3 of 3 in use." });
    expect(order).toEqual([
      `catastrophe:xcrun simctl boot X; touch ${marker}`,
      `device:agent-1:xcrun simctl boot X; touch ${marker}`,
    ]);
    expect(existsSync(marker)).toBe(false);
  });

  test("a cap that throws refuses (fails closed), and an allowing cap runs", async () => {
    const throwing: DeviceLaunchGate = {
      gateLaunch: async () => {
        throw new Error("lease store unreadable");
      },
    };
    expect(await run({ command: "echo hi", deviceGate: throwing })).toEqual({
      kind: "refused",
      reason: JEV_COMMAND_DEVICE_GATE_ERROR_REASON,
    });
    const ran = await run({ command: "echo hi" });
    expect(ran.kind).toBe("ran");
  });
});

describe("the agent's environment (M5)", () => {
  test("the command gets the agent's Bash environment, not the daemon's, minus the JEV key", async () => {
    const result = await run({
      command: "env",
      env: agentEnv({
        PASEO_AGENT_ID: "agent-1",
        CLAUDE_CONFIG_DIR: "/accounts/worker-2",
        DATABASE_URL: "postgres://agent-db",
        PASEO_JEV_API_KEY: "sk-or-sentinel-jev-key-000000",
      }),
    });
    if (result.kind !== "ran") throw new Error("did not run");
    expect(result.output.stdout).toContain("PASEO_AGENT_ID=agent-1");
    expect(result.output.stdout).toContain("CLAUDE_CONFIG_DIR=/accounts/worker-2");
    expect(result.output.stdout).toContain("DATABASE_URL=postgres://agent-db");
    expect(result.output.stdout).not.toContain("sentinel-jev-key");
  });

  test("no environment for the agent refuses, rather than falling back to the daemon's", async () => {
    expect(await run({ command: "echo hi", env: null })).toEqual({
      kind: "refused",
      reason: JEV_COMMAND_NO_ENV_REASON,
    });
  });
});

describe("priority and attribution (H3)", () => {
  test.skipIf(process.platform === "win32")(
    "the command runs at the agents' nice and is charged to the agent while it runs",
    async () => {
      setProcessPriorityPolicy({ agentNice: 12 });
      const spawned: number[] = [];
      const released: number[] = [];
      const result = await run({
        command: "ps -o nice= -p $$; echo pid=$$",
        onSpawn: (pid) => {
          spawned.push(pid);
          return () => released.push(pid);
        },
      });
      if (result.kind !== "ran") throw new Error("did not run");
      const [nice, pidLine] = result.output.stdout.trim().split("\n");
      expect(Number(nice?.trim())).toBe(12);
      expect(spawned).toEqual([Number(pidLine?.replace("pid=", ""))]);
      expect(released).toEqual(spawned);
    },
  );

  test("disk I/O runs at low priority where the platform has a way to ask", () => {
    expect(jevCommandArgv("echo hi", { platform: "darwin", hasTool: () => true })).toEqual([
      "/usr/sbin/taskpolicy",
      "-d",
      "utility",
      "/bin/bash",
      "-c",
      "echo hi",
    ]);
    expect(jevCommandArgv("echo hi", { platform: "linux", hasTool: () => true })).toEqual([
      "ionice",
      "-c",
      "2",
      "-n",
      "7",
      "/bin/bash",
      "-c",
      "echo hi",
    ]);
    expect(jevCommandArgv("echo hi", { platform: "darwin", hasTool: () => false })).toEqual([
      "/bin/bash",
      "-c",
      "echo hi",
    ]);
  });
});

describe("a command that leaves something running (M3)", () => {
  test.skipIf(process.platform === "win32")(
    "a background job holding stdout does not hold the call; it is killed with the group",
    async () => {
      const started = Date.now();
      const result = await run({ command: "sleep 30 & echo started", timeoutMs: 10_000 });
      if (result.kind !== "ran") throw new Error("did not run");
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.output.stdout.trim()).toBe("started");
      expect(result.output.exit_code).toBe(0);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a process that leaves the group with setsid and keeps stdout does not hang the call",
    async () => {
      const tag = `jev-m3-${process.pid}-${Date.now()}`;
      const detach = `perl -e 'use POSIX; POSIX::setsid(); sleep 30' ${tag}`;
      try {
        const started = Date.now();
        const result = await run({ command: `${detach} & sleep 30`, timeoutMs: 500 });
        if (result.kind !== "ran") throw new Error("did not run");
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(result.output.exit_code).toBeNull();
        expect(result.output.stderr).toContain("[killed after 0.5 s]");
      } finally {
        try {
          execFileSync("pkill", ["-f", tag]);
        } catch {
          // Already gone.
        }
      }
    },
  );
});
