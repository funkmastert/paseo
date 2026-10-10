import { describe, expect, test } from "vitest";
import {
  evaluateTestArtifactCandidates,
  markTestArtifactHandled,
  type EvaluateTestArtifactCandidatesInput,
  type TestArtifactEntry,
  type TestArtifactJanitorConfig,
  type TestArtifactMemory,
  type TestRunObligation,
} from "./test-artifact-selection.js";

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const UDID = "1C56B10C-38C1-4547-ABDA-D36412FF01CA";
const OTHER_UDID = "3B6C2CCA-B90C-40FF-94A1-43373DF411E1";

const CONFIG: TestArtifactJanitorConfig = {
  minAgeHours: 12,
  minSweeps: 3,
  obligationGraceMinutes: 10,
  obligationTtlHours: 24,
  maxPerSweep: 8,
  maxBytesPerSweep: 100 * 1024 ** 3,
};

function entry(overrides: Partial<TestArtifactEntry> = {}): TestArtifactEntry {
  return {
    name: UDID,
    path: `/Users/t/Library/Developer/XCTestDevices/${UDID}`,
    mtimeMs: NOW - 20 * HOUR,
    birthtimeMs: NOW - 20 * HOUR,
    ...overrides,
  };
}

function input(
  overrides: Partial<EvaluateTestArtifactCandidatesInput> = {},
): EvaluateTestArtifactCandidatesInput {
  return {
    setId: "xctest-devices",
    entries: [entry()],
    obligations: [],
    liveAgentIds: new Set<string>(),
    referencedDeviceIds: new Set<string>(),
    leasedDeviceIds: new Set<string>(),
    config: CONFIG,
    previous: undefined,
    nowMs: NOW,
    ...overrides,
  };
}

/**
 * Drives `sweeps` consecutive sweeps over the same input the way the janitor would, so a rule
 * that needs evidence across sweeps can be reached. Each sweep is a minute apart, like the
 * resource monitor's tick.
 */
function runSweeps(
  sweeps: number,
  build: (sweep: number) => Partial<EvaluateTestArtifactCandidatesInput>,
): ReturnType<typeof evaluateTestArtifactCandidates> {
  let memory: TestArtifactMemory | undefined;
  let result = evaluateTestArtifactCandidates(input({ previous: undefined }));
  for (let sweep = 0; sweep < sweeps; sweep += 1) {
    result = evaluateTestArtifactCandidates(
      input({ previous: memory, nowMs: NOW + sweep * 60_000, ...build(sweep) }),
    );
    memory = result.memory;
  }
  return result;
}

describe("unowned residue", () => {
  test("needs the sweep count before it is taken", () => {
    expect(runSweeps(2, () => ({})).candidates).toEqual([]);
    const result = runSweeps(3, () => ({}));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ name: UDID, claim: "unowned" });
  });

  test("is spared while it is younger than minAgeHours", () => {
    const young = entry({ mtimeMs: NOW - 2 * HOUR });
    const result = runSweeps(4, () => ({ entries: [young] }));
    expect(result.candidates).toEqual([]);
    expect(result.skipped.map((skip) => skip.reason)).toContain("untouched for 2h of 12h");
  });

  test("restarts its evidence when the directory changes", () => {
    // A clone still being written to: its mtime moves, so the stable run never reaches 3.
    const result = runSweeps(5, (sweep) => ({
      entries: [entry({ mtimeMs: NOW - 20 * HOUR + sweep })],
    }));
    expect(result.candidates).toEqual([]);
  });
});

