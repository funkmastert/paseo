import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  RunMarkerTracker,
  isRunMarkerOpen,
  settleRunMarker,
  type RunMarker,
  type RunMarkerStore,
} from "./run-marker.js";

class MemoryMarkerStore implements RunMarkerStore {
  readonly markers = new Map<string, RunMarker | undefined>();
  writes = 0;

  async updateRunMarker(
    agentId: string,
    mutate: (current: RunMarker | undefined) => RunMarker | undefined,
  ): Promise<boolean> {
    this.writes += 1;
    this.markers.set(agentId, mutate(this.markers.get(agentId)));
    return true;
  }
}

function harness() {
  const store = new MemoryMarkerStore();
  const tasks: Promise<void>[] = [];
  let tick = 0;
  const tracker = new RunMarkerTracker({
    store,
    logger: createTestLogger(),
    track: (task) => tasks.push(task),
    now: () => new Date(Date.UTC(2026, 8, 23, 10, 0, tick++)),
  });
  const settled = () => Promise.all(tasks);
  return { store, tracker, settled };
}

const RUNNING = { shuttingDown: false };

describe("RunMarkerTracker", () => {
  test("opens a marker at the edge into running and settles it at the edge out", async () => {
    const { store, tracker, settled } = harness();
    tracker.observe({ id: "a", lifecycle: "running" }, RUNNING);
    tracker.observe({ id: "a", lifecycle: "running" }, RUNNING);
    await settled();
    expect(store.writes).toBe(1);
    expect(isRunMarkerOpen(store.markers.get("a"))).toBe(true);

    tracker.observe({ id: "a", lifecycle: "idle" }, RUNNING);
    tracker.observe({ id: "a", lifecycle: "idle" }, RUNNING);
    await settled();
    expect(store.writes).toBe(2);
    expect(store.markers.get("a")).toMatchObject({ endedBy: "idle" });
    expect(isRunMarkerOpen(store.markers.get("a"))).toBe(false);
  });

  test("leaves the marker open when the daemon's shutdown is what stopped the run", async () => {
    const { store, tracker, settled } = harness();
    tracker.observe({ id: "a", lifecycle: "running" }, RUNNING);
    tracker.observe({ id: "a", lifecycle: "closed" }, { shuttingDown: true });
    await settled();
    expect(isRunMarkerOpen(store.markers.get("a"))).toBe(true);
  });

  test("never settles a marker an earlier daemon opened", async () => {
    const { store, tracker, settled } = harness();
    store.markers.set("a", { startedAt: "2026-09-22T00:00:00.000Z" });
    tracker.observe({ id: "a", lifecycle: "idle" }, RUNNING);
    tracker.observe({ id: "a", lifecycle: "closed" }, RUNNING);
    await settled();
    expect(store.writes).toBe(0);
    expect(isRunMarkerOpen(store.markers.get("a"))).toBe(true);
  });

  test("a new run replaces an inherited marker", async () => {
    const { store, tracker, settled } = harness();
    store.markers.set("a", { startedAt: "2026-09-22T00:00:00.000Z" });
    tracker.observe({ id: "a", lifecycle: "running" }, RUNNING);
    await settled();
    expect(store.markers.get("a")?.startedAt).not.toBe("2026-09-22T00:00:00.000Z");
  });

  test("ignores internal agents", async () => {
    const { store, tracker, settled } = harness();
    tracker.observe({ id: "a", lifecycle: "running", internal: true }, RUNNING);
    await settled();
    expect(store.writes).toBe(0);
  });
});

describe("settleRunMarker", () => {
  test("settles an open marker and leaves a settled one alone", () => {
    const open = { startedAt: "s" };
    expect(settleRunMarker(open, "e", "dismissed")).toEqual({
      startedAt: "s",
      endedAt: "e",
      endedBy: "dismissed",
    });
    const done = { startedAt: "s", endedAt: "e1", endedBy: "idle" };
    expect(settleRunMarker(done, "e2", "dismissed")).toBe(done);
  });
});
