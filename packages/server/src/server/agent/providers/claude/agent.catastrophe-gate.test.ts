import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Query } from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";

function createQueryMock(): Query {
  const events = [
    {
      type: "system",
      subtype: "init",
      session_id: "catastrophe-gate-session",
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
  permissionMode: unknown;
  logLines: Array<Record<string, unknown>>;
}

/** Runs one turn in bypass mode and returns the hooks the SDK was launched with. */
async function launch(isCatastropheGateEnabled?: () => boolean): Promise<Launched> {
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
    ...(isCatastropheGateEnabled ? { isCatastropheGateEnabled } : {}),
  });
  const session = await client.createSession(
    { provider: "claude", cwd: process.cwd(), modeId: "bypassPermissions" },
    { agentId: "agent-1" },
  );
  try {
    await session.run("catastrophe gate check");
  } finally {
    await session.close();
  }
  if (!captured?.hooks) throw new Error("queryFactory was never called with hooks");
  return { hooks: captured.hooks, permissionMode: captured.permissionMode, logLines };
}

/** With no device cap configured, the catastrophe gate owns the only matcher for `tool`. */
function gateFor(hooks: Hooks, tool: "Bash" | "Monitor"): HookCallback {
  const matchers = hooks.PreToolUse?.filter((entry) => entry.matcher === tool) ?? [];
  expect(matchers).toHaveLength(1);
  const hook = matchers[0]?.hooks[0];
  if (!hook) throw new Error(`Expected a ${tool} PreToolUse matcher`);
  return hook as unknown as HookCallback;
}

function toolUse(command: string, extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "tool-1",
    cwd: process.cwd(),
    ...extra,
  };
}

function denial(result: Record<string, unknown>): string {
  const output = result["hookSpecificOutput"] as Record<string, unknown> | undefined;
  expect(output?.["hookEventName"]).toBe("PreToolUse");
  expect(output?.["permissionDecision"]).toBe("deny");
  return String(output?.["permissionDecisionReason"]);
}

describe("Claude catastrophe gate", () => {
  test("denies a catastrophic command under bypassPermissions and says why", async () => {
    const { hooks, permissionMode } = await launch();

    const reason = denial(await gateFor(hooks, "Bash")(toolUse("git push --force origin main")));

    expect(reason).toContain("rule: force-push-main");
    expect(reason).toContain("Command: git push --force origin main");
    expect(reason).toContain("This block is final. Do not work around it");
    expect(reason).toContain("ask Tyler to run it himself");
    // The reason for a hook rather than canUseTool: the SDK skips canUseTool in bypass mode.
    expect(permissionMode).toBe("bypassPermissions");
  });

  test("passes an ordinary command through untouched", async () => {
    const { hooks } = await launch();
    const gate = gateFor(hooks, "Bash");

    expect(await gate(toolUse("rm -rf node_modules"))).toEqual({});
    expect(await gate(toolUse("git push -f origin my-feature"))).toEqual({});
    expect(await gate(toolUse('echo "git push -f origin main"'))).toEqual({});
  });

  test("gates the Monitor tool's command too", async () => {
    const { hooks } = await launch();

    const result = await gateFor(
      hooks,
      "Monitor",
    )(toolUse("rm -rf ~", { tool_name: "Monitor", tool_input: { command: "rm -rf ~" } }));

    expect(denial(result)).toContain("rule: rm-disk-root");
  });

  test("never looks at a tool that is not a shell", async () => {
    const { hooks } = await launch();

    const result = await gateFor(
      hooks,
      "Bash",
    )({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/wipe.sh", content: "rm -rf /" },
      tool_use_id: "tool-2",
    });

    expect(result).toEqual({});
  });

  test("logs every block at warn with the rule, the agent and the command capped at 500", async () => {
    const { hooks, logLines } = await launch();
    const command = `rm -rf / # ${"x".repeat(600)}`;

    await gateFor(hooks, "Bash")(toolUse(command, { agent_id: "subagent-7" }));

    const line = logLines.find((entry) => entry["msg"] === "Catastrophe gate blocked a command");
    expect(line).toMatchObject({
      level: 40,
      rule: "rm-disk-root",
      agentId: "agent-1",
      subagentId: "subagent-7",
      tool: "Bash",
    });
    expect(line?.["command"]).toBe(command.slice(0, 500));
  });

  test("the kill switch turns it off for a running session", async () => {
    let enabled = true;
    const { hooks } = await launch(() => enabled);
    const gate = gateFor(hooks, "Bash");

    expect(denial(await gate(toolUse("rm -rf /")))).toContain("rm-disk-root");
    enabled = false;
    expect(await gate(toolUse("rm -rf /"))).toEqual({});
  });

  describe("a force push that names no ref", () => {
    let root: string;
    let onMain: string;
    let onFeature: string;

    beforeAll(() => {
      root = realpathSync(mkdtempSync(path.join(tmpdir(), "claude-catastrophe-gate-")));
      onMain = path.join(root, "on-main");
      onFeature = path.join(root, "on-feature");
      for (const repo of [onMain, onFeature]) {
        execFileSync("git", ["init", "-q", "-b", "main", repo]);
        execFileSync(
          "git",
          ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i"],
          { cwd: repo },
        );
      }
      execFileSync("git", ["checkout", "-q", "-b", "my-feature"], { cwd: onFeature });
    });

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    test("is denied in the hook's cwd when main is checked out there", async () => {
      const { hooks } = await launch();
      const gate = gateFor(hooks, "Bash");

      expect(denial(await gate(toolUse("git push -f", { cwd: onMain })))).toContain(
        "force-push-main",
      );
      expect(await gate(toolUse("git push -f", { cwd: onFeature }))).toEqual({});
    });
  });
});