describe("vetoes", () => {
  test("a process that references the UDID spares it", () => {
    const result = runSweeps(5, () => ({ referencedDeviceIds: new Set([UDID]) }));
    expect(result.candidates).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("a running process references it");
  });

  test("the reference check is case-insensitive about the UDID", () => {
    const lower = entry({ name: UDID.toLowerCase() });
    const result = runSweeps(5, () => ({
      entries: [lower],
      referencedDeviceIds: new Set([UDID]),
    }));
    expect(result.candidates).toEqual([]);
  });

  test("a device the cap holds a lease on is spared", () => {
    const result = runSweeps(5, () => ({ leasedDeviceIds: new Set([UDID]) }));
    expect(result.candidates).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("the device cap holds a lease on it");
  });

  test("an mtime ahead of the clock is spared rather than treated as ancient", () => {
    const result = runSweeps(5, () => ({ entries: [entry({ mtimeMs: NOW + HOUR })] }));
    expect(result.candidates).toEqual([]);
  });

  test("a directory the janitor already handled is never selected again", () => {
    const first = runSweeps(3, () => ({}));
    expect(first.candidates).toHaveLength(1);
    markTestArtifactHandled(first.memory, UDID, "reported");
    const second = evaluateTestArtifactCandidates(input({ previous: first.memory }));
    expect(second.candidates).toEqual([]);
  });
});

describe("obligation claims", () => {
  const obligation: TestRunObligation = {
    id: "ob-1",
    agentId: "dead-agent",
    setId: "xctest-devices",
    command: "xcodebuild test",
    startedAtMs: NOW - 3 * HOUR,
  };
  const fresh = entry({ mtimeMs: NOW - 2 * HOUR, birthtimeMs: NOW - 3 * HOUR + 1000 });

  test("takes a young directory the dead agent's run created", () => {
    const result = runSweeps(3, () => ({ entries: [fresh], obligations: [obligation] }));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      claim: "obligation",
      obligation: { agentId: "dead-agent", command: "xcodebuild test" },
    });
  });

  test("does not claim while its agent is still alive", () => {
    const result = runSweeps(3, () => ({
      entries: [fresh],
      obligations: [obligation],
      liveAgentIds: new Set(["dead-agent"]),
    }));
    expect(result.candidates).toEqual([]);
  });

  test("does not claim while any other agent is still running tests into the set", () => {
    // Two interleaved runs in one directory; a birth time cannot tell them apart, so nothing is
    // claimed until the machine is quiet.
    const alsoRunning: TestRunObligation = {
      ...obligation,
      id: "ob-2",
      agentId: "live-agent",
      startedAtMs: NOW - 1 * HOUR,
    };
    const result = runSweeps(3, () => ({
      entries: [fresh],
      obligations: [obligation, alsoRunning],
      liveAgentIds: new Set(["live-agent"]),
    }));
    expect(result.candidates).toEqual([]);
  });

  test("does not claim a directory that predates the run", () => {
    const older = entry({ mtimeMs: NOW - 2 * HOUR, birthtimeMs: NOW - 5 * HOUR });
    const result = runSweeps(3, () => ({ entries: [older], obligations: [obligation] }));
    expect(result.candidates).toEqual([]);
  });

  test("does not claim a directory with no birth time to prove it by", () => {
    const noBirth: TestArtifactEntry = { name: UDID, path: fresh.path, mtimeMs: NOW - 2 * HOUR };
    const result = runSweeps(3, () => ({ entries: [noBirth], obligations: [obligation] }));
    expect(result.candidates).toEqual([]);
  });

  test("waits out the grace window so xcodebuild's own cleanup is not raced", () => {
    const justEnded = entry({ mtimeMs: NOW - 60_000, birthtimeMs: NOW - 3 * HOUR + 1000 });
    const result = runSweeps(3, () => ({ entries: [justEnded], obligations: [obligation] }));
    expect(result.candidates).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("its run ended less than 10m ago");
  });

  test("forgets an obligation past its TTL", () => {
    const stale: TestRunObligation = { ...obligation, startedAtMs: NOW - 30 * HOUR };
    const result = runSweeps(3, () => ({ entries: [fresh], obligations: [stale] }));
    expect(result.obligations).toEqual([]);
    expect(result.candidates).toEqual([]);
  });
});

describe("blast radius", () => {
  test("caps a sweep at maxPerSweep, oldest first", () => {
    const entries = Array.from({ length: 5 }, (_, index) =>
      entry({
        name: `${OTHER_UDID.slice(0, 35)}${index}`,
        mtimeMs: NOW - (20 + index) * HOUR,
      }),
    );
    const result = runSweeps(3, () => ({
      entries,
      config: { ...CONFIG, maxPerSweep: 2 },
    }));
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].ageMs).toBeGreaterThan(result.candidates[1].ageMs);
  });
});
