import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { SessionOutboundMessage } from "../../messages.js";
import { CompactionLedgerService } from "../../compaction-ledger/compaction-ledger-service.js";
import { CompactionLedgerStore } from "../../compaction-ledger/compaction-ledger-store.js";
import { CompactionSession, createCompactionSession } from "./compaction-session.js";

function createSession(reader: ConstructorParameters<typeof CompactionSession>[0]["reader"]) {
  const emitted: SessionOutboundMessage[] = [];
  const session = new CompactionSession({
    host: { emit: (message) => void emitted.push(message) },
    reader,
  });
  return { session, emitted };
}

async function seededService(rootDir: string): Promise<CompactionLedgerService> {
  const store = new CompactionLedgerStore({ rootDir, logger: { warn: vi.fn() } });
  await store.load();
  const service = new CompactionLedgerService({ store });
  service.recordNativeCompaction({
    agentId: "leader-1",
    agentTitle: "Ship the thing",
    trigger: "auto",
    preTokens: 400_000,
    postTokens: 20_000,
    atMs: 1000,
  });
  service.recordNativeCompaction({
    agentId: "leader-2",
    agentTitle: null,
    trigger: "manual",
    preTokens: 300_000,
    postTokens: 10_000,
    atMs: 2000,
  });
  return service;
}

describe("CompactionSession", () => {
  test("answers compaction.episodes.list with every episode, newest first, echoing the request id", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-session-"));
    try {
      const { session, emitted } = createSession(await seededService(rootDir));

      await session.handleListRequest({
        type: "compaction.episodes.list.request",
        requestId: "req-1",
        range: "all",
      });

      expect(emitted).toHaveLength(1);
      const payload = (
        emitted[0] as {
          payload: {
            requestId: string;
            episodes: Array<{ agentId: string }>;
            nextCursor: string | null;
          };
        }
      ).payload;
      expect(payload.requestId).toBe("req-1");
      expect(payload.episodes.map((episode) => episode.agentId)).toEqual(["leader-2", "leader-1"]);
      expect(payload.nextCursor).toBeNull();
      // The store's own payback bookkeeping stays off the wire.
      expect(
        payload.episodes.every((episode) => !("requestsSincePaybackCountedThrough" in episode)),
      ).toBe(true);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  test("answers compaction.episodes.list filtered by agentId", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-session-filter-"));
    try {
      const { session, emitted } = createSession(await seededService(rootDir));

      await session.handleListRequest({
        type: "compaction.episodes.list.request",
        requestId: "req-1",
        range: "all",
        agentId: "leader-1",
      });

      const payload = (emitted[0] as { payload: { episodes: Array<{ agentId: string }> } }).payload;
      expect(payload.episodes.map((episode) => episode.agentId)).toEqual(["leader-1"]);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  test("answers compaction.episodes.summary with totals over the filtered set", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-session-summary-"));
    try {
      const { session, emitted } = createSession(await seededService(rootDir));

      await session.handleSummaryRequest({
        type: "compaction.episodes.summary.request",
        requestId: "req-1",
        range: "all",
      });

      expect(emitted).toHaveLength(1);
      const payload = (emitted[0] as { payload: { requestId: string; summary: { count: number } } })
        .payload;
      expect(payload.requestId).toBe("req-1");
      expect(payload.summary.count).toBe(2);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  test("rejects a range the ledger does not serve", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-session-bad-range-"));
    try {
      const { session } = createSession(await seededService(rootDir));

      await expect(
        session.handleListRequest({
          type: "compaction.episodes.list.request",
          requestId: "req-1",
          range: "90d",
        }),
      ).rejects.toThrow(/unknown range/);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  test("is absent when the host has no compaction ledger service", () => {
    expect(
      createCompactionSession({
        host: { emit: vi.fn() },
        reader: undefined,
      }),
    ).toBeNull();
  });
});
