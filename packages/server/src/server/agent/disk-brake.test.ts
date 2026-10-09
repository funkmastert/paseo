import { describe, expect, test } from "vitest";
import {
  DISK_HOLD_TRICKLE_AFTER_MS,
  type DiskBrakeConfig,
  type DiskBrakeState,
  evaluateDiskBrake,
} from "./disk-brake.js";

const GIB = 1024 ** 3;
const MINUTE = 60_000;

/** The defaults the monitor resolves with nothing configured. */
const CONFIG: DiskBrakeConfig = {
  lowFreeBytes: 20 * GIB,
  criticalFreeBytes: 5 * GIB,
  releaseMarginBytes: 5 * GIB,
  fallBytes: 15 * GIB,
  fallWindowMs: 15 * MINUTE,
};

/** Runs one reading a minute through the brake, the way the monitor's sweep does. */
function run(readings: ReadonlyArray<number | undefined>, startMs = 1_000_000) {
  let state: DiskBrakeState | undefined;
  const results = readings.map((freeGiB, index) => {
    const result = evaluateDiskBrake({
      freeBytes: freeGiB === undefined ? undefined : freeGiB * GIB,
      previous: state,
      config: CONFIG,
      nowMs: startMs + index * MINUTE,
    });
    state = result.next;
    return result;
  });
  return { results, last: results[results.length - 1], state };
}

function transitions(results: ReadonlyArray<{ transition: string }>): string[] {
  return results.map((result) => result.transition).filter((transition) => transition !== "none");
}

describe("evaluateDiskBrake", () => {
  test("free disk under the low line holds; recovering past the line plus the margin releases", () => {
    const { results } = run([30, 19, 22, 24.9, 25]);
    expect(results[1]?.transition).toBe("held");
    expect(results[1]?.conditions).toEqual(["low"]);
    expect(results[1]?.detail).toContain("19.0 GB free");
    // Above the line but inside the margin: still held.
    expect(results[2]?.transition).toBe("none");
    expect(results[3]?.next.held).toBe(true);
    expect(results[4]?.transition).toBe("released");
    expect(results[4]?.detail).toContain("25.0 GB free");
  });

  test("the 10-08 numbers: 32 GB free and falling 27.5 MB/s holds, well above the low line", () => {
    // 13:04 to 13:19 PDT on 2026-10-08: `cp` wrote 16.3 MB/s and GradleWorkerMain 11.2 MB/s
    // under the same coalition, and free disk read 31.88 GB at 13:19 (crash-2026-10-08.md).
    const perMinuteGiB = (27.5 * 1e6 * 60) / GIB;
    const readings = Array.from({ length: 16 }, (_, index) => 31.88 + (15 - index) * perMinuteGiB);
    const { results, last } = run(readings);
    expect(transitions(results)).toEqual(["held"]);
    expect(last?.next.held).toBe(true);
    expect(last?.freeBytes).toBeCloseTo(31.88 * GIB, -6);
    expect(last?.conditions).toEqual(["falling"]);
    const held = results.find((result) => result.transition === "held");
    expect(held?.detail).toMatch(/fell \d+\.\d GB in the last 15 min/);
  });

  test("free disk dropping 15 GB in 15 minutes holds even far above the low line", () => {
    const { results } = run([
      200, 199, 198, 197, 196, 195, 194, 193, 192, 191, 190, 189, 188, 187, 186, 185,
    ]);
    expect(results[14]?.next.held).toBe(false);
    expect(results[15]?.transition).toBe("held");
    expect(results[15]?.fallBytes).toBe(15 * GIB);
  });

  test("a fall that stops releases once the window no longer holds the peak", () => {
    const { results } = run([200, 180, ...Array.from({ length: 16 }, () => 180)]);
    expect(results[1]?.transition).toBe("held");
    expect(transitions(results)).toEqual(["held", "released"]);
    // Released on the first sweep whose window has lost the 200 GB reading.
    const releasedAt = results.findIndex((result) => result.transition === "released");
    expect(releasedAt).toBe(16);
  });

  test("a flat disk never holds, however low the free space was to begin with", () => {
    const { results } = run(Array.from({ length: 40 }, () => 60));
    expect(transitions(results)).toEqual([]);
    expect(results.every((result) => result.conditions.length === 0)).toBe(true);
  });

  test("critical is named and holds; it never trickles", () => {
    const { results } = run([4, ...Array.from({ length: 45 }, () => 4)]);
    expect(results[0]?.transition).toBe("held");
    expect(results[0]?.conditions).toEqual(["critical", "low"]);
    expect(results.some((result) => result.trickle)).toBe(false);
  });

  test("no reading changes nothing: a hold stays and the settled clock starts over", () => {
    const { results } = run([18, undefined, undefined, 30]);
    expect(results[1]?.next.held).toBe(true);
    expect(results[1]?.freeBytes).toBeUndefined();
    expect(results[2]?.transition).toBe("none");
    expect(results[3]?.transition).toBe("released");

    const fresh = run([undefined, undefined]);
    expect(transitions(fresh.results)).toEqual([]);
  });

  test("a low disk that holds still lets one child through per sweep after half an hour", () => {
    const minutes = DISK_HOLD_TRICKLE_AFTER_MS / MINUTE;
    const { results } = run(Array.from({ length: minutes + 3 }, () => 18));
    expect(results[minutes - 1]?.trickle).toBe(false);
    expect(results[minutes]?.trickle).toBe(true);
    expect(results[minutes + 1]?.trickle).toBe(true);
    expect(results[minutes]?.heldForMs).toBe(DISK_HOLD_TRICKLE_AFTER_MS);
  });

  test("a disk still falling never trickles: a fall restarts the half hour once it leaves the window", () => {
    // 25 minutes at 18 GB, then a 2 GB drop. The drop is in the 15-minute window through minute
    // 39, so the half hour counts from there.
    const { results } = run([
      ...Array.from({ length: 25 }, () => 18),
      ...Array.from({ length: 50 }, () => 16),
    ]);
    const firstTrickle = results.findIndex((result) => result.trickle);
    expect(firstTrickle).toBe(39 + DISK_HOLD_TRICKLE_AFTER_MS / MINUTE);
  });
});
