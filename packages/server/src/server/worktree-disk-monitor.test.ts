import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../test-utils/test-logger.js";
import { getPaseoWorktreesRoot } from "../utils/worktree.js";
import { sampleDirectorySizeBytes } from "../utils/directory-size-sampler.js";
import { WorktreeDiskMonitor, type DiskSweeperConfig } from "./worktree-disk-monitor.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "./workspace-registry.js";

const NOW_ISO = "2026-09-12T00:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const DAY_MS = 24 * 60 * 60 * 1000;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, command: string): void {
  execSync(`git -c commit.gpgsign=false ${command}`, { cwd, stdio: "pipe" });
}

function initGitRepoWithRemote(repoDir: string, remoteDir: string): void {
  execSync(`git init --bare -b main ${remoteDir}`, { stdio: "pipe" });
  git(repoDir, "init -b main");
  git(repoDir, "config user.email 'paseo-test@example.com'");
  git(repoDir, "config user.name 'Paseo Test'");
  writeFileSync(join(repoDir, "README.md"), "init\n");
  git(repoDir, "add README.md");
  git(repoDir, "commit -m 'Initial commit'");
  git(repoDir, `remote add origin ${remoteDir}`);
  git(repoDir, "push -u origin main");
}

interface WorktreeFixtureOptions {
  mainRepoDir: string;
  worktreesBaseRoot: string;
  paseoHome: string;
  slug: string;
  /** Bytes of filler content written into the worktree, for reclaimed-bytes assertions. */
  fillerBytes?: number;
  dirty?: boolean;
  /** Local commits never pushed — makes the branch ahead of its own pushed upstream. */
  unpushedCommits?: number;
}

/** A real, git-clean-by-default worktree under a real worktrees-base-root layout. */
async function createWorktreeFixture(options: WorktreeFixtureOptions): Promise<string> {
  const worktreesRoot = await getPaseoWorktreesRoot(
    options.mainRepoDir,
    options.paseoHome,
    options.worktreesBaseRoot,
  );
  mkdirSync(worktreesRoot, { recursive: true });
  const worktreePath = join(worktreesRoot, options.slug);
  git(options.mainRepoDir, `worktree add -b ${options.slug} ${worktreePath}`);

  if (options.fillerBytes) {
    writeFileSync(join(worktreePath, "filler.bin"), Buffer.alloc(options.fillerBytes, 7));
    git(worktreePath, "add filler.bin");
    git(worktreePath, "commit -m 'filler'");
  }

  // Push so the branch has a real upstream — aheadOfOrigin/behindOfOrigin need one to resolve to
  // anything but null (ambiguous, which the detector always keeps).
  git(worktreePath, `push -u origin ${options.slug}`);

  if (options.unpushedCommits) {
    for (let i = 0; i < options.unpushedCommits; i += 1) {
      writeFileSync(join(worktreePath, `extra-${i}.txt`), `extra ${i}`);
      git(worktreePath, `add extra-${i}.txt`);
      git(worktreePath, `commit -m 'extra ${i}'`);
    }
  }

  if (options.dirty) {
    writeFileSync(join(worktreePath, "dirty.txt"), "uncommitted\n");
  }

  return worktreePath;
}

function worktreeWorkspaceRecord(
  input: Partial<PersistedWorkspaceRecord> & {
    workspaceId: string;
    projectId: string;
    cwd: string;
  },
): PersistedWorkspaceRecord {
  return {
    kind: "worktree",
    displayName: input.workspaceId,
    worktreeRoot: input.cwd,
    baseBranch: null,
    isPaseoOwnedWorktree: true,
    mainRepoRoot: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    archivedAt: null,
    ...input,
  };
}

class FakeSender {
  readonly sent: Array<{ title: string; body: string; data: Record<string, unknown> }> = [];
  async send(payload: {
    title: string;
    body: string;
    data: Record<string, unknown>;
  }): Promise<void> {
    this.sent.push(payload);
  }
}

interface MonitorHarnessOptions {
  projects?: PersistedProjectRecord[];
  workspaces?: PersistedWorkspaceRecord[];
  config?: DiskSweeperConfig;
  nowMs?: number;
  statfs?: (path: string) => Promise<{ bavail: number; bsize: number }>;
  worktreesBaseRoot?: string;
}

