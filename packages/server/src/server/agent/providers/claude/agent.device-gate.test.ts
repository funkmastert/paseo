import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { DeviceLaunchGate } from "../../device-lease-manager.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";

function createQueryMock(): Query {
  const events = [
    {
      type: "system",
      subtype: "init",
      session_id: "device-gate-session",
      permissionMode: "bypassPermissions",
      model: "opus",
    },
    { type: "assistant", message: { content: "done" } },
    {
      type: "result",
      subtype: "success",
      usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      total_cost_usd: 0,
    },
  ];
  let index = 0;
  return {
    next: vi.fn(async () =>
      index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined },
    ),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as Query;
}

type HookCallback = (input: unknown) => Promise<Record<string, unknown>>;

/** Runs one turn and returns the hooks the SDK was launched with. */
async function launchHooks(
  gate?: DeviceLaunchGate,
  modeId = "bypassPermissions",
): Promise<{
  hooks: NonNullable<ClaudeQueryInput["options"]["hooks"]>;
  permissionMode: unknown;
}> {
  let captured: ClaudeQueryInput["options"] | undefined;
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: ({ options }: ClaudeQueryInput) => {
      captured = options;
      return createQueryMock();
    },
    resolveBinary: async () => "/test/claude/bin",
    ...(gate ? { deviceLaunchGate: gate } : {}),
  });
  const session = await client.createSession(
    { provider: "claude", cwd: process.cwd(), modeId },
    { agentId: "agent-1" },
  );
  try {
    await session.run("device gate check");
  } finally {
    await session.close();
  }
  if (!captured?.hooks) throw new Error("queryFactory was never called with hooks");
  return { hooks: captured.hooks, permissionMode: captured.permissionMode };
}

/** The gate's matcher is the one scoped to Bash; the other PreToolUse entry only observes. */
function bashHook(hooks: NonNullable<ClaudeQueryInput["options"]["hooks"]>): HookCallback {
  const matcher = hooks.PreToolUse?.find((entry) => entry.matcher === "Bash");
  if (!matcher?.hooks[0]) throw new Error("Expected a Bash PreToolUse matcher");
  return matcher.hooks[0] as unknown as HookCallback;
}

function preToolUseInput(command: string) {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "tool-1",
  };
}

describe("Claude device launch gate", () => {
  test("registers no Bash gate when the daemon has no device cap", async () => {
    const { hooks } = await launchHooks();

    expect(hooks.PreToolUse?.some((entry) => entry.matcher === "Bash")).toBe(false);
    // The effort observer is untouched by the cap.
    expect(hooks.PreToolUse).toHaveLength(1);
  });

  test("denies a device launch the cap refused, and passes its message to the model", async () => {
    const gate: DeviceLaunchGate = {
      gateLaunch: vi.fn(async () => ({
        decision: "deny" as const,
        message: "Bozeo device cap: no ios slot. Call device_checkout and wait.",
      })),
    };
    const { hooks, permissionMode } = await launchHooks(gate);

    const result = await bashHook(hooks)(preToolUseInput("xcrun simctl boot 'iPhone 17 Pro'"));

    expect(gate.gateLaunch).toHaveBeenCalledWith({
      agentId: "agent-1",
      command: "xcrun simctl boot 'iPhone 17 Pro'",
    });
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Bozeo device cap: no ios slot. Call device_checkout and wait.",
      },
    });
    // The point of using a hook rather than canUseTool: this still runs in bypass mode, which
    // is the mode the SDK skips the permission callback in entirely.
    expect(permissionMode).toBe("bypassPermissions");
  });

  test("allows anything the cap allows", async () => {
    const gate: DeviceLaunchGate = {
      gateLaunch: vi.fn(async () => ({ decision: "allow" as const })),
    };
    const { hooks } = await launchHooks(gate);

    expect(await bashHook(hooks)(preToolUseInput("./gradlew installDebug"))).toEqual({});
  });

  test("never consults the cap for a tool that is not Bash", async () => {
    const gate: DeviceLaunchGate = {
      gateLaunch: vi.fn(async () => ({ decision: "allow" as const })),
    };
    const { hooks } = await launchHooks(gate);

    const result = await bashHook(hooks)({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/x", content: "xcrun simctl boot" },
      tool_use_id: "tool-2",
    });

    expect(result).toEqual({});
    expect(gate.gateLaunch).not.toHaveBeenCalled();
  });

  test("fails open when the cap itself throws", async () => {
    const gate: DeviceLaunchGate = {
      gateLaunch: vi.fn(async () => {
        throw new Error("sampler wedged");
      }),
    };
    const { hooks } = await launchHooks(gate);

    // A broken device cap must not break tool calls: the process scan still catches whatever
    // boots, and a daemon that cannot evaluate the cap has no business blocking work.
    expect(await bashHook(hooks)(preToolUseInput("xcrun simctl boot 'iPhone 17 Pro'"))).toEqual({});
  });
});
