import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SlowOpRecorder, type SlowOpRecord } from "./slow-ops.js";

async function readRecords(filePath: string): Promise<SlowOpRecord[]> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SlowOpRecord);
}

function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // Spin.
  }
}

describe("SlowOpRecorder", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "paseo-slow-ops-"));
    filePath = path.join(dir, "diagnostics", "slow-ops.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a synchronous call over budget is recorded with its site, and its result passes through", async () => {
    const recorder = new SlowOpRecorder({ filePath, thresholdMs: 30 });
    const result = recorder.runSync("git:status", () => {
      busyWait(60);
      return 7;
    });
    await recorder.flush();

    expect(result).toBe(7);
    const [record] = await readRecords(filePath);
    expect(record).toMatchObject({ site: "git:status", kind: "sync", outcome: "ok" });
    expect(record?.durationMs).toBeGreaterThanOrEqual(55);
  });

  test("a call under budget writes nothing at all", async () => {
    const recorder = new SlowOpRecorder({ filePath, thresholdMs: 200 });
    recorder.runSync("fast", () => 1);
    await recorder.runStage("fast-async", async () => 2);
    await recorder.flush();

    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(recorder.stats().recorded).toBe(0);
  });

  test("an async stage is timed end to end and a throw is recorded, then rethrown", async () => {
    const recorder = new SlowOpRecorder({ filePath, thresholdMs: 30 });
    await recorder.runStage("wait", () => new Promise((resolve) => setTimeout(resolve, 60)));
    await expect(
      recorder.runStage("boom", async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    await recorder.flush();

    const records = await readRecords(filePath);
    expect(records.map((r) => [r.site, r.kind, r.outcome])).toEqual([
      ["wait", "async", "ok"],
      ["boom", "async", "error"],
    ]);
  });

  test("record() takes a duration measured elsewhere and keeps its detail", async () => {
    const recorder = new SlowOpRecorder({ filePath, thresholdMs: 100 });
    recorder.record("event-loop:wedge", 94_000, { cause: "busy" });
    recorder.record("event-loop:stall", 50);
    await recorder.flush();

    const records = await readRecords(filePath);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      site: "event-loop:wedge",
      durationMs: 94_000,
      kind: "observed",
      detail: { cause: "busy" },
    });
  });

  test("flush resolves only once every queued record is on disk", async () => {
    const recorder = new SlowOpRecorder({ filePath, thresholdMs: 1 });
    for (let index = 0; index < 20; index += 1) recorder.record(`op-${index}`, 10);
    await recorder.flush();
    expect(await readRecords(filePath)).toHaveLength(20);
  });

  test("the log rotates by size and keeps a bounded number of files", async () => {
    const recorder = new SlowOpRecorder({
      filePath,
      thresholdMs: 1,
      maxBytes: 300,
      rotationCount: 2,
    });
    for (let index = 0; index < 12; index += 1) {
      recorder.record(`operation-number-${index}`, 10, { pad: "x".repeat(40) });
      await recorder.flush();
    }

    await expect(stat(filePath)).resolves.toBeDefined();
    await expect(stat(`${filePath}.1`)).resolves.toBeDefined();
    await expect(stat(`${filePath}.2`)).resolves.toBeDefined();
    await expect(stat(`${filePath}.3`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a failed write is counted and reported, never thrown at the caller", async () => {
    const errors: Error[] = [];
    // A regular file where the diagnostics directory should be makes every write fail.
    const blocked = path.join(dir, "blocked");
    await import("node:fs/promises").then((fs) => fs.writeFile(blocked, "x"));
    const recorder = new SlowOpRecorder({
      filePath: path.join(blocked, "slow-ops.jsonl"),
      thresholdMs: 1,
      onWriteError: (error) => errors.push(error),
    });

    expect(() => recorder.record("op", 10)).not.toThrow();
    await recorder.flush();
    expect(recorder.stats().writeErrors).toBe(1);
    expect(errors).toHaveLength(1);
  });

  test("a full queue drops records instead of growing without bound", () => {
    const recorder = new SlowOpRecorder({ filePath, thresholdMs: 1 });
    for (let index = 0; index < 600; index += 1) recorder.record("flood", 10);
    expect(recorder.stats().dropped).toBeGreaterThan(0);
  });
});
