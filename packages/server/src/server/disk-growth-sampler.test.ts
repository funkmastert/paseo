import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../test-utils/test-logger.js";
import {
  DiskGrowthSampler,
  formatGrowthEvidence,
  pickReferenceSample,
  type DiskGrowthSample,
  type DuRunner,
} from "./disk-growth-sampler.js";

const MIB = 1024 * 1024;
const MINUTE_MS = 60_000;
const T0 = Date.parse("2026-09-24T12:00:00.000Z");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      chmodSync(join(dir, "root-a", "locked"), 0o755);
    } catch {
      // not every fixture has a locked directory
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeMebibytes(path: string, mebibytes: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.alloc(mebibytes * MIB, 1));
}

function makeSampler(input: {
  home: string;
  paseoHome?: string;
  clock: { nowMs: number };
  runDu?: DuRunner;
}) {
  return new DiskGrowthSampler({
    paseoHome: input.paseoHome ?? makeTempDir("paseo-growth-home-"),
    homeDir: input.home,
    now: () => input.clock.nowMs,
    minChildBytes: MIB,
    minGrowthBytes: MIB,
    runDu: input.runDu,
    logger: createTestLogger(),
  });
}

describe("DiskGrowthSampler — measuring", () => {
  test("sizes each root and its immediate children, and skips a root that does not exist", async () => {
    const home = makeTempDir("paseo-growth-");
    writeMebibytes(join(home, "root-a", "big", "a.bin"), 6);
    writeMebibytes(join(home, "root-a", "small", "a.bin"), 2);
    writeMebibytes(join(home, "root-a", "loose.bin"), 3);
    const clock = { nowMs: T0 };
    const sampler = makeSampler({ home, clock });

    const report = await sampler.sample({
      roots: [join(home, "root-a"), join(home, "missing-root")],
      timeoutMs: 30_000,
    });

    expect(report.sample.roots.map((root) => root.path)).toEqual([join(home, "root-a")]);
    const [root] = report.sample.roots;
    expect(root.bytes).toBeGreaterThanOrEqual(11 * MIB);
    expect(root.children.map((child) => child.name)).toEqual(["big", "loose.bin", "small"]);
    expect(root.children[0].bytes).toBeGreaterThanOrEqual(6 * MIB);
    expect(report.sample.unmeasured).toEqual([]);
  });

  test("expands ~ in configured roots against the home directory", async () => {
    const home = makeTempDir("paseo-growth-");
    writeMebibytes(join(home, "cache", "x", "a.bin"), 2);
    const sampler = makeSampler({ home, clock: { nowMs: T0 } });

    const report = await sampler.sample({ roots: ["~/cache"], timeoutMs: 30_000 });

    expect(report.sample.roots.map((root) => root.path)).toEqual([join(home, "cache")]);
  });

  test("keeps a root's size when du exits nonzero on an unreadable directory", async () => {
    const home = makeTempDir("paseo-growth-");
    writeMebibytes(join(home, "root-a", "readable", "a.bin"), 4);
    mkdirSync(join(home, "root-a", "locked"));
    chmodSync(join(home, "root-a", "locked"), 0o000);
    const sampler = makeSampler({ home, clock: { nowMs: T0 } });

    const report = await sampler.sample({ roots: [join(home, "root-a")], timeoutMs: 30_000 });

    expect(report.sample.unmeasured).toEqual([]);
    expect(report.sample.roots[0].bytes).toBeGreaterThanOrEqual(4 * MIB);
  });

  test("measures roots one after another and records a timeout as unmeasured, not as zero", async () => {
    const home = makeTempDir("paseo-growth-");
    for (const name of ["one", "two", "three"]) mkdirSync(join(home, name));
    let running = 0;
    let peak = 0;
    const order: string[] = [];
    const runDu: DuRunner = async (root) => {
      running += 1;
      peak = Math.max(peak, running);
      order.push(root);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      if (root.endsWith("two")) return { kind: "timeout" };
      return { kind: "ok", stdout: `2048\t${root}/child\n4096\t${root}\n` };
    };
    const sampler = makeSampler({ home, clock: { nowMs: T0 }, runDu });

    const report = await sampler.sample({
      roots: [join(home, "one"), join(home, "two"), join(home, "three")],
      timeoutMs: 1_000,
    });

    expect(peak).toBe(1);
    expect(order.map((root) => root.split("/").pop())).toEqual(["one", "two", "three"]);
    expect(report.sample.roots.map((root) => root.path.split("/").pop())).toEqual(["one", "three"]);
    expect(report.sample.unmeasured).toEqual([{ path: join(home, "two"), reason: "timeout" }]);
  });
});

