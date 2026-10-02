import { describe, expect, it } from "vitest";
import {
  buildHumanRequestRow,
  buildUpdateRow,
  selectHumanRequests,
  selectUpdates,
  type AggregatedStreamEntry,
  type AggregatedWorkItem,
} from "./model";

function item(overrides: Partial<AggregatedWorkItem>): AggregatedWorkItem {
  return {
    id: "wi-1",
    title: "Review",
    owner: "human",
    state: "pending",
    createdAt: "2026-09-30T12:00:00.000Z",
    updatedAt: "2026-09-30T12:00:00.000Z",
    serverId: "server-1",
    serverName: "Mac",
    ...overrides,
  };
}

function entry(overrides: Partial<AggregatedStreamEntry>): AggregatedStreamEntry {
  return {
    id: "se-1",
    seq: 1,
    at: "2026-09-30T12:00:00.000Z",
    type: "queue.transition",
    source: "queue",
    summary: "Review: new → pending",
    serverId: "server-1",
    serverName: "Mac",
    ...overrides,
  };
}

describe("selectHumanRequests", () => {
  it("keeps only open items owned by human, oldest first", () => {
    const items = [
      item({ id: "newer", owner: "human", state: "pending", createdAt: "2026-09-30T12:05:00Z" }),
      item({ id: "agent-owned", owner: "agent-a", state: "pending" }),
      item({ id: "closed", owner: "human", state: "done", closure: { reason: "no-follow-on" } }),
      item({ id: "older", owner: "human", state: "blocked", createdAt: "2026-09-30T11:00:00Z" }),
    ];
    expect(selectHumanRequests(items).map((row) => row.id)).toEqual(["older", "newer"]);
  });

  it("returns an empty list when nothing is open for human", () => {
    expect(selectHumanRequests([])).toEqual([]);
  });
});

describe("selectUpdates", () => {
  it("sorts newest first and never drops an unrecognized entry type", () => {
    const entries = [
      entry({ id: "old", at: "2026-09-30T10:00:00Z", type: "queue.transition" }),
      entry({ id: "new", at: "2026-09-30T13:00:00Z", type: "some.unknown.kind" }),
      entry({ id: "mid", at: "2026-09-30T11:00:00Z", type: "coordination.inbox.annotate" }),
    ];
    expect(selectUpdates(entries).map((row) => row.id)).toEqual(["new", "mid", "old"]);
  });
});

describe("buildHumanRequestRow", () => {
  it("reduces an item to the compact row shape", () => {
    const nowMs = Date.parse("2026-09-30T12:05:00.000Z");
    const row = buildHumanRequestRow(
      item({
        createdBy: "agent-a",
        closure: { reason: "blocked_on", target: "human" },
        delivery: { state: "failed", reason: "timeout" },
      }),
      nowMs,
    );
    expect(row).toMatchObject({
      id: "wi-1",
      title: "Review",
      owner: "human",
      creator: "agent-a",
      closureReason: "blocked_on",
      closureTarget: "human",
      deliveryFailed: true,
      ageMs: 5 * 60 * 1000,
    });
  });

  it("defaults creator and closure to null when absent", () => {
    const row = buildHumanRequestRow(item({}), Date.parse("2026-09-30T12:00:00.000Z"));
    expect(row.creator).toBeNull();
    expect(row.closureReason).toBeNull();
    expect(row.closureTarget).toBeNull();
    expect(row.deliveryFailed).toBe(false);
  });
});

describe("buildUpdateRow", () => {
  it("carries a plain summary for an unknown entry kind", () => {
    const row = buildUpdateRow(
      entry({ type: "some.unknown.kind", summary: "Something happened" }),
      Date.parse("2026-09-30T12:00:30.000Z"),
    );
    expect(row).toMatchObject({
      type: "some.unknown.kind",
      summary: "Something happened",
      ageMs: 30_000,
    });
  });
});
