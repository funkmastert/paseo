import { describe, expect, test } from "vitest";
import { PlistReadError, readPlistStrings } from "./plist-strings.js";
import { buildBinaryPlist, buildXmlPlist } from "./test-utils/fake-archives.js";

/**
 * A `bplist00` whose top object is a dict of `entries` key/value pairs. Every key ref points at
 * object 1 and every value ref at object 2, and the offset table can repeat offsets, the way a
 * hostile Info.plist would.
 */
function hostileDictPlist(input: {
  entries: number;
  key: Buffer;
  value: Buffer;
  objectCount?: number;
}): Buffer {
  const refSize = 4;
  const header = Buffer.from("bplist00", "latin1");
  const dictHeader = Buffer.from([0xdf, 0x12, 0, 0, 0, 0]);
  dictHeader.writeUInt32BE(input.entries, 2);
  const refs = Buffer.alloc(input.entries * 2 * refSize);
  for (let i = 0; i < input.entries; i += 1) {
    refs.writeUInt32BE(1, i * refSize);
    refs.writeUInt32BE(2, (input.entries + i) * refSize);
  }
  const dict = Buffer.concat([dictHeader, refs]);
  const keyAt = header.length + dict.length;
  const valueAt = keyAt + input.key.length;
  const objectCount = input.objectCount ?? 3;
  const offsetTableAt = valueAt + input.value.length;
  const offsetTable = Buffer.alloc(objectCount * 4);
  offsetTable.writeUInt32BE(header.length, 0);
  for (let ref = 1; ref < objectCount; ref += 1) {
    offsetTable.writeUInt32BE(ref % 2 === 1 ? keyAt : valueAt, ref * 4);
  }
  const trailer = Buffer.alloc(32);
  trailer.writeUInt8(4, 6);
  trailer.writeUInt8(refSize, 7);
  trailer.writeBigUInt64BE(BigInt(objectCount), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(offsetTableAt), 24);
  return Buffer.concat([header, dict, input.key, input.value, offsetTable, trailer]);
}

/** A latin1 bplist string object of `length` characters. */
function asciiObject(text: string): Buffer {
  const length = Buffer.alloc(5);
  length.writeUInt8(0x12, 0);
  length.writeUInt32BE(text.length, 1);
  return Buffer.concat([Buffer.from([0x5f]), length, Buffer.from(text, "latin1")]);
}

describe("readPlistStrings", () => {
  test("reads a binary plist's top-level strings", () => {
    expect(
      readPlistStrings(buildBinaryPlist({ CFBundleIdentifier: "com.example.fake", A: "b" })),
    ).toEqual({ CFBundleIdentifier: "com.example.fake", A: "b" });
  });

  test("refuses a dict with more entries than the plist has objects", () => {
    const plist = hostileDictPlist({
      entries: 20,
      key: asciiObject("CFBundleIdentifier"),
      value: asciiObject("com.example.fake"),
    });
    expect(() => readPlistStrings(plist)).toThrow(PlistReadError);
  });

  test("skips a string longer than any Info.plist value", () => {
    const strings = readPlistStrings(
      buildBinaryPlist({ CFBundleIdentifier: "com.example.fake", Long: "x".repeat(5000) }),
    );
    expect(strings).toEqual({ CFBundleIdentifier: "com.example.fake" });
  });

  test("a dict of half a million refs to one 2 MB string is refused at once", () => {
    const entries = 500_000;
    const plist = hostileDictPlist({
      entries,
      key: asciiObject("K"),
      value: asciiObject("v".repeat(2 * 1024 * 1024)),
      objectCount: entries * 2 + 1,
    });
    const started = performance.now();
    expect(() => readPlistStrings(plist)).toThrow(PlistReadError);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("many refs to one string decode it once", () => {
    const entries = 4000;
    const plist = hostileDictPlist({
      entries,
      key: asciiObject("CFBundleIdentifier"),
      value: asciiObject("v".repeat(4000)),
      objectCount: entries * 2 + 1,
    });
    const started = performance.now();
    expect(readPlistStrings(plist)).toEqual({ CFBundleIdentifier: "v".repeat(4000) });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("an out-of-range numeric entity in an XML plist is a plist error, not a crash", () => {
    const xml = buildXmlPlist({ CFBundleIdentifier: "com.example.fake" }).replace(
      "com.example.fake",
      "com.example.&#x110000;",
    );
    expect(readPlistStrings(Buffer.from(xml))).toEqual({
      CFBundleIdentifier: "com.example.&#x110000;",
    });
  });
});
