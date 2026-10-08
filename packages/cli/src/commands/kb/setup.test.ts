import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { runKbSetupCommand, uvInstallLine } from "./setup.js";
import type { KbSetupReport } from "./setup.js";

const originalPath = process.env["PATH"];
const tempDirs: string[] = [];

afterEach(() => {
  if (originalPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = originalPath;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-kb-setup-"));
  tempDirs.push(dir);
  return dir;
}

/** Puts an empty PATH in place so no real `uv` can be found by the test machine's own PATH. */
function clearPath(): void {
  process.env["PATH"] = tempDir();
}

/** A `uv` that logs its argv to `calls.txt` beside itself and exits 0 without installing anything. */
function putLoggingFakeUvOnPath(): { dir: string; callsFile: string } {
  const dir = tempDir();
  const callsFile = path.join(dir, "calls.txt");
  if (process.platform === "win32") {
    writeFileSync(path.join(dir, "uv.cmd"), `@echo %* > "${callsFile}"\r\n@exit /b 0\r\n`);
  } else {
    const command = path.join(dir, "uv");
    writeFileSync(command, `#!/bin/sh\necho "$@" > "${callsFile}"\nexit 0\n`);
    chmodSync(command, 0o755);
  }
  process.env["PATH"] = `${dir}${path.delimiter}${originalPath ?? ""}`;
  return { dir, callsFile };
}

async function run(): Promise<KbSetupReport> {
  const result = await runKbSetupCommand({}, {} as never);
  return result.data;
}

describe("uvInstallLine", () => {
  test("names Homebrew or the official script on macOS", () => {
    expect(uvInstallLine("darwin")).toContain("brew install uv");
    expect(uvInstallLine("darwin")).toContain("astral.sh/uv/install.sh");
  });

  test("names winget on Windows", () => {
    expect(uvInstallLine("win32")).toBe("winget install astral-sh.uv");
  });

  test("falls back to the macOS/Linux line everywhere else", () => {
    expect(uvInstallLine("linux")).toBe(uvInstallLine("darwin"));
  });
});

describe("runKbSetupCommand", () => {
  test("prints this platform's install line and exits non-zero when uv is missing", async () => {
    clearPath();

    const report = await run();

    expect(report).toEqual({
      outcome: "uv-missing",
      platform: process.platform,
      installLine: uvInstallLine(process.platform),
    });
    expect(process.exitCode).toBe(1);
  });

  test("invokes uv with the pinned version and --prerelease=allow", async () => {
    const { callsFile } = putLoggingFakeUvOnPath();

    const report = await run();

    expect(report.outcome).toBe("installed");
    const invoked = readFileSync(callsFile, "utf8").trim();
    expect(invoked).toBe("tool install basic-memory==0.23.2 --prerelease=allow");
  });
});