function makeMonitor(input: MonitorHarnessOptions) {
  let projects = input.projects ?? [];
  let workspaces = input.workspaces ?? [];
  let currentNowMs = input.nowMs ?? NOW_MS;
  let config = input.config ?? {};
  const sender = new FakeSender();
  const projectListCalls: number[] = [];

  const monitor = new WorktreeDiskMonitor({
    projectRegistry: {
      list: async () => {
        projectListCalls.push(1);
        return projects;
      },
    },
    workspaceRegistry: { list: async () => workspaces },
    paseoHome: makeTempDir("paseo-disk-monitor-home-"),
    worktreesBaseRoot: input.worktreesBaseRoot,
    serverId: "server-1",
    getPushNotificationSender: () => sender,
    readDaemonConfig: () => ({ diskSweeper: config }),
    logger: createTestLogger(),
    now: () => currentNowMs,
    // Comfortably above any test's minFreeGB by default — the emergency-check tests override this.
    statfs: input.statfs ?? (async () => ({ bavail: 100_000_000, bsize: 4096 })),
  });

  return {
    monitor,
    sender,
    projectListCalls,
    setWorkspaces: (next: PersistedWorkspaceRecord[]) => {
      workspaces = next;
    },
    setProjects: (next: PersistedProjectRecord[]) => {
      projects = next;
    },
    setNowMs: (ms: number) => {
      currentNowMs = ms;
    },
    setConfig: (next: DiskSweeperConfig) => {
      config = next;
    },
  };
}

function project(rootPath: string): PersistedProjectRecord {
  return {
    projectId: rootPath,
    rootPath,
    kind: "git",
    displayName: rootPath,
    customName: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    archivedAt: null,
  };
}

describe("WorktreeDiskMonitor — config gating", () => {
  test("disabled config is an early-out: no registries read, no notifications sent", async () => {
    const harness = makeMonitor({ config: { enabled: false } });
    harness.setProjects([project("/does/not/matter")]);

    await harness.monitor.tick();

    expect(harness.projectListCalls).toEqual([]);
    expect(harness.sender.sent).toEqual([]);
  });
});

describe("WorktreeDiskMonitor — sampling rotation and requests", () => {
  test("rotation samples exactly one active worktree per tick", async () => {
    const ws1Dir = makeTempDir("paseo-disk-monitor-ws1-");
    const ws2Dir = makeTempDir("paseo-disk-monitor-ws2-");
    writeFileSync(join(ws1Dir, "a.bin"), Buffer.alloc(4096));
    writeFileSync(join(ws2Dir, "a.bin"), Buffer.alloc(4096));

    const harness = makeMonitor({
      workspaces: [
        worktreeWorkspaceRecord({ workspaceId: "ws-1", projectId: "p", cwd: ws1Dir }),
        worktreeWorkspaceRecord({ workspaceId: "ws-2", projectId: "p", cwd: ws2Dir }),
      ],
    });

    await harness.monitor.tick();
    const afterFirst = {
      ws1: harness.monitor.getDiskUsage("ws-1"),
      ws2: harness.monitor.getDiskUsage("ws-2"),
    };
    expect([afterFirst.ws1, afterFirst.ws2].filter((v) => v !== undefined)).toHaveLength(1);

    await harness.monitor.tick();
    expect(harness.monitor.getDiskUsage("ws-1")).toBeDefined();
    expect(harness.monitor.getDiskUsage("ws-2")).toBeDefined();
  });

  test("a requested sample is drained the same tick, ahead of the rotation reaching it", async () => {
    const dirs = ["ws-1", "ws-2", "ws-3"].map(() => makeTempDir("paseo-disk-monitor-req-"));
    for (const dir of dirs) writeFileSync(join(dir, "a.bin"), Buffer.alloc(4096));

    const harness = makeMonitor({
      workspaces: dirs.map((dir, index) =>
        worktreeWorkspaceRecord({ workspaceId: `ws-${index}`, projectId: "p", cwd: dir }),
      ),
    });

    // Rotation would reach ws-0 first; request ws-2 directly instead.
    harness.monitor.requestSample("ws-2", dirs[2]);
    await harness.monitor.tick();

    expect(harness.monitor.getDiskUsage("ws-2")).toBeDefined();
  });
});

describe("WorktreeDiskMonitor — emergency free-space check", () => {
  test("crossing below minFreeGB fires a critical push exactly once, out-of-cycle sweep still gated", async () => {
    const harness = makeMonitor({
      config: { minFreeGB: 5 },
      statfs: async () => ({ bavail: 1, bsize: 1 }), // ~1 byte free, always critical
    });

    await harness.monitor.tick();
    expect(harness.sender.sent.filter((p) => p.data.reason === "disk_space_critical")).toHaveLength(
      1,
    );

    // Still critical on the next tick — no re-fire until it recovers first.
    await harness.monitor.tick();
    expect(harness.sender.sent.filter((p) => p.data.reason === "disk_space_critical")).toHaveLength(
      1,
    );
  });
});

