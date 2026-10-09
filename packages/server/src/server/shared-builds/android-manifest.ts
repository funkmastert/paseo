/**
 * The package name and version of a shared APK, from its binary `AndroidManifest.xml`, so the push
 * can say which app it is. The app's label lives in `resources.arsc` and is not read: the agent
 * names it, or the package name stands in.
 */

import path from "node:path";
import {
  SharedBuildRefusal,
  type SharedBuildApp,
  type SharedBuildFinishInput,
} from "./shared-build-store.js";
import { readZipEntry, ZipReadError } from "./zip-entry.js";

const MANIFEST_ENTRY = "AndroidManifest.xml";
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const UTF8_FLAG = 0x100;
const NO_INDEX = 0xffffffff;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const ATTR_VERSION_CODE = 0x0101021b;
const ATTR_VERSION_NAME = 0x0101021c;

export interface ApkInfo {
  packageName: string | null;
  versionName: string | null;
  versionCode: string | null;
}

class AxmlReadError extends Error {}

function readStringPool(data: Buffer, start: number): string[] {
  const headerSize = data.readUInt16LE(start + 2);
  const count = data.readUInt32LE(start + 8);
  const flags = data.readUInt32LE(start + 16);
  const stringsStart = start + data.readUInt32LE(start + 20);
  const utf8 = (flags & UTF8_FLAG) !== 0;
  const strings: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let at = stringsStart + data.readUInt32LE(start + headerSize + i * 4);
    if (utf8) {
      // UTF-16 length, then UTF-8 byte length; each one or two bytes.
      at += data[at] & 0x80 ? 2 : 1;
      let length = data[at];
      if (length & 0x80) {
        length = ((length & 0x7f) << 8) | data[at + 1];
        at += 2;
      } else {
        at += 1;
      }
      strings.push(data.toString("utf8", at, at + length));
    } else {
      let length = data.readUInt16LE(at);
      if (length & 0x8000) {
        length = ((length & 0x7fff) << 16) | data.readUInt16LE(at + 2);
        at += 4;
      } else {
        at += 2;
      }
      strings.push(data.toString("utf16le", at, at + length * 2));
    }
  }
  return strings;
}

interface StringTables {
  strings: string[];
  resourceIds: number[];
}

/** One attribute's value as text: its raw string, or its typed string or integer. */
function attributeText(data: Buffer, attr: number, tables: StringTables): string | null {
  const rawValue = data.readUInt32LE(attr + 8);
  if (rawValue !== NO_INDEX) return tables.strings[rawValue] ?? null;
  const dataType = data[attr + 15];
  const value = data.readUInt32LE(attr + 16);
  if (dataType === TYPE_STRING) return tables.strings[value] ?? null;
  if (dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX) return String(value);
  return null;
}

/** The attributes of the start-element chunk at `at`, which must be `<manifest>`. */
function readManifestElement(data: Buffer, at: number, tables: StringTables): ApkInfo {
  const ext = at + data.readUInt16LE(at + 2);
  if (tables.strings[data.readUInt32LE(ext + 4)] !== "manifest") {
    throw new AxmlReadError("the first element is not <manifest>");
  }
  const attributeStart = ext + data.readUInt16LE(ext + 8);
  const attributeSize = data.readUInt16LE(ext + 10);
  const attributeCount = data.readUInt16LE(ext + 12);
  const info: ApkInfo = { packageName: null, versionName: null, versionCode: null };
  for (let i = 0; i < attributeCount; i += 1) {
    const attr = attributeStart + i * attributeSize;
    const nameIndex = data.readUInt32LE(attr + 4);
    // aapt2 can strip attribute names; the resource map still names the android: ones.
    const name = tables.strings[nameIndex] ?? "";
    const resourceId = tables.resourceIds[nameIndex];
    const text = attributeText(data, attr, tables);
    if (name === "package") info.packageName = text;
    else if (name === "versionName" || resourceId === ATTR_VERSION_NAME) info.versionName = text;
    else if (name === "versionCode" || resourceId === ATTR_VERSION_CODE) info.versionCode = text;
  }
  return info;
}

function readManifestChunks(data: Buffer): ApkInfo {
  if (data.length < 8 || data.readUInt16LE(0) !== RES_XML_TYPE) {
    throw new AxmlReadError("not a compiled Android XML file");
  }
  const tables: StringTables = { strings: [], resourceIds: [] };
  let at = data.readUInt16LE(2);
  while (at + 8 <= data.length) {
    const type = data.readUInt16LE(at);
    const size = data.readUInt32LE(at + 4);
    if (size < 8 || at + size > data.length) throw new AxmlReadError("chunk out of bounds");
    if (type === RES_STRING_POOL_TYPE) tables.strings = readStringPool(data, at);
    if (type === RES_XML_RESOURCE_MAP_TYPE) {
      tables.resourceIds = [];
      for (let i = at + 8; i + 4 <= at + size; i += 4)
        tables.resourceIds.push(data.readUInt32LE(i));
    }
    if (type === RES_XML_START_ELEMENT_TYPE) return readManifestElement(data, at, tables);
    at += size;
  }
  throw new AxmlReadError("no <manifest> element");
}

/** The `<manifest>` element's package and version attributes, from compiled (AXML) bytes. */
export function readAndroidManifestInfo(data: Buffer): ApkInfo {
  try {
    return readManifestChunks(data);
  } catch (error) {
    if (error instanceof AxmlReadError) throw error;
    // A truncated buffer reads past its end as a RangeError.
    throw new AxmlReadError("the manifest is truncated");
  }
}

function refuse(reason: string): never {
  throw new SharedBuildRefusal(
    `That file is not an installable APK: ${reason}. Share the APK Gradle builds (for example app/build/outputs/apk/debug/app-debug.apk), not an AAB.`,
  );
}

export async function readApkInfo(apkPath: string): Promise<ApkInfo> {
  let entry: Awaited<ReturnType<typeof readZipEntry>>;
  try {
    entry = await readZipEntry(apkPath, (name) => name === MANIFEST_ENTRY, MAX_MANIFEST_BYTES);
  } catch (error) {
    if (error instanceof ZipReadError) refuse(`it is not a readable zip (${error.message})`);
    throw error;
  }
  if (!entry) refuse("it has no AndroidManifest.xml at its root");
  try {
    return readAndroidManifestInfo(entry.data);
  } catch (error) {
    if (error instanceof AxmlReadError)
      refuse(`its AndroidManifest.xml is unreadable (${error.message})`);
    throw error;
  }
}

/** The store's finishing step for an APK: checks it is one and reads its package and version. */
export async function finishAndroidShare(input: SharedBuildFinishInput): Promise<SharedBuildApp> {
  const info = await readApkInfo(path.join(input.directory, input.fileName));
  return {
    name: null,
    version: info.versionName ?? info.versionCode,
    build: info.versionCode,
    identifier: info.packageName,
  };
}
