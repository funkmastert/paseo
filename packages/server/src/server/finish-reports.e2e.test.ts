import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentPromptInput } from "./agent/agent-sdk-types.js";
import {
  ACCOUNT_FAILOVER_MIGRATED_TO_LABEL,
  HANDOFF_FROM_LABEL,
} from "./agent/account-failover-detector.js";
import type { ChildAdmissionConfig } from "./agent/child-admission.js";
import { setupFinishNotification } from "./agent/agent-prompt.js";
import type { FinishObligation } from "./agent/finish-obligation.js";
import { createPaseoDaemon, type PaseoDaemon, type PaseoDaemonConfig } from "./bootstrap.js";
import type { PushPayload } from "./push/index.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestAgentClient } from "./test-utils/fake-agent-client.js";

// The cap message that stranded worker ff644a1b four seconds into its task.
const LIMIT_MESSAGE = "You've hit your weekly limit · resets 7am (America/Los_Angeles)";
const MINUTE_MS = 60_000;
const RETRY_INTERVAL_MS = 5 * MINUTE_MS;
const PARKED_GRACE_MS = 2 * MINUTE_MS;

interface Prompt {
  sessionId: string;
  text: string;
}

/**
 * One PASEO_HOME that outlives the daemons started on it, so a test can stop a daemon mid-task
 * and start a fresh one — a new process in every way that matters: a new AgentManager with no
 * agents loaded, a new ledger rebuilt from disk, no in-memory observers.
 */
interface Home {
  paseoHome: string;
  cwd: string;
  prompts: Prompt[];
  pushes: PushPayload[];
  /** Provider sessions whose resume fails, the way a vanished transcript does. */
  refusedSessions: Set<string>;
  /** Provider sessions whose resume waits until the promise settles. */
  heldSessions: Map<string, Promise<void>>;
  clockMs: number;
  staticDirs: string[];
  daemon: PaseoDaemon | null;
  client: DaemonClient | null;
  cleanup(): Promise<void>;
}

function promptText(prompt: AgentPromptInput): string {
  return typeof prompt === "string" ? prompt : JSON.stringify(prompt);
}

async function createHome(): Promise<Home> {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-finish-reports-"));
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-finish-reports-cwd-"));
  const home: Home = {
    paseoHome,
    cwd,
    prompts: [],
    pushes: [],
    refusedSessions: new Set(),
    heldSessions: new Map(),
    clockMs: Date.parse("2026-09-23T12:00:00.000Z"),
    staticDirs: [],
    daemon: null,
    client: null,
    cleanup: async () => {
      await stopDaemon(home);
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(cwd, { recursive: true, force: true }),
        ...home.staticDirs.map((dir) => rm(dir, { recursive: true, force: true })),
      ]);
    },
  };
  return home;
}

interface StartOptions {
  restartRecovery?: PaseoDaemonConfig["restartRecovery"];
  admission?: ChildAdmissionConfig;
  /** Agents restart recovery is said to hold; only a real restart produces real claims. */
  claimedByRecovery?: ReadonlySet<string>;
}

async function startDaemon(home: Home, options: StartOptions = {}): Promise<PaseoDaemon> {
  const staticDir = await mkdtemp(path.join(tmpdir(), "paseo-finish-reports-static-"));
  home.staticDirs.push(staticDir);
  const daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome: home.paseoHome,
      daemonVersion: "0.8.0",
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: {
        claude: createTestAgentClient("claude", {
          onStartTurn: (prompt, sessionId) => {
            home.prompts.push({ sessionId, text: promptText(prompt) });
          },
          onResumeSession: async (handle) => {
            if (home.refusedSessions.has(handle.sessionId)) {
              throw new Error(`session ${handle.sessionId} is gone`);
            }
            await home.heldSessions.get(handle.sessionId);
          },
        }),
      },
      pushNotificationSender: {
        send: async (payload) => {
          home.pushes.push(payload);
        },
      },
      // Sweeps are driven by the test; the timers are pushed past its runtime.
      finishReportOverrides: {
        sweepIntervalMs: 60 * MINUTE_MS,
        ladder: { retryIntervalMs: RETRY_INTERVAL_MS, parkedGraceMs: PARKED_GRACE_MS },
        now: () => home.clockMs,
        ...(options.claimedByRecovery
          ? { isClaimedByRestartRecovery: (id: string) => options.claimedByRecovery!.has(id) }
          : {}),
      },
      accountFailoverOverrides: { sweepIntervalMs: 60 * MINUTE_MS },
      ...(options.restartRecovery ? { restartRecovery: options.restartRecovery } : {}),
      ...(options.admission ? { admission: options.admission } : {}),
      agentStoragePath: path.join(home.paseoHome, "agents"),
      relayEnabled: false,
      relayEndpoint: "relay.paseo.sh:443",
      appBaseUrl: "https://app.paseo.sh",
    },
    pino({ level: "silent" }),
  );
  await daemon.start();
  const target = daemon.getListenTarget();
  if (!target || target.type !== "tcp") throw new Error("test daemon did not bind a TCP port");
  const client = new DaemonClient({ url: `ws://127.0.0.1:${target.port}/ws`, appVersion: "0.8.0" });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "finish-reports" } });
  home.daemon = daemon;
  home.client = client;
  return daemon;
}