describe("DiskGrowthSampler — growth since the last sample", () => {
  test("names the child that grew, with its delta, and leaves unchanged children out", async () => {
    const home = makeTempDir("paseo-growth-");
    writeMebibytes(join(home, "root-a", "steady", "a.bin"), 3);
    writeMebibytes(join(home, "root-a", "grows", "a.bin"), 3);
    const clock = { nowMs: T0 };
    const sampler = makeSampler({ home, clock });
    const config = { roots: [join(home, "root-a")], timeoutMs: 30_000 };

    const first = await sampler.sample(config);
    expect(first.previousAt).toBeNull();
    expect(first.growers).toEqual([]);

    writeMebibytes(join(home, "root-a", "grows", "b.bin"), 20);
    clock.nowMs = T0 + 15 * MINUTE_MS;
    const second = await sampler.sample(config);

    expect(second.previousAt).toBe(new Date(T0).toISOString());
    expect(second.growers.map((grower) => grower.path)).toEqual([join(home, "root-a", "grows")]);
    expect(second.growers[0].deltaBytes).toBeGreaterThanOrEqual(19 * MIB);
    expect(second.roots[0].deltaBytes).toBeGreaterThanOrEqual(19 * MIB);
  });

  test("a directory that did not exist last time counts its whole size as growth", async () => {
    const home = makeTempDir("paseo-growth-");
    writeMebibytes(join(home, "root-a", "old", "a.bin"), 3);
    const clock = { nowMs: T0 };
    const sampler = makeSampler({ home, clock });
    const config = { roots: [join(home, "root-a")], timeoutMs: 30_000 };
    await sampler.sample(config);

    writeMebibytes(join(home, "root-a", "fresh", "a.bin"), 30);
    clock.nowMs = T0 + 15 * MINUTE_MS;
    const report = await sampler.sample(config);

    expect(report.growers[0].path).toBe(join(home, "root-a", "fresh"));
    expect(report.growers[0].deltaBytes).toBeGreaterThanOrEqual(29 * MIB);
  });

  test("a restart keeps the baseline: the last sample is read back from disk-growth.json", async () => {
    const home = makeTempDir("paseo-growth-");
    const paseoHome = makeTempDir("paseo-growth-home-");
    writeMebibytes(join(home, "root-a", "grows", "a.bin"), 3);
    const clock = { nowMs: T0 };
    const config = { roots: [join(home, "root-a")], timeoutMs: 30_000 };
    await makeSampler({ home, paseoHome, clock }).sample(config);
    expect(
      JSON.parse(readFileSync(join(paseoHome, "disk-growth.json"), "utf8")).samples,
    ).toHaveLength(1);

    writeMebibytes(join(home, "root-a", "grows", "b.bin"), 15);
    clock.nowMs = T0 + 15 * MINUTE_MS;
    const restarted = makeSampler({ home, paseoHome, clock });
    const report = await restarted.sample(config);

    expect(report.previousAt).toBe(new Date(T0).toISOString());
    expect(report.growers[0].path).toBe(join(home, "root-a", "grows"));
  });

  test("an unreadable or foreign disk-growth.json is a missing baseline, not a crash", async () => {
    const home = makeTempDir("paseo-growth-");
    const paseoHome = makeTempDir("paseo-growth-home-");
    writeFileSync(join(paseoHome, "disk-growth.json"), "{not json");
    writeMebibytes(join(home, "root-a", "a", "a.bin"), 2);
    const sampler = makeSampler({ home, paseoHome, clock: { nowMs: T0 } });

    const report = await sampler.sample({ roots: [join(home, "root-a")], timeoutMs: 30_000 });

    expect(report.previousAt).toBeNull();
  });
});

