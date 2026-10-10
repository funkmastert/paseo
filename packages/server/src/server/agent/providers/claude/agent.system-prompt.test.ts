import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentSessionConfig } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";

function createQueryMock(): Query {
  const events = [
    {
      type: "system",
      subtype: "init",
      session_id: "system-prompt-session",
      permissionMode: "default",
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

/** Runs one turn and returns the options handed to the SDK. */
async function launchOptions(
  config: Omit<AgentSessionConfig, "provider">,
  providerParams?: unknown,
): Promise<ClaudeQueryInput["options"]> {
  let captured: ClaudeQueryInput["options"] | undefined;
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: ({ options }: ClaudeQueryInput) => {
      captured = options;
      return createQueryMock();
    },
    resolveBinary: async () => "/test/claude/bin",
    providerParams,
  });
  const session = await client.createSession({ provider: "claude", ...config }, { env: {} });
  try {
    await session.run("system prompt check");
  } finally {
    await session.close();
  }
  if (!captured) throw new Error("queryFactory was never called");
  return captured;
}

function appendedText(options: ClaudeQueryInput["options"]): string {
  const systemPrompt = options.systemPrompt;
  if (typeof systemPrompt !== "object" || systemPrompt === null || Array.isArray(systemPrompt)) {
    throw new Error("Claude launches must keep the claude_code preset system prompt");
  }
  return systemPrompt.append ?? "";
}

describe("Claude system prompt composition", () => {
  test("providerOptions.appendSystemPrompt reaches the SDK as preset append text", async () => {
    const options = await launchOptions({
      cwd: process.cwd(),
      providerOptions: { appendSystemPrompt: "Write and Bash are withheld from you." },
    });

    expect(appendedText(options)).toBe("Write and Bash are withheld from you.");
  });

  test("the agent, daemon, and providerOptions notes compose in that order", async () => {
    const options = await launchOptions({
      cwd: process.cwd(),
      systemPrompt: "Agent instructions.",
      daemonAppendSystemPrompt: "Daemon-wide instructions.",
      providerOptions: { appendSystemPrompt: "Restriction notice." },
    });

    expect(appendedText(options)).toBe(
      "Agent instructions.\n\nDaemon-wide instructions.\n\nRestriction notice.",
    );
  });

  test("the providerOptions note never clobbers the daemon-wide append", async () => {
    const options = await launchOptions({
      cwd: process.cwd(),
      daemonAppendSystemPrompt: "Daemon-wide instructions.",
      providerOptions: { appendSystemPrompt: "Restriction notice." },
    });

    expect(appendedText(options)).toContain("Daemon-wide instructions.");
    expect(appendedText(options)).toContain("Restriction notice.");
  });

  test("leaving it unset composes exactly as before", async () => {
    const options = await launchOptions({
      cwd: process.cwd(),
      systemPrompt: "Agent instructions.",
      daemonAppendSystemPrompt: "Daemon-wide instructions.",
      providerOptions: {},
    });

    expect(appendedText(options)).toBe("Agent instructions.\n\nDaemon-wide instructions.");
  });

  test("the note is stripped before the SDK option spread", async () => {
    const options = await launchOptions({
      cwd: process.cwd(),
      providerOptions: {
        appendSystemPrompt: "Restriction notice.",
        disallowedTools: ["Write"],
      },
    });

    // appendSystemPrompt is Paseo's own key. Leaking it into the SDK Options object
    // would hand the Claude CLI an option it does not know.
    expect(options).not.toHaveProperty("appendSystemPrompt");
    expect(options.disallowedTools).toEqual(["Write"]);
  });
});

describe("Claude system prompt cache sharing", () => {
  function preset(options: ClaudeQueryInput["options"]): Record<string, unknown> {
    const systemPrompt = options.systemPrompt;
    if (typeof systemPrompt !== "object" || systemPrompt === null || Array.isArray(systemPrompt)) {
      throw new Error("Claude launches must keep the claude_code preset system prompt");
    }
    return systemPrompt;
  }

  test("excludeDynamicSections is on by default so worktrees share one cached prefix", async () => {
    const options = await launchOptions({ cwd: process.cwd() });

    expect(preset(options)).toMatchObject({
      type: "preset",
      preset: "claude_code",
      excludeDynamicSections: true,
    });
  });

  test("params.excludeDynamicSections: false leaves the option off the SDK preset", async () => {
    const options = await launchOptions({ cwd: process.cwd() }, { excludeDynamicSections: false });

    expect(preset(options)).not.toHaveProperty("excludeDynamicSections");
  });

  test("unrelated provider params (accountPool) do not disturb the default", async () => {
    const options = await launchOptions({ cwd: process.cwd() }, { accountPool: { weight: 1 } });

    expect(preset(options)).toMatchObject({ excludeDynamicSections: true });
  });

  test("a malformed value falls back to the default rather than failing the launch", async () => {
    const options = await launchOptions({ cwd: process.cwd() }, { excludeDynamicSections: "no" });

    expect(preset(options)).toMatchObject({ excludeDynamicSections: true });
  });
});

describe("Claude output style (config.outputStyle)", () => {
  test("reaches the SDK as settings.outputStyle", async () => {
    const options = await launchOptions({ cwd: process.cwd(), outputStyle: "Concise" });

    expect(options.settings).toMatchObject({ outputStyle: "Concise" });
  });

  test("merges with providerOptions.settings instead of replacing the deny tier", async () => {
    const options = await launchOptions({
      cwd: process.cwd(),
      outputStyle: "Concise",
      providerOptions: { settings: { permissions: { deny: ["Write(*)"] } } },
    });

    expect(options.settings).toMatchObject({
      outputStyle: "Concise",
      permissions: { deny: ["Write(*)"] },
    });
  });

  test("leaving it unset adds no settings at all", async () => {
    const options = await launchOptions({ cwd: process.cwd() });

    expect(options.settings).toBeUndefined();
  });

  test("is not handed to the SDK as an option of its own", async () => {
    const options = await launchOptions({ cwd: process.cwd(), outputStyle: "Concise" });

    expect(options).not.toHaveProperty("outputStyle");
  });
});
