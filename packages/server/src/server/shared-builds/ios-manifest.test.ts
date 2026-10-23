import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  buildIosInstallLink,
  finishIosShare,
  IOS_INSTALL_PAGE_FILE,
  IOS_MANIFEST_FILE,
  readIpaInfo,
} from "./ios-manifest.js";
import { readPlistStrings } from "./plist-strings.js";
import { SharedBuildRefusal, SharedBuildStore } from "./shared-build-store.js";
import {
  buildBinaryPlist,
  buildFakeIpa,
  buildXmlPlist,
  buildZip,
} from "./test-utils/fake-archives.js";

const INFO = {
  CFBundleIdentifier: "com.example.fakeapp",
  CFBundleShortVersionString: "1.4.0",
  CFBundleVersion: "812",
  CFBundleDisplayName: "Fake Camp",
  CFBundleName: "FakeCamp",
};

let workDir: string;

async function writeIpa(name: string, contents: Buffer): Promise<string> {
  const file = path.join(workDir, name);
  await fs.writeFile(file, contents);
  return file;
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), "shared-builds-ios-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("readIpaInfo", () => {
  test("reads the app's binary Info.plist, not a framework's", async () => {
    const ipa = await writeIpa("app.ipa", buildFakeIpa(buildBinaryPlist(INFO)));
    expect(await readIpaInfo(ipa)).toEqual({
      identifier: "com.example.fakeapp",
      version: "1.4.0",
      build: "812",
      name: "Fake Camp",
    });
  });

  test("reads an XML Info.plist, top-level keys only", async () => {
    const ipa = await writeIpa(
      "app.ipa",
      buildFakeIpa(buildXmlPlist({ ...INFO, CFBundleDisplayName: "Fake & Camp" })),
    );
    expect(await readIpaInfo(ipa)).toEqual({
      identifier: "com.example.fakeapp",
      version: "1.4.0",
      build: "812",
      name: "Fake & Camp",
    });
  });

  test("reads a stored (uncompressed) Info.plist and non-ASCII names", async () => {
    const ipa = await writeIpa(
      "app.ipa",
      buildZip([
        {
          name: "Payload/Fake.app/Info.plist",
          data: buildBinaryPlist({
            CFBundleIdentifier: "com.example.fakeapp",
            CFBundleVersion: "9",
            CFBundleName: "Fäke Cämp with a long name",
          }),
          method: 0,
        },
      ]),
    );
    expect(await readIpaInfo(ipa)).toEqual({
      identifier: "com.example.fakeapp",
      version: "9",
      build: "9",
      name: "Fäke Cämp with a long name",
    });
  });

  test("refuses a corrupt zip", async () => {
    const ipa = await writeIpa("app.ipa", Buffer.from("this is not a zip at all, not even close"));
    const error = await readIpaInfo(ipa).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SharedBuildRefusal);
    expect((error as Error).message).toMatch(/not a readable zip/);
  });

  test("refuses an IPA without an app Info.plist", async () => {
    const ipa = await writeIpa(
      "app.ipa",
      buildZip([{ name: "Payload/Fake.app/Fake", data: "binary" }]),
    );
    await expect(readIpaInfo(ipa)).rejects.toThrow(/no Payload\/<App>.app\/Info.plist/);
  });

  test("refuses an Info.plist without a bundle identifier", async () => {
    const ipa = await writeIpa(
      "app.ipa",
      buildFakeIpa(buildBinaryPlist({ CFBundleShortVersionString: "1.0" })),
    );
    await expect(readIpaInfo(ipa)).rejects.toThrow(/no CFBundleIdentifier/);
  });

  test("refuses an unreadable Info.plist", async () => {
    const ipa = await writeIpa("app.ipa", buildFakeIpa("garbage, not a plist"));
    await expect(readIpaInfo(ipa)).rejects.toThrow(/Info.plist is unreadable/);
  });
});

describe("finishIosShare", () => {
  test("a shared IPA gets a manifest and an install page pointing at its https URLs", async () => {
    const root = path.join(workDir, "shares");
    const store = new SharedBuildStore({
      root,
      readLimits: () => ({
        enabled: true,
        maxFileBytes: 1024 * 1024,
        maxTotalBytes: 10 * 1024 * 1024,
        expiryMs: 60_000,
        publicBaseUrl: "https://shares.example.com",
        lowFreeBytes: 0,
      }),
      readFreeBytes: async () => 1024 * 1024 * 1024,
      logger: createTestLogger(),
    });
    const ipa = await writeIpa("Fake Camp.ipa", buildFakeIpa(buildBinaryPlist(INFO)));
    const { record, urls } = await store.share({
      sourcePath: ipa,
      agentId: "agent-1",
      platform: "ios",
      finish: finishIosShare,
    });

    expect(record.app).toEqual({
      name: "Fake Camp",
      version: "1.4.0",
      build: "812",
      identifier: "com.example.fakeapp",
    });
    const directory = path.join(root, record.token);
    const manifest = await fs.readFile(path.join(directory, IOS_MANIFEST_FILE));
    const manifestText = manifest.toString("utf8");
    expect(manifestText).toContain(
      `<string>https://shares.example.com/b/${record.token}/Fake-Camp.ipa</string>`,
    );
    expect(manifestText).toContain("<string>software-package</string>");
    // The manifest's metadata is a nested dict; its top level has only `items`.
    expect(readPlistStrings(manifest)).toEqual({});
    expect(manifestText).toMatch(
      /<key>bundle-identifier<\/key>\s*<string>com\.example\.fakeapp<\/string>/,
    );
    expect(manifestText).toMatch(/<key>bundle-version<\/key>\s*<string>1\.4\.0<\/string>/);
    expect(manifestText).toMatch(/<key>title<\/key>\s*<string>Fake Camp<\/string>/);

    const page = await fs.readFile(path.join(directory, IOS_INSTALL_PAGE_FILE), "utf8");
    const manifestUrl = `https://shares.example.com/b/${record.token}/manifest.plist`;
    expect(urls.directory).toBe(`https://shares.example.com/b/${record.token}/`);
    expect(page).toContain(`href="${buildIosInstallLink(manifestUrl).replace(/&/g, "&amp;")}"`);
    expect(buildIosInstallLink(manifestUrl)).toBe(
      `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`,
    );
    expect(page).toContain("Fake Camp 1.4.0 (812)");
  });
});
