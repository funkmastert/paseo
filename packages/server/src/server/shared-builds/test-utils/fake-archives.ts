/**
 * Tiny archives for the shared-builds tests: a zip writer and a binary plist writer, enough to make
 * a fake IPA without a real build. Identifiers in fixtures are fake.
 */

import { crc32, deflateRawSync } from "node:zlib";

export interface FakeZipEntry {
  name: string;
  data: Buffer | string;
  /** 8 (deflate) by default; 0 stores it. */
  method?: 0 | 8;
}

export function buildZip(entries: FakeZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(entry.name);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function binaryPlistString(value: string): Buffer {
  const ascii = [...value].every((char) => char.charCodeAt(0) < 0x80);
  const length = value.length;
  const payload = ascii ? Buffer.from(value, "latin1") : Buffer.from(value, "utf16le").swap16();
  const type = ascii ? 0x50 : 0x60;
  if (length < 15) return Buffer.concat([Buffer.from([type | length]), payload]);
  return Buffer.concat([Buffer.from([type | 0x0f, 0x11, length >> 8, length & 0xff]), payload]);
}

/** A `bplist00` whose top object is a dictionary of strings. */
export function buildBinaryPlist(strings: Record<string, string>): Buffer {
  const pairs = Object.entries(strings);
  const count = pairs.length;
  const objects: Buffer[] = [];
  const dict = [0xd0 | Math.min(count, 0x0f)];
  if (count >= 15) dict.push(0x10, count);
  for (let i = 0; i < count; i += 1) dict.push(1 + i);
  for (let i = 0; i < count; i += 1) dict.push(1 + count + i);
  objects.push(Buffer.from(dict));
  for (const [key] of pairs) objects.push(binaryPlistString(key));
  for (const [, value] of pairs) objects.push(binaryPlistString(value));

  const header = Buffer.from("bplist00", "latin1");
  const offsets: number[] = [];
  let at = header.length;
  for (const object of objects) {
    offsets.push(at);
    at += object.length;
  }
  const offsetTable = Buffer.alloc(objects.length * 2);
  offsets.forEach((value, index) => offsetTable.writeUInt16BE(value, index * 2));
  const trailer = Buffer.alloc(32);
  trailer.writeUInt8(2, 6);
  trailer.writeUInt8(1, 7);
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(at), 24);
  return Buffer.concat([header, ...objects, offsetTable, trailer]);
}

export function buildXmlPlist(strings: Record<string, string>): string {
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = Object.entries(strings)
    .map(([key, value]) => `  <key>${escape(key)}</key>\n  <string>${escape(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>UIRequiresFullScreen</key>
  <true/>
${body}
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleIdentifier</key>
      <string>com.example.nested.not.top</string>
    </dict>
  </array>
  <key>Empty</key>
  <dict/>
</dict>
</plist>
`;
}

/** A fake IPA: an app bundle with the given Info.plist and a frameworks plist that must be skipped. */
export function buildFakeIpa(infoPlist: Buffer | string): Buffer {
  return buildZip([
    { name: "Payload/", data: "", method: 0 },
    {
      name: "Payload/Fake.app/Frameworks/Dep.framework/Info.plist",
      data: buildBinaryPlist({ CFBundleIdentifier: "com.example.framework" }),
    },
    { name: "Payload/Fake.app/Info.plist", data: infoPlist },
    { name: "Payload/Fake.app/Fake", data: Buffer.alloc(256, 1), method: 0 },
  ]);
}

function stringPoolChunk(strings: string[], utf8: boolean): Buffer {
  const encoded = strings.map((value) => {
    if (utf8) {
      const bytes = Buffer.from(value, "utf8");
      return Buffer.concat([Buffer.from([value.length, bytes.length]), bytes, Buffer.from([0])]);
    }
    const length = Buffer.alloc(2);
    length.writeUInt16LE(value.length);
    return Buffer.concat([length, Buffer.from(value, "utf16le"), Buffer.alloc(2)]);
  });
  const headerSize = 28;
  const offsets = Buffer.alloc(strings.length * 4);
  let at = 0;
  encoded.forEach((entry, index) => {
    offsets.writeUInt32LE(at, index * 4);
    at += entry.length;
  });
  let data = Buffer.concat(encoded);
  if (data.length % 4 !== 0) data = Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0x0001, 0);
  header.writeUInt16LE(headerSize, 2);
  header.writeUInt32LE(headerSize + offsets.length + data.length, 4);
  header.writeUInt32LE(strings.length, 8);
  header.writeUInt32LE(utf8 ? 0x100 : 0, 16);
  header.writeUInt32LE(headerSize + offsets.length, 20);
  return Buffer.concat([header, offsets, data]);
}

/**
 * A compiled (AXML) AndroidManifest.xml with a `<manifest>` element carrying package,
 * versionCode and versionName, the way aapt2 writes them.
 */
export function buildAndroidManifest(input: {
  packageName: string;
  versionName: string;
  versionCode: number;
  utf8?: boolean;
}): Buffer {
  const strings = [
    "versionCode",
    "versionName",
    "package",
    "manifest",
    input.packageName,
    input.versionName,
  ];
  const pool = stringPoolChunk(strings, input.utf8 ?? false);
  const resourceMap = Buffer.alloc(16);
  resourceMap.writeUInt16LE(0x0180, 0);
  resourceMap.writeUInt16LE(8, 2);
  resourceMap.writeUInt32LE(16, 4);
  resourceMap.writeUInt32LE(0x0101021b, 8);
  resourceMap.writeUInt32LE(0x0101021c, 12);

  const attributes = [
    { name: 2, raw: 4, type: 0x03, data: 4 },
    { name: 0, raw: 0xffffffff, type: 0x10, data: input.versionCode },
    { name: 1, raw: 5, type: 0x03, data: 5 },
  ];
  const element = Buffer.alloc(16 + 20 + attributes.length * 20);
  element.writeUInt16LE(0x0102, 0);
  element.writeUInt16LE(16, 2);
  element.writeUInt32LE(element.length, 4);
  element.writeUInt32LE(1, 8);
  element.writeUInt32LE(0xffffffff, 12);
  element.writeUInt32LE(0xffffffff, 16);
  element.writeUInt32LE(3, 20);
  element.writeUInt16LE(20, 24);
  element.writeUInt16LE(20, 26);
  element.writeUInt16LE(attributes.length, 28);
  attributes.forEach((attribute, index) => {
    const at = 36 + index * 20;
    element.writeUInt32LE(0xffffffff, at);
    element.writeUInt32LE(attribute.name, at + 4);
    element.writeUInt32LE(attribute.raw, at + 8);
    element.writeUInt16LE(8, at + 12);
    element.writeUInt8(attribute.type, at + 15);
    element.writeUInt32LE(attribute.data, at + 16);
  });

  const header = Buffer.alloc(8);
  header.writeUInt16LE(0x0003, 0);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(8 + pool.length + resourceMap.length + element.length, 4);
  return Buffer.concat([header, pool, resourceMap, element]);
}

/** A fake APK: a compiled manifest and a dex file. */
export function buildFakeApk(manifest: Buffer): Buffer {
  return buildZip([
    { name: "AndroidManifest.xml", data: manifest },
    { name: "classes.dex", data: Buffer.alloc(256, 2), method: 0 },
  ]);
}
