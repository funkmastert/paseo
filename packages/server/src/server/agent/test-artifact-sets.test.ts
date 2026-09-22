import { describe, expect, test } from "vitest";
import {
  evaluateRemovableArtifactPath,
  isDeviceUdidDirectoryName,
  resolveTestArtifactSetRoot,
  TEST_ARTIFACT_SETS,
} from "./test-artifact-sets.js";

const ROOT = "/Users/t/Library/Developer/XCTestDevices";
const UDID = "1C56B10C-38C1-4547-ABDA-D36412FF01CA";

describe("artifact set roots", () => {
  test("resolve below the home directory and nowhere else", () => {
    for (const set of TEST_ARTIFACT_SETS) {
      expect(resolveTestArtifactSetRoot("/Users/t", set)).toBe(
        `/Users/t/${set.segments.join("/")}`,
      );
      expect(set.segments).not.toContain("..");
    }
  });

  test("the allowlist covers XCTestDevices and nothing else", () => {
    expect(TEST_ARTIFACT_SETS.map((set) => set.id)).toEqual(["xctest-devices"]);
  });
});

describe("isDeviceUdidDirectoryName", () => {
  test("accepts a canonical UDID in either case", () => {
    expect(isDeviceUdidDirectoryName(UDID)).toBe(true);
    expect(isDeviceUdidDirectoryName(UDID.toLowerCase())).toBe(true);
  });

  test("rejects everything else a device set root can contain", () => {
    for (const name of [
      "device_set.plist",
      ".DS_Store",
      "tmp",
      `${UDID}.backup`,
      `x${UDID}`,
      UDID.replace("-", ""),
      "",
      "..",
    ]) {
      expect(isDeviceUdidDirectoryName(name)).toBe(false);
    }
  });
});

describe("evaluateRemovableArtifactPath", () => {
  test("accepts a UDID directory sitting exactly inside its set root", () => {
    expect(
      evaluateRemovableArtifactPath({
        resolvedRootPath: ROOT,
        entryName: UDID,
        resolvedEntryPath: `${ROOT}/${UDID}`,
      }),
    ).toEqual({ removable: true, path: `${ROOT}/${UDID}` });
  });

  test("refuses an entry that resolves outside the root", () => {
    // What a symlink pointing at the home directory looks like after realpath.
    const verdict = evaluateRemovableArtifactPath({
      resolvedRootPath: ROOT,
      entryName: UDID,
      resolvedEntryPath: "/Users/t/Documents",
    });
    expect(verdict.removable).toBe(false);
  });

  test("refuses a sibling root with the same prefix", () => {
    const verdict = evaluateRemovableArtifactPath({
      resolvedRootPath: ROOT,
      entryName: UDID,
      resolvedEntryPath: `${ROOT}-old/${UDID}`,
    });
    expect(verdict.removable).toBe(false);
  });

  test("refuses a nested path even inside the root", () => {
    const verdict = evaluateRemovableArtifactPath({
      resolvedRootPath: ROOT,
      entryName: UDID,
      resolvedEntryPath: `${ROOT}/${UDID}/data`,
    });
    expect(verdict.removable).toBe(false);
  });

  test("refuses a non-UDID name", () => {
    const verdict = evaluateRemovableArtifactPath({
      resolvedRootPath: ROOT,
      entryName: "data",
      resolvedEntryPath: `${ROOT}/data`,
    });
    expect(verdict.removable).toBe(false);
  });

  test("refuses a relative path and the filesystem root", () => {
    expect(
      evaluateRemovableArtifactPath({
        resolvedRootPath: "Library/Developer/XCTestDevices",
        entryName: UDID,
        resolvedEntryPath: `Library/Developer/XCTestDevices/${UDID}`,
      }).removable,
    ).toBe(false);
    expect(
      evaluateRemovableArtifactPath({
        resolvedRootPath: "/",
        entryName: UDID,
        resolvedEntryPath: `/${UDID}`,
      }).removable,
    ).toBe(false);
  });
});
