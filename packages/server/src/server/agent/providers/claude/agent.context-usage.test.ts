import { readFileSync } from "node:fs";
import type { Query, SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";

const RAW_USAGE: SDKControlGetContextUsageResponse = {
  gridRows: [],
  ...JSON.parse(
    readFileSync(new URL("./test-fixtures/context-usage-opus-1m.json", import.meta.url), "utf8"),
  ),
};

const INIT_EVENT = {
  type: "system",
  subtype: "init",
  session_id: "claude-context-usage-session",
  permissionMode: "default",
  model: "opus",
};
const RESULT_EVENT = {
  type: "result",
  subtype: "success",
  usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
  total_cost_usd: 0,
};

interface QueryHandle {
  query: Query;
  getContextUsage: ReturnType<typeof vi.fn>;
  retired: ReturnType<typeof vi.fn>;
}

// A query that plays `events` and then stays open, the way a live CLI process does between
// turns, until the session closes it.
function createLiveQuery(events: unknown[]): QueryHandle {
  let index = 0;
  let release: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const getContextUsage = vi.fn(async () => RAW_USAGE);
  const retired = vi.fn(async () => {
    release();
    return { done: true, value: undefined };
  });
  const query = {
    next: vi.fn(async () => {
      if (index < events.length) return { done: false, value: events[index++] };
      await closed;
      return { done: true, value: undefined };
    }),
    return: retired,
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => release()),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    applyFlagSettings: vi.fn(async () => undefined),
    getContextUsage,
    [Symbol.asyncIterator]() {
      return this;
    },
  } as unknown as Query;
  return { query, getContextUsage, retired };
}

async function createSession(events: unknown[]) {
  const handles: QueryHandle[] = [];
  const queryFactory = vi.fn(() => {
    const handle = createLiveQuery(events);
    handles.push(handle);
    return handle.query;
  });
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
    model: "claude-opus-4-6",
  });
  return { session, queryFactory, handles };
}

describe("Claude getContextUsage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("asks the live process with a control request and starts no turn", async () => {
    const { session, queryFactory, handles } = await createSession([INIT_EVENT, RESULT_EVENT]);
    try {
      await session.run("hello");
      const promptsBefore = vi.mocked(handles[0].query.next).mock.calls.length;

      const usage = await session.getContextUsage?.({ allowStart: false });

      expect(usage?.totalTokens).toBe(174085);
      expect(usage?.source).toBe("session");
      expect(handles[0].getContextUsage).toHaveBeenCalledTimes(1);
      expect(queryFactory).toHaveBeenCalledTimes(1);
      expect(vi.mocked(handles[0].query.next).mock.calls.length).toBe(promptsBefore);
    } finally {
      await session.close();
    }
  });

  test("answers null without a live process when it may not start one", async () => {
    const { session, queryFactory } = await createSession([INIT_EVENT, RESULT_EVENT]);
    try {
      await expect(session.getContextUsage?.({ allowStart: false })).resolves.toBeNull();
      expect(queryFactory).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  test("starts the process for an idle session when allowed", async () => {
    const { session, queryFactory, handles } = await createSession([INIT_EVENT, RESULT_EVENT]);
    try {
      const usage = await session.getContextUsage?.({ allowStart: true });

      expect(usage?.maxTokens).toBe(1000000);
      expect(queryFactory).toHaveBeenCalledTimes(1);
      expect(handles[0].getContextUsage).toHaveBeenCalledTimes(1);
    } finally {
      await session.close();
    }
  });

  test("mid-turn it reads the running process and never retires it, even flagged for restart", async () => {
    // No result event: the turn stays running.
    const { session, queryFactory, handles } = await createSession([INIT_EVENT]);
    try {
      await session.startTurn("long task");
      await vi.waitFor(() => expect(queryFactory).toHaveBeenCalledTimes(1));
      await session.setThinkingOption?.("high");

      const usage = await session.getContextUsage?.({ allowStart: true });

      expect(usage?.totalTokens).toBe(174085);
      expect(queryFactory).toHaveBeenCalledTimes(1);
      expect(handles[0].retired).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });
});
