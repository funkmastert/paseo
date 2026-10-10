/**
 * Reads one small entry out of a zip (an IPA or an APK) through the central directory, without
 * unpacking the archive. Only stored and deflated entries are read, which is what both formats use.
 */

import fs from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;

export class ZipReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipReadError";
  }
}

interface CentralDirectory {
  offset: number;
  size: number;
}

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

type FileHandle = Awaited<ReturnType<typeof fs.open>>;

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) throw new ZipReadError("the archive ends early");
    filled += bytesRead;
  }
  return buffer;
}

async function findCentralDirectory(
  handle: FileHandle,
  fileSize: number,
): Promise<CentralDirectory> {
  if (fileSize < EOCD_SIZE) throw new ZipReadError("too small to be a zip");
  const tailLength = Math.min(fileSize, EOCD_SIZE + MAX_COMMENT);
  const tailStart = fileSize - tailLength;
  const tail = await readAt(handle, tailStart, tailLength);
  for (let at = tail.length - EOCD_SIZE; at >= 0; at -= 1) {
    if (tail.readUInt32LE(at) !== EOCD_SIGNATURE) continue;
    const size = tail.readUInt32LE(at + 12);
    const offset = tail.readUInt32LE(at + 16);
    if (size !== 0xffffffff && offset !== 0xffffffff) return { offset, size };
    // ZIP64: the locator sits just before the end record and points at the 64-bit one.
    const locatorAt = tailStart + at - 20;
    if (locatorAt < 0) break;
    const locator = await readAt(handle, locatorAt, 20);
    if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE) break;
    const record = await readAt(handle, Number(locator.readBigUInt64LE(8)), 56);
    if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) break;
    return { size: Number(record.readBigUInt64LE(40)), offset: Number(record.readBigUInt64LE(48)) };
  }
  throw new ZipReadError("no zip central directory");
}

function* centralEntries(directory: Buffer): Generator<CentralEntry> {
  let at = 0;
  while (at + 46 <= directory.length && directory.readUInt32LE(at) === CENTRAL_ENTRY_SIGNATURE) {
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    yield {
      method: directory.readUInt16LE(at + 10),
      compressedSize: directory.readUInt32LE(at + 20),
      uncompressedSize: directory.readUInt32LE(at + 24),
      localHeaderOffset: directory.readUInt32LE(at + 42),
      name: directory.toString("utf8", at + 46, at + 46 + nameLength),
    };
    at += 46 + nameLength + extraLength + commentLength;
  }
}

/**
 * The first entry whose name matches, decompressed, or null when none matches. Throws
 * ZipReadError for an archive it can't read and for a match larger than `maxBytes`.
 */
export async function readZipEntry(
  zipPath: string,
  matches: (name: string) => boolean,
  maxBytes: number,
): Promise<{ name: string; data: Buffer } | null> {
  const handle = await fs.open(zipPath, "r");
  try {
    const { size: fileSize } = await handle.stat();
    const directory = await findCentralDirectory(handle, fileSize);
    if (
      directory.size > MAX_CENTRAL_DIRECTORY_BYTES ||
      directory.offset + directory.size > fileSize
    ) {
      throw new ZipReadError("the central directory is out of bounds");
    }
    const entries = await readAt(handle, directory.offset, directory.size);
    for (const entry of centralEntries(entries)) {
      if (!matches(entry.name)) continue;
      if (entry.uncompressedSize > maxBytes || entry.compressedSize > maxBytes) {
        throw new ZipReadError(`${entry.name} is larger than ${maxBytes} bytes`);
      }
      const header = await readAt(handle, entry.localHeaderOffset, 30);
      if (header.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
        throw new ZipReadError(`${entry.name} has no local header`);
      }
      const dataStart =
        entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      const raw = await readAt(handle, dataStart, entry.compressedSize);
      if (entry.method === 0) return { name: entry.name, data: raw };
      if (entry.method !== 8) {
        throw new ZipReadError(`${entry.name} uses unsupported compression ${entry.method}`);
      }
      try {
        return { name: entry.name, data: inflateRawSync(raw, { maxOutputLength: maxBytes }) };
      } catch {
        throw new ZipReadError(`${entry.name} does not inflate`);
      }
    }
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
