import { describe, expect, it, vi } from "vitest";
import { AccountAuthProbe } from "./account-auth-probe.js";

const T0 = Date.parse("2026-10-12T18:00:00Z");
const FIFTEEN_MIN = 15 * 60_000;

function makeProbe(
  run: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>,
) {
  return new AccountAuthProbe({ runProcess: run });
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

  it("runs the keepalive's single-Haiku-turn command with the entry's CLAUDE_CONFIG_DIR", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false });
    const probe = makeProbe(run);
    await probe.run(
      { providerId: "claude-personal", configDir: "/tmp/x", hasRunningAgent: false },
      T0,
    );
    expect(run).toHaveBeenCalledWith(
      "claude",
      ["-p", "reply ok", "--model", "haiku", "--max-turns", "1"],
      expect.objectContaining({ env: expect.objectContaining({ CLAUDE_CONFIG_DIR: "/tmp/x" }) }),
    );
  });
});
