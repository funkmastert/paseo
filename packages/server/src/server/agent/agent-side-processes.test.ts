import { describe, expect, test, vi } from "vitest";

import { AgentSideProcesses } from "./agent-side-processes.js";

describe("add", () => {
  test("registers a root and the release removes it", () => {
    const sides = new AgentSideProcesses();
    const release = sides.add("agent-1", 111);
    expect(sides.snapshot().get("agent-1")).toEqual([111]);
    release();
    expect(sides.snapshot().get("agent-1")).toBeUndefined();
  });
});

describe("trackUntilExit (m3)", () => {
  test("a survivor pid stays charged to the agent until it is no longer alive", async () => {
    vi.useFakeTimers();
    try {
      const sides = new AgentSideProcesses();
      let alive = true;
      sides.trackUntilExit("agent-1", 222, { isAlive: () => alive, pollMs: 10 });
      expect(sides.snapshot().get("agent-1")).toEqual([222]);

      await vi.advanceTimersByTimeAsync(50);
      expect(sides.snapshot().get("agent-1")).toEqual([222]);

      alive = false;
      await vi.advanceTimersByTimeAsync(50);
      expect(sides.snapshot().get("agent-1")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("stops polling once released externally, without reviving the entry", async () => {
    vi.useFakeTimers();
    try {
      const sides = new AgentSideProcesses();
      const isAlive = vi.fn(() => true);
      sides.trackUntilExit("agent-1", 333, { isAlive, pollMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      const calls = isAlive.mock.calls.length;
      expect(calls).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(1_000);
      // isAlive keeps returning true, so polling continues; the pid is still tracked.
      expect(sides.snapshot().get("agent-1")).toEqual([333]);
    } finally {
      vi.useRealTimers();
    }
  });
});
