/**
 * Turns a shared IPA into an over-the-air install (docs/shared-builds.md): `manifest.plist` and an
 * `index.html` with the `itms-services://` link, beside the IPA. iOS installs it only when the
 * IPA is ad-hoc signed with a profile that lists the phone.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { PlistReadError, readPlistStrings } from "./plist-strings.js";
import {
  SharedBuildRefusal,
  type SharedBuildApp,
  type SharedBuildFinishInput,
} from "./shared-build-store.js";
import { readZipEntry, ZipReadError } from "./zip-entry.js";

export const IOS_MANIFEST_FILE = "manifest.plist";
export const IOS_INSTALL_PAGE_FILE = "index.html";

const INFO_PLIST_PATTERN = /^Payload\/[^/]+\.app\/Info\.plist$/;
const MAX_INFO_PLIST_BYTES = 4 * 1024 * 1024;

export interface IpaInfo {
  identifier: string;
  /** `CFBundleShortVersionString`, else `CFBundleVersion`. */
  version: string;
  build: string | null;
  /** `CFBundleDisplayName`, else `CFBundleName`, else the identifier. */
  name: string;
}

function refuse(reason: string): never {
  throw new SharedBuildRefusal(
    `The IPA can't be installed over the air: ${reason}. Export it from an archive (xcodebuild -exportArchive) with an ad-hoc export-options plist.`,
  );
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function readIpaInfo(ipaPath: string): Promise<IpaInfo> {
  let entry: Awaited<ReturnType<typeof readZipEntry>>;
  try {
    entry = await readZipEntry(
      ipaPath,
      (name) => INFO_PLIST_PATTERN.test(name),
      MAX_INFO_PLIST_BYTES,
    );
  } catch (error) {
    if (error instanceof ZipReadError) refuse(`it is not a readable zip (${error.message})`);
    throw error;
  }
  if (!entry) refuse("it has no Payload/<App>.app/Info.plist");

  let strings: Record<string, string>;
  try {
    strings = readPlistStrings(entry.data);
  } catch (error) {
    if (error instanceof PlistReadError) refuse(`its Info.plist is unreadable (${error.message})`);
    throw error;
  }
  const identifier = nonEmpty(strings["CFBundleIdentifier"]);
  if (!identifier) refuse("its Info.plist has no CFBundleIdentifier");
  const build = nonEmpty(strings["CFBundleVersion"]);
  const version = nonEmpty(strings["CFBundleShortVersionString"]) ?? build;
  if (!version) refuse("its Info.plist has no CFBundleShortVersionString or CFBundleVersion");
  const name =
    nonEmpty(strings["CFBundleDisplayName"]) ?? nonEmpty(strings["CFBundleName"]) ?? identifier;
  return { identifier, version, build, name };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildIosManifest(input: { ipaUrl: string; info: IpaInfo }): string {
  const { ipaUrl, info } = input;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${escapeXml(ipaUrl)}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${escapeXml(info.identifier)}</string>
        <key>bundle-version</key>
        <string>${escapeXml(info.version)}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${escapeXml(info.name)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}

export function buildIosInstallLink(manifestUrl: string): string {
  return `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
}

export function buildIosInstallPage(input: { manifestUrl: string; info: IpaInfo }): string {
  const { info } = input;
  const label = `${info.name} ${info.version}${info.build && info.build !== info.version ? ` (${info.build})` : ""}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Install ${escapeXml(label)}</title>
<style>
  body { font: 17px -apple-system, system-ui, sans-serif; margin: 0; padding: 48px 24px; text-align: center; color: #111; background: #fff; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { color: #555; margin: 0 0 32px; }
  a.install { display: inline-block; padding: 14px 28px; border-radius: 12px; background: #111; color: #fff; text-decoration: none; font-weight: 600; }
  small { display: block; margin-top: 32px; color: #888; }
</style>
</head>
<body>
<h1>${escapeXml(label)}</h1>
<p>${escapeXml(info.identifier)}</p>
<a class="install" href="${escapeXml(buildIosInstallLink(input.manifestUrl))}">Install</a>
<small>Open this page in Safari. The build installs only on an iPhone registered on its ad-hoc profile.</small>
</body>
</html>
`;
}

/** The store's finishing step for an IPA: reads its Info.plist and writes the manifest and page. */
export async function finishIosShare(input: SharedBuildFinishInput): Promise<SharedBuildApp> {
  const info = await readIpaInfo(path.join(input.directory, input.fileName));
  const manifestUrl = `${input.urls.directory}${IOS_MANIFEST_FILE}`;
  await fs.writeFile(
    path.join(input.directory, IOS_MANIFEST_FILE),
    buildIosManifest({ ipaUrl: input.urls.file, info }),
  );
  await fs.writeFile(
    path.join(input.directory, IOS_INSTALL_PAGE_FILE),
    buildIosInstallPage({ manifestUrl, info }),
  );
  return { name: info.name, version: info.version, build: info.build, identifier: info.identifier };
}