describe("DiskGrowthSampler — when to sample", () => {
  const config = { sampleIntervalMinutes: 15 };

  test("samples on the first look, then no more often than sampleIntervalMinutes while a condition is active", async () => {
    const home = makeTempDir("paseo-growth-");
    mkdirSync(join(home, "root-a"));
    const clock = { nowMs: T0 };
    const sampler = makeSampler({ home, clock });

    expect(await sampler.isSampleDue({ conditionActive: true, ...config })).toBe(true);
    await sampler.sample({ roots: [join(home, "root-a")], timeoutMs: 30_000 });

    clock.nowMs = T0 + 14 * MINUTE_MS;
    expect(await sampler.isSampleDue({ conditionActive: true, ...config })).toBe(false);
    clock.nowMs = T0 + 15 * MINUTE_MS;
    expect(await sampler.isSampleDue({ conditionActive: true, ...config })).toBe(true);
  });

  test("with no condition active, only the hourly baseline is due", async () => {
    const home = makeTempDir("paseo-growth-");
    mkdirSync(join(home, "root-a"));
    const clock = { nowMs: T0 };
    const sampler = makeSampler({ home, clock });
    await sampler.sample({ roots: [join(home, "root-a")], timeoutMs: 30_000 });

    clock.nowMs = T0 + 59 * MINUTE_MS;
    expect(await sampler.isSampleDue({ conditionActive: false, ...config })).toBe(false);
    clock.nowMs = T0 + 60 * MINUTE_MS;
    expect(await sampler.isSampleDue({ conditionActive: false, ...config })).toBe(true);
  });
});

describe("pickReferenceSample", () => {
  function sampleAt(minutes: number): DiskGrowthSample {
    return { at: new Date(T0 + minutes * MINUTE_MS).toISOString(), roots: [], unmeasured: [] };
  }
  const samples = [sampleAt(0), sampleAt(20), sampleAt(40)];

  test("takes the newest sample at least a fall window old, so the delta covers the whole fall", () => {
    const reference = pickReferenceSample(samples, T0 + 55 * MINUTE_MS, 30 * MINUTE_MS);
    expect(reference?.at).toBe(sampleAt(20).at);
  });

  test("falls back to the oldest sample when none is that old", () => {
    const reference = pickReferenceSample(samples, T0 + 55 * MINUTE_MS, 120 * MINUTE_MS);
    expect(reference?.at).toBe(sampleAt(0).at);
  });

  test("returns null with no history", () => {
    expect(pickReferenceSample([], T0, 30 * MINUTE_MS)).toBeNull();
  });
});

describe("formatGrowthEvidence", () => {
  test("lists the top growers with deltas and names the roots it could not measure", async () => {
    const home = makeTempDir("paseo-growth-");
    writeMebibytes(join(home, "root-a", "grows", "a.bin"), 3);
    const clock = { nowMs: T0 };
    const sampler = makeSampler({ home, clock });
    const config = { roots: [join(home, "root-a"), join(home, "gone")], timeoutMs: 30_000 };
    await sampler.sample(config);
    writeMebibytes(join(home, "root-a", "grows", "b.bin"), 30);
    clock.nowMs = T0 + 15 * MINUTE_MS;
    const report = await sampler.sample(config);

    const text = formatGrowthEvidence(report, home);

    expect(text).toContain("since the sample at 2026-09-24T12:00:00.000Z");
    expect(text).toMatch(/~\/root-a\/grows: \+(29|30|31)(\.\d)? MB/);
  });

  test("says so when there is no earlier sample to compare against", async () => {
    const home = makeTempDir("paseo-growth-");
    writeMebibytes(join(home, "root-a", "a", "a.bin"), 2);
    const sampler = makeSampler({ home, clock: { nowMs: T0 } });
    const report = await sampler.sample({ roots: [join(home, "root-a")], timeoutMs: 30_000 });

    expect(formatGrowthEvidence(report, home)).toContain("no earlier sample");
  });
});
