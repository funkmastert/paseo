import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { listProcessesInside } from "./worktree-process-scan.js";

let root: string;
let child: ChildProcess | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "worktree-process-scan-"));
});

afterEach(() => {
  child?.kill("SIGKILL");
  child = null;
  rmSync(root, { recursive: true, force: true });
});

const LSOF = [
  "p10",
  "czsh",
  "fcwd",
  "n/wt/feature",
  "p11",
  "cbun",
  "fcwd",
  "n/home/t",
  "f12",
  "n/wt/feature/Clone/server.log",
  "f13",
  "n/wt/feature/Clone/other.log",
  "p12",
  "csourcekit-lsp",
  "ftxt",
  "n/wt/feature-2/bin/tool",
  "p99",
  "cnode",
  "fcwd",
  "n/wt/feature",
  "",
].join("\n");

describe("listProcessesInside", () => {
  // directoryForms resolves `directory` through node:path's native resolve() before comparing it
  // against the raw lsof-reported paths above. The injected `platform: "darwin"` only decides the
  // win32 short-circuit, not which path module parses the rest — on an actual Windows host,
  // resolve("/wt/feature") drive-prefixes and backslash-ifies it, so it stops matching these
  // literal POSIX fixture paths. A real win32 daemon never reaches this code at all (the
  // short-circuit above), so this never occurs outside a test fixture running on the "wrong" host.
  test.skipIf(process.platform === "win32")(
    "finds a process by its cwd or by any file it has open inside, once each",
    async () => {
      const scan = await listProcessesInside("/wt/feature", {
        runLsof: async () => LSOF,
        selfPid: 99,
        platform: "darwin",
      });
      expect(scan).toEqual({
        kind: "scanned",
        processes: [
          { pid: 10, command: "zsh", path: "/wt/feature" },
          { pid: 11, command: "bun", path: "/wt/feature/Clone/server.log" },
        ],
      });
    },
  );

  test("a sibling whose name starts the same is not inside", async () => {
    const scan = await listProcessesInside("/wt/feature", {
      runLsof: async () => "p12\ncsourcekit-lsp\nftxt\nn/wt/feature-2/bin/tool\n",
      selfPid: 1,
      platform: "darwin",
    });
    expect(scan).toEqual({ kind: "scanned", processes: [] });
  });

  test("the daemon's own process is left out", async () => {
    const scan = await listProcessesInside("/wt/feature", {
      runLsof: async () => "p99\ncnode\nfcwd\nn/wt/feature\n",
      selfPid: 99,
      platform: "darwin",
    });
    expect(scan).toEqual({ kind: "scanned", processes: [] });
  });

  test("a scan that fails or lists no process is failed, never empty", async () => {
    const failing = await listProcessesInside("/wt/feature", {
      runLsof: async () => {
        throw new Error("lsof exited 1");
      },
      platform: "darwin",
    });
    expect(failing).toEqual({ kind: "failed", error: "lsof exited 1" });
    const blank = await listProcessesInside("/wt/feature", {
      runLsof: async () => "",
      platform: "darwin",
    });
    expect(blank).toEqual({ kind: "failed", error: "lsof listed no processes" });
  });

  test("on Windows there is no lsof, so nothing is known", async () => {
    expect(await listProcessesInside("C:\\wt\\feature", { platform: "win32" })).toEqual({
      kind: "failed",
      error: "lsof is not available on Windows",
    });
  });

  test.skipIf(process.platform === "win32")(
    "finds a real process whose cwd is inside, through the real lsof",
    async () => {
      const inside = join(root, "worktree", "src");
      mkdirSync(inside, { recursive: true });
      child = spawn("sleep", ["30"], { cwd: inside, stdio: "ignore" });
      await new Promise((resolve) => child?.once("spawn", resolve));

      const scan = await listProcessesInside(join(root, "worktree"));

      expect(scan.kind).toBe("scanned");
      expect(scan.kind === "scanned" && scan.processes.map((entry) => entry.pid)).toContain(
        child.pid,
      );
    },
  );
});
