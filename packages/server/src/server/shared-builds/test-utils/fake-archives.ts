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
