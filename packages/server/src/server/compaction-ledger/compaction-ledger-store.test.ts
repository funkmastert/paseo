import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type CompactionEpisodeRow, CompactionLedgerStore } from "./compaction-ledger-store.js";

const logger = { warn: () => undefined };

function row(overrides: Partial<CompactionEpisodeRow> = {}): CompactionEpisodeRow {
  return {
    id: "leader-1:1000",
    agentId: "leader-1",
    agentTitle: "Ship the thing",
    source: "monitor",
    trigger: "line",
    triggerReason: null,
    startedAtMs: 1000,
    endedAtMs: 2000,
    steps: [
      {
        step: "prepare",
        startedAtMs: 1000,
        endedAtMs: 1100,
        outcome: "completed",
        costWeightedTokens: 50,
      },
      {
        step: "compact",
        startedAtMs: 1100,
        endedAtMs: 1500,
        outcome: "completed",
        costWeightedTokens: 100,
      },
      {
        step: "restore",
        startedAtMs: 1500,
        endedAtMs: 2000,
        outcome: "completed",
        costWeightedTokens: 25,
      },
    ],
    contextBeforeTokens: 612_000,
    contextAfterTokens: 31_000,
    outcome: "done",
    noteLength: 120,
    promptsCarried: null,
    quietGate: null,
    deferrals: null,
    costWeightedTokens: 175,
    costBasis: "measured",
    estimatedSavedWeightedTokens: null,
    requestsSincePaybackCountedThrough: null,
    ...overrides,
  };
}

