import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  AgentWorkSnapshotSweep,
  buildWorkSnapshotAgentViews,
  listPaseoWorktreeDirectories,
  type WorkSnapshotAgentView,
  WORK_AT_RISK_JUDGE_TASK,
} from "./agent-work-snapshot-sweep.js";
import { GitWorktreeSnapshotter } from "./agent/worktree-snapshot.js";
import { UNRESPONSIVE_CANCEL_ERROR } from "./agent/turn-cancel.js";
import type { RemediationObservation } from "./remediation/contract.js";
import type { WorkSnapshotsConfig } from "./remediation/config.js";

// Real repositories and a real snapshotter; only the agent list and the ladder are stand-ins.
const MINUTE = 60_000;
const NOW = Date.parse("2026-09-24T15:00:00.000Z");
const TWO_HOURS_AGO = NOW - 120 * MINUTE;

let root: string;
let remote: string;
const cleanup: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();
}

/** A clone of the shared remote: clean and fully pushed until a test dirties it. */
function makeRepo(parent: string, name: string): string {
  const path = join(parent, name);
  git(parent, "clone", "-q", remote, path);
  return path;
}

function view(overrides: Partial<WorkSnapshotAgentView> = {}): WorkSnapshotAgentView {
  return {
    id: "agent-1aaaaaaa",
    title: "Build the feature",
    cwd: "/nowhere",
    workspaceId: "ws-1",
    archived: false,
    live: false,
    lifecycle: "closed",
    busy: false,
    lastError: null,
    lastActivityAtMs: TWO_HOURS_AGO,
    ...overrides,
  };
}

interface Harness {
  sweep: AgentWorkSnapshotSweep;
  observations: RemediationObservation[];
  statePath: string;
  setNow(ms: number): void;
}

function harness(input: {
  agents?: WorkSnapshotAgentView[];
  activeWorkspaceDirectories?: string[];
  orphanCandidates?: string[];
  config?: WorkSnapshotsConfig;
  statePath?: string;
}): Harness {
  let now = NOW;
  const observations: RemediationObservation[] = [];
  const statePath = input.statePath ?? join(root, "paseo-home", "work-snapshots.json");
  const snapshotter = new GitWorktreeSnapshotter({
    readConfig: () => ({
      personalOwners: ["funkmastert"],
      bundleDir: join(root, "bundles"),
      maxUntrackedFileBytes: 1024 * 1024,
    }),
    paseoHome: join(root, "paseo-home"),
    logger: pino({ level: "silent" }),
    now: () => now,
  });
  const sweep = new AgentWorkSnapshotSweep({
    dependencies: {
      listAgents: async () => input.agents ?? [],
      listActiveWorkspaceDirectories: async () => input.activeWorkspaceDirectories ?? [],
      listOrphanCandidates: async () => input.orphanCandidates ?? [],
      snapshotter,
    },
    sink: {
      observe: async (observation) => {
        observations.push(observation);
      },
    },
    readConfig: () => ({ workSnapshots: input.config ?? {} }),
    statePath,
    logger: pino({ level: "silent" }),
    now: () => now,
  });
  return {
    sweep,
    observations,
    statePath,
    setNow: (ms) => {
      now = ms;
    },
  };
}

function backupRefs(cwd: string): string[] {
  return git(cwd, "for-each-ref", "--format=%(refname)", "refs/backup/")
    .split("\n")
    .filter(Boolean);
}

beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_SYSTEM", "/dev/null");
  root = realpathSync(mkdtempSync(join(tmpdir(), "work-snapshot-sweep-")));
  remote = join(root, "remote.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "main", seed);
  writeFileSync(join(seed, "README.md"), "hello\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "push", "-q", remote, "main");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("AgentWorkSnapshotSweep", () => {
  test("snapshots an archived agent's dirty worktree and hands the batch to one judge", async () => {
    const repo = makeRepo(root, "feature");
    writeFileSync(join(repo, "README.md"), "wip\n");
    const { sweep, observations } = harness({
      agents: [view({ cwd: repo, archived: true })],
    });

    const report = await sweep.tick();

    expect(report?.snapshots).toHaveLength(1);
    const [ref] = backupRefs(repo);
    expect(ref).toMatch(/^refs\/backup\//);
    expect(observations).toHaveLength(1);
    const [observation] = observations;
    expect(observation).toMatchObject({
      key: "work-at-risk",
      kind: "work-at-risk",
      active: true,
      remedy: "none",
      graceMs: 0,
      level: "alert",
      escalation: { task: WORK_AT_RISK_JUDGE_TASK, taskClass: "mechanical" },
    });
    expect(observation.evidence).toContain(repo);
    expect(observation.evidence).toContain("main");
    expect(observation.evidence).toContain("agent-1aaaaaaa");
    expect(observation.evidence).toContain("Build the feature");
    expect(observation.evidence).toContain("1 dirty file(s)");
    expect(observation.evidence).toContain("0 unpushed commit(s)");
    expect(observation.evidence).toContain(ref);
    expect(observation.evidence).toContain("bundled");
  });

  test("the next sweep reports the condition inactive, and an unchanged worktree is not handed over again", async () => {
    const repo = makeRepo(root, "feature");
    writeFileSync(join(repo, "README.md"), "wip\n");
    const { sweep, observations, setNow } = harness({
      agents: [view({ cwd: repo, archived: true })],
    });

    await sweep.tick();
    setNow(NOW + 60 * MINUTE);
    await sweep.tick();
    setNow(NOW + 120 * MINUTE);
    await sweep.tick();

    expect(observations.map((observation) => observation.active)).toEqual([true, false]);
    expect(observations[1]).toMatchObject({ key: "work-at-risk", kind: "work-at-risk" });
    expect(backupRefs(repo)).toHaveLength(1);
  });

  test("new work in a handed-over worktree is handed over again, once the last batch is closed", async () => {
    const repo = makeRepo(root, "feature");
    writeFileSync(join(repo, "README.md"), "wip\n");
    const { sweep, observations, setNow } = harness({
      agents: [view({ cwd: repo, archived: true })],
    });
    await sweep.tick();

    writeFileSync(join(repo, "README.md"), "more wip\n");
    setNow(NOW + 60 * MINUTE);
    await sweep.tick();
    // Closing sweep: the new snapshot is taken, but not handed over in the same sweep.
    expect(backupRefs(repo)).toHaveLength(2);
    expect(observations.map((observation) => observation.active)).toEqual([true, false]);

    setNow(NOW + 120 * MINUTE);
    await sweep.tick();
    expect(observations.map((observation) => observation.active)).toEqual([true, false, true]);
    expect(backupRefs(repo)).toHaveLength(2);
  });

  test("what was handed over survives a restart", async () => {
    const repo = makeRepo(root, "feature");
    writeFileSync(join(repo, "README.md"), "wip\n");
    const agents = [view({ cwd: repo, archived: true })];
    const first = harness({ agents });
    await first.sweep.tick();
    first.setNow(NOW + 60 * MINUTE);
    await first.sweep.tick();

    const second = harness({ agents, statePath: first.statePath });
    second.setNow(NOW + 120 * MINUTE);
    await second.sweep.tick();

    expect(second.observations).toEqual([]);
  });

  test("an episode left open by a restart is closed by the next daemon's first sweep", async () => {
    const repo = makeRepo(root, "feature");
    writeFileSync(join(repo, "README.md"), "wip\n");
    const agents = [view({ cwd: repo, archived: true })];
    const first = harness({ agents });
    await first.sweep.tick();

    const second = harness({ agents, statePath: first.statePath });
    await second.sweep.tick();

    expect(second.observations.map((observation) => observation.active)).toEqual([false]);
  });

  test("a clean, pushed worktree is not snapshotted and nothing is observed", async () => {
    const repo = makeRepo(root, "clean");
    const { sweep, observations } = harness({ agents: [view({ cwd: repo, archived: true })] });
    const report = await sweep.tick();
    expect(report?.snapshots).toEqual([]);
    expect(observations).toEqual([]);
    expect(backupRefs(repo)).toEqual([]);
  });

  test("dead, wedged and archived agents count; working and freshly closed ones do not", async () => {
    const make = (name: string) => {
      const repo = makeRepo(root, name);
      writeFileSync(join(repo, "README.md"), `${name}\n`);
      return repo;
    };
    const dead = make("dead");
    const errored = make("errored");
    const unresponsive = make("unresponsive");
    const archived = make("archived");
    const running = make("running");
    const justClosed = make("just-closed");
    const idle = make("idle");
    const { sweep } = harness({
      agents: [
        view({ id: "dead", cwd: dead }),
        view({ id: "errored", cwd: errored, live: true, lifecycle: "error" }),
        view({
          id: "unresponsive",
          cwd: unresponsive,
          live: true,
          lifecycle: "idle",
          lastError: UNRESPONSIVE_CANCEL_ERROR,
        }),
        view({ id: "archived", cwd: archived, archived: true, lastActivityAtMs: NOW }),
        view({ id: "running", cwd: running, live: true, lifecycle: "running", busy: true }),
        view({ id: "just-closed", cwd: justClosed, lastActivityAtMs: NOW - 5 * MINUTE }),
        view({ id: "idle", cwd: idle, live: true, lifecycle: "idle" }),
      ],
    });

    const report = await sweep.tick();

    const byPath = new Map(report?.snapshots.map((entry) => [entry.worktreePath, entry.reason]));
    expect(byPath).toEqual(
      new Map([
        [dead, "dead"],
        [errored, "wedged"],
        [unresponsive, "wedged"],
        [archived, "archived"],
      ]),
    );
  });

  test("a worktree a working agent still uses is left alone, even when an archived agent shares it", async () => {
    const repo = makeRepo(root, "shared");
    writeFileSync(join(repo, "README.md"), "wip\n");
    const { sweep } = harness({
      agents: [
        view({ id: "old", cwd: repo, archived: true }),
        view({ id: "new", cwd: repo, live: true, lifecycle: "idle", lastActivityAtMs: NOW }),
      ],
    });
    const report = await sweep.tick();
    expect(report?.snapshots).toEqual([]);
    expect(backupRefs(repo)).toEqual([]);
  });

  test("worktrees under /tmp go first when the per-sweep cap bites", async () => {
    const tmpParent = realpathSync(mkdtempSync("/tmp/work-snapshot-sweep-"));
    cleanup.push(tmpParent);
    const elsewhere = makeRepo(root, "elsewhere");
    const inTmp = makeRepo(tmpParent, "in-tmp");
    writeFileSync(join(elsewhere, "README.md"), "wip\n");
    writeFileSync(join(inTmp, "README.md"), "wip\n");
    const { sweep } = harness({
      agents: [
        view({ id: "a", cwd: elsewhere, archived: true }),
        view({ id: "b", cwd: inTmp, archived: true }),
      ],
      config: { maxPerSweep: 1 },
    });

    const report = await sweep.tick();

    expect(report?.snapshots.map((entry) => entry.worktreePath)).toEqual([inTmp]);
    expect(backupRefs(elsewhere)).toEqual([]);
  });

  test("orphaned worktrees under the Paseo root with no active workspace are snapshotted", async () => {
    const worktrees = join(root, "worktrees", "hash1");
    mkdirSync(worktrees, { recursive: true });
    const orphan = makeRepo(worktrees, "orphan");
    const active = makeRepo(worktrees, "active");
    writeFileSync(join(orphan, "README.md"), "wip\n");
    writeFileSync(join(active, "README.md"), "wip\n");
    const { sweep, observations } = harness({
      orphanCandidates: [orphan, active],
      activeWorkspaceDirectories: [active],
    });

    const report = await sweep.tick();

    expect(report?.snapshots.map((entry) => [entry.worktreePath, entry.reason])).toEqual([
      [orphan, "orphaned"],
    ]);
    expect(observations[0]?.evidence).toContain("no agent");
  });

  test("a dry run says what it would snapshot and writes nothing", async () => {
    const repo = makeRepo(root, "feature");
    writeFileSync(join(repo, "README.md"), "wip\n");
    const { sweep, observations, statePath } = harness({
      agents: [view({ cwd: repo, archived: true })],
      config: { dryRun: true },
    });

    const report = await sweep.tick();

    expect(report).toMatchObject({ dryRun: true });
    expect(report?.snapshots.map((entry) => entry.worktreePath)).toEqual([repo]);
    expect(backupRefs(repo)).toEqual([]);
    expect(observations).toEqual([]);
    expect(existsSync(statePath)).toBe(false);
  });

  test("disabled, or with remedies off, the sweep does nothing", async () => {
    const repo = makeRepo(root, "feature");
    writeFileSync(join(repo, "README.md"), "wip\n");
    const disabled = harness({
      agents: [view({ cwd: repo, archived: true })],
      config: { enabled: false },
    });
    expect(await disabled.sweep.tick()).toBeNull();
    expect(backupRefs(repo)).toEqual([]);
  });
});

describe("production readers", () => {
  test("agent views merge the live summary, the stored record and the live last error", () => {
    const views = buildWorkSnapshotAgentViews({
      live: [
        {
          id: "live",
          provider: "claude",
          cwd: "/w/live",
          workspaceId: "ws-1",
          internal: false,
          lifecycle: "idle",
          busy: false,
          pendingPermissionCount: 0,
          requiresAttention: false,
          attentionReason: null,
          hasAlert: false,
          runningProviderSubagentCount: 0,
          lastActivityAt: new Date(TWO_HOURS_AGO).toISOString(),
          labels: {},
          title: "Live one",
          sessionId: "s",
        },
      ],
      stored: [
        {
          id: "gone",
          provider: "claude",
          cwd: "/w/gone",
          workspaceId: "ws-2",
          createdAt: new Date(TWO_HOURS_AGO).toISOString(),
          updatedAt: new Date(TWO_HOURS_AGO).toISOString(),
          title: "Archived one",
          labels: {},
          lastStatus: "idle",
          archivedAt: new Date(TWO_HOURS_AGO).toISOString(),
        } as never,
      ],
      lastErrors: new Map([["live", UNRESPONSIVE_CANCEL_ERROR]]),
    });
    expect(views).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gone",
          archived: true,
          live: false,
          title: "Archived one",
          lastError: null,
        }),
        expect.objectContaining({
          id: "live",
          live: true,
          lifecycle: "idle",
          lastError: UNRESPONSIVE_CANCEL_ERROR,
          lastActivityAtMs: TWO_HOURS_AGO,
        }),
      ]),
    );
  });

  test("Paseo worktree directories are <root>/<hash>/<slug>, and a missing root is empty", () => {
    const base = join(root, "wt-root");
    mkdirSync(join(base, "h1", "a"), { recursive: true });
    mkdirSync(join(base, "h1", "b"), { recursive: true });
    mkdirSync(join(base, "h2", "c"), { recursive: true });
    writeFileSync(join(base, "h2", "file.txt"), "x");
    expect(listPaseoWorktreeDirectories(base).sort()).toEqual(
      [join(base, "h1", "a"), join(base, "h1", "b"), join(base, "h2", "c")].sort(),
    );
    expect(listPaseoWorktreeDirectories(join(root, "missing"))).toEqual([]);
  });
});
