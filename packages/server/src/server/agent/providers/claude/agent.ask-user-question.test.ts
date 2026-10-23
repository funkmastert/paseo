import type { Query } from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import type { AskUserQuestionCheckOptions } from "./agent.js";
import { ASK_USER_QUESTION_BLOCK_REASON, ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";

function createQueryMock(): Query {
  const events = [
    {
      type: "system",
      subtype: "init",
      session_id: "ask-user-question-session",
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
type Hooks = NonNullable<ClaudeQueryInput["options"]["hooks"]>;

interface Launched {
  hooks: Hooks;
  logLines: Array<Record<string, unknown>>;
}

function fakeCheck(
  overrides: Partial<AskUserQuestionCheckOptions> = {},
): AskUserQuestionCheckOptions {
  return {
    readConfig: () => ({ enabled: true, mode: "enforce" }),
    isRootAgent: () => true,
    ...overrides,
  };
}

/** Runs one turn in bypass mode and returns the hooks the SDK was launched with. */
async function launch(
  askUserQuestionCheck?: AskUserQuestionCheckOptions,
  agentId: string | undefined = "agent-1",
): Promise<Launched> {
  let captured: ClaudeQueryInput["options"] | undefined;
  const logLines: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: "warn" },
    { write: (line: string) => logLines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  const client = new ClaudeAgentClient({
    logger,
    queryFactory: ({ options }: ClaudeQueryInput) => {
      captured = options;
      return createQueryMock();
    },
    resolveBinary: async () => "/test/claude/bin",
    ...(askUserQuestionCheck ? { askUserQuestionCheck } : {}),
  });
  const session = await client.createSession(
    { provider: "claude", cwd: process.cwd(), modeId: "bypassPermissions" },
    { agentId },
  );
  try {
    await session.run("ask-user-question check");
  } finally {
    await session.close();
  }
  if (!captured?.hooks) throw new Error("queryFactory was never called with hooks");
  return { hooks: captured.hooks, logLines };
}

function stopHook(hooks: Hooks): HookCallback | null {
  const hook = hooks.Stop?.[0]?.hooks[0];
  return (hook as unknown as HookCallback) ?? null;
}

function askUserQuestionPreHook(hooks: Hooks): HookCallback | null {
  const matchers = hooks.PreToolUse?.filter((entry) => entry.matcher === "AskUserQuestion") ?? [];
  const hook = matchers[0]?.hooks[0];
  return (hook as unknown as HookCallback) ?? null;
}

function stopInput(lastAssistantMessage?: string, stopHookActive = false) {
  return {
    hook_event_name: "Stop",
    stop_hook_active: stopHookActive,
    ...(lastAssistantMessage !== undefined ? { last_assistant_message: lastAssistantMessage } : {}),
  };
}

describe("Claude AskUserQuestion check", () => {
  test("blocks a root agent's plain-text question once, then passes on the re-fire", async () => {
    const { hooks, logLines } = await launch(fakeCheck());
    const stop = stopHook(hooks);
    if (!stop) throw new Error("Expected a Stop hook");

    const blocked = await stop(stopInput("Want me to merge it?"));
    expect(blocked).toEqual({ decision: "block", reason: ASK_USER_QUESTION_BLOCK_REASON });
    const line = logLines.find(
      (entry) => entry["msg"] === "AskUserQuestion check: turn ended asking Tyler in plain text",
    );
    expect(line).toMatchObject({ agentId: "agent-1", mode: "enforce" });

    // Same turn, stop_hook_active now true: never fires twice.
    expect(await stop(stopInput("Want me to merge it?", true))).toEqual({});
  });

  test("passes the same text from a child agent", async () => {
    const { hooks } = await launch(fakeCheck({ isRootAgent: () => false }));
    const stop = stopHook(hooks);
    if (!stop) throw new Error("Expected a Stop hook");

    expect(await stop(stopInput("Want me to merge it?"))).toEqual({});
  });

  test("passes a turn that called AskUserQuestion", async () => {
    const { hooks } = await launch(fakeCheck());
    const stop = stopHook(hooks);
    const askUserQuestion = askUserQuestionPreHook(hooks);
    if (!stop || !askUserQuestion) throw new Error("Expected both hooks");

    await askUserQuestion({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" });

    expect(await stop(stopInput("Want me to merge it?"))).toEqual({});
  });

  test("a subagent's own AskUserQuestion call does not count for the root turn", async () => {
    const { hooks } = await launch(fakeCheck());
    const stop = stopHook(hooks);
    const askUserQuestion = askUserQuestionPreHook(hooks);
    if (!stop || !askUserQuestion) throw new Error("Expected both hooks");

    await askUserQuestion({
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      agent_id: "subagent-1",
    });

    const blocked = await stop(stopInput("Want me to merge it?"));
    expect(blocked).toEqual({ decision: "block", reason: ASK_USER_QUESTION_BLOCK_REASON });
  });

  test("mode: log logs what it would have blocked and lets the turn end", async () => {
    const { hooks, logLines } = await launch(
      fakeCheck({ readConfig: () => ({ enabled: true, mode: "log" }) }),
    );
    const stop = stopHook(hooks);
    if (!stop) throw new Error("Expected a Stop hook");

    expect(await stop(stopInput("Want me to merge it?"))).toEqual({});
    const line = logLines.find(
      (entry) => entry["msg"] === "AskUserQuestion check: turn ended asking Tyler in plain text",
    );
    expect(line).toMatchObject({ mode: "log" });
  });

  test("enabled: false registers no Stop hook", async () => {
    const { hooks } = await launch(
      fakeCheck({ readConfig: () => ({ enabled: false, mode: "enforce" }) }),
    );

    expect(hooks.Stop ?? []).toHaveLength(0);
    expect(hooks.PreToolUse?.some((entry) => entry.matcher === "AskUserQuestion")).toBe(false);
  });

  test("passes a plain status report", async () => {
    const { hooks } = await launch(fakeCheck());
    const stop = stopHook(hooks);
    if (!stop) throw new Error("Expected a Stop hook");

    expect(await stop(stopInput("Fixed the bug and reran the suite. Done."))).toEqual({});
  });

  test("judges only the SDK's last_assistant_message, not every text block of the turn (#18)", async () => {
    const { hooks } = await launch(fakeCheck());
    const stop = stopHook(hooks);
    if (!stop) throw new Error("Expected a Stop hook");

    // A multi-paragraph status report with a bulleted list and a relative "which" next to it —
    // the false positive from #18. The SDK hands the Stop hook only this one field, so if the
    // hook ever starts concatenating other turn text alongside it, this must still pass.
    const statusReport = [
      "Three agents are running:",
      "",
      "| Agent | Doing |",
      "|---|---|",
      "| Codex PR A re-review | Confirming the two P0 holes are actually closed |",
      "| Arena rate-limit fix | So all nine boards load |",
      "| Explicit-request fix | So the ranking runs even though every spawn names a model |",
      "",
      "A background watch is also waiting for the first live workspace archives. When those land:",
      "- merge PR A if the re-review passes;",
      "- gate and merge the two arena fixes;",
      "- one more deploy, which now reloads the plugin automatically;",
      "- then check the arena shadow's picks over real spawns.",
      "",
      "Each agent reports back when done.",
    ].join("\n");

    expect(await stop(stopInput(statusReport))).toEqual({});
  });

  test("passes a cancelled turn with no final text", async () => {
    const { hooks } = await launch(fakeCheck());
    const stop = stopHook(hooks);
    if (!stop) throw new Error("Expected a Stop hook");

    expect(await stop(stopInput(undefined))).toEqual({});
  });

  test("no AskUserQuestion check configured registers no Stop hook", async () => {
    const { hooks } = await launch();

    expect(hooks.Stop ?? []).toHaveLength(0);
  });
});