async function stopDaemon(home: Home): Promise<void> {
  await home.client?.close().catch(() => undefined);
  await home.daemon?.stop().catch(() => undefined);
  home.client = null;
  home.daemon = null;
}

/** A real stop and a fresh start on the same PASEO_HOME. */
async function restart(home: Home, options: StartOptions = {}): Promise<PaseoDaemon> {
  await stopDaemon(home);
  return startDaemon(home, options);
}

function daemonOf(home: Home): PaseoDaemon {
  if (!home.daemon) throw new Error("no daemon is running");
  return home.daemon;
}

function clientOf(home: Home): DaemonClient {
  if (!home.client) throw new Error("no daemon is running");
  return home.client;
}

async function createAgent(
  home: Home,
  input: { title: string; labels?: Record<string, string> },
): Promise<string> {
  const agent = await clientOf(home).createAgent({
    provider: "claude",
    model: "sonnet",
    modeId: "bypassPermissions",
    cwd: home.cwd,
    title: input.title,
    ...(input.labels ? { labels: input.labels } : {}),
  });
  return agent.id;
}

async function converse(home: Home, agentId: string, reply: string): Promise<void> {
  await clientOf(home).sendMessage(agentId, `respond with exactly: ${reply}`);
  const manager = daemonOf(home).agentManager;
  await expect
    .poll(() => manager.getLastAssistantMessage(agentId), { timeout: 10_000 })
    .toBe(reply);
  await expect.poll(() => manager.getAgent(agentId)?.lifecycle, { timeout: 10_000 }).toBe("idle");
}

/** What `create_agent` does for a subagent created with notifyOnFinish (create.ts). */
function watchForParent(home: Home, input: { child: string; parent: string }): void {
  const daemon = daemonOf(home);
  setupFinishNotification({
    agentManager: daemon.agentManager,
    agentStorage: daemon.agentStorage,
    childAgentId: input.child,
    callerAgentId: input.parent,
    requireParentOwnership: true,
    logger: pino({ level: "silent" }),
  });
}

async function sessionIdOf(home: Home, agentId: string): Promise<string> {
  const record = await daemonOf(home).agentStorage.get(agentId);
  const sessionId = record?.persistence?.sessionId;
  if (!sessionId) throw new Error(`agent ${agentId} has no provider session`);
  return sessionId;
}

/** The report about `about` that `to` was prompted with, if any. */
async function reportAbout(
  home: Home,
  input: { to: string; about: string },
): Promise<string | undefined> {
  return (await promptsTo(home, input.to)).find((text) => text.includes(`Agent ${input.about}`));
}

async function promptsTo(home: Home, agentId: string): Promise<string[]> {
  const sessionId = await sessionIdOf(home, agentId);
  return home.prompts.filter((prompt) => prompt.sessionId === sessionId).map((p) => p.text);
}

/** The obligation exactly as it sits in the agent's JSON file — no daemon in between. */
async function obligationOnDisk(home: Home, agentId: string): Promise<FinishObligation | null> {
  const agentsDir = path.join(home.paseoHome, "agents");
  for (const dir of await readdir(agentsDir)) {
    const file = path.join(agentsDir, dir, `${agentId}.json`);
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) continue;
    const record = JSON.parse(text) as { finishObligations?: FinishObligation[] };
    return record.finishObligations?.[0] ?? null;
  }
  return null;
}

function obligationInLedger(home: Home, agentId: string): FinishObligation | undefined {
  return daemonOf(home).getFinishObligations().getObligations(agentId)[0];
}

