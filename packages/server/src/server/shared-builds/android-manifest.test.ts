import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readAndroidManifestInfo, readApkInfo } from "./android-manifest.js";
import { SharedBuildRefusal } from "./shared-build-store.js";
import { buildAndroidManifest, buildFakeApk, buildZip } from "./test-utils/fake-archives.js";

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
