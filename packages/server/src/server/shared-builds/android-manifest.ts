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

// The manifest comes from whatever the agent built, so nothing it declares is trusted: a string is
// decoded only when an attribute asks for it, only inside its own chunk, and only if it is short.
// A pool that declares a million strings costs nothing until one is read.
const MAX_ATTRIBUTES = 1024;
/** Longer than any attribute name the reader compares against. */
const MAX_NAME_CHARS = 64;
/** Longer than any package name or version a real manifest carries. */
const MAX_VALUE_CHARS = 1024;

interface StringPool {
  /** The string at `index`, or null when it is missing, outside its chunk or over `maxChars`. */
  get(index: number, maxChars: number): string | null;
}

const EMPTY_POOL: StringPool = { get: () => null };

interface Length {
  value: number;
  next: number;
}

/** A UTF-8 pool length: one byte, or two when the high bit is set. Null past `end`. */
function utf8Length(data: Buffer, at: number, end: number): Length | null {
  if (at + 1 > end) return null;
  if (!(data[at] & 0x80)) return { value: data[at], next: at + 1 };
  if (at + 2 > end) return null;
  return { value: ((data[at] & 0x7f) << 8) | data[at + 1], next: at + 2 };
}

/** A UTF-16 pool length: one word, or two when the high bit is set. Null past `end`. */
function utf16Length(data: Buffer, at: number, end: number): Length | null {
  if (at + 2 > end) return null;
  const word = data.readUInt16LE(at);
  if (!(word & 0x8000)) return { value: word, next: at + 2 };
  if (at + 4 > end) return null;
  return { value: ((word & 0x7fff) << 16) | data.readUInt16LE(at + 2), next: at + 4 };
}

function readStringPool(data: Buffer, start: number, end: number): StringPool {
  const headerSize = data.readUInt16LE(start + 2);
  const count = data.readUInt32LE(start + 8);
  const utf8 = (data.readUInt32LE(start + 16) & UTF8_FLAG) !== 0;
  const stringsStart = start + data.readUInt32LE(start + 20);
  if (headerSize < 28 || start + headerSize + count * 4 > end || stringsStart > end) {
    throw new AxmlReadError("the string pool is out of bounds");
  }
  return {
    get(index, maxChars) {
      if (index >= count) return null;
      const at = stringsStart + data.readUInt32LE(start + headerSize + index * 4);
      if (utf8) {
        // The character count, then the UTF-8 byte count.
        const chars = utf8Length(data, at, end);
        const bytes = chars && utf8Length(data, chars.next, end);
        if (!chars || !bytes || chars.value > maxChars || bytes.next + bytes.value > end) {
          return null;
        }
        return data.toString("utf8", bytes.next, bytes.next + bytes.value);
      }
      const chars = utf16Length(data, at, end);
      if (!chars || chars.value > maxChars || chars.next + chars.value * 2 > end) return null;
      return data.toString("utf16le", chars.next, chars.next + chars.value * 2);
    },
  };
}

interface StringTables {
  pool: StringPool;
  /** The resource map: the android: attribute id for each low string index. */
  resourceId: (index: number) => number | undefined;
}

/** One attribute's value as text: its raw string, or its typed string or integer. */
function attributeText(data: Buffer, attr: number, tables: StringTables): string | null {
  const rawValue = data.readUInt32LE(attr + 8);
  if (rawValue !== NO_INDEX) return tables.pool.get(rawValue, MAX_VALUE_CHARS);
  const dataType = data[attr + 15];
  const value = data.readUInt32LE(attr + 16);
  if (dataType === TYPE_STRING) return tables.pool.get(value, MAX_VALUE_CHARS);
  if (dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX) return String(value);
  return null;
}

/** The attributes of the start-element chunk at `at`, which must be `<manifest>`. */
function readManifestElement(data: Buffer, at: number, tables: StringTables): ApkInfo {
  const ext = at + data.readUInt16LE(at + 2);
  if (tables.pool.get(data.readUInt32LE(ext + 4), MAX_NAME_CHARS) !== "manifest") {
    throw new AxmlReadError("the first element is not <manifest>");
  }
  const attributeStart = ext + data.readUInt16LE(ext + 8);
  const attributeSize = data.readUInt16LE(ext + 10);
  const attributeCount = data.readUInt16LE(ext + 12);
  if (attributeCount > MAX_ATTRIBUTES)
    throw new AxmlReadError("<manifest> has too many attributes");
  const info: ApkInfo = { packageName: null, versionName: null, versionCode: null };
  for (let i = 0; i < attributeCount; i += 1) {
    const attr = attributeStart + i * attributeSize;
    const nameIndex = data.readUInt32LE(attr + 4);
    // aapt2 can strip attribute names; the resource map still names the android: ones.
    const name = tables.pool.get(nameIndex, MAX_NAME_CHARS) ?? "";
    const resourceId = tables.resourceId(nameIndex);
    if (name === "package") info.packageName = attributeText(data, attr, tables);
    else if (name === "versionName" || resourceId === ATTR_VERSION_NAME) {
      info.versionName = attributeText(data, attr, tables);
    } else if (name === "versionCode" || resourceId === ATTR_VERSION_CODE) {
      info.versionCode = attributeText(data, attr, tables);
    }
  }
  return info;
}

function readManifestChunks(data: Buffer): ApkInfo {
  if (data.length < 8 || data.readUInt16LE(0) !== RES_XML_TYPE) {
    throw new AxmlReadError("not a compiled Android XML file");
  }
  const tables: StringTables = { pool: EMPTY_POOL, resourceId: () => undefined };
  let at = data.readUInt16LE(2);
  while (at + 8 <= data.length) {
    const type = data.readUInt16LE(at);
    const size = data.readUInt32LE(at + 4);
    if (size < 8 || at + size > data.length) throw new AxmlReadError("chunk out of bounds");
    if (type === RES_STRING_POOL_TYPE) tables.pool = readStringPool(data, at, at + size);
    if (type === RES_XML_RESOURCE_MAP_TYPE) {
      const mapStart = at + 8;
      const mapCount = Math.floor((size - 8) / 4);
      tables.resourceId = (index) =>
        index < mapCount ? data.readUInt32LE(mapStart + index * 4) : undefined;
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
