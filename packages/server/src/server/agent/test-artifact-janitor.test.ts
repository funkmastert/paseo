import { mkdir, mkdtemp, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parsePsOutput, type ProcessSampleRow } from "./process-sampler.js";
import {
  TestArtifactJanitor,
  type TestArtifactJanitorConfigInput,
} from "./test-artifact-janitor.js";
import { createSystemTestArtifactFileSystem } from "./test-artifact-fs.js";

const HOUR = 3_600_000;
const GIBIBYTE = 1024 ** 3;
const UDID = "1C56B10C-38C1-4547-ABDA-D36412FF01CA";
const OTHER_UDID = "3B6C2CCA-B90C-40FF-94A1-43373DF411E1";

let homeDir: string;
let setRoot: string;
/**
 * Starts at the real wall clock, and only ever moves forward from there. The obligation rules
 * compare a directory's `birthtime` — which the filesystem stamps, not this — against when the
 * run started, so a fake epoch would make every real clone look older than every obligation.
 */
let nowMs = Date.now();
let config: TestArtifactJanitorConfigInput;
let liveAgentIds: string[];
let leasedDeviceIds: string[];
const logs: Array<{ level: "info" | "warn"; obj: object; msg?: string }> = [];

const logger = {
  info: (obj: object, msg?: string) => logs.push({ level: "info", obj, msg }),
  warn: (obj: object, msg?: string) => logs.push({ level: "warn", obj, msg }),
};

function buildJanitor(): TestArtifactJanitor {
  return new TestArtifactJanitor({
    homeDir,
    readDaemonConfig: () => ({ artifactJanitor: config }),
    listAgentIds: () => liveAgentIds,
    listLeasedDeviceIds: () => leasedDeviceIds,
    logger,
    fileSystem: createSystemTestArtifactFileSystem(),
    now: () => nowMs,
  });
}

