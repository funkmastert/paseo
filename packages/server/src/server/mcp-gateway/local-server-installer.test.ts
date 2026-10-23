import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { McpGatewayActionError } from "./action-failure.js";
import { installLocalServer, runWithDeadline, type NpmRunner } from "./local-server-installer.js";
import type { ProcessTerminator } from "../../utils/tree-kill.js";
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

function installDir(paseoHome: string): string {
  return path.join(paseoHome, "mcp-gateway", "local-servers", `figma-${figma.version}`);
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

  test("an npm failure removes the directory, partial tree and all", async () => {
    const paseoHome = createTempHome();
    const directory = installDir(paseoHome);
    const runNpm: NpmRunner = async (command) => {
      mkdirSync(path.join(command.cwd, "node_modules", "half"), { recursive: true });
      throw Object.assign(new Error("Command failed"), { stderr: "npm ERR! network" });
    };

    await installLocalServer({ paseoHome, preset: figma, runNpm }).catch(() => undefined);

    expect(existsSync(directory)).toBe(false);
  });

  test("a timeout removes the directory and says how long npm was given", async () => {
    const paseoHome = createTempHome();
    const runNpm: NpmRunner = async (command) => {
      mkdirSync(path.join(command.cwd, "node_modules", "half"), { recursive: true });
      throw Object.assign(new Error("did not finish within 150 s"), {
        stderr: "did not finish within 150 s",
      });
    };

    const failure = await installLocalServer({ paseoHome, preset: figma, runNpm }).catch(
      (error: unknown) => error,
    );

    expect((failure as McpGatewayActionError).reason).toBe("install_failed");
    expect((failure as McpGatewayActionError).message).toContain("did not finish within 150 s");
    expect(existsSync(installDir(paseoHome))).toBe(false);
  });

  test("an install that leaves no entry file also removes the directory", async () => {
    const paseoHome = createTempHome();
    await installLocalServer({ paseoHome, preset: figma, runNpm: async () => undefined }).catch(
      () => undefined,
    );
    expect(existsSync(installDir(paseoHome))).toBe(false);
  });

  test("an entry file without the completion marker is not an install: it is cleared and redone", async () => {
    const paseoHome = createTempHome();
    const directory = installDir(paseoHome);
    // What an interrupted install leaves: the entry is there, its dependencies may not be.
    const entry = path.join(directory, ...figma.entry);
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, "// half installed");
    writeFileSync(path.join(directory, "stray-from-the-last-attempt"), "x");
    const runNpm = fakeNpm(paseoHome);

    await installLocalServer({ paseoHome, preset: figma, runNpm });

    expect(runNpm.calls).toHaveLength(1);
    expect(existsSync(path.join(directory, "stray-from-the-last-attempt"))).toBe(false);
    expect(readFileSync(entry, "utf8")).toBe("// fake");
  });

  test("the marker is written only after npm has finished", async () => {
    const paseoHome = createTempHome();
    const directory = installDir(paseoHome);
    let markerDuringNpm: boolean | undefined;
    const runNpm: NpmRunner = async (command) => {
      markerDuringNpm = readdirSync(directory).some((name) => name.includes("complete"));
      const entry = path.join(command.cwd, ...figma.entry);
      mkdirSync(path.dirname(entry), { recursive: true });
      writeFileSync(entry, "// fake");
    };

    await installLocalServer({ paseoHome, preset: figma, runNpm });

    expect(markerDuringNpm).toBe(false);
    expect(readdirSync(directory).some((name) => name.includes("complete"))).toBe(true);
  });

  test("two installs of one directory share a single npm run", async () => {
    const paseoHome = createTempHome();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const runNpm: NpmRunner = async (command) => {
      calls.push(command.cwd);
      await gate;
      const entry = path.join(command.cwd, ...figma.entry);
      mkdirSync(path.dirname(entry), { recursive: true });
      writeFileSync(entry, "// fake");
    };

    const first = installLocalServer({ paseoHome, preset: figma, runNpm });
    const second = installLocalServer({ paseoHome, preset: figma, runNpm });
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
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

describe("runWithDeadline", () => {
  const node = process.execPath;

  test("resolves when the command exits 0", async () => {
    await runWithDeadline({
      executable: node,
      args: ["-e", "process.exit(0)"],
      cwd: tmpdir(),
      timeout: 30_000,
    });
  });

  test("rejects with the command's stderr when it exits non-zero", async () => {
    const failure = await runWithDeadline({
      executable: node,
      args: ["-e", "process.stderr.write('npm ERR! 404'); process.exit(2)"],
      cwd: tmpdir(),
      timeout: 30_000,
    }).catch((error: unknown) => error);

    expect((failure as { stderr: string }).stderr).toContain("npm ERR! 404");
  });

  test("on timeout it kills the whole process tree and rejects only once the command has stopped", async () => {
    const stopped: number[] = [];
    const terminate: ProcessTerminator = async (child) => {
      await new Promise<void>((resolve) => {
        child.once?.("exit", () => resolve());
        child.kill("SIGKILL");
      });
      stopped.push(child.pid ?? -1);
      return "killed";
    };

    const failure = await runWithDeadline({
      executable: node,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tmpdir(),
      timeout: 50,
      terminate,
    }).catch((error: unknown) => error);

    expect(stopped).toHaveLength(1);
    expect((failure as { stderr: string }).stderr).toBe("did not finish within 0.05 s");
    expect(() => process.kill(stopped[0] ?? -1, 0)).toThrow();
  });
});
