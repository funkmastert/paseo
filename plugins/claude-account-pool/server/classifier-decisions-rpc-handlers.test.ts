import { describe, it, expect, vi } from "vitest";
import { createClassifierDecisionsRpcHandlers } from "./classifier-decisions-rpc-handlers";
import type { ClassifierDecisionsLedger } from "./classifier-decisions-ledger";
import type { ClassifierDecisionRow } from "../shared/classifier-decisions-schema";

function row(overrides: Partial<ClassifierDecisionRow> = {}): ClassifierDecisionRow {
  return {
    id: "d1",
    at: "2026-10-20T00:00:00.000Z",
    agentId: "a1",
    agentTitle: "fan-out",
    role: "worker",
    taskClass: "standard",
    workKind: "coding",
    modelRan: "claude-sonnet-5",
    arena: {
      outcome: "ranked",
      applied: false,
      ref: "claude-sonnet-5-5",
      tier: "mid",
      board: "agent/overall",
      publishDate: "2026-10-20",
      pick: { ref: "claude-sonnet-5-5", proxy: false },
    },
    backfilled: false,
    ...overrides,
  };
}

function fakeLedger(rows: ClassifierDecisionRow[]): Pick<ClassifierDecisionsLedger, "all"> {
  return { all: () => rows };
}

function fakeContext(agents: { id: string; lastStatus?: string }[] = []) {
  const list = vi.fn(async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }));
  return { paseo: { agents: { list } } } as unknown as Parameters<ReturnType<typeof createClassifierDecisionsRpcHandlers>["list"]>[1];
}

describe("classifier-decisions RPC handlers", () => {
  it("list returns rows newest-first (ledger order), each joined with its outcome", async () => {
    const handlers = createClassifierDecisionsRpcHandlers({ ledger: fakeLedger([row({ agentId: "a1" })]) });
    const context = fakeContext([{ id: "a1", lastStatus: "idle" }]);

    const result = await handlers.list({}, context);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].outcome.state).toBe("finished");
    expect(result.nextCursor).toBeUndefined();
  });

  it("disagreementsOnly keeps only ranked rows whose pick differs from the model that ran", async () => {
    const rows = [
      row({ id: "agree", modelRan: "claude-sonnet-5-5" }),
      row({ id: "disagree", modelRan: "claude-sonnet-5" }),
      row({ id: "fallback", arena: { outcome: "fallback", reason: "no-ranked-board" } }),
    ];
    const handlers = createClassifierDecisionsRpcHandlers({ ledger: fakeLedger(rows) });
    const context = fakeContext([{ id: "a1" }]);

    const result = await handlers.list({ disagreementsOnly: true }, context);

    expect(result.rows.map((r) => r.id)).toEqual(["disagree"]);
  });

  it("role and workKind filters narrow list and summary identically", async () => {
    const rows = [row({ id: "d1", role: "worker" }), row({ id: "d2", role: "reviewer" })];
    const handlers = createClassifierDecisionsRpcHandlers({ ledger: fakeLedger(rows) });
    const context = fakeContext([{ id: "a1" }]);

    const listResult = await handlers.list({ role: "reviewer" }, context);
    const summaryResult = await handlers.summary({ role: "reviewer" }, context);

    expect(listResult.rows.map((r) => r.id)).toEqual(["d2"]);
    expect(summaryResult.totalRows).toBe(1);
  });

  it("an empty ledger returns an empty list and a zeroed summary, not an error", async () => {
    const handlers = createClassifierDecisionsRpcHandlers({ ledger: fakeLedger([]) });
    const context = fakeContext([]);

    const listResult = await handlers.list({}, context);
    const summaryResult = await handlers.summary({}, context);

    expect(listResult.rows).toEqual([]);
    expect(summaryResult.totalRows).toBe(0);
    expect(summaryResult.agreementRate).toBeNull();
  });

  it("summary's agreement rate matches an independent computation over the same filtered rows", async () => {
    const rows = [
      row({ id: "agree1", agentId: "a1", modelRan: "claude-sonnet-5-5" }),
      row({ id: "agree2", agentId: "a2", modelRan: "claude-sonnet-5-5" }),
      row({ id: "disagree", agentId: "a3", modelRan: "claude-sonnet-5" }),
    ];
    const handlers = createClassifierDecisionsRpcHandlers({ ledger: fakeLedger(rows) });
    const context = fakeContext([{ id: "a1" }, { id: "a2" }, { id: "a3" }]);

    const summaryResult = await handlers.summary({}, context);

    expect(summaryResult.agreementRate).toBeCloseTo(2 / 3);
  });

  it("paginates list and hands back a cursor for the next page", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ id: `d${i}`, agentId: `a${i}` }));
    const handlers = createClassifierDecisionsRpcHandlers({ ledger: fakeLedger(rows) });
    const context = fakeContext(rows.map((_, i) => ({ id: `a${i}` })));

    const page1 = await handlers.list({ limit: 2 }, context);
    expect(page1.rows.map((r) => r.id)).toEqual(["d0", "d1"]);
    expect(page1.nextCursor).toBe("2");

    const page2 = await handlers.list({ limit: 2, cursor: page1.nextCursor }, context);
    expect(page2.rows.map((r) => r.id)).toEqual(["d2", "d3"]);
  });
});
