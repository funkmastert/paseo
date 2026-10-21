import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

  it("a flush failure (full disk, permissions) never throws and the row is retried on the next flush", async () => {
    let attempts = 0;
    const ledger = await loadClassifierDecisionsLedger({
      filePath,
      writeFile: async (targetPath, data) => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        }
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, data, "utf-8");
      },
    });
    ledger.notePending("t1", rankedRow("claude-sonnet-5-5"));
    ledger.resolveAgent("t1", "agent-1", "fan-out");

    await expect(ledger.flush()).resolves.toBeUndefined();
    expect(attempts).toBe(1);

    // The failed round stayed dirty, so a second flush retries rather than silently giving up.
    await expect(ledger.flush()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    const raw = await fs.readFile(filePath, "utf-8");
    expect(JSON.parse(raw).rows).toHaveLength(1);
  });

  it("quarantines (renames aside) and logs a file that will not parse as JSON, rather than silently replacing it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{ not json", "utf-8");

    const ledger = await loadClassifierDecisionsLedger({ filePath, now: () => 1234 });
    expect(ledger.all()).toHaveLength(0);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("did not parse as JSON"));

    const corruptRaw = await fs.readFile(`${filePath}.corrupt-1234`, "utf-8");
    expect(corruptRaw).toBe("{ not json");
    await expect(fs.readFile(filePath, "utf-8")).rejects.toThrow();

    ledger.notePending("t1", rankedRow("claude-sonnet-5-5"));
    ledger.resolveAgent("t1", "agent-1", null);
    await ledger.flush();
    expect(JSON.parse(await fs.readFile(filePath, "utf-8")).rows).toHaveLength(1);
    errors.mockRestore();
  });

  it("does not quarantine a missing file (ENOENT is a fresh install, not corruption)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const ledger = await loadClassifierDecisionsLedger({ filePath });

    expect(ledger.all()).toHaveLength(0);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("quarantines a read failure other than ENOENT (EACCES, EMFILE) instead of treating it like a fresh install", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const eaccesError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    let renamed: [string, string] | undefined;

    const ledger = await loadClassifierDecisionsLedger({
      filePath,
      now: () => 5678,
      readFile: async () => {
        throw eaccesError;
      },
      renameFile: async (from, to) => {
        renamed = [from, to];
      },
    });

    expect(ledger.all()).toHaveLength(0);
    expect(renamed).toEqual([filePath, `${filePath}.corrupt-5678`]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
    errors.mockRestore();
  });

  it("drops only a malformed row, keeping every row that still parses", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const goodRow = { ...rankedRow("claude-sonnet-5-5"), agentId: "agent-1", agentTitle: null, backfilled: false };
    await fs.writeFile(
      filePath,
      JSON.stringify({ v: 1, rows: [goodRow, { id: "broken", not: "a valid row" }] }),
      "utf-8",
    );

    const ledger = await loadClassifierDecisionsLedger({ filePath });

    expect(ledger.all()).toHaveLength(1);
    expect(ledger.all()[0].agentId).toBe("agent-1");
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("dropped 1 malformed row"));
    errors.mockRestore();
  });

  it("never overwrites a file from a newer, unrecognized version", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ v: 2, rows: [], somethingThisBuildDoesNotKnow: true }), "utf-8");

    const ledger = await loadClassifierDecisionsLedger({ filePath });
    expect(ledger.all()).toHaveLength(0);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("newer than this build understands"));

    ledger.notePending("t1", rankedRow("claude-sonnet-5-5"));
    ledger.resolveAgent("t1", "agent-1", null);
    await ledger.flush();

    // The v2 file on disk is untouched — not clobbered with a v1-shaped rewrite.
    const raw = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(raw).toEqual({ v: 2, rows: [], somethingThisBuildDoesNotKnow: true });
    errors.mockRestore();
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
