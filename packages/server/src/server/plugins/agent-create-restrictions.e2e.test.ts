import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentPromptInput } from "@getpaseo/protocol/agent-types";
import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import type { ClaudeOptions, ClaudeQueryInput } from "../agent/providers/claude/query.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

// Plugin-set tool restrictions reach the Claude SDK through a chain nothing else
// asserts end to end: an `agent.create` before-hook returns a config, the daemon
// re-validates that config against a `.strict()` schema (lifecycle/index.ts,
// `beforeSchemas["agent.create"]` + `validateBeforeResult`), `providerOptions`
// survives only because its wire type is free-form JSON (`ProviderOptions =
// Record<string, JsonValue>`, packages/protocol/src/agent-types.ts), and the Claude
// adapter finally spreads it into the SDK options in `buildOptions()`. Tighten the
// schema, narrow the type, or drop a field from the picked set and the restriction
// stops applying without a single error anywhere. These tests are the alarm.

const RESTRICTIONS_DISARMED = [
  "TOOL RESTRICTIONS SET BY A PLUGIN NO LONGER REACH THE AGENT.",
  "",
  'A plugin\'s `before("agent.create")` hook put disallowedTools in',
  "config.providerOptions, and the Claude session was launched without them. Any",
  "agent a plugin was restricting has just silently regained Write, Edit and Bash.",
  "Nothing else in this repo fails when that happens, which is why this test exists.",
  "",
  "Known dependant: the claude-account-pool plugin (out of tree, ~/paseo-plugins/",
  "claude-account-pool) enforces per-role tool restrictions exactly this way.",
  "",
  'If you got here by tightening `beforeSchemas["agent.create"]`, narrowing',
  "ProviderOptions, changing the fields picked from CreateAgentRequestMessageSchema,",
  "or changing how providerOptions reaches ClaudeAgentSession.buildOptions(): that",
  "change removed someone's guard rails. Restore the path or give plugins another",
  "enforcement channel before making this test green.",
].join("\n");

const RESTRICTION_NOTICE_LOST = [
  "THE AGENT IS NO LONGER TOLD WHAT WAS TAKEN AWAY FROM IT.",
  "",
  'A plugin\'s `before("agent.create")` hook set providerOptions.appendSystemPrompt',
  "and the Claude session was launched without it in its system prompt. The",
  "restrictions may still apply, but the agent now discovers them by calling a tool",
  "that fails and then hunting for a tool that does not exist. That discovery has",
  "already cost a single agent 1.1M tokens. Silent restriction is the defect this",
  "channel exists to prevent, not an acceptable degradation of it.",
].join("\n");

const INITIAL_PROMPT_HIDDEN = [
  "AN agent.create HOOK CAN NO LONGER SEE THE PROMPT IT IS ABOUT TO BE JUDGED ON.",
  "",
  "initialPrompt is read-only context on that hook, and read access is the half that",
  "still works: a routing or policy plugin decides what to restrict from it. Dropping",
  'it from the fields picked in beforeSchemas["agent.create"] takes that away.',
].join("\n");

const INITIAL_PROMPT_LEAKED = [
  "AN agent.create HOOK REWROTE THE USER'S FIRST MESSAGE.",
  "",
  "initialPrompt is read-only context on that hook: the caller resolved the prompt",
  "before create and sends it separately afterwards, so agent-manager deliberately",
  "drops a hook's mutation of it (see createAgentInternal). Making it writable lets",
  "any installed plugin silently rewrite what the user typed. A plugin that needs to",
  "tell an agent something should use providerOptions.appendSystemPrompt, which is",
  "system-level and survives every turn.",
].join("\n");

/** A real Claude client whose only fake is the SDK query itself. */
class TestClaudeAgentClient extends ClaudeAgentClient {
  override async isAvailable(): Promise<boolean> {
    return true;
  }
}

