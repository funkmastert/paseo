import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runClassifierDecisionsBackfill, type ClassifierDecisionsAgentsApi } from "./classifier-decisions-backfill";
import { loadClassifierDecisionsLedger, type ClassifierDecisionsLedger } from "./classifier-decisions-ledger";

function agentEntry(
  id: string,
  overrides: { title?: string | null; labels?: Record<string, string>; createdAt?: string } = {},
) {
  return {
    agent: {
      id,
      title: overrides.title ?? `agent ${id}`,
      status: "idle" as const,
      createdAt: overrides.createdAt ?? "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
      labels: overrides.labels ?? {
        "paseo.arena-pick": "v1;ref=claude-sonnet-5-5;tier=mid;board=agent/overall;date=2026-10-20;applied=0;proxy=0",
        "paseo.agent-role": "worker",
        "paseo.task-class": "standard",
        "paseo.work-kind": "coding",
      },
    },
  };
}

function fakeAgentsApi(
  pages: ReturnType<typeof agentEntry>[][],
  options: { failOnPage?: number } = {},
): ClassifierDecisionsAgentsApi {
  const list = vi.fn(async ({ page }: { page?: { cursor?: string } } = {}) => {
    const index = page?.cursor ? Number(page.cursor) : 0;
    if (options.failOnPage === index) {
      throw new Error(`page ${index} failed`);
    }
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

    expect(result).toEqual({ ran: true, complete: true, scanned: 2, backfilled: 1, skipped: 0 });
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

  it("stamps a backfilled row with the agent's createdAt, not the sweep time", async () => {
    const paseo = fakeAgentsApi([[agentEntry("a1", { createdAt: "2026-09-01T00:00:00.000Z" })]]);

    await runClassifierDecisionsBackfill(paseo, ledger);

    expect(ledger.all()[0].at).toBe("2026-09-01T00:00:00.000Z");
  });

  it("skips a failover successor (carries handoff-from) so one decision is not counted twice", async () => {
    const predecessor = agentEntry("a1");
    const successor = agentEntry("a2", {
      labels: { ...predecessor.agent.labels, "handoff-from": "a1" },
    });
    const paseo = fakeAgentsApi([[predecessor, successor]]);

    const result = await runClassifierDecisionsBackfill(paseo, ledger);

    expect(result).toMatchObject({ scanned: 2, backfilled: 1 });
    expect(ledger.all().map((row) => row.agentId)).toEqual(["a1"]);
  });

  it("pages through every page, including archived agents (includeArchived: true is what the sweep asks for)", async () => {
    const paseo = fakeAgentsApi([[agentEntry("a1")], [agentEntry("a2")], [agentEntry("a3")]]);

    const result = await runClassifierDecisionsBackfill(paseo, ledger);

    expect(result).toMatchObject({ ran: true, complete: true, scanned: 3, backfilled: 3 });
    expect(paseo.agents.list).toHaveBeenCalledWith(expect.objectContaining({ filter: { includeArchived: true } }));
  });

  it("counts a malformed paseo.arena-pick label as skipped rather than silently dropping it", async () => {
    const paseo = fakeAgentsApi([[agentEntry("a1", { labels: { "paseo.arena-pick": "not-a-valid-label" } })]]);

    const result = await runClassifierDecisionsBackfill(paseo, ledger);

    expect(result).toEqual({ ran: true, complete: true, scanned: 1, backfilled: 0, skipped: 1 });
  });

  it("runs once: a second call after backfilledAt is set is a no-op and does not re-page", async () => {
    const paseo = fakeAgentsApi([[agentEntry("a1")]]);
    await runClassifierDecisionsBackfill(paseo, ledger);
    expect(ledger.all()).toHaveLength(1);

    const second = await runClassifierDecisionsBackfill(paseo, ledger);

    expect(second).toEqual({ ran: false, complete: true, scanned: 0, backfilled: 0, skipped: 0 });
    expect(paseo.agents.list).toHaveBeenCalledTimes(1);
    expect(ledger.all()).toHaveLength(1);
  });

  it("a page that rejects leaves backfilledAt unset and writes no rows, instead of a partial success", async () => {
    const paseo = fakeAgentsApi([[agentEntry("a1")], [agentEntry("a2")]], { failOnPage: 1 });

    const result = await runClassifierDecisionsBackfill(paseo, ledger);

    expect(result).toEqual({ ran: false, complete: false, scanned: 1, backfilled: 0, skipped: 0 });
    expect(ledger.all()).toHaveLength(0);
    expect(ledger.backfilledAt()).toBeUndefined();

    // The next plugin start retries rather than treating the failed sweep as done.
    const retry = await runClassifierDecisionsBackfill(fakeAgentsApi([[agentEntry("a1")], [agentEntry("a2")]]), ledger);
    expect(retry).toMatchObject({ ran: true, complete: true, backfilled: 2 });
  });

  it("a sweep that never ends (hasMore stays true past the page cap) is a failure, not a partial success", async () => {
    const list = vi.fn(async () => ({
      entries: [agentEntry("a1").agent].map((agent) => ({ agent })),
      pageInfo: { hasMore: true, nextCursor: "next" },
    }));
    const paseo: ClassifierDecisionsAgentsApi = { agents: { list } };

    const result = await runClassifierDecisionsBackfill(paseo, ledger);

    expect(result.complete).toBe(false);
    expect(result.ran).toBe(false);
    expect(list).toHaveBeenCalledTimes(25); // MAX_PAGES
    expect(ledger.backfilledAt()).toBeUndefined();
  });

  it("zero agents is a complete, successful backfill of nothing", async () => {
    const paseo = fakeAgentsApi([[]]);

    const result = await runClassifierDecisionsBackfill(paseo, ledger);

    expect(result).toEqual({ ran: true, complete: true, scanned: 0, backfilled: 0, skipped: 0 });
    expect(ledger.backfilledAt()).toBeDefined();
  });
});
