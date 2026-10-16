import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readAndroidManifestInfo, readApkInfo } from "./android-manifest.js";
import { SharedBuildRefusal } from "./shared-build-store.js";
import {
  buildAndroidManifest,
  buildFakeApk,
  buildZip,
  stringPoolChunk,
} from "./test-utils/fake-archives.js";

let workDir: string;

async function writeApk(contents: Buffer): Promise<string> {
  const file = path.join(workDir, "app-debug.apk");
  await fs.writeFile(file, contents);
  return file;
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), "shared-builds-apk-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("readAndroidManifestInfo", () => {
  test("reads package, versionName and versionCode from a UTF-16 string pool", () => {
    const manifest = buildAndroidManifest({
      packageName: "com.example.fakecamp.debug",
      versionName: "2.3.0-debug",
      versionCode: 4021,
    });
    expect(readAndroidManifestInfo(manifest)).toEqual({
      packageName: "com.example.fakecamp.debug",
      versionName: "2.3.0-debug",
      versionCode: "4021",
    });
  });

  test("reads a UTF-8 string pool", () => {
    const manifest = buildAndroidManifest({
      packageName: "com.example.fake",
      versionName: "1.0",
      versionCode: 1,
      utf8: true,
    });
    expect(readAndroidManifestInfo(manifest)).toMatchObject({
      packageName: "com.example.fake",
      versionName: "1.0",
    });
  });

  test("refuses plain XML and truncated bytes", () => {
    expect(() => readAndroidManifestInfo(Buffer.from("<manifest/>"))).toThrow(/not a compiled/);
    const manifest = buildAndroidManifest({
      packageName: "com.example.fake",
      versionName: "1.0",
      versionCode: 1,
    });
    expect(() => readAndroidManifestInfo(manifest.subarray(0, 60))).toThrow();
  });
});

const POOL_STRINGS = [
  "versionCode",
  "versionName",
  "package",
  "manifest",
  "com.example.fake",
  "1.0",
];

/** The standard pool with one field patched, the way a hostile build would. */
function patchedPool(patch: (pool: Buffer) => void): Buffer {
  const pool = stringPoolChunk(POOL_STRINGS, false);
  patch(pool);
  return pool;
}

function manifestWithPool(pool: Buffer): Buffer {
  return buildAndroidManifest({
    packageName: "com.example.fake",
    versionName: "1.0",
    versionCode: 1,
    pool,
  });
}

describe("readAndroidManifestInfo on hostile manifests", () => {
  test("refuses a string pool whose offset table runs past its chunk", () => {
    const pool = patchedPool((bytes) => bytes.writeUInt32LE(100_000, 8));
    expect(() => readAndroidManifestInfo(manifestWithPool(pool))).toThrow(/string pool/);
  });

  test("does not read a string that runs past its chunk", () => {
    const pool = patchedPool((bytes) => {
      const stringsStart = bytes.readUInt32LE(20);
      const versionNameOffset = bytes.readUInt32LE(28 + 5 * 4);
      bytes.writeUInt16LE(0x7000, stringsStart + versionNameOffset);
    });
    expect(readAndroidManifestInfo(manifestWithPool(pool))).toEqual({
      packageName: "com.example.fake",
      versionName: null,
      versionCode: "1",
    });
  });

  test("does not read an absurdly long value", () => {
    const manifest = buildAndroidManifest({
      packageName: "com.example.fake",
      versionName: "1.".padEnd(5000, "0"),
      versionCode: 1,
    });
    expect(readAndroidManifestInfo(manifest).versionName).toBeNull();
  });

  test("a pool of a million entries pointing at one huge string is refused at once", () => {
    const count = 1_000_000;
    const headerSize = 32;
    const pool = Buffer.alloc(headerSize + count * 4 + 64);
    pool.writeUInt16LE(0x0001, 0);
    pool.writeUInt16LE(headerSize, 2);
    pool.writeUInt32LE(pool.length, 4);
    pool.writeUInt32LE(count, 8);
    // Every offset is 0, at the header's last 4 bytes: a UTF-16 length of 2^31 - 1 characters.
    pool.writeUInt32LE(28, 20);
    pool.writeUInt32LE(0xffffffff, 28);
    const started = performance.now();
    expect(() => readAndroidManifestInfo(manifestWithPool(pool))).toThrow(/not <manifest>/);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("readApkInfo", () => {
  test("reads the manifest out of an APK", async () => {
    const apk = await writeApk(
      buildFakeApk(
        buildAndroidManifest({
          packageName: "com.example.fakecamp",
          versionName: "2.3.0",
          versionCode: 7,
        }),
      ),
    );
    expect(await readApkInfo(apk)).toEqual({
      packageName: "com.example.fakecamp",
      versionName: "2.3.0",
      versionCode: "7",
    });
  });

  test("refuses an AAB renamed to .apk", async () => {
    const aab = await writeApk(
      buildZip([{ name: "base/manifest/AndroidManifest.xml", data: "protobuf bytes" }]),
    );
    const error = await readApkInfo(aab).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SharedBuildRefusal);
    expect((error as Error).message).toMatch(/no AndroidManifest.xml at its root/);
  });

  test("refuses a file that is not a zip", async () => {
    const apk = await writeApk(Buffer.from("not a zip, just some text pretending to be one"));
    await expect(readApkInfo(apk)).rejects.toThrow(/not a readable zip/);
  });
});
