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
      totalTokensAtStart: 1_000_000,
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
      totalTokensAtStart: 1_000_000,
      totalTokensAtEnd: undefined, // the agent left the list before the end snapshot
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
    const burn: { listener: ((agentId: string, tokens: number) => void) | null } = {
      listener: null,
    };
    const service = new CompactionLedgerService({
      store,
      subscribeTokenBurn: (fn) => {
        burn.listener = fn;
        return () => {
          burn.listener = null;
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

    burn.listener?.("leader-1", 999);
    burn.listener?.("leader-1", 999);
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
    burn.listener?.("leader-1", 999);

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

  test("today starts at the host's local midnight, not UTC midnight", async () => {
    const store = freshStore();
    await store.load();
    const nowMs = new Date(2026, 9, 21, 9, 0).getTime();
    const service = new CompactionLedgerService({ store, now: () => nowMs });
    for (const atMs of [
      new Date(2026, 9, 20, 23, 30).getTime(), // last night, local
      new Date(2026, 9, 21, 0, 15).getTime(), // just after local midnight
    ]) {
      service.recordNativeCompaction({
        agentId: "leader-1",
        agentTitle: null,
        trigger: "auto",
        preTokens: 100,
        postTokens: 10,
        atMs,
      });
    }

    expect(service.list({ range: "today" }).map((row) => row.startedAtMs)).toEqual([
      new Date(2026, 9, 21, 0, 15).getTime(),
    ]);
    expect(service.list({ range: "all" })).toHaveLength(2);
  });

  test("7d is today plus the six local days before it, as the JEV dashboard counts it", async () => {
    const store = freshStore();
    await store.load();
    const nowMs = new Date(2026, 9, 21, 9, 0).getTime();
    const service = new CompactionLedgerService({ store, now: () => nowMs });
    for (const atMs of [
      new Date(2026, 9, 14, 23, 0).getTime(), // seven days back: out
      new Date(2026, 9, 15, 0, 30).getTime(), // six days back: in
    ]) {
      service.recordNativeCompaction({
        agentId: "leader-1",
        agentTitle: null,
        trigger: "auto",
        preTokens: 100,
        postTokens: 10,
        atMs,
      });
    }

    expect(service.list({ range: "7d" }).map((row) => row.startedAtMs)).toEqual([
      new Date(2026, 9, 15, 0, 30).getTime(),
    ]);
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

  test("page() returns pages with no overlap and no gap across a cursor", async () => {
    const store = freshStore();
    await store.load();
    const service = new CompactionLedgerService({ store });
    for (let i = 0; i < 5; i += 1) {
      service.recordNativeCompaction({
        agentId: "leader-1",
        agentTitle: null,
        trigger: "auto",
        preTokens: 100,
        postTokens: 10,
        atMs: 1000 + i * 100,
      });
    }

    const firstPage = service.page({ limit: 2 });
    expect(firstPage.episodes.map((row) => row.startedAtMs)).toEqual([1400, 1300]);
    expect(firstPage.nextCursor).toBe("1300");

    const secondPage = service.page({ limit: 2, cursor: firstPage.nextCursor ?? undefined });
    expect(secondPage.episodes.map((row) => row.startedAtMs)).toEqual([1200, 1100]);
    expect(secondPage.nextCursor).toBe("1100");

    const thirdPage = service.page({ limit: 2, cursor: secondPage.nextCursor ?? undefined });
    expect(thirdPage.episodes.map((row) => row.startedAtMs)).toEqual([1000]);
    expect(thirdPage.nextCursor).toBeNull();
  });
});

function startPrepare(
  service: CompactionLedgerService,
  overrides: Partial<Parameters<CompactionLedgerService["onStepStarted"]>[0]> = {},
): void {
  service.onStepStarted({
    agentId: "leader-1",
    agentTitle: "Ship the thing",
    step: "prepare",
    attempt: 1,
    trigger: { kind: "line" },
    usedTokens: 612_000,
    totalTokensAtStart: 1_000_000,
    atMs: 1000,
    ...overrides,
  });
}

function finishStep(
  service: CompactionLedgerService,
  overrides: Partial<Parameters<CompactionLedgerService["onStepFinished"]>[0]> = {},
): void {
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
    ...overrides,
  });
}

describe("CompactionLedgerService: episodes that stop early, shared steps", () => {
  test("a row left open by a previous daemon is closed as interrupted once the store loads", async () => {
    const first = freshStore();
    await first.load();
    const before = new CompactionLedgerService({ store: first });
    startPrepare(before);
    finishStep(before, { atMs: 1100 });
    await first.flush();

    // The daemon restarted mid-episode: a new store and service over the same directory.
    const store = new CompactionLedgerStore({ rootDir: roots.at(-1) ?? "", logger });
    await store.load();
    const service = new CompactionLedgerService({ store });
    service.reconcileAfterLoad();

    const [row] = service.list({});
    expect(row).toMatchObject({
      outcome: "interrupted",
      endedAtMs: 1100,
      costBasis: "measured",
      costWeightedTokens: 50,
    });
  });

  test("a step still running when the daemon stopped makes the interrupted episode unmeasured", async () => {
    const store = freshStore();
    await store.load();
    const before = new CompactionLedgerService({ store });
    startPrepare(before);

    const service = new CompactionLedgerService({ store });
    service.reconcileAfterLoad();

    const [row] = service.list({});
    expect(row).toMatchObject({
      outcome: "interrupted",
      endedAtMs: 1000,
      costBasis: "unmeasured",
      costWeightedTokens: null,
    });
  });

  test("payback keeps counting for an agent's newest closed episode after a restart", async () => {
    const store = freshStore();
    await store.load();
    const before = new CompactionLedgerService({ store });
    startPrepare(before);
    finishStep(before, {
      episodeEnded: "done",
      compactedFromTokens: 400_000,
      compactedToTokens: 20_000,
    });

    const burn: { listener: ((agentId: string, tokens: number) => void) | null } = {
      listener: null,
    };
    const service = new CompactionLedgerService({
      store,
      subscribeTokenBurn: (fn) => {
        burn.listener = fn;
        return () => undefined;
      },
    });
    service.reconcileAfterLoad();
    burn.listener?.("leader-1", 999);

    expect(service.list({})[0]?.estimatedSavedWeightedTokens).toBe((400_000 - 20_000) * 0.1);
  });

  test("an abandoned episode is closed as interrupted, keeping the cost of the steps that ran", async () => {
    const store = freshStore();
    await store.load();
    const service = new CompactionLedgerService({ store });
    startPrepare(service);
    finishStep(service, { outcome: "canceled" });

    service.onEpisodeAbandoned({ agentId: "leader-1", atMs: 5000 });

    const [row] = service.list({});
    expect(row).toMatchObject({ outcome: "interrupted", endedAtMs: 5000 });
    expect(row?.costWeightedTokens).toBe(50);
  });

  test("a fresh prepare never joins a stale open episode: the stale one closes first", async () => {
    const store = freshStore();
    await store.load();
    const service = new CompactionLedgerService({ store });
    startPrepare(service, { atMs: 1000 });
    finishStep(service, { outcome: "canceled", atMs: 1100 });

    startPrepare(service, { atMs: 9_000_000, totalTokensAtStart: 2_000_000 });

    const rows = service.list({});
    expect(rows.map((row) => [row.startedAtMs, row.outcome, row.steps.length])).toEqual([
      [9_000_000, "unknown", 1],
      [1000, "interrupted", 1],
    ]);
  });

  test("a step another message was steered into is not measured, and says so", async () => {
    const store = freshStore();
    await store.load();
    const service = new CompactionLedgerService({ store });
    startPrepare(service);
    finishStep(service, { steeredIn: 2, totalTokensAtEnd: 1_090_000, episodeEnded: "done" });

    const [row] = service.list({});
    expect(row?.steps[0]).toMatchObject({ costWeightedTokens: null, steeredIn: 2 });
    expect(row?.costBasis).toBe("unmeasured");
    expect(row?.costWeightedTokens).toBeNull();
  });
});

describe("CompactionLedgerService: quiet gate and carried prompts", () => {
  test("the quiet-gate hold lands on the row with its duration", async () => {
    const store = freshStore();
    await store.load();
    const service = new CompactionLedgerService({ store });
    startPrepare(service, { quietGate: { heldFromMs: 400_000, heldUntilMs: 1_000_000 } });

    expect(service.list({})[0]?.quietGate).toEqual({
      heldFromMs: 400_000,
      heldUntilMs: 1_000_000,
      heldMs: 600_000,
    });
  });

  test("carried prompts land on the row, latest list wins, and a long one is cut", async () => {
    const store = freshStore();
    await store.load();
    const service = new CompactionLedgerService({ store });
    startPrepare(service, { carriedPrompts: [{ atMs: 900, text: "also fix the login bug" }] });
    finishStep(service, {
      carriedPrompts: [
        { atMs: 900, text: "also fix the login bug" },
        { atMs: 1050, text: "x".repeat(5_000) },
      ],
    });

    const prompts = service.list({})[0]?.promptsCarried ?? [];
    expect(prompts.map((prompt) => prompt.atMs)).toEqual([900, 1050]);
    expect(prompts[0]?.text).toBe("also fix the login bug");
    expect(prompts[1]?.text.length).toBeLessThan(2_100);
    expect(prompts[1]?.text.endsWith("…")).toBe(true);
  });

  test("an episode with no carried prompts stores null, not an empty list", async () => {
    const store = freshStore();
    await store.load();
    const service = new CompactionLedgerService({ store });
    startPrepare(service, { carriedPrompts: [] });

    expect(service.list({})[0]?.promptsCarried).toBeNull();
  });
});
