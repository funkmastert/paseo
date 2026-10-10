import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { writeFileAtomic, writeJsonFileAtomic } from "./atomic-file.js";

const MODE_MASK = 0o777;
const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-atomic-file-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("writeFileAtomic", () => {
  test("writes the file with the default mode when none is given", async () => {
    const filePath = path.join(createTempDir(), "plain.txt");
    await writeFileAtomic(filePath, "hello");
    expect(readFileSync(filePath, "utf8")).toBe("hello");
  });

  test.skipIf(process.platform === "win32")(
    "applies the requested mode regardless of umask",
    async () => {
      const filePath = path.join(createTempDir(), "secret.txt");
      await writeFileAtomic(filePath, "hello", { mode: 0o600 });
      expect(statSync(filePath).mode & MODE_MASK).toBe(0o600);
    },
  );
});

describe("writeJsonFileAtomic", () => {
  test.skipIf(process.platform === "win32")("passes its mode option through", async () => {
    const filePath = path.join(createTempDir(), "secret.json");
    await writeJsonFileAtomic(filePath, { a: 1 }, { mode: 0o600 });
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ a: 1 });
    expect(statSync(filePath).mode & MODE_MASK).toBe(0o600);
  });
});
