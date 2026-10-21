import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  arenaFromDecisionLine,
  buildPendingRowFromDecisionLine,
  loadClassifierDecisionsLedger,
  type PendingClassifierDecisionRow,
} from "./classifier-decisions-ledger";

function rankedRow(ref: string): PendingClassifierDecisionRow {
  return {
    id: `decision-${ref}`,
    at: "2026-10-20T00:00:00.000Z",
    role: "worker",
    taskClass: "standard",
    workKind: "coding",
    modelRan: ref,
    arena: {
      outcome: "ranked",
      applied: false,
      ref,
      tier: "mid",
      board: "agent/overall",
      publishDate: "2026-10-20",
      pick: { ref, rating: 0.1, ratingLower: 0.09, ratingUpper: 0.11, votes: 100, effort: "max", proxy: false },
    },
  };
}

function fallbackRow(id: string): PendingClassifierDecisionRow {
  return {
    id,
    at: "2026-10-20T00:00:00.000Z",
    role: "advisor",
    taskClass: "standard",
    workKind: null,
    modelRan: "claude-opus-5-5",
    arena: { outcome: "fallback", reason: "role-out-of-scope" },
  };
}

describe("classifier-decisions ledger", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "classifier-decisions-ledger-test-"));
    filePath = path.join(tempDir, "classifier", "decisions.json");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("a ranked and a fallback decision both resolve into valid rows, newest first", async () => {
    const ledger = await loadClassifierDecisionsLedger({ filePath });
    ledger.notePending("t1", rankedRow("claude-sonnet-5-5"));
    ledger.resolveAgent("t1", "agent-1", "fan-out");
    ledger.notePending("t2", fallbackRow("t2"));
    ledger.resolveAgent("t2", "agent-2", null);

    const rows = ledger.all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ agentId: "agent-2", backfilled: false, arena: { outcome: "fallback" } });
    expect(rows[1]).toMatchObject({ agentId: "agent-1", agentTitle: "fan-out", backfilled: false });
    await ledger.flush();
  });

  it("a token nothing is pending for is a no-op", async () => {
    const ledger = await loadClassifierDecisionsLedger({ filePath });
    ledger.resolveAgent("never-noted", "agent-1", null);
    expect(ledger.all()).toHaveLength(0);
  });

  it("caps at the row limit, dropping the oldest first", async () => {
    const ledger = await loadClassifierDecisionsLedger({ filePath });
    for (let i = 0; i < 5005; i++) {
      ledger.notePending(`t${i}`, rankedRow(`model-${i}`));
      ledger.resolveAgent(`t${i}`, `agent-${i}`, null);
    }
    const rows = ledger.all();
    expect(rows).toHaveLength(5000);
    expect(rows[0].agentId).toBe("agent-5004"); // newest first
    expect(rows[rows.length - 1].agentId).toBe("agent-5"); // the oldest 5 (0-4) were dropped
  });

  it("flushes to disk and round-trips through the schema on reload", async () => {
    const ledger = await loadClassifierDecisionsLedger({ filePath });
    ledger.notePending("t1", rankedRow("claude-sonnet-5-5"));
    ledger.resolveAgent("t1", "agent-1", "fan-out");
    await ledger.flush();

    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.rows).toHaveLength(1);

    const reloaded = await loadClassifierDecisionsLedger({ filePath });
    expect(reloaded.all()).toEqual(ledger.all());
    await reloaded.flush();
  });

  it("replaces rather than crashes on a file that will not parse", async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{ not json", "utf-8");

    const ledger = await loadClassifierDecisionsLedger({ filePath });
    expect(ledger.all()).toHaveLength(0);
    ledger.notePending("t1", rankedRow("claude-sonnet-5-5"));
    ledger.resolveAgent("t1", "agent-1", null);
    await ledger.flush();

    const raw = await fs.readFile(filePath, "utf-8");
    expect(JSON.parse(raw).rows).toHaveLength(1);
  });

  describe("appendBackfill", () => {
    it("runs once, gated by backfilledAt", async () => {
      const ledger = await loadClassifierDecisionsLedger({ filePath });
      expect(ledger.backfilledAt()).toBeUndefined();

      const backfilled = { ...rankedRow("claude-sonnet-5"), agentId: "old-agent", agentTitle: null, backfilled: true };
      await ledger.appendBackfill([backfilled]);
      expect(ledger.backfilledAt()).toBeDefined();
      expect(ledger.all()).toHaveLength(1);

      // A second call after `backfilledAt` is set is a no-op.
      await ledger.appendBackfill([{ ...backfilled, agentId: "another-agent" }]);
      expect(ledger.all()).toHaveLength(1);
      expect(ledger.all()[0].agentId).toBe("old-agent");
    });
  });
});

describe("arenaFromDecisionLine", () => {
  it("parses a ranked decision-log ranking object", () => {
    const parsed = arenaFromDecisionLine({
      outcome: "ranked",
      applied: true,
      ref: "claude-sonnet-5-5",
      tier: "mid",
      board: "agent/overall",
      publishDate: "2026-10-20",
      credit: "LMArena leaderboard dataset (CC-BY-4.0)",
      pick: { ref: "claude-sonnet-5-5", rating: 0.1, ratingLower: 0.09, ratingUpper: 0.11, votes: 100, effort: "max", proxy: false },
    });
    expect(parsed?.outcome).toBe("ranked");
  });

  it("parses a fallback decision-log ranking object", () => {
    expect(arenaFromDecisionLine({ outcome: "fallback", reason: "no-file", applied: false })).toEqual({
      outcome: "fallback",
      reason: "no-file",
    });
  });

  it("returns undefined for anything else, including a leader's absent ranking field", () => {
    expect(arenaFromDecisionLine(undefined)).toBeUndefined();
    expect(arenaFromDecisionLine({ outcome: "not-a-real-outcome" })).toBeUndefined();
  });
});

describe("buildPendingRowFromDecisionLine", () => {
  it("returns undefined when the decision line carries no ranking field at all (a leader create)", () => {
    const row = buildPendingRowFromDecisionLine("id1", "2026-10-20T00:00:00.000Z", { model: { ref: "claude-opus-5-5" } }, undefined);
    expect(row).toBeUndefined();
  });

  it("extracts role, task class, work kind and the model that ran from a ranked decision line", () => {
    const row = buildPendingRowFromDecisionLine(
      "id1",
      "2026-10-20T00:00:00.000Z",
      {
        role: { id: "worker", source: "declared" },
        taskClass: { value: "standard", source: "default" },
        model: {
          ref: "claude-sonnet-5-5",
          final: "claude-sonnet-5-5",
          ranking: {
            outcome: "ranked",
            applied: false,
            ref: "claude-sonnet-5-5",
            tier: "mid",
            board: "agent/overall",
            publishDate: "2026-10-20",
            pick: { ref: "claude-sonnet-5-5", rating: 0.1, ratingLower: 0.09, ratingUpper: 0.11, votes: 100, effort: "max", proxy: false },
          },
        },
      },
      "coding",
    );
    expect(row).toMatchObject({ role: "worker", taskClass: "standard", workKind: "coding", modelRan: "claude-sonnet-5-5" });
  });
});
