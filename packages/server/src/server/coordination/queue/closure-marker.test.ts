import { describe, expect, it } from "vitest";
import { parseClosureMarkers } from "./closure-marker.js";

describe("closure markers", () => {
  it("parses a state, a reason and a target, one item per line", () => {
    const parsed = parseClosureMarkers(
      [
        "Finished the review.",
        "queue: wi_1 done no-follow-on",
        "  queue: wi_2 blocked blocked_on=wi_9  ",
        "queue: wi_3 done handed_off_to=agent-b",
        "queue: wi_4 canceled",
      ].join("\n"),
    );
    expect(parsed.malformed).toEqual([]);
    expect(parsed.markers.map(({ line: _line, ...marker }) => marker)).toEqual([
      { itemId: "wi_1", to: "done", closure: { reason: "no-follow-on" } },
      { itemId: "wi_2", to: "blocked", closure: { reason: "blocked_on", target: "wi_9" } },
      { itemId: "wi_3", to: "done", closure: { reason: "handed_off_to", target: "agent-b" } },
      { itemId: "wi_4", to: "canceled" },
    ]);
  });

  it("returns nothing for a message without markers", () => {
    expect(parseClosureMarkers("All done, nothing else to report.\nqueue it later")).toEqual({
      markers: [],
      malformed: [],
    });
  });

  it("reports every queue: line that does not fit the grammar, and keeps none of them", () => {
    const parsed = parseClosureMarkers(
      [
        "queue: wi_1 finished no-follow-on",
        "queue: wi_2 done because-reasons",
        "queue: wi_3 done blocked_on=",
        "queue: wi_4 done no-follow-on and more words",
        "queue:wi_5 done no-follow-on",
        "queue: wi_6 pending",
      ].join("\n"),
    );
    expect(parsed.markers).toEqual([]);
    expect(parsed.malformed.map((entry) => entry.line)).toEqual([
      "queue: wi_1 finished no-follow-on",
      "queue: wi_2 done because-reasons",
      "queue: wi_3 done blocked_on=",
      "queue: wi_4 done no-follow-on and more words",
      "queue:wi_5 done no-follow-on",
      "queue: wi_6 pending",
    ]);
  });

  it("trusts neither of two markers for the same item", () => {
    const parsed = parseClosureMarkers(
      "queue: wi_1 done no-follow-on\nqueue: wi_1 failed\nqueue: wi_2 failed",
    );
    expect(parsed.markers.map((marker) => marker.itemId)).toEqual(["wi_2"]);
    expect(parsed.malformed).toHaveLength(2);
  });
});
