import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { McpGatewayActionError } from "./action-failure.js";
import { installLocalServer, type NpmRunner } from "./local-server-installer.js";
import { getLocalServerPreset, LOCAL_SERVER_PRESETS } from "./local-server-presets.js";

const tempDirs: string[] = [];

function createTempHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-local-server-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const figma = LOCAL_SERVER_PRESETS.figma;
if (!figma) throw new Error("figma preset missing");

/** Stands in for npm by laying down the entry file the real install would. */
function fakeNpm(paseoHome: string): NpmRunner & { calls: Array<Parameters<NpmRunner>[0]> } {
  const calls: Array<Parameters<NpmRunner>[0]> = [];
  const runner = (async (command) => {
    calls.push(command);
    const entry = path.join(command.cwd, ...figma.entry);
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, "// fake");
  }) as NpmRunner & { calls: typeof calls };
  runner.calls = calls;
  void paseoHome;
  return runner;
}

describe("figma preset", () => {
  test("pins an exact version and keeps telemetry and image downloads off", () => {
    expect(figma.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(figma.args).toEqual(["--stdio", "--no-telemetry", "--skip-image-downloads"]);
    expect(figma.tokenEnv).toBe("FIGMA_API_KEY");
  });

  test("lookup is by own key only", () => {
    expect(getLocalServerPreset("figma")).toBe(figma);
    expect(getLocalServerPreset("toString")).toBeUndefined();
    expect(getLocalServerPreset("nope")).toBeUndefined();
  });
});

describe("installLocalServer", () => {
  test("installs the exact pinned spec without lifecycle scripts and returns the launch spec", async () => {
    const paseoHome = createTempHome();
    const runNpm = fakeNpm(paseoHome);

    const spec = await installLocalServer({ paseoHome, preset: figma, runNpm });

    expect(runNpm.calls).toHaveLength(1);
    const [call] = runNpm.calls;
    expect(call?.args).toContain(`${figma.package}@${figma.version}`);
    expect(call?.args).toContain("--ignore-scripts");
    expect(call?.args).toContain("--save-exact");
    const directory = path.join(
      paseoHome,
      "mcp-gateway",
      "local-servers",
      `figma-${figma.version}`,
    );
    expect(call?.cwd).toBe(directory);
    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual([path.join(directory, ...figma.entry), ...figma.args]);
    expect(path.isAbsolute(spec.args[0] ?? "")).toBe(true);
    // The package.json keeps npm from adopting a parent directory as its prefix.
    expect(JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")).private).toBe(
      true,
    );
  });

  test("skips npm when the entry file is already there", async () => {
    const paseoHome = createTempHome();
    const runNpm = fakeNpm(paseoHome);
    await installLocalServer({ paseoHome, preset: figma, runNpm });
    await installLocalServer({ paseoHome, preset: figma, runNpm });
    expect(runNpm.calls).toHaveLength(1);
  });

  test("an npm failure becomes install_failed carrying the stderr tail", async () => {
    const paseoHome = createTempHome();
    const runNpm: NpmRunner = async () => {
      throw Object.assign(new Error("Command failed"), { stderr: "npm ERR! 404 Not Found\n" });
    };

    const failure = await installLocalServer({ paseoHome, preset: figma, runNpm }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(McpGatewayActionError);
    expect((failure as McpGatewayActionError).reason).toBe("install_failed");
    expect((failure as McpGatewayActionError).message).toContain("npm ERR! 404 Not Found");
    expect((failure as McpGatewayActionError).message).toContain(
      `${figma.package}@${figma.version}`,
    );
  });

  test("an install that leaves no entry file is a failure, not a launch spec", async () => {
    const paseoHome = createTempHome();
    const runNpm: NpmRunner = async () => undefined;
    const failure = await installLocalServer({ paseoHome, preset: figma, runNpm }).catch(
      (error: unknown) => error,
    );
    expect((failure as McpGatewayActionError).reason).toBe("install_failed");
    expect(
      existsSync(
        path.join(
          paseoHome,
          "mcp-gateway",
          "local-servers",
          `figma-${figma.version}`,
          ...figma.entry,
        ),
      ),
    ).toBe(false);
  });

  test("refuses a Node older than the package supports before touching npm", async () => {
    const paseoHome = createTempHome();
    const runNpm = fakeNpm(paseoHome);
    const old = { ...figma, minNode: [999, 0] as const };
    const failure = await installLocalServer({ paseoHome, preset: old, runNpm }).catch(
      (error: unknown) => error,
    );
    expect((failure as McpGatewayActionError).reason).toBe("install_failed");
    expect((failure as McpGatewayActionError).message).toContain("Node 999.0");
    expect(runNpm.calls).toHaveLength(0);
  });

  test("hands an Electron daemon's child ELECTRON_RUN_AS_NODE so it starts as node", async () => {
    const original = process.versions.electron;
    Object.defineProperty(process.versions, "electron", { value: "33.0.0", configurable: true });
    try {
      const paseoHome = createTempHome();
      const spec = await installLocalServer({
        paseoHome,
        preset: figma,
        runNpm: fakeNpm(paseoHome),
      });
      expect(spec.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    } finally {
      if (original === undefined) {
        delete (process.versions as Record<string, unknown>).electron;
      } else {
        Object.defineProperty(process.versions, "electron", {
          value: original,
          configurable: true,
        });
      }
    }
  });

  test("a plain node daemon needs no extra environment", async () => {
    const paseoHome = createTempHome();
    const spec = await installLocalServer({ paseoHome, preset: figma, runNpm: fakeNpm(paseoHome) });
    expect(spec.env).toEqual({});
  });
});
