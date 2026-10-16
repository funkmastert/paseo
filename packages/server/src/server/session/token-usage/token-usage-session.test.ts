import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TokenUsageGetBreakdownRequestSchema,
  TokenUsageGetBreakdownResponseSchema,
} from "@getpaseo/protocol/token-usage/rpc-schemas";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionOutboundMessage } from "../../messages.js";
import { TokenUsageService } from "../../token-usage/token-usage-service.js";
import { TokenUsageStore } from "../../token-usage/token-usage-store.js";
import { TokenUsageSession, createTokenUsageSession } from "./token-usage-session.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-01T13:30:00.000Z");

let rootDir: string;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "token-usage-session-"));
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

async function seededService(options?: { enabled?: boolean }): Promise<TokenUsageService> {
  const store = new TokenUsageStore({ rootDir, logger: { warn: vi.fn() } });
  await store.load();
  for (const [ageMs, role] of [
    [HOUR, "leader"],
    [2 * DAY, "worker"],
    [20 * DAY, "outside"],
  ] as const) {
    store.add({
      atMs: NOW - ageMs,
      provider: "claude",
      model: "claude-opus-5-5",
      role,
      input: 10,
      cacheWrite: 100,
      cacheRead: 1_000,
      output: 20,
      responses: 1,
    });
  }
  return new TokenUsageService({
    rootDir,
    roots: [],
    listAgentRecords: async () => [],
    isEnabled: () => options?.enabled ?? true,
    logger: { warn: vi.fn(), info: vi.fn() },
    now: () => NOW,
    store,
  });
}

function rolesOf(payload: { rows: Array<{ role: string }> }): string[] {
  return payload.rows.map((row) => row.role);
}

function createSession(reader: ConstructorParameters<typeof TokenUsageSession>[0]["reader"]) {
  const emitted: SessionOutboundMessage[] = [];
  const logger = { error: vi.fn() };
  const session = new TokenUsageSession({
    host: { emit: (message) => void emitted.push(message) },
    reader,
    logger,
    now: () => NOW,
  });
  return { session, emitted, logger };
}

describe("TokenUsageSession", () => {
  test("answers each range with that range's rows and the coverage, echoing the request id", async () => {
    const { session, emitted } = createSession(await seededService());

    for (const range of ["24h", "7d", "30d"] as const) {
      await session.handleGetBreakdownRequest({
        type: "usage.tokens.get_breakdown.request",
        requestId: `req-${range}`,
        range,
      });
    }

    expect(emitted).toHaveLength(3);
    const payloads = emitted.map(
      (message) => TokenUsageGetBreakdownResponseSchema.parse(message).payload,
    );
    expect(payloads.map((payload) => payload.requestId)).toEqual(["req-24h", "req-7d", "req-30d"]);
    expect(payloads.map(rolesOf)).toEqual([
      ["leader"],
      ["leader", "worker"],
      ["leader", "worker", "outside"],
    ]);
    expect(payloads[0]).toMatchObject({
      generatedAt: new Date(NOW).toISOString(),
      range: "24h",
      rangeStartMs: Date.parse("2026-09-30T13:00:00.000Z"),
      coverage: { enabled: true, backfill: { state: "pending" } },
    });
    expect(payloads[0]?.error).toBeUndefined();
  });

  test("carries enabled: false and no rows while the config turns the feature off", async () => {
    const { session, emitted } = createSession(await seededService({ enabled: false }));

    await session.handleGetBreakdownRequest({
      type: "usage.tokens.get_breakdown.request",
      requestId: "req-off",
      range: "7d",
    });

    const payload = TokenUsageGetBreakdownResponseSchema.parse(emitted[0]).payload;
    expect(payload.rows).toEqual([]);
    expect(payload.coverage).toEqual({
      enabled: false,
      recordingSinceMs: null,
      backfill: { state: "off", filesDone: 0, filesTotal: 0 },
    });
  });

  test("answers a failed read with an error in a schema-valid payload", async () => {
    const { session, emitted, logger } = createSession({
      getBreakdown: async () => {
        throw new Error("disk on fire");
      },
    });

    await session.handleGetBreakdownRequest({
      type: "usage.tokens.get_breakdown.request",
      requestId: "req-err",
      range: "30d",
    });

    const payload = TokenUsageGetBreakdownResponseSchema.parse(emitted[0]).payload;
    expect(payload).toMatchObject({
      requestId: "req-err",
      range: "30d",
      rows: [],
      error: "Failed to read token usage: disk on fire",
    });
    expect(logger.error).toHaveBeenCalledOnce();
  });

  test("the request schema rejects a range the daemon does not serve", () => {
    const result = TokenUsageGetBreakdownRequestSchema.safeParse({
      type: "usage.tokens.get_breakdown.request",
      requestId: "req-bad",
      range: "1y",
    });

    expect(result.success).toBe(false);
  });

  test("is absent when the host has no token usage service", () => {
    expect(
      createTokenUsageSession({
        host: { emit: vi.fn() },
        reader: undefined,
        logger: { error: vi.fn() },
      }),
    ).toBeNull();
  });
});