/** Whether any provider session was ever prompted with `text`. */
function providerSaw(home: Home, text: string): boolean {
  return home.prompts.some((prompt) => prompt.text.includes(text));
}

/** Whether restart recovery has told `agentId` about children it could not resume. */
async function toldAboutUnresumedChildren(home: Home, agentId: string): Promise<boolean> {
  const prompts = await promptsTo(home, agentId);
  return prompts.some((text) => text.includes("Restart recovery could not resume these subagents"));
}

/** How many restart-recovery resume prompts the provider has seen. */
function recoveryPromptCount(home: Home): number {
  return home.prompts.filter((prompt) => prompt.text.includes("Restart recovery")).length;
}

/** How many of these children's reports reached their parent. */
async function reportsDelivered(
  home: Home,
  pairs: readonly { parent: string; child: string }[],
): Promise<number> {
  let delivered = 0;
  for (const { parent, child } of pairs) {
    if (await reportAbout(home, { to: parent, about: child })) delivered += 1;
  }
  return delivered;
}

async function sweep(home: Home): Promise<void> {
  await daemonOf(home).getFinishObligations().tick();
}

async function owedReportOnTheWire(home: Home, agentId: string) {
  const { entries } = await clientOf(home).fetchAgents();
  return entries.find((entry) => entry.agent.id === agentId)?.agent.owedFinishReport;
}

