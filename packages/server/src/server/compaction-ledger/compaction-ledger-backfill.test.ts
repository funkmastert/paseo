import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  reconstructCompactionEpisodesFromLogLines,
  runCompactionLedgerBackfill,
} from "./compaction-ledger-backfill.js";
import { CompactionLedgerStore } from "./compaction-ledger-store.js";

const logger = { warn: () => undefined };

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function fullSequence(agentId: string, startAtMs: number): string[] {
  return [
    line({
      level: 30,
      time: startAtMs,
      msg: "Leader compaction started a step",
      agentId,
      step: "prepare",
      usedTokens: 612_000,
      attempt: 1,
      trigger: "line",
    }),
    line({
      level: 30,
      time: startAtMs + 100,
      msg: "Leader compaction finished a step",
      agentId,
      step: "prepare",
      next: "compact",
    }),
    line({
      level: 30,
      time: startAtMs + 200,
      msg: "Leader compaction started a step",
      agentId,
      step: "compact",
      usedTokens: 612_000,
      attempt: 1,
      trigger: "line",
    }),
    line({
      level: 30,
      time: startAtMs + 500,
      msg: "Leader compaction finished a step",
      agentId,
      step: "compact",
      next: "restore",
      compactedFromTokens: 612_000,
      compactedToTokens: 31_000,
    }),
    line({
      level: 30,
      time: startAtMs + 600,
      msg: "Leader compaction started a step",
      agentId,
      step: "restore",
      usedTokens: 31_000,
      attempt: 1,
      trigger: "line",
    }),
    line({
      level: 30,
      time: startAtMs + 700,
      msg: "Leader compaction finished a step",
      agentId,
      step: "restore",
      next: "settled",
    }),
  ];
}

describe("reconstructCompactionEpisodesFromLogLines", () => {
  test("a full prepare/compact/restore sequence produces one closed done row", () => {
    const rows = reconstructCompactionEpisodesFromLogLines(fullSequence("agent-a", 1000));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agentId: "agent-a",
      source: "backfill",
      trigger: "line",
      outcome: "done",
      costBasis: "unmeasured",
      costWeightedTokens: null,
      contextBeforeTokens: 612_000,
      contextAfterTokens: 31_000,
      startedAtMs: 1000,
      endedAtMs: 1700,
    });
    expect(rows[0]?.steps.map((step) => step.step)).toEqual(["prepare", "compact", "restore"]);
  });

  test("a gaveUp sequence produces one closed gaveUp row", () => {
    const lines = [
      line({
        time: 1000,
        msg: "Leader compaction started a step",
        agentId: "agent-a",
        step: "compact",
        usedTokens: 612_000,
        attempt: 2,
        trigger: "line",
      }),
      line({
        time: 1100,
        msg: "Leader compaction gave up",
        agentId: "agent-a",
        step: "compact",
        trigger: "line",
        reason: "the context was still 612K tokens afterwards",
        gaveUp: true,
        retryAt: null,
      }),
    ];

    const rows = reconstructCompactionEpisodesFromLogLines(lines);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: "agent-a", outcome: "gaveUp" });
  });

  test("interleaved lines for two agents produce two separate episodes", () => {
    const lines = [...fullSequence("agent-a", 1000), ...fullSequence("agent-b", 1050)];
    // Interleave by sorting on timestamp, the way a real log file would read.
    lines.sort((a, b) => (JSON.parse(a).time as number) - (JSON.parse(b).time as number));

    const rows = reconstructCompactionEpisodesFromLogLines(lines);

    expect(rows.map((row) => row.agentId).sort()).toEqual(["agent-a", "agent-b"]);
  });

  test("a malformed line is skipped without throwing; the rest of the file still backfills", () => {
    const lines = [...fullSequence("agent-a", 1000)];
    lines.splice(2, 0, "{ not json");

    expect(() => reconstructCompactionEpisodesFromLogLines(lines)).not.toThrow();
    const rows = reconstructCompactionEpisodesFromLogLines(lines);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("done");
  });

  test("an episode still open at end of file is dropped, not reported as closed", () => {
    const rows = reconstructCompactionEpisodesFromLogLines(
      fullSequence("agent-a", 1000).slice(0, 2),
    );
    expect(rows).toEqual([]);
  });
});

describe("runCompactionLedgerBackfill", () => {
  test("populates the store from a fixture log and marks the backfill done", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "compaction-ledger-backfill-run-"));
    try {
      const store = new CompactionLedgerStore({ rootDir, logger });
      await store.load();
      const lines = fullSequence("agent-a", 1000);

      await runCompactionLedgerBackfill({
        store,
        logPath: "/fake/daemon.log",
        readLines: async () => lines,
        logger,
      });

      expect(store.listEpisodes()).toHaveLength(1);
      expect(store.getBackfillDoneAtMs()).not.toBeNull();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("running the backfill twice performs no second write", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "compaction-ledger-backfill-twice-"));
    try {
      const store = new CompactionLedgerStore({ rootDir, logger });
      await store.load();
      let reads = 0;
      const options = {
        store,
        logPath: "/fake/daemon.log",
        readLines: async () => {
          reads += 1;
          return fullSequence("agent-a", 1000);
        },
        logger,
      };

      await runCompactionLedgerBackfill(options);
      await runCompactionLedgerBackfill(options);

      expect(reads).toBe(1);
      expect(store.listEpisodes()).toHaveLength(1);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("an empty log file still marks the backfill done", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "compaction-ledger-backfill-empty-"));
    try {
      const store = new CompactionLedgerStore({ rootDir, logger });
      await store.load();

      await runCompactionLedgerBackfill({
        store,
        logPath: "/fake/daemon.log",
        readLines: async () => [],
        logger,
      });

      expect(store.listEpisodes()).toEqual([]);
      expect(store.getBackfillDoneAtMs()).not.toBeNull();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("a readLines failure (e.g. missing log file) still marks the backfill done", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "compaction-ledger-backfill-missing-"));
    try {
      const store = new CompactionLedgerStore({ rootDir, logger });
      await store.load();

      await runCompactionLedgerBackfill({
        store,
        logPath: "/fake/daemon.log",
        readLines: async () => {
          throw new Error("ENOENT");
        },
        logger,
      });

      expect(store.getBackfillDoneAtMs()).not.toBeNull();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
