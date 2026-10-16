import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createSystemTestArtifactFileSystem } from "./test-artifact-fs.js";

const UDID = "1C56B10C-38C1-4547-ABDA-D36412FF01CA";
const OTHER_UDID = "3B6C2CCA-B90C-40FF-94A1-43373DF411E1";

let tempRoot: string;
let setRoot: string;
const fileSystem = createSystemTestArtifactFileSystem();

beforeEach(async () => {
  // `realpath` up front because on macOS `/var` is a symlink to `/private/var`, and `remove`
  // deliberately refuses a root it was handed unresolved — see the last test in this block.
  tempRoot = await realpath(await mkdtemp(join(tmpdir(), "paseo-artifact-")));
  setRoot = join(tempRoot, "XCTestDevices");
  await mkdir(setRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function makeClone(name: string): Promise<string> {
  const path = join(setRoot, name);
  await mkdir(join(path, "data", "Library"), { recursive: true });
  await writeFile(join(path, "device.plist"), "<plist/>");
  await writeFile(join(path, "data", "Library", "big"), "x".repeat(4096));
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("scan", () => {
  test("returns UDID directories with their times", async () => {
    await makeClone(UDID);
    const scan = await fileSystem.scan(setRoot);
    expect(scan.resolvedRootPath).toBeDefined();
    expect(scan.entries).toHaveLength(1);
    expect(scan.entries[0].name).toBe(UDID);
    expect(scan.entries[0].mtimeMs).toBeGreaterThan(0);
  });

  test("reports non-UDID names and files instead of returning them", async () => {
    await makeClone(UDID);
    await writeFile(join(setRoot, "device_set.plist"), "<plist/>");
    await mkdir(join(setRoot, "scratch"));
    await writeFile(join(setRoot, OTHER_UDID), "not a directory");

    const scan = await fileSystem.scan(setRoot);
    expect(scan.entries.map((entry) => entry.name)).toEqual([UDID]);
    expect(scan.skipped).toEqual(
      expect.arrayContaining([
        { name: "device_set.plist", reason: "not named by a device UDID" },
        { name: "scratch", reason: "not named by a device UDID" },
        { name: OTHER_UDID, reason: "not a directory" },
      ]),
    );
  });

  test("never follows a symlink, even one named like a UDID", async () => {
    const outside = join(tempRoot, "precious");
    await mkdir(outside);
    await symlink(outside, join(setRoot, UDID));

    const scan = await fileSystem.scan(setRoot);
    expect(scan.entries).toEqual([]);
    expect(scan.skipped).toEqual([{ name: UDID, reason: "not a directory" }]);
  });

  test("a root that does not exist is not an error", async () => {
    const scan = await fileSystem.scan(join(tempRoot, "nothing-here"));
    expect(scan).toEqual({ resolvedRootPath: undefined, entries: [], skipped: [] });
  });
});

describe("measureSizeBytes", () => {
  test("reports a clone's size", async () => {
    const path = await makeClone(UDID);
    const bytes = await fileSystem.measureSizeBytes(path);
    expect(bytes).toBeGreaterThan(0);
  });

  test("returns undefined rather than 0 for a path that is gone", async () => {
    expect(await fileSystem.measureSizeBytes(join(setRoot, "missing"))).toBeUndefined();
  });
});

describe("remove", () => {
  test("removes exactly the named clone", async () => {
    const target = await makeClone(UDID);
    const neighbour = await makeClone(OTHER_UDID);
    const { resolvedRootPath } = await fileSystem.scan(setRoot);

    await fileSystem.remove({
      resolvedRootPath: resolvedRootPath as string,
      entryName: UDID,
    });
    expect(await exists(target)).toBe(false);
    expect(await exists(neighbour)).toBe(true);
  });

  test("refuses a name that is not a UDID", async () => {
    await mkdir(join(setRoot, "scratch"));
    await expect(
      fileSystem.remove({ resolvedRootPath: setRoot, entryName: "scratch" }),
    ).rejects.toThrow(/not named by a device UDID/);
    expect(await exists(join(setRoot, "scratch"))).toBe(true);
  });

  test("refuses a path escape and leaves the target alone", async () => {
    const outside = join(tempRoot, "precious");
    await mkdir(outside);
    await expect(
      fileSystem.remove({ resolvedRootPath: setRoot, entryName: `../precious` }),
    ).rejects.toThrow();
    expect(await exists(outside)).toBe(true);
  });

  test("refuses a symlink pointing out of the tree", async () => {
    const outside = join(tempRoot, "precious");
    await mkdir(outside);
    await writeFile(join(outside, "keepme"), "important");
    await symlink(outside, join(setRoot, UDID));

    await expect(fileSystem.remove({ resolvedRootPath: setRoot, entryName: UDID })).rejects.toThrow(
      /not a directory/,
    );
    expect(await exists(join(outside, "keepme"))).toBe(true);
  });

  test("unlinks a symlink inside a clone rather than deleting what it points at", async () => {
    // The clone itself is legitimate; something inside it links out of the tree. `rm -rf` that
    // followed it would take the home directory with it.
    const target = await makeClone(UDID);
    const outside = join(tempRoot, "precious");
    await mkdir(outside);
    await writeFile(join(outside, "keepme"), "important");
    await symlink(outside, join(target, "data", "escape"));

    await fileSystem.remove({ resolvedRootPath: setRoot, entryName: UDID });
    expect(await exists(target)).toBe(false);
    expect(await exists(join(outside, "keepme"))).toBe(true);
  });

  test("refuses a clone that is already gone rather than reporting a reclaim", async () => {
    await expect(
      fileSystem.remove({ resolvedRootPath: setRoot, entryName: UDID }),
    ).rejects.toThrow();
  });

  test("refuses a root it was handed unresolved", async () => {
    // The janitor always passes the root `scan` resolved. A caller that passes a path with a
    // symlink in it — `/var/...` on macOS — is a caller whose idea of the root disagrees with
    // the filesystem's, and the safe answer to that is no.
    const target = await makeClone(UDID);
    const viaSymlink = join(tempRoot, "XCTestDevices-link");
    await symlink(setRoot, viaSymlink);

    await expect(
      fileSystem.remove({ resolvedRootPath: viaSymlink, entryName: UDID }),
    ).rejects.toThrow(/resolves outside its artifact set/);
    expect(await exists(target)).toBe(true);
  });
});

describe("readFreeBytes", () => {
  test("reports free space on the volume holding a path", async () => {
    const free = await fileSystem.readFreeBytes(tempRoot);
    expect(free).toBeGreaterThan(0);
  });

  test("returns undefined for a path it cannot read", async () => {
    expect(await fileSystem.readFreeBytes(join(tempRoot, "nothing", "here"))).toBeUndefined();
  });
});
