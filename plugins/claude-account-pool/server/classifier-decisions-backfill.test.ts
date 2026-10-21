import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runClassifierDecisionsBackfill, type ClassifierDecisionsAgentsApi } from "./classifier-decisions-backfill";
import { loadClassifierDecisionsLedger, type ClassifierDecisionsLedger } from "./classifier-decisions-ledger";

function agentEntry(
  id: string,
  overrides: { title?: string | null; labels?: Record<string, string> } = {},
) {
  return {
    agent: {
      id,
      title: overrides.title ?? `agent ${id}`,
      labels: overrides.labels ?? {
        "paseo.arena-pick": "v1;ref=claude-sonnet-5-5;tier=mid;board=agent/overall;date=2026-10-20;applied=0;proxy=0",
        "paseo.agent-role": "worker",
        "paseo.task-class": "standard",
        "paseo.work-kind": "coding",
      },
    },
  };
}

function fakeAgentsApi(pages: ReturnType<typeof agentEntry>[][]): ClassifierDecisionsAgentsApi {
  const list = vi.fn(async ({ page }: { page?: { cursor?: string } } = {}) => {
    const index = page?.cursor ? Number(page.cursor) : 0;
    const entries = pages[index] ?? [];
    const hasMore = index + 1 < pages.length;
    return { entries, pageInfo: { hasMore, nextCursor: hasMore ? String(index + 1) : null } };
  });
  return { agents: { list } };
}

describe("classifier-decisions backfill", () => {
  let tempDir: string;
  let ledger: ClassifierDecisionsLedger;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "classifier-decisions-backfill-test-"));
    ledger = await loadClassifierDecisionsLedger({ filePath: path.join(tempDir, "decisions.json") });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("backfills one row per agent carrying paseo.arena-pick, marked backfilled with no fallback reason", async () => {
    const paseo = fakeAgentsApi([[agentEntry("a1"), agentEntry("a2", { labels: {} })]]);

    const result = await runClassifierDecisionsBackfill(paseo, ledger);

    expect(result).toEqual({ ran: true, scanned: 2, backfilled: 1, skipped: 0 });
    const rows = ledger.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agentId: "a1",
      backfilled: true,
      role: "worker",
      taskClass: "standard",
      workKind: "coding",
      arena: { outcome: "ranked", ref: "claude-sonnet-5-5", tier: "mid", board: "agent/overall", applied: false },
    });
  });

  it("pages through every page, including archived agents (includeArchived: true is what the sweep asks for)", async () => {
    const paseo = fakeAgentsApi([[agentEntry("a1")], [agentEntry("a2")], [agentEntry("a3")]]);

    const result = await runClassifierDecisionsBackfill(paseo, ledger);

    expect(result).toMatchObject({ ran: true, scanned: 3, backfilled: 3 });
    expect(paseo.agents.list).toHaveBeenCalledWith(expect.objectContaining({ filter: { includeArchived: true } }));
  });

  it("counts a malformed paseo.arena-pick label as skipped rather than silently dropping it", async () => {
    const paseo = fakeAgentsApi([[agentEntry("a1", { labels: { "paseo.arena-pick": "not-a-valid-label" } })]]);

    const result = await runClassifierDecisionsBackfill(paseo, ledger);

    expect(result).toEqual({ ran: true, scanned: 1, backfilled: 0, skipped: 1 });
  });

  it("runs once: a second call after backfilledAt is set is a no-op and does not re-page", async () => {
    const paseo = fakeAgentsApi([[agentEntry("a1")]]);
    await runClassifierDecisionsBackfill(paseo, ledger);
    expect(ledger.all()).toHaveLength(1);

    const second = await runClassifierDecisionsBackfill(paseo, ledger);

    expect(second).toEqual({ ran: false, scanned: 0, backfilled: 0, skipped: 0 });
    expect(paseo.agents.list).toHaveBeenCalledTimes(1);
    expect(ledger.all()).toHaveLength(1);
  });
});
