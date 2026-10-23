/**
 * The string values of a property list's top-level dictionary, from a binary (`bplist00`) or an
 * XML plist. Everything else in the plist is skipped: an install page needs a few strings out of
 * `Info.plist`, not the whole document.
 */

export class PlistReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlistReadError";
  }
}

const BINARY_MAGIC = "bplist00";
// The plist comes from whatever the agent built, so its counts are not trusted. A real Info.plist
// has a few dozen top-level keys and short values; past these a dict is refused and a string is
// skipped, so a crafted one can't make the parse run long.
const MAX_DICT_ENTRIES = 4096;
const MAX_STRING_CHARS = 4096;

export function readPlistStrings(data: Buffer): Record<string, string> {
  if (data.toString("latin1", 0, BINARY_MAGIC.length) === BINARY_MAGIC) {
    return readBinaryPlistStrings(data);
  }
  return readXmlPlistStrings(data.toString("utf8"));
}

function readBinaryPlistStrings(data: Buffer): Record<string, string> {
  if (data.length < BINARY_MAGIC.length + 32) throw new PlistReadError("binary plist too short");
  const trailer = data.subarray(data.length - 32);
  const offsetSize = trailer.readUInt8(6);
  const refSize = trailer.readUInt8(7);
  const objectCount = Number(trailer.readBigUInt64BE(8));
  const topObject = Number(trailer.readBigUInt64BE(16));
  const offsetTable = Number(trailer.readBigUInt64BE(24));
  if (
    offsetSize < 1 ||
    offsetSize > 8 ||
    refSize < 1 ||
    refSize > 8 ||
    topObject >= objectCount ||
    offsetTable + objectCount * offsetSize > data.length - 32
  ) {
    throw new PlistReadError("binary plist trailer is out of bounds");
  }

  const readUInt = (at: number, size: number): number => {
    if (at < 0 || at + size > data.length) throw new PlistReadError("binary plist read past end");
    let value = 0;
    for (let i = 0; i < size; i += 1) value = value * 256 + data[at + i];
    return value;
  };
  const objectOffset = (ref: number): number => {
    if (ref >= objectCount) throw new PlistReadError("binary plist reference out of range");
    return readUInt(offsetTable + ref * offsetSize, offsetSize);
  };
  /** An object's element count and where its payload starts. */
  const lengthAt = (at: number): { length: number; start: number } => {
    const info = data[at] & 0x0f;
    if (info !== 0x0f) return { length: info, start: at + 1 };
    const marker = data[at + 1];
    if ((marker & 0xf0) !== 0x10) throw new PlistReadError("binary plist bad length");
    const size = 1 << (marker & 0x0f);
    return { length: readUInt(at + 2, size), start: at + 2 + size };
  };
  const decodeString = (at: number): string | null => {
    const type = data[at] >> 4;
    if (type !== 0x5 && type !== 0x6) return null;
    const { length, start } = lengthAt(at);
    if (length > MAX_STRING_CHARS) return null;
    if (type === 0x5) {
      if (start + length > data.length) throw new PlistReadError("binary plist string past end");
      return data.toString("latin1", start, start + length);
    }
    if (start + length * 2 > data.length) throw new PlistReadError("binary plist string past end");
    return Buffer.from(data.subarray(start, start + length * 2))
      .swap16()
      .toString("utf16le");
  };
  // By offset, not ref: many refs, or many objects, can name the same bytes.
  const decoded = new Map<number, string | null>();
  const readString = (ref: number): string | null => {
    const at = objectOffset(ref);
    let value = decoded.get(at);
    if (value === undefined) {
      value = decodeString(at);
      decoded.set(at, value);
    }
    return value;
  };

  const top = objectOffset(topObject);
  if (data[top] >> 4 !== 0xd) throw new PlistReadError("binary plist top object is not a dict");
  const { length, start } = lengthAt(top);
  if (length > objectCount || length > MAX_DICT_ENTRIES) {
    throw new PlistReadError("binary plist dict is too large");
  }
  const strings: Record<string, string> = {};
  for (let i = 0; i < length; i += 1) {
    const key = readString(readUInt(start + i * refSize, refSize));
    const value = readString(readUInt(start + (length + i) * refSize, refSize));
    if (key !== null && value !== null) strings[key] = value;
  }
  return strings;
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity.startsWith("#x")
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      // Past U+10FFFF is no character; leave the text as written rather than throw.
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[entity] ?? whole;
  });
}

function readXmlPlistStrings(text: string): Record<string, string> {
  const open = text.search(/<dict\s*>/);
  if (open === -1 || !/<plist[\s>]/.test(text)) throw new PlistReadError("not a plist");
  const strings: Record<string, string> = {};
  const tokens = /<(\/?)(dict|array|key|string)\s*>([^<]*)|<(dict|array)\s*\/>/g;
  tokens.lastIndex = open;
  let depth = 0;
  let pendingKey: string | null = null;
  for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
    const [, closing, tag, content] = match;
    if (match[4]) {
      // An empty <dict/> or <array/> is a value at this depth.
      pendingKey = null;
      continue;
    }
    if (tag === "dict" || tag === "array") {
      if (closing) {
        depth -= 1;
        if (depth === 0) return strings;
      } else {
        if (depth === 1) pendingKey = null;
        depth += 1;
      }
      continue;
    }
    if (closing || depth !== 1) continue;
    if (tag === "key") {
      pendingKey = decodeXmlText(content ?? "");
    } else if (pendingKey !== null) {
      strings[pendingKey] = decodeXmlText(content ?? "");
      pendingKey = null;
    }
  }
  throw new PlistReadError("plist dict is not closed");
}