describe("finish reports survive a daemon restart (e2e)", () => {
  let home: Home;

  beforeEach(async () => {
    home = await createHome();
    await startDaemon(home);
  }, 30_000);

  afterEach(async () => {
    await home.cleanup();
  }, 30_000);

  test("a child mid-turn when the daemon stops still reports to its parent after the restart", async () => {
    const parent = await createAgent(home, { title: "Leader" });
    await converse(home, parent, "LEADER-READY");
    const child = await createAgent(home, {
      title: "Worker",
      labels: { [PARENT_AGENT_ID_LABEL]: parent },
    });
    await clientOf(home).sendMessage(child, "keep working until interrupted");
    await expect
      .poll(() => daemonOf(home).agentManager.getAgent(child)?.lifecycle, { timeout: 10_000 })
      .toBe("running");
    watchForParent(home, { child, parent });

    // Armed durably, on the child's own record.
    await expect
      .poll(() => obligationOnDisk(home, child))
      .toMatchObject({
        ownerAgentId: parent,
        state: "pending",
        requireParentOwnership: true,
      });

    await stopDaemon(home);

    // Shutdown closed the child mid-turn. That is not its outcome: nothing was reported, and
    // the obligation is still owed on disk.
    expect(await obligationOnDisk(home, child)).toMatchObject({ state: "pending" });
    expect(home.prompts.some((prompt) => prompt.text.includes(`Agent ${child}`))).toBe(false);

    const daemon = await startDaemon(home);
    // Re-armed from the record by a daemon that never saw the child run.
    expect(obligationInLedger(home, child)).toMatchObject({
      ownerAgentId: parent,
      state: "pending",
    });
    expect(daemon.agentManager.getAgent(child)).toBeNull();

    // First sweep: the child is stopped and still owes its report — parked, and the panel sees it.
    await sweep(home);
    expect(obligationInLedger(home, child)?.parkedSince).toBeDefined();
    await expect
      .poll(() => owedReportOnTheWire(home, child))
      .toMatchObject({
        ownerAgentId: parent,
        state: "parked",
      });

    // Past the grace period the daemon reports for the child, waking the (unloaded) parent.
    home.clockMs += PARKED_GRACE_MS;
    await sweep(home);

    const report = (await promptsTo(home, parent)).find((text) => text.includes(`Agent ${child}`));
    expect(report).toContain(`Agent ${child} (Worker) stopped before reporting.`);
    expect(report).toContain("send_agent_prompt");
    await expect
      .poll(() => obligationOnDisk(home, child))
      .toMatchObject({
        state: "delivered",
        resolution: `delivered to ${parent}`,
      });
    await expect.poll(() => owedReportOnTheWire(home, child)).toBeUndefined();
  }, 60_000);

  test("a child restart recovery resumes is not also parked and reported on: one resume, one report", async () => {
    const parent = await createAgent(home, { title: "Leader" });
    await converse(home, parent, "LEADER-READY");
    const child = await createAgent(home, {
      title: "Worker",
      labels: { [PARENT_AGENT_ID_LABEL]: parent },
    });
    await clientOf(home).sendMessage(child, "keep working until interrupted");
    await expect
      .poll(() => daemonOf(home).agentManager.getAgent(child)?.lifecycle, { timeout: 10_000 })
      .toBe("running");
    watchForParent(home, { child, parent });
    await expect.poll(() => obligationOnDisk(home, child)).toMatchObject({ state: "pending" });

    const childSession = await sessionIdOf(home, child);
    await stopDaemon(home);
    const promptsBeforeRestart = home.prompts.length;
    // Recovery's resume of the child waits here, so the sweeps below run while it holds the child.
    let releaseChild = () => {};
    home.heldSessions.set(
      childSession,
      new Promise<void>((resolve) => {
        releaseChild = resolve;
      }),
    );
    // In `resume` mode recovery claims the child from the moment it reads the run markers.
    const daemon = await startDaemon(home, { restartRecovery: { mode: "resume" } });
    expect(daemon.getRestartRecovery().isAboutToResume(child)).toBe(true);

    // Sweeping while recovery holds the child, and past the grace period, parks nothing and
    // reports nothing.
    await sweep(home);
    home.clockMs += PARKED_GRACE_MS;
    await sweep(home);
    expect(obligationInLedger(home, child)?.parkedSince).toBeUndefined();
    expect(obligationInLedger(home, child)?.state).toBe("pending");
    releaseChild();

    // Recovery resumed the child once, and the child finished and reported as usual.
    await expect
      .poll(async () => (await reportAbout(home, { to: parent, about: child })) ?? null, {
        timeout: 10_000,
      })
      .not.toBeNull();
    const report = await reportAbout(home, { to: parent, about: child });
    expect(report).not.toContain("stopped before reporting");
    const childPromptsAfterRestart = home.prompts
      .slice(promptsBeforeRestart)
      .filter((prompt) => prompt.sessionId === childSession);
    expect(childPromptsAfterRestart).toHaveLength(1);
    expect(childPromptsAfterRestart[0]?.text).toContain("Restart recovery");
    await expect
      .poll(() => obligationOnDisk(home, child))
      .toMatchObject({ state: "delivered", resolution: `delivered to ${parent}` });
  }, 60_000);

  test("after a restart, reports that each start a turn in their owner go out a few a minute", async () => {
    const pairs: { parent: string; child: string }[] = [];
    for (const name of ["A", "B"]) {
      const parent = await createAgent(home, { title: `Leader ${name}` });
      await converse(home, parent, `LEADER-${name}-READY`);
      const child = await createAgent(home, {
        title: `Worker ${name}`,
        labels: { [PARENT_AGENT_ID_LABEL]: parent },
      });
      await clientOf(home).sendMessage(child, "keep working until interrupted");
      await expect
        .poll(() => daemonOf(home).agentManager.getAgent(child)?.lifecycle, { timeout: 10_000 })
        .toBe("running");
      watchForParent(home, { child, parent });
      pairs.push({ parent, child });
    }

    await restart(home);
    // One restart report a minute: the first wakes its leader now, the second waits its turn.
    await clientOf(home).patchDaemonConfig({ admission: { bulkResumesPerMinute: 1 } });
    await sweep(home);
    home.clockMs += PARKED_GRACE_MS;
    // The sweep waits on the budget; cleanup stops the daemon, which lets it go.
    void sweep(home).catch(() => undefined);

    await expect.poll(() => reportsDelivered(home, pairs), { timeout: 10_000 }).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await reportsDelivered(home, pairs)).toBe(1);
  }, 60_000);

  test("a child turn held for an admission slot survives a restart and runs after it", async () => {
    await clientOf(home).patchDaemonConfig({ admission: { maxConcurrentChildTurns: 1 } });
    const parent = await createAgent(home, { title: "Leader" });
    await converse(home, parent, "LEADER-READY");
    const busy = await createAgent(home, {
      title: "Busy worker",
      labels: { [PARENT_AGENT_ID_LABEL]: parent },
    });
    const held = await createAgent(home, {
      title: "Held worker",
      labels: { [PARENT_AGENT_ID_LABEL]: parent },
    });
    await clientOf(home).sendMessage(busy, "keep working until interrupted");
    await expect
      .poll(() => daemonOf(home).agentManager.getAgent(busy)?.lifecycle, { timeout: 10_000 })
      .toBe("running");
    await clientOf(home).sendMessage(held, "respond with exactly: HELD-TASK-RAN");
    await expect
      .poll(() => daemonOf(home).agentManager.getAgent(held)?.turnQueued, { timeout: 10_000 })
      .toBeDefined();
    // Queued, so the provider never saw it.
    expect(providerSaw(home, "HELD-TASK-RAN")).toBe(false);

    await stopDaemon(home);
    const queueFile = JSON.parse(
      await readFile(path.join(home.paseoHome, "admission", "queue.json"), "utf8"),
    ) as { held: { agentId: string }[] };
    expect(queueFile.held.map((turn) => turn.agentId)).toEqual([held]);

    await startDaemon(home);
    // The busy worker's turn ended with the old daemon, so the held one gets the slot.
    await expect
      .poll(() => providerSaw(home, "HELD-TASK-RAN"), {
        timeout: 10_000,
      })
      .toBe(true);
    await expect
      .poll(() => daemonOf(home).agentManager.getLastAssistantMessage(held), { timeout: 10_000 })
      .toBe("HELD-TASK-RAN");
  }, 60_000);

  test("a child only queued when the daemon stops is pending after the restart, not stopped", async () => {
    const admission = { maxConcurrentChildTurns: 1, bulkResumesPerMinute: 1 };
    await clientOf(home).patchDaemonConfig({ admission });
    const parent = await createAgent(home, { title: "Leader" });
    await converse(home, parent, "LEADER-READY");
    const workers: string[] = [];
    for (const name of ["Busy", "First held", "Second held"]) {
      workers.push(
        await createAgent(home, {
          title: `${name} worker`,
          labels: { [PARENT_AGENT_ID_LABEL]: parent },
        }),
      );
    }
    const [busy, first, second] = workers as [string, string, string];
    await clientOf(home).sendMessage(busy, "keep working until interrupted");
    await expect
      .poll(() => daemonOf(home).agentManager.getAgent(busy)?.lifecycle, { timeout: 10_000 })
      .toBe("running");
    for (const held of [first, second]) {
      await clientOf(home).sendMessage(held, `keep working until interrupted ${held}`);
      await expect
        .poll(() => daemonOf(home).agentManager.getAgent(held)?.turnQueued, { timeout: 10_000 })
        .toBeDefined();
    }
    watchForParent(home, { child: second, parent });
    await expect.poll(() => obligationOnDisk(home, second)).toMatchObject({ state: "pending" });

    // One restart resume a minute: the first held turn is re-sent now, the second waits.
    await restart(home, { admission });
    await expect.poll(() => providerSaw(home, `interrupted ${first}`)).toBe(true);
    expect(providerSaw(home, `interrupted ${second}`)).toBe(false);

    // The second child's turn is held, so it is pending: never parked, never reported stopped.
    await sweep(home);
    expect(obligationInLedger(home, second)).toMatchObject({ state: "pending" });
    expect(obligationInLedger(home, second)?.parkedSince).toBeUndefined();
    home.clockMs += PARKED_GRACE_MS;
    await sweep(home);
    expect(obligationInLedger(home, second)).toMatchObject({ state: "pending" });
    expect(await reportAbout(home, { to: parent, about: second })).toBeUndefined();
  }, 60_000);

  test("restart recovery resumes the child cut off mid-turn and leaves a queued child's turn to admission", async () => {
    const admission = { maxConcurrentChildTurns: 1, bulkResumesPerMinute: 10 };
    await clientOf(home).patchDaemonConfig({ admission });
    const parent = await createAgent(home, { title: "Leader" });
    await converse(home, parent, "LEADER-READY");
    const busy = await createAgent(home, {
      title: "Busy worker",
      labels: { [PARENT_AGENT_ID_LABEL]: parent },
    });
    const held = await createAgent(home, {
      title: "Held worker",
      labels: { [PARENT_AGENT_ID_LABEL]: parent },
    });
    await clientOf(home).sendMessage(busy, "keep working until interrupted");
    await expect
      .poll(() => daemonOf(home).agentManager.getAgent(busy)?.lifecycle, { timeout: 10_000 })
      .toBe("running");
    await clientOf(home).sendMessage(held, `keep working until interrupted ${held}`);
    await expect
      .poll(() => daemonOf(home).agentManager.getAgent(held)?.turnQueued, { timeout: 10_000 })
      .toBeDefined();
    // A queued child reads as running, so its run marker is open like the busy one's.
    await expect
      .poll(async () => (await daemonOf(home).agentStorage.get(held))?.runMarker, {
        timeout: 10_000,
      })
      .toMatchObject({ startedAt: expect.any(String) });
    expect(providerSaw(home, `interrupted ${held}`)).toBe(false);

    // Two slots after the restart: the held turn admission re-sends never ends, and the busy
    // child's resume must not queue behind it.
    await restart(home, {
      admission: { ...admission, maxConcurrentChildTurns: 2 },
      restartRecovery: { mode: "resume" },
    });

    // Recovery owns only the turn that reached the provider.
    const plan = await daemonOf(home).getRestartRecovery().getPlan();
    expect(plan.entries.map((entry) => entry.agentId)).toEqual([busy]);
    // Admission re-sends the held prompt; recovery sends one resume, to the busy child only.
    await expect
      .poll(() => providerSaw(home, `interrupted ${held}`), { timeout: 10_000 })
      .toBe(true);
    await expect.poll(() => recoveryPromptCount(home), { timeout: 10_000 }).toBe(1);
    const busySession = await sessionIdOf(home, busy);
    const recoveryPrompt = home.prompts.find((prompt) => prompt.text.includes("Restart recovery"));
    expect(recoveryPrompt?.sessionId).toBe(busySession);
  }, 60_000);

  test("a report whose owner moved to a successor waits while restart recovery holds that successor", async () => {
    const parent = await createAgent(home, { title: "Leader" });
    await converse(home, parent, "LEADER-READY");
    const successor = await createAgent(home, { title: "Leader (moved)" });
    await converse(home, successor, "SUCCESSOR-READY");
    const child = await createAgent(home, {
      title: "Worker",
      labels: { [PARENT_AGENT_ID_LABEL]: parent },
    });
    await clientOf(home).sendMessage(child, "keep working until interrupted");
    await expect
      .poll(() => daemonOf(home).agentManager.getAgent(child)?.lifecycle, { timeout: 10_000 })
      .toBe("running");
    watchForParent(home, { child, parent });
    await expect.poll(() => obligationOnDisk(home, child)).toMatchObject({ state: "pending" });
    // Account failover retired the leader into the successor, so reports resolve to it.
    await daemonOf(home).agentManager.setLabels(parent, {
      [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: successor,
    });

    // The stored owner is the leader, which nobody claims; recovery holds the successor.
    const claimed = new Set([successor]);
    await restart(home, { claimedByRecovery: claimed });
    await sweep(home);
    home.clockMs += PARKED_GRACE_MS;
    await sweep(home);
    expect(await reportAbout(home, { to: successor, about: child })).toBeUndefined();
    expect(obligationInLedger(home, child)?.state).not.toBe("delivered");

    // Recovery lets go: the report goes to the successor, as it always would have.
    claimed.delete(successor);
    await sweep(home);
    await expect
      .poll(() => reportAbout(home, { to: successor, about: child }))
      .toContain(`Agent ${child} (Worker) stopped before reporting.`);
  }, 60_000);

  test("a parent restart recovery told about a child it could not resume is not told again", async () => {
    const parent = await createAgent(home, { title: "Leader" });
    await converse(home, parent, "LEADER-READY");
    const child = await createAgent(home, {
      title: "Worker",
      labels: { [PARENT_AGENT_ID_LABEL]: parent },
    });
    for (const agentId of [parent, child]) {
      await clientOf(home).sendMessage(agentId, `keep working until interrupted ${agentId}`);
      await expect
        .poll(() => daemonOf(home).agentManager.getAgent(agentId)?.lifecycle, { timeout: 10_000 })
        .toBe("running");
    }
    watchForParent(home, { child, parent });
    await expect.poll(() => obligationOnDisk(home, child)).toMatchObject({ state: "pending" });

    // Both were cut off mid-turn. The leader comes back; the child's session is gone.
    home.refusedSessions.add(await sessionIdOf(home, child));
    await restart(home, { restartRecovery: { mode: "resume" } });
    await expect
      .poll(() => toldAboutUnresumedChildren(home, parent), { timeout: 10_000 })
      .toBe(true);

    // That notice was the report: the ladder does not send "stopped before reporting" too.
    await expect
      .poll(() => obligationInLedger(home, child)?.state, { timeout: 10_000 })
      .toBe("released");
    await sweep(home);
    home.clockMs += PARKED_GRACE_MS;
    await sweep(home);
    expect(await reportAbout(home, { to: parent, about: child })).toBeUndefined();
  }, 60_000);

  test("a report the parent cannot take keeps its retry count across a restart, then goes to the orchestrator", async () => {
    const leader = await createAgent(home, { title: "Orchestrator" });
    await converse(home, leader, "ORCHESTRATOR-READY");
    const parent = await createAgent(home, {
      title: "Sub-leader",
      labels: { [PARENT_AGENT_ID_LABEL]: leader },
    });
    await converse(home, parent, "SUBLEADER-READY");
    const child = await createAgent(home, {
      title: "Worker",
      labels: { [PARENT_AGENT_ID_LABEL]: parent },
    });
    await converse(home, child, "WARMED-UP");

    // The parent's runtime is gone and its session cannot be resumed.
    home.refusedSessions.add(await sessionIdOf(home, parent));
    await daemonOf(home).agentManager.closeAgent(parent);

    watchForParent(home, { child, parent });
    await clientOf(home).sendMessage(child, "respond with exactly: RESULT-42");

    // Finished; the first delivery failed on the spot and the report is owed with one attempt.
    await expect
      .poll(() => obligationOnDisk(home, child))
      .toMatchObject({
        state: "owed",
        rung: "owner",
        attempts: 1,
        outcome: { reason: "finished", message: "RESULT-42" },
      });

    await restart(home);
    // The ladder resumes where it stopped: one attempt spent, the next one not due yet.
    expect(obligationInLedger(home, child)).toMatchObject({ state: "owed", attempts: 1 });
    await sweep(home);
    expect(obligationInLedger(home, child)).toMatchObject({ attempts: 1 });

    home.clockMs += RETRY_INTERVAL_MS;
    await sweep(home);
    expect(obligationInLedger(home, child)).toMatchObject({ rung: "owner", attempts: 2 });

    // Third failure exhausts the owner rung; the same sweep goes one rung up.
    home.clockMs += RETRY_INTERVAL_MS;
    await sweep(home);

    await expect
      .poll(() => obligationOnDisk(home, child))
      .toMatchObject({
        state: "escalated",
        rung: "orchestrator",
        attempts: 4,
        resolution: `delivered to orchestrator ${leader}; the owner was unreachable`,
      });
    const report = (await promptsTo(home, leader)).find((text) => text.includes(`Agent ${child}`));
    expect(report).toContain(`This report was owed to ${parent} (Sub-leader)`);
    expect(report).toContain(`Agent ${child} (Worker) finished.`);
    // Captured when the child finished, so it survives the child not being loaded now.
    expect(report).toContain("RESULT-42");
    // An agent was told, so nobody had to be pushed.
    expect(home.pushes.filter((push) => push.data?.reason === "finish_report_undelivered")).toEqual(
      [],
    );
  }, 60_000);

  test("when no agent can be told, the ladder ends in one push to the operator", async () => {
    const parent = await createAgent(home, { title: "Lone leader" });
    await converse(home, parent, "READY");
    const child = await createAgent(home, {
      title: "Worker",
      labels: { [PARENT_AGENT_ID_LABEL]: parent },
    });
    await converse(home, child, "WARMED-UP");
    home.refusedSessions.add(await sessionIdOf(home, parent));
    await daemonOf(home).agentManager.closeAgent(parent);

    watchForParent(home, { child, parent });
    await clientOf(home).sendMessage(child, "respond with exactly: ORPHANED-RESULT");
    await expect.poll(() => obligationInLedger(home, child)?.attempts).toBe(1);

    for (let sweepIndex = 0; sweepIndex < 4; sweepIndex += 1) {
      home.clockMs += RETRY_INTERVAL_MS;
      await sweep(home);
    }

    expect(obligationInLedger(home, child)).toMatchObject({
      state: "escalated",
      rung: "operator",
      resolution: "pushed to the operator; no agent could be told",
    });
    const pushes = home.pushes.filter((push) => push.data?.reason === "finish_report_undelivered");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.data).toMatchObject({ agentId: child, ownerAgentId: parent });
    // Terminal: more sweeps change nothing and push nothing.
    home.clockMs += RETRY_INTERVAL_MS;
    await sweep(home);
    expect(
      home.pushes.filter((push) => push.data?.reason === "finish_report_undelivered"),
    ).toHaveLength(1);
  }, 60_000);

  test("a hand-made successor carries the report its capped predecessor owed (ff644a1b → b0758585)", async () => {
    const parent = await createAgent(home, { title: "Leader" });
    await converse(home, parent, "READY");
    const worker = await createAgent(home, {
      title: "Worker",
      labels: { [PARENT_AGENT_ID_LABEL]: parent },
    });
    await converse(home, worker, "WARMED-UP");

    watchForParent(home, { child: worker, parent });
    await clientOf(home).sendMessage(worker, `emit a turn failure: ${LIMIT_MESSAGE}`);
    await expect.poll(() => obligationInLedger(home, worker)?.state).toBe("delivered");
    const errored = (await promptsTo(home, parent)).find((text) =>
      text.includes(`Agent ${worker}`),
    );
    expect(errored).toContain(`Agent ${worker} (Worker) errored.`);
    // Told a successor is coming, so it does not relaunch the work itself.
    expect(errored).toContain("Account failover moves it to another account");

    // Someone picks the work up by hand: a new agent naming its predecessor, and — as happened —
    // without the parent label.
    const successor = await createAgent(home, {
      title: "Worker (continued)",
      labels: { [HANDOFF_FROM_LABEL]: worker },
    });
    await expect
      .poll(() => obligationInLedger(home, successor))
      .toMatchObject({
        ownerAgentId: parent,
        state: "pending",
        inheritedFrom: worker,
      });
    expect(obligationInLedger(home, worker)).toMatchObject({ transferredTo: successor });

    // Survives a restart before the successor even starts.
    await restart(home);
    expect(obligationInLedger(home, successor)).toMatchObject({ state: "pending" });

    await converse(home, successor, "SUCCESSOR-DONE");

    await expect
      .poll(() => reportAbout(home, { to: parent, about: successor }))
      .toContain(
        `Agent ${successor} (Worker (continued)), which took over from ${worker}, finished.`,
      );
    await expect
      .poll(() => obligationOnDisk(home, successor))
      .toMatchObject({
        state: "delivered",
      });
  }, 60_000);
});

