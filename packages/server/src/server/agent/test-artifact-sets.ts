/**
 * The allowlist of directories the artifact janitor may ever remove something from, and the
 * path rules that decide whether one specific child of one of them is removable.
 *
 * This is the narrowest part of the feature on purpose. Everything else — obligations, sweep
 * evidence, booted-device vetoes — decides *whether* to reclaim. This decides *what a reclaimable
 * thing can even be*, and nothing outside what it returns is ever passed to a remove call.
 * See docs/artifact-janitor.md.
 */

import { isAbsolute, join, sep } from "node:path";

export type TestArtifactSetId = "xctest-devices";

export interface TestArtifactSet {
  id: TestArtifactSetId;
  /** For logs and notifications. Never free text from a filesystem entry. */
  label: string;
  /**
   * Path segments below the user's home directory. Split rather than a string so a set can
   * never be written with a `..` component or an absolute path by accident.
   */
  segments: readonly string[];
}

/**
 * One entry, and only after it was verified on a real machine.
 *
 * `~/Library/Developer/XCTestDevices` is the device set `xcodebuild test` clones simulators
 * into when parallel testing is on. Verified from CoreSimulator's own log:
 * `Failed to clone the device data path from …/CoreSimulator/Devices/<template>/data to
 * …/XCTestDevices/<UDID>/data`, and `Clone 3 of iPhone 16 Pro (<UDID>, iOS 26.5, Creating)`.
 * Xcode deletes these when a test run finishes; a run that is killed leaves them, and nothing
 * on the machine ever comes back for them — the same 125 UDIDs are logged as unloadable on
 * every CoreSimulatorService start for weeks.
 *
 * Deliberately absent, and see docs/artifact-janitor.md for why: `DerivedData` (live build
 * state a developer is depending on), `CoreSimulator/Devices` (the user's own simulators, with
 * their installed apps and state), and `XCPGDevices` (playground device set — same shape, but
 * it has never held anything on this machine, and an unverified entry is how an allowlist stops
 * being one).
 */
export const TEST_ARTIFACT_SETS: readonly TestArtifactSet[] = [
  {
    id: "xctest-devices",
    label: "Xcode test simulator clones",
    segments: ["Library", "Developer", "XCTestDevices"],
  },
];

export function findTestArtifactSet(id: TestArtifactSetId): TestArtifactSet | undefined {
  return TEST_ARTIFACT_SETS.find((set) => set.id === id);
}

export function resolveTestArtifactSetRoot(homeDir: string, set: TestArtifactSet): string {
  return join(homeDir, ...set.segments);
}

/**
 * A CoreSimulator device directory is named by its UDID and nothing else. Anchored, canonical
 * 8-4-4-4-12, so `device.plist`, `.DS_Store`, a stray `tmp` directory, and a UDID with a suffix
 * are all outside the set of removable names. Everything in the set root that is not this shape
 * is reported and left alone.
 */
const DEVICE_UDID_DIRECTORY = /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;

export function isDeviceUdidDirectoryName(name: string): boolean {
  return DEVICE_UDID_DIRECTORY.test(name);
}

export type RemovablePathVerdict =
  | { removable: true; path: string }
  | { removable: false; reason: string };

/**
 * The last check before a path reaches a remove call, expressed over paths that have already
 * been through `realpath`. Every rule is a way for the path to be something other than "a
 * simulator clone directly inside a set root we resolved ourselves":
 *
 *  - both paths absolute, so a relative path can never be resolved against the daemon's cwd;
 *  - the entry name is a canonical UDID;
 *  - the resolved entry is exactly `<resolved root>/<name>` — which is what a symlink out of
 *    the tree, a `..` component, and a bind-mount escape all fail.
 *
 * The root equality check is the one that matters: `startsWith` would accept
 * `/…/XCTestDevices-old/<UDID>`, and a depth check alone would accept a symlink pointing at
 * `~/Documents`. Nothing here trusts the caller to have done any of it.
 */
export function evaluateRemovableArtifactPath(input: {
  resolvedRootPath: string;
  entryName: string;
  resolvedEntryPath: string;
}): RemovablePathVerdict {
  if (!isAbsolute(input.resolvedRootPath) || !isAbsolute(input.resolvedEntryPath)) {
    return { removable: false, reason: "path is not absolute" };
  }
  if (input.resolvedRootPath === sep) {
    return { removable: false, reason: "artifact set root resolved to the filesystem root" };
  }
  if (!isDeviceUdidDirectoryName(input.entryName)) {
    return { removable: false, reason: "entry is not named by a device UDID" };
  }
  const expected = join(input.resolvedRootPath, input.entryName);
  if (input.resolvedEntryPath !== expected) {
    return {
      removable: false,
      reason: `entry resolves outside its artifact set (${input.resolvedEntryPath})`,
    };
  }
  return { removable: true, path: expected };
}