describe("CompactionLedgerStore", () => {
  test("round-trips every field of a row through a flush and a fresh load", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "compaction-ledger-roundtrip-"));
    try {
      const store = new CompactionLedgerStore({ rootDir, logger });
      await store.load();
      store.upsertEpisode(row());
      await store.flush();

      const reloaded = new CompactionLedgerStore({ rootDir, logger });
      await reloaded.load();
      expect(reloaded.getEpisode("leader-1:1000")).toEqual(row());
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("a corrupt state file is replaced; the store starts empty instead of throwing", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "compaction-ledger-corrupt-"));
    try {
      writeFileSync(join(rootDir, "state.json"), "{ not json");
      const store = new CompactionLedgerStore({ rootDir, logger });
      await expect(store.load()).resolves.toBeUndefined();
      expect(store.listEpisodes()).toEqual([]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("an unreadable state file is set aside before the next flush replaces it", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "compaction-ledger-set-aside-"));
    try {
      writeFileSync(join(rootDir, "state.json"), "{ not json");
      const store = new CompactionLedgerStore({ rootDir, logger });
      await store.load();
      store.upsertEpisode(row());
      await store.flush();

      const corrupt = readdirSync(rootDir).filter((name) => name.startsWith("state.json.corrupt-"));
      expect(corrupt).toHaveLength(1);
      expect(readFileSync(join(rootDir, corrupt[0] ?? ""), "utf8")).toBe("{ not json");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("a state file that cannot be read (not missing) is never overwritten", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "compaction-ledger-unreadable-"));
    const statePath = join(rootDir, "state.json");
    try {
      const original = JSON.stringify({ v: 1, backfillDoneAtMs: 5, rows: [row()] });
      writeFileSync(statePath, original);
      chmodSync(statePath, 0o000);
      const store = new CompactionLedgerStore({ rootDir, logger });
      await store.load();
      store.upsertEpisode(row({ id: "leader-2:3000", agentId: "leader-2", startedAtMs: 3000 }));
      await store.flush();

      chmodSync(statePath, 0o600);
      expect(readFileSync(statePath, "utf8")).toBe(original);
    } finally {
      chmodSync(statePath, 0o600);
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("a flush before the load has finished writes nothing over the file", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "compaction-ledger-early-flush-"));
    const statePath = join(rootDir, "state.json");
    try {
      const original = JSON.stringify({ v: 1, backfillDoneAtMs: 5, rows: [row()] });
      writeFileSync(statePath, original);
      const store = new CompactionLedgerStore({ rootDir, logger });
      store.upsertEpisode(row({ id: "leader-2:3000", agentId: "leader-2", startedAtMs: 3000 }));
      await store.flush();
      expect(readFileSync(statePath, "utf8")).toBe(original);

      await store.load();
      await store.flush();
      const reloaded = new CompactionLedgerStore({ rootDir, logger });
      await reloaded.load();
      expect(
        reloaded
          .listEpisodes()
          .map((entry) => entry.id)
          .sort(),
      ).toEqual(["leader-1:1000", "leader-2:3000"]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("rows written before the quiet-gate fields existed still load", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "compaction-ledger-older-row-"));
    try {
      const { promptsCarried: _prompts, quietGate: _gate, deferrals: _deferrals, ...older } = row();
      writeFileSync(
        join(rootDir, "state.json"),
        JSON.stringify({ v: 1, backfillDoneAtMs: null, rows: [older] }),
      );
      const store = new CompactionLedgerStore({ rootDir, logger });
      await store.load();
      expect(store.getEpisode("leader-1:1000")).toEqual(row());
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("round-trips the deferrals an episode took", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "compaction-ledger-deferrals-"));
    try {
      const store = new CompactionLedgerStore({ rootDir, logger });
      await store.load();
      store.upsertEpisode(row({ deferrals: { count: 2, totalMs: 20 * 60_000 } }));
      await store.flush();

      const reloaded = new CompactionLedgerStore({ rootDir, logger });
      await reloaded.load();
      expect(reloaded.getEpisode("leader-1:1000")?.deferrals).toEqual({
        count: 2,
        totalMs: 20 * 60_000,
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("round-trips the quiet-gate hold, carried prompts and a shared step", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "compaction-ledger-quiet-gate-"));
    try {
      const store = new CompactionLedgerStore({ rootDir, logger });
      await store.load();
      const withGate = row({
        quietGate: { heldFromMs: 400, heldUntilMs: 1000, heldMs: 600 },
        promptsCarried: [{ atMs: 900, text: "also fix the login bug" }],
        steps: [
          {
            step: "prepare",
            startedAtMs: 1000,
            endedAtMs: 1100,
            outcome: "completed",
            costWeightedTokens: null,
            steeredIn: 1,
          },
        ],
      });
      store.upsertEpisode(withGate);
      await store.flush();

      const reloaded = new CompactionLedgerStore({ rootDir, logger });
      await reloaded.load();
      expect(reloaded.getEpisode("leader-1:1000")).toEqual(withGate);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("row count over the bound evicts the oldest row, not an arbitrary one", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "compaction-ledger-bound-"));
    try {
      const store = new CompactionLedgerStore({ rootDir, logger, limits: { maxRows: 2 } });
      await store.load();
      store.upsertEpisode(row({ id: "a", startedAtMs: 1000 }));
      store.upsertEpisode(row({ id: "b", startedAtMs: 2000 }));
      store.upsertEpisode(row({ id: "c", startedAtMs: 3000 }));

      const ids = store.listEpisodes().map((entry) => entry.id);
      expect(ids.sort()).toEqual(["b", "c"]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("a row older than the retention cutoff is pruned on the next write", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "compaction-ledger-retention-"));
    try {
      const retentionDays = 1;
      const dayMs = 24 * 60 * 60 * 1000;
      const store = new CompactionLedgerStore({ rootDir, logger, limits: { retentionDays } });
      await store.load();
      const nowMs = 10 * dayMs;
      store.upsertEpisode(row({ id: "old", startedAtMs: nowMs - 2 * dayMs }));
      store.upsertEpisode(row({ id: "fresh", startedAtMs: nowMs - 1000 }));

      store.prune(nowMs);

      expect(store.listEpisodes().map((entry) => entry.id)).toEqual(["fresh"]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("markBackfillDone is idempotent", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "compaction-ledger-backfill-marker-"));
    try {
      const store = new CompactionLedgerStore({ rootDir, logger });
      await store.load();
      expect(store.getBackfillDoneAtMs()).toBeNull();

      store.markBackfillDone(5000);
      expect(store.getBackfillDoneAtMs()).toBe(5000);

      store.markBackfillDone(9999);
      expect(store.getBackfillDoneAtMs()).toBe(5000);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("concurrent flushes serialize instead of interleaving into a corrupt file", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "compaction-ledger-concurrent-"));
    try {
      const store = new CompactionLedgerStore({ rootDir, logger });
      await store.load();
      store.upsertEpisode(row({ id: "a" }));
      const first = store.flush();
      store.upsertEpisode(row({ id: "b" }));
      const second = store.flush();
      await Promise.all([first, second]);

      const reloaded = new CompactionLedgerStore({ rootDir, logger });
      await reloaded.load();
      expect(
        reloaded
          .listEpisodes()
          .map((entry) => entry.id)
          .sort(),
      ).toEqual(["a", "b"]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