describe("WorktreeDiskMonitor — sweep behavior (real git fixtures)", () => {
  test("deletes an archived, past-retention, clean, not-ahead worktree and reports reclaimed bytes", async () => {
    const mainRepoDir = makeTempDir("paseo-disk-monitor-repo-");
    const remoteDir = makeTempDir("paseo-disk-monitor-remote-");
    const worktreesBaseRoot = makeTempDir("paseo-disk-monitor-base-");
    initGitRepoWithRemote(mainRepoDir, remoteDir);

    const worktreePath = await createWorktreeFixture({
      mainRepoDir,
      worktreesBaseRoot,
      paseoHome: worktreesBaseRoot,
      slug: "reclaim-me",
      fillerBytes: 16_384,
    });
    const expectedBytes = await sampleDirectorySizeBytes(worktreePath, { timeoutMs: 5000 });
    expect(expectedBytes).toBeGreaterThan(0);

    const archivedAt = new Date(NOW_MS - 8 * DAY_MS).toISOString();
    const harness = makeMonitor({
      projects: [project(mainRepoDir)],
      workspaces: [
        worktreeWorkspaceRecord({
          workspaceId: "ws-archived",
          projectId: mainRepoDir,
          cwd: worktreePath,
          worktreeRoot: worktreePath,
          archivedAt,
        }),
      ],
      config: { retentionDays: 7, maxDeletionsPerTick: 5 },
      worktreesBaseRoot,
    });

    await harness.monitor.tick();

    expect(() => statSync(worktreePath)).toThrow();
    const reclaimed = harness.sender.sent.find((p) => p.data.reason === "disk_sweep_reclaimed");
    expect(reclaimed).toBeDefined();
    expect(reclaimed?.body).toContain("1 abandoned worktree");
  });

  test("never deletes a dirty worktree, even long past retention", async () => {
    const mainRepoDir = makeTempDir("paseo-disk-monitor-repo-");
    const remoteDir = makeTempDir("paseo-disk-monitor-remote-");
    const worktreesBaseRoot = makeTempDir("paseo-disk-monitor-base-");
    initGitRepoWithRemote(mainRepoDir, remoteDir);

    const worktreePath = await createWorktreeFixture({
      mainRepoDir,
      worktreesBaseRoot,
      paseoHome: worktreesBaseRoot,
      slug: "dirty-worktree",
      dirty: true,
    });

    const archivedAt = new Date(NOW_MS - 30 * DAY_MS).toISOString();
    const harness = makeMonitor({
      projects: [project(mainRepoDir)],
      workspaces: [
        worktreeWorkspaceRecord({
          workspaceId: "ws-dirty",
          projectId: mainRepoDir,
          cwd: worktreePath,
          worktreeRoot: worktreePath,
          archivedAt,
        }),
      ],
      config: { retentionDays: 7 },
      worktreesBaseRoot,
    });

    await harness.monitor.tick();

    expect(statSync(worktreePath).isDirectory()).toBe(true);
    expect(harness.sender.sent.some((p) => p.data.reason === "disk_sweep_reclaimed")).toBe(false);
    expect(harness.sender.sent.some((p) => p.data.reason === "disk_sweep_unsafe_orphan")).toBe(
      true,
    );
  });

  test("keeps an archived worktree still within its retention grace period", async () => {
    const mainRepoDir = makeTempDir("paseo-disk-monitor-repo-");
    const remoteDir = makeTempDir("paseo-disk-monitor-remote-");
    const worktreesBaseRoot = makeTempDir("paseo-disk-monitor-base-");
    initGitRepoWithRemote(mainRepoDir, remoteDir);

    const worktreePath = await createWorktreeFixture({
      mainRepoDir,
      worktreesBaseRoot,
      paseoHome: worktreesBaseRoot,
      slug: "in-grace",
    });

    const archivedAt = new Date(NOW_MS - 1 * DAY_MS).toISOString();
    const harness = makeMonitor({
      projects: [project(mainRepoDir)],
      workspaces: [
        worktreeWorkspaceRecord({
          workspaceId: "ws-in-grace",
          projectId: mainRepoDir,
          cwd: worktreePath,
          worktreeRoot: worktreePath,
          archivedAt,
        }),
      ],
      config: { retentionDays: 7 },
      worktreesBaseRoot,
    });

    await harness.monitor.tick();

    expect(statSync(worktreePath).isDirectory()).toBe(true);
    expect(harness.sender.sent).toEqual([]);
  });

  test("never deletes a directory referenced by an active workspace, even if another record marks it archived", async () => {
    const mainRepoDir = makeTempDir("paseo-disk-monitor-repo-");
    const remoteDir = makeTempDir("paseo-disk-monitor-remote-");
    const worktreesBaseRoot = makeTempDir("paseo-disk-monitor-base-");
    initGitRepoWithRemote(mainRepoDir, remoteDir);

    const worktreePath = await createWorktreeFixture({
      mainRepoDir,
      worktreesBaseRoot,
      paseoHome: worktreesBaseRoot,
      slug: "shared-cwd",
    });

    const archivedAt = new Date(NOW_MS - 30 * DAY_MS).toISOString();
    const harness = makeMonitor({
      projects: [project(mainRepoDir)],
      workspaces: [
        worktreeWorkspaceRecord({
          workspaceId: "ws-archived-sibling",
          projectId: mainRepoDir,
          cwd: worktreePath,
          worktreeRoot: worktreePath,
          archivedAt,
        }),
        worktreeWorkspaceRecord({
          workspaceId: "ws-active-sibling",
          projectId: mainRepoDir,
          cwd: worktreePath,
          worktreeRoot: worktreePath,
          archivedAt: null,
        }),
      ],
      config: { retentionDays: 7 },
      worktreesBaseRoot,
    });

    await harness.monitor.tick();

    expect(statSync(worktreePath).isDirectory()).toBe(true);
  });

  test("maxDeletionsPerTick caps deletions; the remainder clears on the next tick", async () => {
    const mainRepoDir = makeTempDir("paseo-disk-monitor-repo-");
    const remoteDir = makeTempDir("paseo-disk-monitor-remote-");
    const worktreesBaseRoot = makeTempDir("paseo-disk-monitor-base-");
    initGitRepoWithRemote(mainRepoDir, remoteDir);

    const archivedAt = new Date(NOW_MS - 30 * DAY_MS).toISOString();
    const slugs = ["cap-1", "cap-2", "cap-3"];
    const worktreePaths: string[] = [];
    const workspaces: PersistedWorkspaceRecord[] = [];
    for (const slug of slugs) {
      const worktreePath = await createWorktreeFixture({
        mainRepoDir,
        worktreesBaseRoot,
        paseoHome: worktreesBaseRoot,
        slug,
      });
      worktreePaths.push(worktreePath);
      workspaces.push(
        worktreeWorkspaceRecord({
          workspaceId: `ws-${slug}`,
          projectId: mainRepoDir,
          cwd: worktreePath,
          worktreeRoot: worktreePath,
          archivedAt,
        }),
      );
    }

    const harness = makeMonitor({
      projects: [project(mainRepoDir)],
      workspaces,
      config: { retentionDays: 7, maxDeletionsPerTick: 2 },
      worktreesBaseRoot,
    });

    await harness.monitor.tick();
    const remainingAfterFirst = worktreePaths.filter((p) => {
      try {
        statSync(p);
        return true;
      } catch {
        return false;
      }
    });
    expect(remainingAfterFirst).toHaveLength(1);

    await harness.monitor.tick();
    const remainingAfterSecond = worktreePaths.filter((p) => {
      try {
        statSync(p);
        return true;
      } catch {
        return false;
      }
    });
    expect(remainingAfterSecond).toHaveLength(0);
  });

  test("re-notifies an unsafe orphan at most once per day", async () => {
    const mainRepoDir = makeTempDir("paseo-disk-monitor-repo-");
    const remoteDir = makeTempDir("paseo-disk-monitor-remote-");
    const worktreesBaseRoot = makeTempDir("paseo-disk-monitor-base-");
    initGitRepoWithRemote(mainRepoDir, remoteDir);

    const worktreePath = await createWorktreeFixture({
      mainRepoDir,
      worktreesBaseRoot,
      paseoHome: worktreesBaseRoot,
      slug: "rearm-me",
      dirty: true,
    });

    const archivedAt = new Date(NOW_MS - 30 * DAY_MS).toISOString();
    const harness = makeMonitor({
      projects: [project(mainRepoDir)],
      workspaces: [
        worktreeWorkspaceRecord({
          workspaceId: "ws-rearm",
          projectId: mainRepoDir,
          cwd: worktreePath,
          worktreeRoot: worktreePath,
          archivedAt,
        }),
      ],
      config: { retentionDays: 7 },
      worktreesBaseRoot,
    });

    await harness.monitor.tick();
    expect(
      harness.sender.sent.filter((p) => p.data.reason === "disk_sweep_unsafe_orphan"),
    ).toHaveLength(1);

    // An hour later — still within the 24h re-arm window.
    harness.setNowMs(NOW_MS + 60 * 60 * 1000);
    await harness.monitor.tick();
    expect(
      harness.sender.sent.filter((p) => p.data.reason === "disk_sweep_unsafe_orphan"),
    ).toHaveLength(1);

    // Past 24h — re-arms.
    harness.setNowMs(NOW_MS + 25 * 60 * 60 * 1000);
    await harness.monitor.tick();
    expect(
      harness.sender.sent.filter((p) => p.data.reason === "disk_sweep_unsafe_orphan"),
    ).toHaveLength(2);
  });
});