beforeEach(async () => {
  homeDir = await realpath(await mkdtemp(join(tmpdir(), "paseo-janitor-")));
  setRoot = join(homeDir, "Library", "Developer", "XCTestDevices");
  await mkdir(setRoot, { recursive: true });
  nowMs = Date.now();
  liveAgentIds = [];
  leasedDeviceIds = [];
  logs.length = 0;
  config = { enabled: true };
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

/**
 * A clone, as Xcode leaves one: a `device.plist` and a `data` directory.
 *
 * `ageMs` backdates it. That also drags its `birthtime` back — macOS clamps birth time to be no
 * later than mtime — which is why a test about an obligation ages the janitor's clock forward
 * instead of backdating the directory. Real clones are never backdated, so their birth time is
 * the one thing an obligation can safely be proven against.
 */
async function makeClone(name: string, ageMs: number): Promise<string> {
  const path = join(setRoot, name);
  await mkdir(join(path, "data"), { recursive: true });
  await writeFile(join(path, "device.plist"), "<plist/>");
  if (ageMs > 0) {
    const seconds = (nowMs - ageMs) / 1000;
    await utimes(path, seconds, seconds);
  }
  return path;
}

function psRows(commands: readonly string[]): ProcessSampleRow[] {
  const header = "  PID  PPID   UID    RSS  %CPU     ELAPSED      TIME COMMAND";
  const lines = commands.map(
    (command, index) =>
      `  ${100 + index}     1   501   1000   0.0    01:00:00  00:00:01 ${command}`,
  );
  return parsePsOutput([header, ...lines].join("\n"));
}

/** Runs `count` sweeps a minute apart, which is the resource monitor's cadence. */
async function sweepTimes(
  janitor: TestArtifactJanitor,
  count: number,
  rows: readonly ProcessSampleRow[] = [],
) {
  let result = await janitor.sweep({ rows });
  for (let index = 1; index < count; index += 1) {
    nowMs += 60_000;
    result = await janitor.sweep({ rows });
  }
  return result;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("off by default", () => {
  test("an absent config block reclaims nothing", async () => {
    const path = await makeClone(UDID, 40 * HOUR);
    config = {};
    const janitor = buildJanitor();
    const result = await sweepTimes(janitor, 5);
    expect(result.reclaimed).toEqual([]);
    expect(await exists(path)).toBe(true);
  });

  test("turning it on starts the evidence over rather than acting on old sweeps", async () => {
    const path = await makeClone(UDID, 40 * HOUR);
    config = { enabled: false };
    const janitor = buildJanitor();
    await sweepTimes(janitor, 5);

    config = { enabled: true };
    nowMs += 60_000;
    // The first sweep after turning it on is a first sighting, not a third.
    expect((await janitor.sweep({ rows: [] })).reclaimed).toEqual([]);
    expect(await exists(path)).toBe(true);
  });
});

describe("the unowned sweep", () => {
  test("reclaims a clone nobody references after the wait", async () => {
    const path = await makeClone(UDID, 40 * HOUR);
    const janitor = buildJanitor();

    expect((await sweepTimes(janitor, 2)).reclaimed).toEqual([]);
    expect(await exists(path)).toBe(true);

    nowMs += 60_000;
    const result = await janitor.sweep({ rows: [] });
    expect(result.reclaimed).toHaveLength(1);
    expect(result.reclaimed[0]).toMatchObject({
      name: UDID,
      path,
      claim: "unowned",
      label: "Xcode test simulator clones",
    });
    expect(result.reclaimed[0].sizeBytes).toBeGreaterThan(0);
    expect(await exists(path)).toBe(false);
  });

  test("spares a clone whose simulator is booted", async () => {
    const path = await makeClone(UDID, 40 * HOUR);
    const janitor = buildJanitor();
    const booted = psRows([`launchd_sim ${setRoot}/${UDID}/data/var/run/launchd_bootstrap.plist`]);

    expect((await sweepTimes(janitor, 5, booted)).reclaimed).toEqual([]);
    expect(await exists(path)).toBe(true);
  });

  test("spares a clone an xcodebuild run still names", async () => {
    const path = await makeClone(UDID, 40 * HOUR);
    const janitor = buildJanitor();
    const running = psRows([
      `/usr/bin/xcodebuild test -destination platform=iOS Simulator,id=${UDID}`,
    ]);

    expect((await sweepTimes(janitor, 5, running)).reclaimed).toEqual([]);
    expect(await exists(path)).toBe(true);
  });

  test("spares a clone the device cap holds a lease on", async () => {
    const path = await makeClone(UDID, 40 * HOUR);
    leasedDeviceIds = [UDID.toLowerCase()];
    const janitor = buildJanitor();

    expect((await sweepTimes(janitor, 5)).reclaimed).toEqual([]);
    expect(await exists(path)).toBe(true);
  });

  test("leaves everything that is not a clone alone", async () => {
    await makeClone(UDID, 40 * HOUR);
    const plist = join(setRoot, "device_set.plist");
    await writeFile(plist, "<plist/>");
    const janitor = buildJanitor();

    await sweepTimes(janitor, 3);
    expect(await exists(plist)).toBe(true);
  });
});

describe("dry run", () => {
  test("reports the path, size and reason and deletes nothing", async () => {
    const path = await makeClone(UDID, 40 * HOUR);
    config = { enabled: true, dryRun: true };
    const janitor = buildJanitor();

    const result = await sweepTimes(janitor, 3);
    expect(result.dryRun).toBe(true);
    expect(result.reclaimed).toHaveLength(1);
    expect(await exists(path)).toBe(true);

    const reported = logs.find((entry) => entry.msg === "Artifact janitor would reclaim");
    expect(reported?.obj).toMatchObject({ path, claim: "unowned", dryRun: true });
  });

  test("reports each directory once, not once a minute", async () => {
    await makeClone(UDID, 40 * HOUR);
    config = { enabled: true, dryRun: true };
    const janitor = buildJanitor();

    await sweepTimes(janitor, 3);
    nowMs += 60_000;
    expect((await janitor.sweep({ rows: [] })).reclaimed).toEqual([]);
  });
});

describe("obligations", () => {
  test("reclaim a young clone once the agent that made it is gone", async () => {
    const janitor = buildJanitor();
    liveAgentIds = ["agent-a"];
    janitor.noteTestRunLaunch({
      agentId: "agent-a",
      setId: "xctest-devices",
      command: "xcodebuild test",
    });
    // Created by that run, then the agent died. Two hours later it is still far short of the
    // 12h the unowned rules would make it wait.
    const path = await makeClone(UDID, 0);
    liveAgentIds = [];
    nowMs += 2 * HOUR;

    const result = await sweepTimes(janitor, 3);
    expect(result.reclaimed).toHaveLength(1);
    expect(result.reclaimed[0]).toMatchObject({ claim: "obligation", agentId: "agent-a" });
    expect(await exists(path)).toBe(false);
  });

  test("do not reclaim while the agent is still running", async () => {
    const janitor = buildJanitor();
    liveAgentIds = ["agent-a"];
    janitor.noteTestRunLaunch({
      agentId: "agent-a",
      setId: "xctest-devices",
      command: "xcodebuild test",
    });
    const path = await makeClone(UDID, 0);
    nowMs += 2 * HOUR;

    expect((await sweepTimes(janitor, 5)).reclaimed).toEqual([]);
    expect(await exists(path)).toBe(true);
  });

  test("do not reclaim while another agent is still testing into the same set", async () => {
    const janitor = buildJanitor();
    liveAgentIds = ["agent-a", "agent-b"];
    for (const agentId of ["agent-a", "agent-b"]) {
      janitor.noteTestRunLaunch({ agentId, setId: "xctest-devices", command: "xcodebuild test" });
    }
    const path = await makeClone(UDID, 0);
    liveAgentIds = ["agent-b"];
    nowMs += 2 * HOUR;

    expect((await sweepTimes(janitor, 5)).reclaimed).toEqual([]);
    expect(await exists(path)).toBe(true);
  });

  test("are not taken on while the janitor is off", async () => {
    config = { enabled: false };
    const janitor = buildJanitor();
    janitor.noteTestRunLaunch({
      agentId: "agent-a",
      setId: "xctest-devices",
      command: "xcodebuild test",
    });
    const path = await makeClone(UDID, 0);
    nowMs += 2 * HOUR;

    config = { enabled: true };
    expect((await sweepTimes(janitor, 5)).reclaimed).toEqual([]);
    expect(await exists(path)).toBe(true);
  });
});

describe("blast radius", () => {
  test("stops at maxPerSweep", async () => {
    await makeClone(UDID, 40 * HOUR);
    await makeClone(OTHER_UDID, 30 * HOUR);
    config = { enabled: true, maxPerSweep: 1 };
    const janitor = buildJanitor();

    const result = await sweepTimes(janitor, 3);
    expect(result.reclaimed).toHaveLength(1);
    // Oldest first.
    expect(result.reclaimed[0].name).toBe(UDID);
  });

  test("stops at the byte budget and picks the rest up next sweep", async () => {
    const first = await makeClone(UDID, 40 * HOUR);
    const second = await makeClone(OTHER_UDID, 30 * HOUR);
    // Small enough that one clone fits and two do not.
    config = { enabled: true, maxBytesPerSweep: 4096 };
    const janitor = buildJanitor();

    const result = await sweepTimes(janitor, 3);
    expect(result.reclaimed).toHaveLength(1);
    expect(await exists(first)).toBe(false);
    expect(await exists(second)).toBe(true);

    nowMs += 60_000;
    expect((await janitor.sweep({ rows: [] })).reclaimed).toHaveLength(1);
    expect(await exists(second)).toBe(false);
  });
});

describe("disk guard", () => {
  test("is off unless it is turned on", async () => {
    expect(await buildJanitor().evaluateDiskGuard()).toEqual({ ok: true });
  });

  test("refuses below the floor and says by how much", async () => {
    config = { diskGuard: { enabled: true, minFreeBytes: Number.MAX_SAFE_INTEGER } };
    const verdict = await buildJanitor().evaluateDiskGuard();
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.message).toMatch(/free and the floor is/);
  });

  test("allows when there is room", async () => {
    config = { diskGuard: { enabled: true, minFreeBytes: 1 } };
    expect(await buildJanitor().evaluateDiskGuard()).toEqual({ ok: true });
  });

  test("allows when free space cannot be read", async () => {
    config = { diskGuard: { enabled: true, minFreeBytes: 20 * GIBIBYTE } };
    const janitor = new TestArtifactJanitor({
      homeDir,
      readDaemonConfig: () => ({ artifactJanitor: config }),
      listAgentIds: () => liveAgentIds,
      listLeasedDeviceIds: () => leasedDeviceIds,
      logger,
      fileSystem: {
        ...createSystemTestArtifactFileSystem(),
        readFreeBytes: async () => undefined,
      },
      now: () => nowMs,
    });
    expect(await janitor.evaluateDiskGuard()).toEqual({ ok: true });
  });
});
