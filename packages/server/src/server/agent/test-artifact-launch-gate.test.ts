import { describe, expect, test, vi } from "vitest";
import type { DeviceLaunchGate } from "./device-lease-manager.js";
import type { TestArtifactJanitor } from "./test-artifact-janitor.js";
import { createArtifactAwareLaunchGate } from "./test-artifact-launch-gate.js";

const SIM_DESTINATION = "'platform=iOS Simulator,name=iPhone 16 Pro'";
const TEST_COMMAND = `xcodebuild test -scheme App -destination ${SIM_DESTINATION}`;

const logger = { info: () => undefined, warn: () => undefined };

interface Harness {
  gate: DeviceLaunchGate;
  inner: DeviceLaunchGate & { gateLaunch: ReturnType<typeof vi.fn> };
  noteTestRunLaunch: ReturnType<typeof vi.fn>;
  evaluateDiskGuard: ReturnType<typeof vi.fn>;
}

function harness(options: {
  diskGuard?: Awaited<ReturnType<TestArtifactJanitor["evaluateDiskGuard"]>> | Error;
  diskGuardDryRun?: boolean;
  innerDecision?: Awaited<ReturnType<DeviceLaunchGate["gateLaunch"]>>;
}): Harness {
  const noteTestRunLaunch = vi.fn();
  const evaluateDiskGuard = vi.fn(async () => {
    if (options.diskGuard instanceof Error) throw options.diskGuard;
    return options.diskGuard ?? { ok: true as const };
  });
  const inner = {
    gateLaunch: vi.fn(async () => options.innerDecision ?? { decision: "allow" as const }),
  };
  const janitor = {
    noteTestRunLaunch,
    evaluateDiskGuard,
    isDiskGuardDryRun: () => options.diskGuardDryRun ?? false,
  } as unknown as TestArtifactJanitor;

  return {
    gate: createArtifactAwareLaunchGate({ janitor, inner, logger }),
    inner,
    noteTestRunLaunch,
    evaluateDiskGuard,
  };
}

describe("cleanup obligations", () => {
  test("a test run is registered before the command is allowed through", async () => {
    const { gate, noteTestRunLaunch, inner } = harness({});
    await gate.gateLaunch({ agentId: "agent-a", command: TEST_COMMAND });

    expect(noteTestRunLaunch).toHaveBeenCalledWith({
      agentId: "agent-a",
      setId: "xctest-devices",
      command: "xcodebuild test",
    });
    expect(inner.gateLaunch).toHaveBeenCalledOnce();
  });

  test("a command that clones nothing registers nothing", async () => {
    const { gate, noteTestRunLaunch } = harness({});
    await gate.gateLaunch({ agentId: "agent-a", command: "git status" });
    await gate.gateLaunch({ agentId: "agent-a", command: "xcrun simctl boot 'iPhone 16 Pro'" });
    expect(noteTestRunLaunch).not.toHaveBeenCalled();
  });

  test("a refused launch takes on no obligation, because it never ran", async () => {
    const { gate, noteTestRunLaunch } = harness({
      diskGuard: { ok: false, freeBytes: 1, minFreeBytes: 2, message: "no room" },
    });
    const decision = await gate.gateLaunch({ agentId: "agent-a", command: TEST_COMMAND });
    expect(decision.decision).toBe("deny");
    expect(noteTestRunLaunch).not.toHaveBeenCalled();
  });
});

describe("the disk guard", () => {
  test("refuses a test launch with no room and says what to do", async () => {
    const { gate, inner } = harness({
      diskGuard: { ok: false, freeBytes: 1, minFreeBytes: 2, message: "the volume is full" },
    });
    const decision = await gate.gateLaunch({ agentId: "agent-a", command: TEST_COMMAND });

    expect(decision).toEqual({
      decision: "deny",
      message: expect.stringContaining("the volume is full"),
    });
    if (decision.decision !== "deny") throw new Error("expected a denial");
    expect(decision.message).toContain("xcodebuild test");
    expect(decision.message).toContain("Do not retry");
    // Never reaches the device cap: no slot is spent on a launch that cannot succeed.
    expect(inner.gateLaunch).not.toHaveBeenCalled();
  });

  test("refuses a plain device boot too, not just a test run", async () => {
    const { gate } = harness({
      diskGuard: { ok: false, freeBytes: 1, minFreeBytes: 2, message: "the volume is full" },
    });
    const decision = await gate.gateLaunch({
      agentId: "agent-a",
      command: "xcrun simctl boot 1C56B10C-38C1-4547-ABDA-D36412FF01CA",
    });
    expect(decision.decision).toBe("deny");
  });

  test("never weighs a command that boots nothing", async () => {
    const { gate, evaluateDiskGuard, inner } = harness({
      diskGuard: { ok: false, freeBytes: 1, minFreeBytes: 2, message: "the volume is full" },
    });
    const decision = await gate.gateLaunch({ agentId: "agent-a", command: "rm -rf DerivedData" });

    expect(decision).toEqual({ decision: "allow" });
    expect(evaluateDiskGuard).not.toHaveBeenCalled();
    expect(inner.gateLaunch).toHaveBeenCalledOnce();
  });

  test("in dry run it reports and allows", async () => {
    const { gate, inner } = harness({
      diskGuard: { ok: false, freeBytes: 1, minFreeBytes: 2, message: "the volume is full" },
      diskGuardDryRun: true,
    });
    expect(await gate.gateLaunch({ agentId: "agent-a", command: TEST_COMMAND })).toEqual({
      decision: "allow",
    });
    expect(inner.gateLaunch).toHaveBeenCalledOnce();
  });

  test("fails open when it cannot be evaluated", async () => {
    const { gate, inner } = harness({ diskGuard: new Error("statfs exploded") });
    expect(await gate.gateLaunch({ agentId: "agent-a", command: TEST_COMMAND })).toEqual({
      decision: "allow",
    });
    expect(inner.gateLaunch).toHaveBeenCalledOnce();
  });
});

describe("the device cap underneath", () => {
  test("its denial is passed through unchanged", async () => {
    const denial = { decision: "deny" as const, message: "Bozeo device cap: no slot" };
    const { gate } = harness({ innerDecision: denial });
    expect(await gate.gateLaunch({ agentId: "agent-a", command: TEST_COMMAND })).toEqual(denial);
  });
});