/** Every prompt any agent received that mentions `text`, across daemons. */
function promptsMentioning(home: Home, text: string): string[] {
  return home.prompts.filter((prompt) => prompt.text.includes(text)).map((prompt) => prompt.text);
}

/** The messages queued for an agent exactly as they sit in its JSON file. */
async function queuedOnDisk(home: Home, agentId: string): Promise<string[]> {
  const agentsDir = path.join(home.paseoHome, "agents");
  for (const dir of await readdir(agentsDir)) {
    const file = path.join(agentsDir, dir, `${agentId}.json`);
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) continue;
    const record = JSON.parse(text) as { queuedPrompts?: Array<{ prompt: AgentPromptInput }> };
    return (record.queuedPrompts ?? []).map((queued) => promptText(queued.prompt));
  }
  return [];
}

describe("messages waiting for a busy agent survive a daemon restart (e2e)", () => {
  let home: Home;

  beforeEach(async () => {
    home = await createHome();
    await startDaemon(home);
  }, 30_000);

  afterEach(async () => {
    await home.cleanup();
  }, 30_000);

  // A report counts as delivered once it is queued behind its owner's turn. When that queue lived
  // only in memory, a restart before the turn ended lost the report for good.
  test("a finish report queued behind its parent's turn reaches the parent after a restart", async () => {
    const parent = await createAgent(home, { title: "Leader" });
    await clientOf(home).sendMessage(parent, "keep working until interrupted");
    await expect
      .poll(() => daemonOf(home).agentManager.getAgent(parent)?.lifecycle, { timeout: 10_000 })
      .toBe("running");
    const child = await createAgent(home, {
      title: "Worker",
      labels: { [PARENT_AGENT_ID_LABEL]: parent },
    });
    watchForParent(home, { child, parent });
    await converse(home, child, "CHILD-DONE");

    // The parent's turn cannot take it, so the report waits on the parent's record.
    await expect.poll(() => obligationInLedger(home, child)).toMatchObject({ state: "delivered" });
    await expect
      .poll(() => queuedOnDisk(home, parent))
      .toEqual([expect.stringContaining(`Agent ${child} (Worker) finished.`)]);
    expect(home.prompts.some((prompt) => prompt.text.includes(`Agent ${child}`))).toBe(false);

    await restart(home);

    await expect
      .poll(() => promptsMentioning(home, `Agent ${child}`), { timeout: 10_000 })
      .toEqual([expect.stringContaining("CHILD-DONE")]);
    expect(await reportAbout(home, { to: parent, about: child })).toContain("finished.");
    await expect.poll(() => queuedOnDisk(home, parent)).toEqual([]);
  });
});
