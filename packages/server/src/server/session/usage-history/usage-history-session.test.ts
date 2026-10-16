import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageHistoryGetResponseSchema } from "@getpaseo/protocol/usage-history/rpc-schemas";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionOutboundMessage } from "../../messages.js";
import { UsageHistoryStore } from "../../usage-history/usage-history-store.js";
import { UsageHistorySession } from "./usage-history-session.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 8, 23, 12, 0, 0);

let rootDir: string;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-history-session-"));
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

async function seededStore(): Promise<UsageHistoryStore> {
  const store = new UsageHistoryStore({ rootDir, logger: { warn: () => undefined } });
  for (let minutes = 0; minutes <= 60; minutes += 5) {
    const atMs = T0 + minutes * MINUTE;
    await store.record({
      nowMs: atMs,
      accounts: [
        {
          providerId: "claude-personal",
          windowId: "five_hour",
          label: "Session",
          atMs,
          usedPct: 60 + minutes / 3,
          resetsAtMs: T0 + 5 * HOUR,
        },
      ],
      agents: [{ agentId: "agent-1", totalTokens: 1_000 * (minutes + 1) }],
    });
  }
  return store;
}

function createSession(store: UsageHistoryStore) {
  const emitted: SessionOutboundMessage[] = [];
  const session = new UsageHistorySession({
    host: { emit: (message) => void emitted.push(message) },
    store,
    logger: { error: vi.fn() },
    now: () => T0 + HOUR,
  });
  return { session, emitted };
}

describe("UsageHistorySession", () => {
  test("serves account projections and, when asked, one agent's spend, in a schema-valid response", async () => {
    const { session, emitted } = createSession(await seededStore());
    await session.handleGetRequest({
      type: "usage.history.get.request",
      requestId: "req-1",
      agentId: "agent-1",
    });

    const [message] = emitted;
    const parsed = UsageHistoryGetResponseSchema.parse(message);
    expect(parsed.payload.requestId).toBe("req-1");
    expect(parsed.payload.generatedAt).toBe(new Date(T0 + HOUR).toISOString());
    const window = parsed.payload.accounts[0]?.windows[0];
    expect(window).toMatchObject({ windowId: "five_hour", usedPct: 80 });
    expect(window?.projection).toMatchObject({ status: "projected", confidence: "ok" });
    expect(window?.projection.capsAt).toBe(new Date(T0 + 2 * HOUR).toISOString());
    expect(parsed.payload.agent?.totalWeightedTokens).toBe(61_000);
    expect(parsed.payload.agent?.points.at(-1)).toEqual({
      at: new Date(T0 + HOUR).toISOString(),
      weightedTokens: 61_000,
    });
  });

  test("leaves the agent out when the request names none, or one with no recorded spend", async () => {
    const { session, emitted } = createSession(await seededStore());
    await session.handleGetRequest({ type: "usage.history.get.request", requestId: "a" });
    await session.handleGetRequest({
      type: "usage.history.get.request",
      requestId: "b",
      agentId: "never-ran",
    });
    for (const message of emitted) {
      const parsed = UsageHistoryGetResponseSchema.parse(message);
      expect(parsed.payload.agent).toBeUndefined();
      expect(parsed.payload.accounts).toHaveLength(1);
    }
  });

  test("answers an empty history with an empty list rather than an error", async () => {
    const store = new UsageHistoryStore({ rootDir, logger: { warn: () => undefined } });
    const { session, emitted } = createSession(store);
    await session.handleGetRequest({ type: "usage.history.get.request", requestId: "r" });
    expect(UsageHistoryGetResponseSchema.parse(emitted[0]).payload.accounts).toEqual([]);
  });

  test("reports a failing store as an rpc_error the client can correlate", async () => {
    const store = new UsageHistoryStore({ rootDir, logger: { warn: () => undefined } });
    vi.spyOn(store, "readAccountSeries").mockRejectedValue(new Error("boom"));
    const { session, emitted } = createSession(store);
    await session.handleGetRequest({ type: "usage.history.get.request", requestId: "r-err" });
    expect(emitted[0]).toMatchObject({
      type: "rpc_error",
      payload: {
        requestId: "r-err",
        requestType: "usage.history.get.request",
        code: "usage_history_get_failed",
      },
    });
  });
});
