import { describe, expect, it } from "vitest";
import { createRecentAgentTypes } from "./recent-agent-types";

describe("createRecentAgentTypes", () => {
  it("lists distinct values, most-recently-seen first", () => {
    const recent = createRecentAgentTypes();
    recent.record("ce-code-reviewer");
    recent.record("worker");
    recent.record("scout");

    expect(recent.list()).toEqual(["scout", "worker", "ce-code-reviewer"]);
  });

  it("re-recording an existing value moves it to the front instead of duplicating it", () => {
    const recent = createRecentAgentTypes();
    recent.record("worker");
    recent.record("scout");
    recent.record("worker");

    expect(recent.list()).toEqual(["worker", "scout"]);
  });

  it("ignores blank values", () => {
    const recent = createRecentAgentTypes();
    recent.record("");
    recent.record("   ");

    expect(recent.list()).toEqual([]);
  });

  it("caps at the configured capacity, evicting the oldest", () => {
    const recent = createRecentAgentTypes({ capacity: 2 });
    recent.record("a");
    recent.record("b");
    recent.record("c");

    expect(recent.list()).toEqual(["c", "b"]);
  });
});
