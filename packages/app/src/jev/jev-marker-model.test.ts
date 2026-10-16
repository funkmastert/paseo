import { describe, expect, it } from "vitest";
import type { JevDecisionRecord } from "@getpaseo/protocol/jev/rpc-schemas";
import { buildJevMarkerLines, placeJevMarkers, splitJevMarkerLines } from "./jev-marker-model";
import type { JevDecisionLine } from "./jev-decisions-model";

function record(overrides: Partial<JevDecisionRecord> = {}): JevDecisionRecord {
  return {
    agentId: "agent-1",
    callId: "call-1",
    feature: "stallJudgment",
    question: "Is this stalled?",
    verdict: "yes (0.8)",
    confidence: 0.8,
    action: "nudged",
    applied: true,
    at: "2026-10-16T12:00:00.000Z",
    costUsd: 0.0001,
    ...overrides,
  };
}

function line(overrides: Partial<JevDecisionLine> = {}): JevDecisionLine {
  return {
    key: "call-1",
    feature: "Stall judgment",
    question: "Is this stalled?",
    verdict: "yes (0.8)",
    action: "nudged",
    tag: null,
    cost: "$0.0001",
    at: new Date("2026-10-16T12:00:00.000Z"),
    ...overrides,
  };
}

function item(id: string, iso: string) {
  return { id, timestamp: new Date(iso) };
}

describe("buildJevMarkerLines", () => {
  it("sorts oldest first and keeps every parseable decision", () => {
    const lines = buildJevMarkerLines(
      [
        record({ callId: "b", at: "2026-10-16T12:00:02.000Z" }),
        record({ callId: "a", at: "2026-10-16T12:00:01.000Z" }),
      ],
      null,
    );
    expect(lines.map((l) => l.key)).toEqual(["a", "b"]);
  });

  it("skips a record with an unparseable timestamp", () => {
    const lines = buildJevMarkerLines(
      [record({ callId: "bad", at: "not-a-date" }), record({ callId: "ok" })],
      null,
    );
    expect(lines.map((l) => l.key)).toEqual(["ok"]);
  });
});

describe("splitJevMarkerLines", () => {
  it("puts everything in forTail when the tail is empty", () => {
    const { forTail, forHead } = splitJevMarkerLines([line()], null);
    expect(forTail).toHaveLength(1);
    expect(forHead).toHaveLength(0);
  });

  it("keeps a line exactly at the boundary in forTail, one past it in forHead", () => {
    const boundaryMs = new Date("2026-10-16T12:00:00.000Z").getTime();
    const atBoundary = line({ key: "at-boundary" });
    const pastBoundary = line({ key: "past-boundary", at: new Date(boundaryMs + 1) });
    const { forTail, forHead } = splitJevMarkerLines([atBoundary, pastBoundary], boundaryMs);
    expect(forTail.map((l) => l.key)).toEqual(["at-boundary"]);
    expect(forHead.map((l) => l.key)).toEqual(["past-boundary"]);
  });
});

describe("placeJevMarkers", () => {
  it("returns the same array reference when there are no lines", () => {
    const items = [item("1", "2026-10-16T12:00:00.000Z")];
    expect(placeJevMarkers(items, [])).toBe(items);
  });

  it("places a marker at the top when the decision precedes the first item", () => {
    const items = [item("1", "2026-10-16T12:00:05.000Z")];
    const lines = [line({ at: new Date("2026-10-16T12:00:00.000Z") })];
    const result = placeJevMarkers(items, lines);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ kind: "jev_marker" });
    expect(result[1]).toBe(items[0]);
  });

  it("collapses two decisions landing in the same gap into one marker", () => {
    const items = [item("1", "2026-10-16T12:00:00.000Z"), item("2", "2026-10-16T12:00:10.000Z")];
    const lines = [
      line({ key: "a", at: new Date("2026-10-16T12:00:01.000Z") }),
      line({ key: "b", at: new Date("2026-10-16T12:00:02.000Z") }),
    ];
    const result = placeJevMarkers(items, lines);
    expect(result).toHaveLength(3);
    const marker = result[1];
    expect(marker).toMatchObject({ kind: "jev_marker" });
    if ("lines" in marker) {
      expect(marker.lines.map((l) => l.key)).toEqual(["a", "b"]);
    }
  });

  it("flushes a decision newer than every item at the end", () => {
    const items = [item("1", "2026-10-16T12:00:00.000Z")];
    const lines = [line({ at: new Date("2026-10-16T12:00:05.000Z") })];
    const result = placeJevMarkers(items, lines);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(items[0]);
    expect(result[1]).toMatchObject({ kind: "jev_marker" });
  });
});
