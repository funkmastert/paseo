import { describe, expect, it, vi } from "vitest";
import {
  AccountAuthProbe,
  type ProbeProcessResult,
  type RunProbeProcess,
} from "./account-auth-probe.js";

const T0 = Date.parse("2026-10-12T18:00:00Z");
const FIFTEEN_MIN = 15 * 60_000;

function makeProbe(run: RunProbeProcess) {
  return new AccountAuthProbe({
    runProcess: run,
    resolveBinary: async () => "claude",
    scratchDir: () => "/tmp/probe-scratch",
  });
}

describe("AccountAuthProbe", () => {
  it("confirms auth_failure on auth-shaped output", async () => {
    const probe = makeProbe(async () => ({
      stdout: "",
      stderr: "Failed to authenticate: OAuth session expired",
      exitCode: 1,
      timedOut: false,
    }));
    const result = await probe.run(
      { providerId: "claude-personal", configDir: "/tmp/x", hasRunningAgent: false },
      T0,
    );
    expect(result).toBe("auth_failure");
  });

  it("clears on a clean exit", async () => {
    const probe = makeProbe(async () => ({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }));
    const result = await probe.run(
      { providerId: "claude-personal", configDir: "/tmp/x", hasRunningAgent: false },
      T0,
    );
    expect(result).toBe("success");
  });

  it("is inconclusive on a timeout", async () => {
    const probe = makeProbe(async () => ({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: true,
    }));
    const result = await probe.run(
      { providerId: "claude-personal", configDir: "/tmp/x", hasRunningAgent: false },
      T0,
    );
    expect(result).toBe("inconclusive");
  });

  it("is inconclusive on an unrelated non-zero exit", async () => {
    const probe = makeProbe(async () => ({
      stdout: "",
      stderr: "network error",
      exitCode: 1,
      timedOut: false,
    }));
    const result = await probe.run(
      { providerId: "claude-personal", configDir: "/tmp/x", hasRunningAgent: false },
      T0,
    );
    expect(result).toBe("inconclusive");
  });

  it("never runs while an agent on the account is running", async () => {
    const run = vi.fn();
    const probe = makeProbe(run);
    const result = await probe.run(
      { providerId: "claude-personal", configDir: "/tmp/x", hasRunningAgent: true },
      T0,
    );
    expect(result).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not run twice inside 15 minutes for the same account", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false });
    const probe = makeProbe(run);
    const first = await probe.run(
      { providerId: "claude-personal", configDir: "/tmp/x", hasRunningAgent: false },
      T0,
    );
    const second = await probe.run(
      { providerId: "claude-personal", configDir: "/tmp/x", hasRunningAgent: false },
      T0 + FIFTEEN_MIN - 1,
    );
    expect(first).toBe("success");
    expect(second).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs again once 15 minutes have passed", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false });
    const probe = makeProbe(run);
    await probe.run(
      { providerId: "claude-personal", configDir: "/tmp/x", hasRunningAgent: false },
      T0,
    );
    const second = await probe.run(
      { providerId: "claude-personal", configDir: "/tmp/x", hasRunningAgent: false },
      T0 + FIFTEEN_MIN,
    );
    expect(second).toBe("success");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs one Haiku turn with the resolved binary, overlaying only the entry's CLAUDE_CONFIG_DIR", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false });
    const probe = new AccountAuthProbe({
      runProcess: run,
      resolveBinary: async () => "/opt/claude/bin/claude",
      scratchDir: () => "/tmp/probe-scratch",
    });
    await probe.run(
      { providerId: "claude-personal", configDir: "/tmp/x", hasRunningAgent: false },
      T0,
    );
    expect(run).toHaveBeenCalledWith(
      "/opt/claude/bin/claude",
      ["-p", "reply ok", "--model", "haiku", "--max-turns", "1", "--no-session-persistence"],
      { envOverlay: { CLAUDE_CONFIG_DIR: "/tmp/x" }, cwd: "/tmp/probe-scratch", timeoutMs: 60_000 },
    );
  });

  it("is inconclusive, and spawns nothing, when no claude binary resolves", async () => {
    const run = vi.fn();
    const probe = new AccountAuthProbe({
      runProcess: run,
      resolveBinary: async () => {
        throw new Error("Claude binary not found");
      },
    });
    const result = await probe.run(
      { providerId: "claude-personal", configDir: "/tmp/x", hasRunningAgent: false },
      T0,
    );
    expect(result).toBe("inconclusive");
    expect(run).not.toHaveBeenCalled();
  });

  it("reuses one scratch directory across runs", async () => {
    const scratchDir = vi.fn(() => "/tmp/probe-scratch");
    const probe = new AccountAuthProbe({
      runProcess: async () => ({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false }),
      resolveBinary: async () => "claude",
      scratchDir,
    });
    for (const providerId of ["claude-personal", "claude-backup"]) {
      await probe.run({ providerId, configDir: "/tmp/x", hasRunningAgent: false }, T0);
    }
    expect(scratchDir).toHaveBeenCalledTimes(1);
  });

  it("start() returns before the CLI finishes, and the result is collected afterwards", async () => {
    let finish: (result: ProbeProcessResult) => void = () => {};
    const probe = new AccountAuthProbe({
      runProcess: () =>
        new Promise<ProbeProcessResult>((resolve) => {
          finish = resolve;
        }),
      resolveBinary: async () => "claude",
      scratchDir: () => "/tmp/probe-scratch",
    });

    expect(
      probe.start(
        { providerId: "claude-personal", configDir: "/tmp/x", hasRunningAgent: false },
        T0,
      ),
    ).toBe(true);
    expect(probe.takeFinished()).toEqual([]);

    await vi.waitFor(() => expect(probe.takeFinished()).toEqual([]));
    finish({ stdout: "", stderr: "Not logged in", exitCode: 1, timedOut: false });
    await vi.waitFor(() =>
      expect(probe.takeFinished()).toEqual([
        { providerId: "claude-personal", result: "auth_failure", atMs: T0 },
      ]),
    );
    expect(probe.takeFinished()).toEqual([]);
  });
});
