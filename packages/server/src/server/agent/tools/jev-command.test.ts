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
  runJevCommand,
} from "./jev-command.js";

let cwd: string;
const allow: CommandGate = async () => ({ allowed: true, reason: null });

beforeEach(() => {
  const cache = path.join(os.homedir(), ".cache");
  mkdirSync(cache, { recursive: true });
  cwd = mkdtempSync(path.join(cache, "jev-command-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("refusals, before anything runs", () => {
  test("Windows refuses outright, without asking the gate", async () => {
    const gate = vi.fn(allow);
    const result = await runJevCommand({
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
    const result = await runJevCommand({
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
    const attended = await runJevCommand({
      command: "echo hi",
      cwd,
      gate,
      bashDenied: false,
      unattended: false,
      sandboxed: false,
    });
    expect(attended).toEqual({ kind: "refused", reason: JEV_COMMAND_ATTENDED_REASON });
    const sandboxed = await runJevCommand({
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
    const result = await runJevCommand({
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
    const result = await runJevCommand({
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
      const result = await runJevCommand({
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
    await runJevCommand({
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
    const result = await runJevCommand({
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
    const result = await runJevCommand({
      command: "env",
      cwd,
      gate: allow,
      bashDenied: false,
      unattended: true,
      sandboxed: false,
      baseEnv: {
        PATH: process.env["PATH"],
        PASEO_JEV_API_KEY: "sk-or-sentinel-jev-key-000000",
        HARMLESS: "kept",
      },
    });
    if (result.kind !== "ran") throw new Error("did not run");
    expect(result.output.stdout).not.toContain("sentinel-jev-key");
    expect(result.output.stdout).not.toContain("PASEO_JEV_API_KEY");
    expect(result.output.stdout).toContain("HARMLESS=kept");
    expect(result.output.stdout).toContain("CI=1");
  });

  test("a command past its time is killed, with a note", async () => {
    const result = await runJevCommand({
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
    const result = await runJevCommand({
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
    const pending = runJevCommand({
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
