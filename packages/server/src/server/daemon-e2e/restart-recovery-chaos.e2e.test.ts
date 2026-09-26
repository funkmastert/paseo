import { afterEach, describe, expect, test } from "vitest";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { RestartRecoveryPlan } from "@getpaseo/protocol/restart-recovery/rpc-schemas";
import { DaemonClient } from "../test-utils/daemon-client.js";

// OR-D13's restart-recovery chaos case (docs/restart-recovery.md): a leader and two children are
// mid-turn, the daemon process is SIGKILLed, and the next daemon on the same PASEO_HOME has to
// find all three and resume the leader before its children. The daemon runs in its own process so
// the kill is real: nothing in it gets to write, flush or settle anything.

const execFileAsync = promisify(execFile);
const PARENT_LABEL = "paseo.parent-agent-id";
const HOLD = "Please hold the turn open until you are interrupted.";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../..");
const DAEMON_SCRIPT = path.resolve(
  import.meta.dirname,
  "../test-utils/restart-recovery-daemon-process.ts",
);

interface DaemonProcess {
  child: ChildProcess;
  port: number;
  client: DaemonClient;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup().catch(() => undefined);
  }
});

async function startDaemon(root: string, mode: "plan" | "resume"): Promise<DaemonProcess> {
  const child = fork(DAEMON_SCRIPT, {
    env: {
      ...process.env,
      PASEO_HOME: path.join(root, ".paseo"),
      RESTART_RECOVERY_HOME_ROOT: root,
      RESTART_RECOVERY_MODE: mode,
    },
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const stderr: string[] = [];
  child.stderr?.on("data", (data: Buffer) => stderr.push(data.toString("utf8")));
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`daemon did not start: ${stderr.join("")}`)),
      60_000,
    );
    child.once("message", (message: { type: string; port?: number; error?: string }) => {
      clearTimeout(timeout);
      if (message.type === "ready" && message.port) resolve(message.port);
      else reject(new Error(message.error ?? "daemon failed to start"));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`daemon exited (${code ?? signal}) before ready: ${stderr.join("")}`));
    });
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${port}/ws`, appVersion: "0.8.0" });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "restart-recovery-chaos" } });
  cleanups.push(() => client.close());
  return { child, port, client };
}

async function killHard(daemon: DaemonProcess): Promise<void> {
  const exited = new Promise((resolve) => daemon.child.once("exit", resolve));
  daemon.child.kill("SIGKILL");
  await exited;
  await daemon.client.close().catch(() => undefined);
}

async function readRecords(root: string): Promise<Map<string, Record<string, unknown>>> {
  const agentsDir = path.join(root, ".paseo", "agents");
  const records = new Map<string, Record<string, unknown>>();
  for (const dir of await readdir(agentsDir).catch(() => [] as string[])) {
    for (const file of await readdir(path.join(agentsDir, dir)).catch(() => [] as string[])) {
      if (!file.endsWith(".json")) continue;
      const record = JSON.parse(await readFile(path.join(agentsDir, dir, file), "utf8"));
      records.set(record.id, record);
    }
  }
  return records;
}

/** Whether every one of `ids` has a run marker, open or settled as asked. */
async function markersAre(root: string, ids: readonly string[], want: "open" | "settled") {
  const records = await readRecords(root);
  return ids.every((id) => {
    const marker = records.get(id)?.runMarker as { endedAt?: string } | undefined;
    if (!marker) return false;
    return want === "open" ? marker.endedAt === undefined : marker.endedAt !== undefined;
  });
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Leader plus two children, all held mid-turn, with their run markers on disk. */
async function startLeaderAndChildrenMidTurn(root: string, cwd: string, daemon: DaemonProcess) {
  const { client } = daemon;
  const leader = await client.createAgent({ provider: "claude", cwd, title: "Leader" });
  const children = [];
  for (const title of ["Child one", "Child two"]) {
    children.push(
      await client.createAgent({
        provider: "claude",
        cwd,
        title,
        labels: { [PARENT_LABEL]: leader.id },
      }),
    );
  }
  const ids = [leader.id, ...children.map((child) => child.id)];
  for (const id of ids) {
    await client.sendMessage(id, HOLD);
    await client.waitForAgentUpsert(id, (snapshot) => snapshot.status === "running", 30_000);
  }
  await waitFor(() => markersAre(root, ids, "open"), "every run marker to be written");
  return { leaderId: leader.id, childIds: children.map((child) => child.id), ids };
}

function isResumed(candidate: { state: string }): boolean {
  return candidate.state === "resumed";
}

function entry(plan: RestartRecoveryPlan, agentId: string) {
  const found = plan.entries.find((candidate) => candidate.agentId === agentId);
  if (!found) throw new Error(`no plan entry for ${agentId}`);
  return found;
}

async function runCli(root: string, port: number, args: string[]): Promise<RestartRecoveryPlan> {
  const { stdout } = await execFileAsync(
    path.join(REPO_ROOT, "node_modules/.bin/tsx"),
    [
      path.join(REPO_ROOT, "packages/cli/src/index.ts"),
      "recover",
      ...args,
      "--json",
      "--host",
      `127.0.0.1:${port}`,
    ],
    { env: { ...process.env, PASEO_HOME: path.join(root, ".paseo") }, timeout: 120_000 },
  );
  return (JSON.parse(stdout) as { plan: RestartRecoveryPlan }).plan;
}

describe("restart recovery chaos", () => {
  test("a SIGKILLed daemon's mid-turn leader and children are planned, then resumed leader first", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-restart-recovery-"));
    const cwd = await mkdtemp(path.join(os.tmpdir(), "paseo-restart-recovery-cwd-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));

    const first = await startDaemon(root, "plan");
    const { leaderId, childIds, ids } = await startLeaderAndChildrenMidTurn(root, cwd, first);
    await killHard(first);

    const second = await startDaemon(root, "plan");
    expect(second.client.getLastServerInfoMessage()?.features?.restartRecovery).toBe(true);

    // The real CLI, against the restarted daemon.
    const plan = await runCli(root, second.port, ["--plan"]);
    expect(plan.mode).toBe("plan");
    expect(plan.entries.map((candidate) => candidate.agentId)).toEqual([leaderId, ...childIds]);
    expect(entry(plan, leaderId)).toMatchObject({ depth: 0, state: "pending" });
    for (const childId of childIds) {
      expect(entry(plan, childId)).toMatchObject({
        depth: 1,
        parentAgentId: leaderId,
        state: "pending",
      });
    }
    for (const candidate of plan.entries) {
      expect(candidate.readiness).toBe("restorable");
    }
    // `plan` resumed nothing on its own: no runtime holds any of them. (Their stored status still
    // says `running`, which is what the killed daemon last wrote.)
    for (const candidate of plan.entries) {
      expect(candidate.checks.find((check) => check.id === "live")?.detail).toBe("not loaded");
    }

    const applied = await runCli(root, second.port, ["--apply"]);
    for (const id of ids) {
      expect(entry(applied, id).state).toBe("resumed");
    }
    const leaderResumedAt = Date.parse(entry(applied, leaderId).resolvedAt!);
    for (const childId of childIds) {
      expect(Date.parse(entry(applied, childId).resolvedAt!)).toBeGreaterThanOrEqual(
        leaderResumedAt,
      );
    }

    // Each resumed agent got the one recovery prompt, under its own id and conversation. The
    // leader's names both children; each child's names the leader.
    for (const id of ids) {
      await second.client.waitForFinish(id, 30_000);
    }
    const leaderTimeline = JSON.stringify(await second.client.fetchAgentTimeline(leaderId));
    expect(leaderTimeline).toContain("Restart recovery: the Paseo daemon stopped");
    for (const childId of childIds) {
      expect(leaderTimeline).toContain(childId);
      const childTimeline = JSON.stringify(await second.client.fetchAgentTimeline(childId));
      expect(childTimeline).toContain("Restart recovery: the Paseo daemon stopped");
      expect(childTimeline).toContain(`Your parent ${leaderId}`);
    }

    // The resumed runs settled their markers, so a third daemon has nothing to recover.
    await waitFor(() => markersAre(root, ids, "settled"), "the resumed runs to settle");
    await killHard(second);
    const third = await startDaemon(root, "plan");
    expect((await third.client.getRestartRecoveryPlan()).entries).toEqual([]);
  }, 240_000);

  test("a clean shutdown leaves the markers open too, and dismiss settles them for good", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-restart-recovery-"));
    const cwd = await mkdtemp(path.join(os.tmpdir(), "paseo-restart-recovery-cwd-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));

    const first = await startDaemon(root, "plan");
    const { ids, childIds } = await startLeaderAndChildrenMidTurn(root, cwd, first);
    const exited = new Promise((resolve) => first.child.once("exit", resolve));
    first.child.kill("SIGTERM");
    await exited;

    const second = await startDaemon(root, "plan");
    const plan = await second.client.getRestartRecoveryPlan();
    expect(plan.entries.map((candidate) => candidate.agentId).sort()).toEqual([...ids].sort());

    const dismissed = await second.client.dismissRestartRecovery({ agentIds: [childIds[0]!] });
    expect(entry(dismissed, childIds[0]!).state).toBe("dismissed");
    await killHard(second);

    const third = await startDaemon(root, "plan");
    const after = await third.client.getRestartRecoveryPlan();
    expect(after.entries.map((candidate) => candidate.agentId)).not.toContain(childIds[0]);
    expect(after.entries).toHaveLength(2);
  }, 240_000);

  test("in resume mode the next daemon resumes them at boot, leader first", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-restart-recovery-"));
    const cwd = await mkdtemp(path.join(os.tmpdir(), "paseo-restart-recovery-cwd-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));

    const first = await startDaemon(root, "resume");
    const { leaderId, childIds, ids } = await startLeaderAndChildrenMidTurn(root, cwd, first);
    await killHard(first);

    const second = await startDaemon(root, "resume");
    let plan = await second.client.getRestartRecoveryPlan();
    const allResumed = async () => {
      plan = await second.client.getRestartRecoveryPlan();
      return plan.entries.every(isResumed);
    };
    await waitFor(allResumed, "the boot apply to resume every agent");
    expect(plan.entries).toHaveLength(ids.length);
    const leaderResumedAt = Date.parse(entry(plan, leaderId).resolvedAt!);
    for (const childId of childIds) {
      expect(Date.parse(entry(plan, childId).resolvedAt!)).toBeGreaterThanOrEqual(leaderResumedAt);
    }
  }, 240_000);
});
