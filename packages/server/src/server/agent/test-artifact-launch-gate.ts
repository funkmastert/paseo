/**
 * Wraps the device cap's launch gate so the artifact janitor sees the same commands it does,
 * without either one knowing about the other. Composed in bootstrap.ts; the providers keep
 * taking a plain `DeviceLaunchGate` and nothing downstream changes.
 *
 * Two jobs, in the order that matters:
 *
 *   - **Refuse a launch onto a full volume.** The device cap already refuses when memory
 *     headroom is gone; free disk is the same class of problem and fails harder, because a full
 *     volume takes down every agent on the machine rather than the one that asked. This runs
 *     first, so a machine with no disk never gets as far as spending a device slot.
 *   - **Register a cleanup obligation** for a test run that clones simulators, so the janitor has
 *     an owner for whatever the run leaves behind if it is killed (docs/artifact-janitor.md).
 *
 * Deliberately a decorator rather than another leg inside device-lease-manager.ts. The disk
 * guard has to work with the device cap turned off — disk fills up whether or not anybody is
 * counting simulators — and the obligation is over a directory, which is not a thing the lease
 * table has any concept of.
 */

import type { DeviceLaunchGate, DeviceLaunchGateDecision } from "./device-lease-manager.js";
import { detectDeviceLaunchIntents } from "./device-launch-commands.js";
import { detectTestRunIntents } from "./test-run-commands.js";
import type { TestArtifactJanitor } from "./test-artifact-janitor.js";

interface ArtifactAwareLaunchGateLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

export interface ArtifactAwareLaunchGateOptions {
  janitor: TestArtifactJanitor;
  /** The device cap. Every command the disk guard allows is passed straight through to it. */
  inner: DeviceLaunchGate;
  logger: ArtifactAwareLaunchGateLogger;
}

function buildDiskDenial(command: string, reason: string): string {
  return (
    `Bozeo disk guard: \`${command}\` was not run because ${reason}. ` +
    "Do not retry the command and do not work around the guard — a full volume takes down " +
    "every agent on this machine, not just yours. Free space first: `xcrun simctl delete " +
    "unavailable`, remove stale DerivedData for projects you are done with, or ask the person " +
    "at the keyboard. Then run the command again."
  );
}

export function createArtifactAwareLaunchGate(
  options: ArtifactAwareLaunchGateOptions,
): DeviceLaunchGate {
  return {
    async gateLaunch(input) {
      const decision = await runDiskGuard(options, input);
      if (decision) return decision;
      noteTestRuns(options, input);
      return await options.inner.gateLaunch(input);
    },
  };
}

/**
 * Only commands that would boot a device or run tests are weighed against free disk. A guard on
 * every shell command would refuse `git status` on a full volume, which helps nobody and breaks
 * the one thing that might fix it.
 */
async function runDiskGuard(
  options: ArtifactAwareLaunchGateOptions,
  input: { agentId: string; command: string },
): Promise<DeviceLaunchGateDecision | undefined> {
  const launches = detectDeviceLaunchIntents(input.command);
  const testRuns = detectTestRunIntents(input.command);
  // The test-run label first: `xcodebuild test` says more in a denial than the
  // `xcodebuild -destination` the device matcher sees in the same command line.
  const label = testRuns[0]?.command ?? launches[0]?.command;
  if (label === undefined) return undefined;

  // Fails open on every uncertainty, like the device gate it wraps: a guard that breaks tool
  // calls is worse than one that misses a launch.
  let verdict: Awaited<ReturnType<TestArtifactJanitor["evaluateDiskGuard"]>>;
  try {
    verdict = await options.janitor.evaluateDiskGuard();
  } catch (error) {
    options.logger.warn({ err: error }, "Disk guard failed to read free space; allowing");
    return undefined;
  }
  if (verdict.ok) return undefined;

  if (options.janitor.isDiskGuardDryRun()) {
    options.logger.info(
      { dryRun: true, agentId: input.agentId, command: label, freeBytes: verdict.freeBytes },
      "Disk guard would have refused a launch",
    );
    return undefined;
  }
  options.logger.info(
    { agentId: input.agentId, command: label, freeBytes: verdict.freeBytes },
    "Disk guard refused a launch",
  );
  return { decision: "deny", message: buildDiskDenial(label, verdict.message) };
}

function noteTestRuns(
  options: ArtifactAwareLaunchGateOptions,
  input: { agentId: string; command: string },
): void {
  for (const intent of detectTestRunIntents(input.command)) {
    options.janitor.noteTestRunLaunch({
      agentId: input.agentId,
      setId: intent.setId,
      command: intent.command,
    });
  }
}