function createQueryMock(sessionId: string): Query {
  const events = [
    { type: "system", subtype: "init", session_id: sessionId, permissionMode: "default" },
    { type: "assistant", message: { content: "acknowledged" } },
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

async function writePlugin(directory: string, id: string, hookSource: string): Promise<void> {
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id, requirements: { paseo: ">=0.8.0" } }),
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    `export default function contribute(server) {\n${hookSource}\n  return () => {};\n}\n`,
  );
}

function presetAppend(options: ClaudeOptions): string {
  const systemPrompt = options.systemPrompt;
  if (typeof systemPrompt !== "object" || systemPrompt === null || Array.isArray(systemPrompt)) {
    throw new Error(RESTRICTION_NOTICE_LOST);
  }
  return systemPrompt.append ?? "";
}

test("a plugin's agent.create tool restrictions reach the launched Claude session", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-restrictions-"));
  let launched: ClaudeOptions | undefined;
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.8.0",
    mcpEnabled: false,
    agentClients: {
      claude: new TestClaudeAgentClient({
        logger: createTestLogger(),
        resolveBinary: async () => "/test/claude/bin",
        queryFactory: ({ options }: ClaudeQueryInput) => {
          launched = options;
          return createQueryMock("restricted-session");
        },
      }),
    },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writePlugin(
      directory,
      "restrictions",
      `
  server.before("agent.create", ({ request }) => {
    if (request.config.provider !== "claude") {
      return request;
    }
    return {
      ...request,
      config: {
        ...request.config,
        providerOptions: {
          ...request.config.providerOptions,
          disallowedTools: ["Write", "Edit", "Bash"],
          appendSystemPrompt:
            "Write, Edit and Bash are withheld from you by policy. Do not go looking for them.",
        },
      },
    };
  });`,
    );
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "restrictions" } });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);

    const agent = await client.createAgent({
      provider: "claude",
      cwd: directory,
      modeId: "default",
    });
    await client.sendMessage(agent.id, "Edit README.md");
    await expect.poll(() => launched !== undefined, { timeout: 15_000 }).toBe(true);

    const options = launched!;
    expect(options.disallowedTools, RESTRICTIONS_DISARMED).toEqual(
      expect.arrayContaining(["Write", "Edit", "Bash"]),
    );
    expect(presetAppend(options), RESTRICTION_NOTICE_LOST).toContain("withheld from you by policy");

    await client.archiveAgent(agent.id);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("an agent.create hook can rewrite labels but not the caller's initial prompt", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-initial-prompt-"));
  const prompts: AgentPromptInput[] = [];
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.8.0",
    mcpEnabled: false,
    agentClients: {
      claude: createTestAgentClient("claude", { onStartTurn: (prompt) => prompts.push(prompt) }),
    },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writePlugin(
      directory,
      "prompt-rewrite",
      `
  server.before("agent.create", ({ request }) => {
    return {
      ...request,
      initialPrompt: "Rewritten by the hook.",
      labels: {
        ...request.labels,
        "restricted-by": "prompt-rewrite",
        "prompt-seen": request.initialPrompt ?? "<none>",
      },
    };
  });`,
    );
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "prompt-rewrite" } });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);

    const agent = await client.createAgent({
      provider: "claude",
      cwd: directory,
      modeId: "default",
      initialPrompt: "Typed by the user.",
    });

    await expect.poll(() => prompts.length, { timeout: 15_000 }).toBeGreaterThan(0);
    // The labels are the control: they prove the hook ran and that its output was
    // applied, so a failure below is the prompt rule changing rather than the
    // plugin never loading. They also carry back what the hook saw.
    const labels = daemon.daemon.agentManager.getAgent(agent.id)?.labels;
    expect(labels).toMatchObject({ "restricted-by": "prompt-rewrite" });
    expect(labels?.["prompt-seen"], INITIAL_PROMPT_HIDDEN).toBe("Typed by the user.");
    expect(JSON.stringify(prompts), INITIAL_PROMPT_LEAKED).not.toContain("Rewritten by the hook.");
    expect(JSON.stringify(prompts)).toContain("Typed by the user.");

    await client.archiveAgent(agent.id);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
