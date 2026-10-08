import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { knowledgeBaseCheck } from "./knowledge-base.js";
import { createRealProbes } from "./probes.js";
import { makeContext, makeFixture, writeConfig, type Fixture } from "./test-support.js";

const originalPath = process.env["PATH"];
const tempDirs: string[] = [];

afterEach(() => {
  if (originalPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = originalPath;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-kb-doctor-"));
  tempDirs.push(dir);
  return dir;
}

/** A placeholder `basic-memory`: resolution only checks the file exists, it is never run. */
function fakeBasicMemoryPath(): string {
  const dir = tempDir();
  const command = path.join(
    dir,
    process.platform === "win32" ? "basic-memory.exe" : "basic-memory",
  );
  writeFileSync(command, "");
  if (process.platform !== "win32") chmodSync(command, 0o755);
  return command;
}

/** A `uv` whose `tool list` always prints `line`, on PATH ahead of anything already there. */
function putFakeUvOnPath(line: string): void {
  const dir = tempDir();
  const command = process.platform === "win32" ? path.join(dir, "uv.cmd") : path.join(dir, "uv");
  const contents =
    process.platform === "win32" ? `@echo ${line}\r\n` : `#!/bin/sh\necho "${line}"\n`;
  writeFileSync(command, contents);
  if (process.platform !== "win32") chmodSync(command, 0o755);
  process.env["PATH"] = `${dir}${path.delimiter}${originalPath ?? ""}`;
}

function enabledConfig(fixture: Fixture, command: string) {
  return {
    knowledgeBase: {
      enabled: true,
      notesDir: path.join(fixture.paseoHome, "knowledge"),
      basicMemory: { command },
    },
  };
}

describe("knowledgeBaseCheck", () => {
  test("reports nothing when the section is absent", async () => {
    const fixture = makeFixture();
    const ctx = makeContext(fixture);
    expect(await knowledgeBaseCheck.run(ctx, Date.now() + 10_000)).toEqual([]);
  });

  test("reports nothing when enabled: false", async () => {
    const fixture = makeFixture();
    writeConfig(fixture, { knowledgeBase: { enabled: false } });
    const ctx = makeContext(fixture);
    expect(await knowledgeBaseCheck.run(ctx, Date.now() + 10_000)).toEqual([]);
  });

  test("fails when the binary is missing", async () => {
    const fixture = makeFixture();
    writeConfig(fixture, enabledConfig(fixture, "paseo-kb-doctor-test-missing-binary"));
    mkdirSync(path.join(fixture.paseoHome, "knowledge"), { recursive: true });
    const ctx = makeContext(fixture);

    const findings = await knowledgeBaseCheck.run(ctx, Date.now() + 10_000);

    const missing = findings.find((f) => f.title === "Basic Memory is not installed");
    expect(missing?.status).toBe("fail");
    expect(missing?.fix).toBe("paseo kb setup");
  });

  test("reports ok with the version when it matches the pin", async () => {
    const fixture = makeFixture();
    const command = fakeBasicMemoryPath();
    writeConfig(fixture, enabledConfig(fixture, command));
    mkdirSync(path.join(fixture.paseoHome, "knowledge"), { recursive: true });
    putFakeUvOnPath("basic-memory v0.23.2");
    const ctx = makeContext(fixture, {}, { probes: createRealProbes() });

    const findings = await knowledgeBaseCheck.run(ctx, Date.now() + 10_000);

    const version = findings.find((f) => f.title.startsWith("Basic Memory 0.23.2"));
    expect(version?.status).toBe("ok");
  });

  test("warns on a version mismatch against the pin", async () => {
    const fixture = makeFixture();
    const command = fakeBasicMemoryPath();
    writeConfig(fixture, enabledConfig(fixture, command));
    mkdirSync(path.join(fixture.paseoHome, "knowledge"), { recursive: true });
    putFakeUvOnPath("basic-memory v0.20.0");
    const ctx = makeContext(fixture, {}, { probes: createRealProbes() });

    const findings = await knowledgeBaseCheck.run(ctx, Date.now() + 10_000);

    const mismatch = findings.find((f) =>
      f.title.includes("0.20.0 is installed; the pin is 0.23.2"),
    );
    expect(mismatch?.status).toBe("warn");
    expect(mismatch?.fix).toBe("paseo kb setup");
  });

  test("fails when the notes directory is not writable", async () => {
    const fixture = makeFixture();
    const command = fakeBasicMemoryPath();
    const notesDir = path.join(fixture.paseoHome, "knowledge");
    mkdirSync(notesDir, { recursive: true });
    if (process.platform !== "win32") chmodSync(notesDir, 0o500);
    writeConfig(fixture, {
      knowledgeBase: { enabled: true, notesDir, basicMemory: { command } },
    });
    putFakeUvOnPath("basic-memory v0.23.2");
    const ctx = makeContext(fixture, {}, { probes: createRealProbes() });

    const findings = await knowledgeBaseCheck.run(ctx, Date.now() + 10_000);

    try {
      const notesFinding = findings.find((f) => f.title.includes("Notes directory"));
      // chmod 0o500 does not deny directory writes on Windows (no POSIX permission bits), so
      // there is no reliable way to fabricate an unwritable directory here; this assertion is
      // POSIX-only. The rest of the test still runs on Windows as a smoke check.
      if (process.platform !== "win32") {
        expect(notesFinding?.status).toBe("fail");
      }
    } finally {
      if (process.platform !== "win32") chmodSync(notesDir, 0o755);
    }
  });
});
