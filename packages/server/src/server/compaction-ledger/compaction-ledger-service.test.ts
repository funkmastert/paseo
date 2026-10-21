import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CompactionLedgerService } from "./compaction-ledger-service.js";
import { CompactionLedgerStore } from "./compaction-ledger-store.js";

const logger = { warn: () => undefined };
const roots: string[] = [];

function freshStore(): CompactionLedgerStore {
  const rootDir = mkdtempSync(join(tmpdir(), "compaction-ledger-service-"));
  roots.push(rootDir);
  return new CompactionLedgerStore({ rootDir, logger });
}

afterEach(() => {
  while (roots.length > 0) {
    const rootDir = roots.pop();
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  }
});

describe("CompactionLedgerService episode observer", () => {
  test("a full prepare/compact/restore cycle produces one measured, closed row", async () => {
    const store = freshStore();
    await store.load();
    const service = new CompactionLedgerService({ store });

    service.onStepStarted({
      agentId: "leader-1",
      agentTitle: "Ship the thing",
      step: "prepare",
      attempt: 1,
      trigger: { kind: "line" },
      usedTokens: 612_000,
      totalTokensAtStart: 1_000_000,
      atMs: 1000,
    });
    service.onStepFinished({
      agentId: "leader-1",
      step: "prepare",
      outcome: "completed",
      gaveUp: false,
      episodeEnded: null,
      compactedFromTokens: null,
      compactedToTokens: null,
      noteLength: 120,
      totalTokensAtStart: 1_000_000,
      totalTokensAtEnd: 1_000_050,
      atMs: 1100,
    });

    service.onStepStarted({
      agentId: "leader-1",
      agentTitle: "Ship the thing",
      step: "compact",
      attempt: 1,
      trigger: { kind: "line" },
      usedTokens: 612_000,
      totalTokensAtStart: 1_000_050,
      atMs: 1200,
    });
    service.onStepFinished({
      agentId: "leader-1",
      step: "compact",
      outcome: "completed",
      gaveUp: false,
      episodeEnded: null,
      compactedFromTokens: 612_000,
      compactedToTokens: 31_000,
      noteLength: 120,
      totalTokensAtStart: 1_000_050,
      totalTokensAtEnd: 1_000_150,
      atMs: 1500,
    });

    service.onStepStarted({
      agentId: "leader-1",
      agentTitle: "Ship the thing",
      step: "restore",
      attempt: 1,
      trigger: { kind: "line" },
      usedTokens: 31_000,
      totalTokensAtStart: 1_000_150,
      atMs: 1600,
    });
    service.onStepFinished({
      agentId: "leader-1",
      step: "restore",
      outcome: "completed",
      gaveUp: false,
      episodeEnded: "done",
      compactedFromTokens: 612_000,
      compactedToTokens: 31_000,
      noteLength: 120,
      totalTokensAtStart: 1_000_150,
      totalTokensAtEnd: 1_000_175,
      atMs: 1700,
    });

    const rows = service.list({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agentId: "leader-1",
      outcome: "done",
      costBasis: "measured",
      costWeightedTokens: 50 + 100 + 25,
      contextBeforeTokens: 612_000,
      contextAfterTokens: 31_000,
    });
  });

  test("a step with a missing totalTokens snapshot makes the closed episode unmeasured", async () => {
    const store = freshStore();
    await store.load();
    const service = new CompactionLedgerService({ store });

    service.onStepStarted({
      agentId: "leader-1",
      agentTitle: null,
      step: "prepare",
      attempt: 1,
      trigger: { kind: "line" },
      usedTokens: 612_000,
      totalTokensAtStart: undefined, // the daemon restarted mid-step; no snapshot landed
      atMs: 1000,
    });
    service.onStepFinished({
      agentId: "leader-1",
      step: "prepare",
      outcome: "completed",
      gaveUp: false,
      episodeEnded: "done",
      compactedFromTokens: 612_000,
      compactedToTokens: 31_000,
      noteLength: null,
      totalTokensAtStart: undefined,
      totalTokensAtEnd: 1_000_050,
      atMs: 1100,
    });

    const [row] = service.list({});
    expect(row?.costBasis).toBe("unmeasured");
    expect(row?.costWeightedTokens).toBeNull();
  });

  test("a gaveUp episode closes with outcome gaveUp and whatever costs were measured", async () => {
    const store = freshStore();
    await store.load();
    const service = new CompactionLedgerService({ store });

    service.onStepStarted({
      agentId: "leader-1",
      agentTitle: null,
      step: "compact",
      attempt: 2,
      trigger: { kind: "line" },
      usedTokens: 612_000,
      totalTokensAtStart: 2_000_000,
      atMs: 1000,
    });
    service.onStepFinished({
      agentId: "leader-1",
      step: "compact",
      outcome: "notCompacted",
      gaveUp: true,
      episodeEnded: "gaveUp",
      compactedFromTokens: null,
      compactedToTokens: null,
      noteLength: null,
      totalTokensAtStart: 2_000_000,
      totalTokensAtEnd: 2_000_300,
      atMs: 1100,
    });

    const [row] = service.list({});
    expect(row).toMatchObject({
      outcome: "gaveUp",
      costBasis: "measured",
      costWeightedTokens: 300,
    });
  });

  test("recordNativeCompaction writes an unmeasured, already-closed native-source row", async () => {
    const store = freshStore();
    await store.load();
    const service = new CompactionLedgerService({ store });

    service.recordNativeCompaction({
      agentId: "leader-1",
      agentTitle: "Ship the thing",
      trigger: "auto",
      preTokens: 400_000,
      postTokens: 20_000,
      atMs: 5000,
    });

    const [row] = service.list({});
    expect(row).toMatchObject({
      agentId: "leader-1",
      source: "native",
      trigger: "auto",
      costBasis: "unmeasured",
      costWeightedTokens: null,
      outcome: "done",
    });
  });

  test("requestsSincePaybackCountedThrough stops incrementing once the next episode opens", async () => {
    const store = freshStore();
    await store.load();
    let listener: ((agentId: string, tokens: number) => void) | null = null;
    const service = new CompactionLedgerService({
      store,
      subscribeTokenBurn: (fn) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    });

    service.recordNativeCompaction({
      agentId: "leader-1",
      agentTitle: null,
      trigger: "auto",
      preTokens: 400_000,
      postTokens: 20_000,
      atMs: 1000,
    });

    listener?.("leader-1", 999);
    listener?.("leader-1", 999);
    const afterTwoRequests = service.list({})[0];
    expect(afterTwoRequests?.requestsSincePaybackCountedThrough).toBe(2);
    expect(afterTwoRequests?.estimatedSavedWeightedTokens).toBe((400_000 - 20_000) * 2 * 0.1);

    // A second episode opens for the same agent; the first episode's window is now closed.
    service.onStepStarted({
      agentId: "leader-1",
      agentTitle: null,
      step: "prepare",
      attempt: 1,
      trigger: { kind: "line" },
      usedTokens: 450_000,
      totalTokensAtStart: 10_000,
      atMs: 2000,
    });
    listener?.("leader-1", 999);

    const firstEpisode = service.list({}).find((row) => row.source === "native");
    expect(firstEpisode?.requestsSincePaybackCountedThrough).toBe(2);
  });

  test("list filters by agentId", async () => {
    const store = freshStore();
    await store.load();
    const service = new CompactionLedgerService({ store });
    service.recordNativeCompaction({
      agentId: "leader-1",
      agentTitle: null,
      trigger: "auto",
      preTokens: 100,
      postTokens: 10,
      atMs: 1000,
    });
    service.recordNativeCompaction({
      agentId: "leader-2",
      agentTitle: null,
      trigger: "auto",
      preTokens: 100,
      postTokens: 10,
      atMs: 1000,
    });

    expect(service.list({ agentId: "leader-1" }).map((row) => row.agentId)).toEqual(["leader-1"]);
  });

  test("list filters by range today", async () => {
    const store = freshStore();
    await store.load();
    const dayMs = 24 * 60 * 60 * 1000;
    const nowMs = 10 * dayMs + 5000;
    const service = new CompactionLedgerService({ store, now: () => nowMs });
    service.recordNativeCompaction({
      agentId: "leader-1",
      agentTitle: null,
      trigger: "auto",
      preTokens: 100,
      postTokens: 10,
      atMs: 9 * dayMs, // yesterday
    });
    service.recordNativeCompaction({
      agentId: "leader-1",
      agentTitle: null,
      trigger: "auto",
      preTokens: 100,
      postTokens: 10,
      atMs: 10 * dayMs + 10, // today
    });

    expect(service.list({ range: "today" })).toHaveLength(1);
    expect(service.list({ range: "all" })).toHaveLength(2);
  });

  test("summary totals match a manual sum over the filtered set", async () => {
    const store = freshStore();
    await store.load();
    const service = new CompactionLedgerService({ store });
    service.recordNativeCompaction({
      agentId: "leader-1",
      agentTitle: null,
      trigger: "auto",
      preTokens: 100,
      postTokens: 10,
      atMs: 1000,
    });
    service.onStepStarted({
      agentId: "leader-2",
      agentTitle: null,
      step: "prepare",
      attempt: 1,
      trigger: { kind: "line" },
      usedTokens: 500_000,
      totalTokensAtStart: 10_000,
      atMs: 2000,
    });
    service.onStepFinished({
      agentId: "leader-2",
      step: "prepare",
      outcome: "completed",
      gaveUp: false,
      episodeEnded: "done",
      compactedFromTokens: 500_000,
      compactedToTokens: 20_000,
      noteLength: null,
      totalTokensAtStart: 10_000,
      totalTokensAtEnd: 10_200,
      atMs: 2100,
    });

    const summary = service.summary({});
    expect(summary.count).toBe(2);
    expect(summary.measuredCount).toBe(1);
    expect(summary.unmeasuredCount).toBe(1);
    expect(summary.totalCostWeightedTokens).toBe(200);
    expect(summary.averageCostWeightedTokens).toBe(200);
  });
});
