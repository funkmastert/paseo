import { describe, expect, test } from "vitest";
import {
  deriveVitalsVerdict,
  describeVitalsVerdict,
  lastWedge,
  type DaemonVitalsFile,
} from "./vitals-file.js";

const NOW = 1_000_000;

function file(overrides: Partial<DaemonVitalsFile> = {}): DaemonVitalsFile {
  return {
    schema: "paseo.daemon-vitals/v1",
    pid: 4242,
    startedAt: "2026-09-23T00:00:00.000Z",
    updatedAtMs: NOW - 500,
    mainTickAtMs: NOW - 700,
    mainBlockedMs: 0,
    thresholds: { tickMs: 250, slowStallMs: 500, wedgeMs: 5_000, suspendMs: 2_000 },
    dryRun: true,
    summary: null,
    ...overrides,
  };
}

describe("deriveVitalsVerdict", () => {
  test("no file is not-reporting, not down", () => {
    expect(deriveVitalsVerdict(null, NOW)).toEqual({ state: "not-reporting" });
  });

  test("a fresh heartbeat with a current main thread is healthy", () => {
    expect(deriveVitalsVerdict(file(), NOW)).toEqual({ state: "healthy" });
  });

  test("a main thread blocked past the wedge threshold is wedged while the heartbeat is fresh", () => {
    expect(deriveVitalsVerdict(file({ mainBlockedMs: 41_000 }), NOW)).toEqual({
      state: "wedged",
      blockedMs: 41_000,
    });
  });

  test("a short block is slow, never wedged", () => {
    expect(deriveVitalsVerdict(file({ mainBlockedMs: 900 }), NOW).state).toBe("slow");
  });

  test("a heartbeat that stopped means the watchdog is silent too, which is not a wedge", () => {
    expect(deriveVitalsVerdict(file({ updatedAtMs: NOW - 60_000 }), NOW)).toEqual({
      state: "silent",
      silentMs: 60_000,
    });
  });

  test("a cleanly stopped daemon is stopped, however old the file", () => {
    expect(
      deriveVitalsVerdict(file({ stoppedAt: "x", updatedAtMs: NOW - 900_000 }), NOW).state,
    ).toBe("stopped");
  });
});

describe("describeVitalsVerdict", () => {
  test("says the process is alive when wedged, so no one reads it as down", () => {
    expect(describeVitalsVerdict({ state: "wedged", blockedMs: 41_000 })).toContain("alive");
  });
});

describe("lastWedge", () => {
  test("finds the most recent wedge among other episodes", () => {
    const episode = (kind: "wedge" | "stall" | "suspension", endedAt: string) => ({
      kind,
      startedAt: endedAt,
      endedAt,
      blockedMs: 1,
      suspendedMs: 0,
      cpuRatio: 0,
      cause: "busy" as const,
    });
    const result = lastWedge(
      file({
        summary: {
          counts: { wedges: 2, stalls: 1, suspensions: 1 },
          episodes: [
            episode("wedge", "a"),
            episode("wedge", "b"),
            episode("suspension", "c"),
            episode("stall", "d"),
          ],
        },
      }),
    );
    expect(result?.endedAt).toBe("b");
    expect(lastWedge(file())).toBeNull();
  });
});
