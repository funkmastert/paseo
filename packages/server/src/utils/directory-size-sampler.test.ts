import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { sampleDirectorySizeBytes } from "./directory-size-sampler.js";
import { isPlatform } from "../test-utils/platform.js";

const originalPath = process.env.PATH;
const tempDirs: string[] = [];

afterEach(() => {
  process.env.PATH = originalPath;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-du-sampler-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Prepends a fake `du` script to PATH so real `du` resolution stays untouched for other tests. */
function installFakeDu(script: string): void {
  const binDir = makeTempDir();
  const fakeDuPath = path.join(binDir, "du");
  writeFileSync(fakeDuPath, `#!/bin/sh\n${script}\n`);
  chmodSync(fakeDuPath, 0o755);
  process.env.PATH = [binDir, originalPath].filter(Boolean).join(path.delimiter);
}

describe.skipIf(isPlatform("win32"))("sampleDirectorySizeBytes", () => {
  test("samples a real directory's size in bytes", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "file.bin"), Buffer.alloc(8192, 1));

    const bytes = await sampleDirectorySizeBytes(dir, { timeoutMs: 5000 });

    expect(bytes).not.toBeUndefined();
    expect(bytes).toBeGreaterThan(0);
    // du reports whole 1KB blocks.
    expect((bytes ?? 0) % 1024).toBe(0);
  });

  test("returns undefined, never 0, when du exits nonzero", async () => {
    installFakeDu("exit 1");

    const bytes = await sampleDirectorySizeBytes("/does/not/matter", { timeoutMs: 5000 });

    expect(bytes).toBeUndefined();
  });

  test("returns undefined, never 0, on timeout", async () => {
    installFakeDu("sleep 2");

    const bytes = await sampleDirectorySizeBytes("/does/not/matter", { timeoutMs: 50 });

    expect(bytes).toBeUndefined();
  });

  test("returns undefined, never 0, when output doesn't parse", async () => {
    installFakeDu('echo "not-a-number"');

    const bytes = await sampleDirectorySizeBytes("/does/not/matter", { timeoutMs: 5000 });

    expect(bytes).toBeUndefined();
  });

  test("returns undefined for a directory that doesn't exist", async () => {
    const bytes = await sampleDirectorySizeBytes(
      path.join(os.tmpdir(), "paseo-du-sampler-missing", "nope"),
      { timeoutMs: 5000 },
    );

    expect(bytes).toBeUndefined();
  });
});
