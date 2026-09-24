import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resetProcessPriorityPolicy, setProcessPriorityPolicy } from "./process-priority.js";
import { runGitCommand } from "./run-git-command.js";

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "paseo-git-fsmonitor-"));
  tempDirs.push(repo);
  return repo;
}

async function configureFsmonitor(repo: string): Promise<string> {
  const hookPath = path.join(repo, "fsmonitor-hook.sh");
  const markerPath = `${hookPath}.marker`;
  writeFileSync(hookPath, "#!/bin/sh\n: > \"$0.marker\"\nprintf '1\\n'\n");
  chmodSync(hookPath, 0o755);
  await runGitCommand(["config", "core.fsmonitor", hookPath], { cwd: repo });
  return markerPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("runGitCommand fsmonitor isolation", () => {
  it("does not execute a repository-configured fsmonitor command", async () => {
    const repo = makeTempRepo();
    await runGitCommand(["init"], { cwd: repo });
    const markerPath = await configureFsmonitor(repo);

    await runGitCommand(["status", "--porcelain"], { cwd: repo });

    expect(existsSync(markerPath)).toBe(false);
  });

  it("overrides core.fsmonitor for commands other than status", async () => {
    const repo = makeTempRepo();
    await runGitCommand(["init"], { cwd: repo });
    await configureFsmonitor(repo);

    const result = await runGitCommand(["config", "--get", "core.fsmonitor"], { cwd: repo });

    expect(result.stdout.trim()).toBe("false");
  });
});

describe("runGitCommand priority", () => {
  afterEach(() => {
    resetProcessPriorityPolicy();
  });

  // An alias runs a shell as git's child, so the nice value it prints is what git's children
  // inherit. The values differ from 10 because the test runner may itself run at nice 10.
  async function niceSeenByGitChild(priority?: "background"): Promise<number> {
    const repo = makeTempRepo();
    await runGitCommand(["init"], { cwd: repo });
    const { stdout } = await runGitCommand(
      ["-c", "alias.nice=!sleep 0.2; ps -o ni= -p $$", "nice"],
      { cwd: repo, priority },
    );
    return Number(stdout.trim());
  }

  it("runs a background git command at backgroundNice", async () => {
    setProcessPriorityPolicy({ backgroundNice: 15 });
    expect(await niceSeenByGitChild("background")).toBe(15);
  });

  it("leaves a git command without the option at the daemon's priority", async () => {
    setProcessPriorityPolicy({ backgroundNice: 15 });
    expect(await niceSeenByGitChild()).not.toBe(15);
  });
});
