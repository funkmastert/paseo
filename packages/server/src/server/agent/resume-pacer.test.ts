import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { ResumePacer, type ResumePacerSettings } from "./resume-pacer.js";

/** A pacer on a hand-driven clock: `advance` fires due timers, the way the real ones would. */
function harness(settings: ResumePacerSettings = { enabled: true, perMinute: 4 }) {
  let nowMs = 0;
  let current = settings;
  const timers: { at: number; fn: () => void }[] = [];
  const pacer = new ResumePacer({
    readSettings: () => current,
    logger: createTestLogger(),
    now: () => nowMs,
    setTimer: (fn, ms) => {
      const timer = { at: nowMs + ms, fn };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const started: string[] = [];
  const resume = (agentId: string, root = false) =>
    pacer.run({ agentId, root, source: "test" }, async () => {
      started.push(agentId);
    });
  const flush = () => new Promise((r) => setImmediate(r));
  const advance = async (ms: number) => {
    nowMs += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= nowMs).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
    await flush();
  };
  return {
    pacer,
    started,
    resume,
    flush,
    advance,
    setSettings: (next: ResumePacerSettings) => {
      current = next;
    },
  };
}

describe("ResumePacer", () => {
  test("a single resume runs immediately", async () => {
    const h = harness();
    await h.resume("a");
    expect(h.started).toEqual(["a"]);
  });

  test("eleven resumes after a failover drain at the configured rate, burst first", async () => {
    const h = harness({ enabled: true, perMinute: 4 });
    const ids = Array.from({ length: 11 }, (_, i) => `agent-${i}`);
    for (const id of ids) void h.resume(id);
    await h.flush();
    expect(h.started).toHaveLength(4);
    await h.advance(15_000);
    expect(h.started).toHaveLength(5);
    await h.advance(45_000);
    expect(h.started).toHaveLength(8);
    await h.advance(45_000);
    expect(h.started).toEqual(ids);
  });

  test("roots are released ahead of waiting children", async () => {
    const h = harness({ enabled: true, perMinute: 1 });
    void h.resume("first-child");
    void h.resume("child-2");
    void h.resume("child-3");
    void h.resume("root", true);
    await h.flush();
    expect(h.started).toEqual(["first-child"]);
    await h.advance(60_000);
    expect(h.started).toEqual(["first-child", "root"]);
    await h.advance(60_000);
    expect(h.started).toEqual(["first-child", "root", "child-2"]);
  });

  test("turned off, it passes everything through and releases anyone waiting", async () => {
    const h = harness({ enabled: true, perMinute: 1 });
    void h.resume("a");
    void h.resume("b");
    await h.flush();
    expect(h.started).toEqual(["a"]);
    h.setSettings({ enabled: false, perMinute: 1 });
    await h.advance(1);
    await h.advance(60_000);
    await h.resume("c");
    expect(h.started).toEqual(["a", "b", "c"]);
  });

  test("stopping rejects whoever is still waiting instead of running them", async () => {
    const h = harness({ enabled: true, perMinute: 1 });
    await h.resume("a");
    const waiting = h.resume("b");
    h.pacer.stop();
    await expect(waiting).rejects.toThrow("Resume pacer stopped");
    expect(h.started).toEqual(["a"]);
  });

  test("a failing resume surfaces to its caller and does not stall the rest", async () => {
    const h = harness({ enabled: true, perMinute: 60 });
    await expect(
      h.pacer.run({ agentId: "x", root: false, source: "test" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await h.resume("y");
    expect(h.started).toEqual(["y"]);
  });
});
