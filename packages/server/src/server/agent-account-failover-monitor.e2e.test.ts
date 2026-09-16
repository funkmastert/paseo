import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import type { AgentPromptInput } from "./agent/agent-sdk-types.js";
import {
  ACCOUNT_FAILOVER_MIGRATED_TO_LABEL,
  HANDOFF_FROM_LABEL,
} from "./agent/account-failover-detector.js";
import { createPaseoDaemon, type PaseoDaemon } from "./bootstrap.js";
import type { PushPayload } from "./push/index.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestAgentClient } from "./test-utils/fake-agent-client.js";

// The exact message a real account produced when it ran dry.
const REAL_LIMIT_MESSAGE =
  "You've hit your monthly spend limit · raise it at " +
  "claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets " +
  "3:10pm (America/Los_Angeles)";
const REACTIVE_TTL_MS = 5 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const POOL_PROVIDERS = ["claude", "claude-personal", "claude-backup"] as const;
type PoolProvider = (typeof POOL_PROVIDERS)[number];

interface Harness {
  daemon: PaseoDaemon;
  client: DaemonClient;
  cwd: string;
  pushes: PushPayload[];
  prompts: Record<PoolProvider, string[]>;
  setUsage(providers: ProviderUsage[]): void;
  advanceClock(ms: number): void;
  setClock(ms: number): void;
  sweep(): Promise<void>;
  close(): Promise<void>;
}

function promptText(prompt: AgentPromptInput): string {
  return typeof prompt === "string" ? prompt : JSON.stringify(prompt);
}

function usageRow(
  providerId: string,
  usedPcts: number[],
  status: ProviderUsage["status"] = "available",
): ProviderUsage {
  return {
    providerId,
    displayName: providerId,
    status,
    planLabel: null,
    windows: usedPcts.map((usedPct, index) => ({
      id: `window-${index}`,
      label: `Window ${index}`,
      usedPct,
      remainingPct: Math.max(0, 100 - usedPct),
      resetsAt: null,
    })),
    balances: [],
    details: [],
    error: null,
  };
}

async function createHarness(): Promise<Harness> {
  const homeRoot = await mkdtemp(path.join(tmpdir(), "paseo-failover-home-"));
  const paseoHome = path.join(homeRoot, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  const staticDir = await mkdtemp(path.join(tmpdir(), "paseo-failover-static-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-failover-cwd-"));

  const pushes: PushPayload[] = [];
  const prompts: Record<PoolProvider, string[]> = {
    claude: [],
    "claude-personal": [],
    "claude-backup": [],
  };
  let usage: ProviderUsage[] = [];
  // Sightings are dated by the failure's timeline row, clamped to the monitor clock. Starting the
  // monitor clock before any real timestamp keeps that clamp in effect, so ages depend only on
  // advanceClock and never on the wall clock the test happens to run at.
  let clockMs = Date.parse("2000-01-01T00:00:00.000Z");

  const daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome,
      daemonVersion: "0.8.0",
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: Object.fromEntries(
        POOL_PROVIDERS.map((provider) => [
          provider,
          createTestAgentClient(provider, {
            onStartTurn: (prompt) => prompts[provider].push(promptText(prompt)),
          }),
        ]),
      ),
      providerOverrides: {
        "claude-personal": {
          extends: "claude",
          label: "Claude Personal",
          env: { CLAUDE_CONFIG_DIR: path.join(homeRoot, "personal-config") },
        },
        "claude-backup": {
          extends: "claude",
          label: "Claude Backup",
          env: { CLAUDE_CONFIG_DIR: path.join(homeRoot, "backup-config") },
        },
      },
      pushNotificationSender: {
        send: async (payload) => {
          pushes.push(payload);
        },
      },
      accountFailoverOverrides: {
        providerUsage: {
          listUsage: async () => ({
            fetchedAt: new Date(clockMs).toISOString(),
            providers: usage,
          }),
        },
        sweepIntervalMs: 60 * MINUTE_MS,
        now: () => clockMs,
      },
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      relayEndpoint: "relay.paseo.sh:443",
      appBaseUrl: "https://app.paseo.sh",
    },
    pino({ level: "silent" }),
  );

  await daemon.start();
  const target = daemon.getListenTarget();
  if (!target || target.type !== "tcp") {
    throw new Error("account failover test daemon did not bind a TCP port");
  }
  const client = new DaemonClient({ url: `ws://127.0.0.1:${target.port}/ws`, appVersion: "0.8.0" });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "account-failover" } });

  // Tyler's live shape: the bare `claude` entry is the pool leader, two derived workers.
  await client.patchDaemonConfig({
    providers: {
      claude: { params: { accountPool: { role: "leader", priority: 1 } } },
      "claude-personal": {
        extends: "claude",
        label: "Claude Personal",
        params: { accountPool: { role: "worker", priority: 1 } },
      },
      "claude-backup": {
        extends: "claude",
        label: "Claude Backup",
        params: { accountPool: { role: "worker", priority: 2 } },
      },
    },
  });

  return {
    daemon,
    client,
    cwd,
    pushes,
    prompts,
    setUsage: (providers) => {
      usage = providers;
    },
    advanceClock: (ms) => {
      clockMs += ms;
    },
    setClock: (ms) => {
      clockMs = ms;
    },
    sweep: async () => {
      const monitor = daemon.getAccountFailoverMonitor();
      if (!monitor) throw new Error("account failover monitor was not started");
      await monitor.tick();
    },
    close: async () => {
      await client.close();
      await daemon.stop().catch(() => undefined);
      await Promise.all([
        rm(homeRoot, { recursive: true, force: true }),
        rm(staticDir, { recursive: true, force: true }),
        rm(cwd, { recursive: true, force: true }),
      ]);
    },
  };
}

async function createAgent(
  harness: Harness,
  input: {
    provider: PoolProvider;
    title: string;
    modeId?: string;
    parentAgentId?: string;
  },
): Promise<string> {
  const agent = await harness.client.createAgent({
    provider: input.provider,
    model: "sonnet",
    modeId: input.modeId ?? "bypassPermissions",
    cwd: harness.cwd,
    title: input.title,
    ...(input.parentAgentId ? { labels: { [PARENT_AGENT_ID_LABEL]: input.parentAgentId } } : {}),
  });
  await harness.client.setAgentThinkingOption(agent.id, "max");
  return agent.id;
}

function managed(harness: Harness, agentId: string) {
  const agent = harness.daemon.agentManager.getAgent(agentId);
  if (!agent) throw new Error(`agent ${agentId} is not loaded`);
  return agent;
}

async function converse(harness: Harness, agentId: string, reply: string): Promise<void> {
  await harness.client.sendMessage(agentId, `respond with exactly: ${reply}`);
  await expect
    .poll(() => harness.daemon.agentManager.getLastAssistantMessage(agentId), { timeout: 10_000 })
    .toBe(reply);
  await expect.poll(() => managed(harness, agentId).lifecycle, { timeout: 10_000 }).toBe("idle");
}

async function failOnLimit(harness: Harness, agentId: string): Promise<void> {
  await harness.client.sendMessage(agentId, `emit a turn failure: ${REAL_LIMIT_MESSAGE}`);
  await expect
    .poll(() => managed(harness, agentId).lastError, { timeout: 10_000 })
    .toBe(REAL_LIMIT_MESSAGE);
  await expect
    .poll(() => managed(harness, agentId).lifecycle, { timeout: 10_000 })
    .not.toBe("running");
}

function successorOf(harness: Harness, agentId: string): string | undefined {
  return managed(harness, agentId).labels[ACCOUNT_FAILOVER_MIGRATED_TO_LABEL];
}

function assistantText(harness: Harness, agentId: string): string {
  return harness.daemon.agentManager
    .getTimeline(agentId)
    .flatMap((item) => (item.type === "assistant_message" ? [item.text] : []))
    .join("");
}

function failoverPushes(harness: Harness): PushPayload[] {
  return harness.pushes.filter((push) => push.data?.reason === "account_failover");
}

function agentCount(harness: Harness): number {
  return harness.daemon.agentManager.listAgents().length;
}

describe("AccountFailoverMonitor (e2e)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  }, 30_000);

  afterEach(async () => {
    await harness.close();
  });

  test("moves a leader off a capped leader account with its conversation and settings intact", async () => {
    // Live counter-example: a worker whose usage cannot be read is still a valid target.
    harness.setUsage([usageRow("claude-personal", [], "unavailable")]);
    const leader = await createAgent(harness, { provider: "claude", title: "Build failover" });
    await converse(harness, leader, "CONTEXT-MARKER-42");
    await failOnLimit(harness, leader);

    await harness.sweep();

    const successor = successorOf(harness, leader);
    expect(successor).toBeTruthy();
    const next = managed(harness, successor!);
    expect(next.provider).toBe("claude-personal");
    expect(next.config).toMatchObject({
      model: "sonnet",
      thinkingOptionId: "max",
      modeId: "bypassPermissions",
    });
    expect(next.labels[HANDOFF_FROM_LABEL]).toBe(leader);
    expect(assistantText(harness, successor!)).toContain("CONTEXT-MARKER-42");

    const resumePrompt = harness.prompts["claude-personal"].find((prompt) =>
      prompt.includes(`agent ${leader}`),
    );
    expect(resumePrompt).toContain('provider "claude-personal/sonnet"');
    expect(resumePrompt).toContain("model sonnet, thinking max, mode bypassPermissions");

    const predecessor = await harness.daemon.agentStorage.get(leader);
    expect(predecessor?.title).toBe(`[MOVED → ${successor}, out of budget] Build failover`);
    expect(predecessor?.archivedAt ?? null).toBeNull();

    expect(failoverPushes(harness)).toEqual([
      expect.objectContaining({
        title: "Agent moved to a new account",
        data: expect.objectContaining({ agentId: successor, reason: "account_failover" }),
      }),
    ]);

    // Same episode, second sweep: nothing new happens.
    const agentsAfterFirstSweep = agentCount(harness);
    await harness.sweep();
    expect(agentCount(harness)).toBe(agentsAfterFirstSweep);
    expect(failoverPushes(harness)).toHaveLength(1);
    expect(successorOf(harness, leader)).toBe(successor);
  }, 60_000);

  test("steers a running parent about its migrated subagent and leaves an idle parent alone", async () => {
    const busyParent = await createAgent(harness, {
      provider: "claude",
      title: "Busy leader",
      modeId: "default",
    });
    const idleParent = await createAgent(harness, { provider: "claude", title: "Idle leader" });
    await converse(harness, idleParent, "IDLE-LEADER-DONE");

    const busyChild = await createAgent(harness, {
      provider: "claude-personal",
      title: "Busy child",
      parentAgentId: busyParent,
    });
    const idleChild = await createAgent(harness, {
      provider: "claude-personal",
      title: "Idle child",
      parentAgentId: idleParent,
    });
    await failOnLimit(harness, busyChild);
    await failOnLimit(harness, idleChild);

    // Hold the busy parent mid-turn on a permission prompt.
    await harness.client.sendMessage(
      busyParent,
      'create a file named "hold.txt" with the content "x"',
    );
    await expect
      .poll(() => managed(harness, busyParent).pendingPermissions.size, { timeout: 10_000 })
      .toBe(1);
    expect(managed(harness, busyParent).lifecycle).toBe("running");
    const promptsBeforeSweep = harness.prompts.claude.length;

    await harness.sweep();

    // claude-personal is dead and the leader account is never a target: both go to backup.
    const busySuccessor = successorOf(harness, busyChild);
    const idleSuccessor = successorOf(harness, idleChild);
    expect(managed(harness, busySuccessor!).provider).toBe("claude-backup");
    expect(managed(harness, idleSuccessor!).provider).toBe("claude-backup");
    expect(managed(harness, busySuccessor!).labels[PARENT_AGENT_ID_LABEL]).toBe(busyParent);

    const parentMessages = harness.prompts.claude.slice(promptsBeforeSweep);
    expect(parentMessages).toHaveLength(1);
    expect(parentMessages[0]).toContain(`Your subagent ${busyChild}`);
    expect(parentMessages[0]).toContain(busySuccessor!);
    expect(parentMessages[0]).toContain('provider "claude-backup/sonnet"');
    expect(managed(harness, idleParent).lifecycle).toBe("idle");
  }, 60_000);

  test("skips a worker whose usage is at 100% and picks the next one", async () => {
    harness.setUsage([usageRow("claude-personal", [35, 100]), usageRow("claude-backup", [20])]);
    const leader = await createAgent(harness, { provider: "claude", title: "Leader" });
    await failOnLimit(harness, leader);

    await harness.sweep();

    expect(managed(harness, successorOf(harness, leader)!).provider).toBe("claude-backup");
  }, 60_000);

  test("adopts a successor that a person already imported by hand instead of importing again", async () => {
    const labeledLeader = await createAgent(harness, { provider: "claude", title: "Labeled" });
    const unlabeledLeader = await createAgent(harness, { provider: "claude", title: "Unlabeled" });
    await failOnLimit(harness, labeledLeader);
    await failOnLimit(harness, unlabeledLeader);

    const labeledSession = managed(harness, labeledLeader).persistence!.sessionId;
    const unlabeledSession = managed(harness, unlabeledLeader).persistence!.sessionId;
    const manual = await harness.client.importAgent({
      provider: "claude-backup",
      sessionId: labeledSession,
      cwd: harness.cwd,
      labels: { [HANDOFF_FROM_LABEL]: labeledLeader },
    });
    const unlabeledManual = await harness.client.importAgent({
      provider: "claude-personal",
      sessionId: unlabeledSession,
      cwd: harness.cwd,
    });
    // Observed in production: a second import of the same session onto the same provider is
    // rejected rather than returning the existing agent.
    await expect(
      harness.client.importAgent({
        provider: "claude-backup",
        sessionId: labeledSession,
        cwd: harness.cwd,
      }),
    ).rejects.toThrow(/already imported/);
    const agentsBeforeSweep = agentCount(harness);

    await harness.sweep();

    expect(agentCount(harness)).toBe(agentsBeforeSweep);
    expect(successorOf(harness, labeledLeader)).toBe(manual.id);
    expect(successorOf(harness, unlabeledLeader)).toBe(unlabeledManual.id);
    expect((await harness.daemon.agentStorage.get(labeledLeader))?.title).toBe(
      `[MOVED → ${manual.id}, out of budget] Labeled`,
    );
    expect(failoverPushes(harness)).toEqual([]);
  }, 60_000);

  test("waits while no worker is healthy and migrates once one recovers", async () => {
    harness.setUsage([usageRow("claude-personal", [100]), usageRow("claude-backup", [100])]);
    const leader = await createAgent(harness, { provider: "claude", title: "Leader" });
    await failOnLimit(harness, leader);

    await harness.sweep();
    expect(successorOf(harness, leader)).toBeUndefined();

    harness.setUsage([usageRow("claude-personal", [100]), usageRow("claude-backup", [10])]);
    harness.advanceClock(MINUTE_MS);
    await harness.sweep();

    expect(managed(harness, successorOf(harness, leader)!).provider).toBe("claude-backup");
  }, 60_000);

  test("reuses the retired handle when a conversation returns to an account it left", async () => {
    const first = await createAgent(harness, { provider: "claude-personal", title: "Hopper" });
    await failOnLimit(harness, first);
    await harness.sweep();
    const second = successorOf(harness, first)!;
    expect(managed(harness, second).provider).toBe("claude-backup");
    await expect.poll(() => managed(harness, second).lifecycle).toBe("idle");

    // Backup caps too, while personal's cap is still fresh: nowhere to go yet.
    harness.advanceClock(REACTIVE_TTL_MS - MINUTE_MS);
    await failOnLimit(harness, second);
    await harness.sweep();
    expect(successorOf(harness, second)).toBeUndefined();

    // Personal's evidence expires; backup's is still fresh. The conversation goes back.
    harness.advanceClock(2 * MINUTE_MS);
    const agentsBeforeReturn = agentCount(harness);
    await harness.sweep();

    expect(agentCount(harness)).toBe(agentsBeforeReturn);
    expect(successorOf(harness, second)).toBe(first);
    const revived = managed(harness, first);
    expect(revived.labels[ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]).toBe("");
    expect(revived.labels[HANDOFF_FROM_LABEL]).toBe(second);
    expect((await harness.daemon.agentStorage.get(first))?.title).toBe("Hopper");
    expect(
      harness.prompts["claude-personal"].some((prompt) => prompt.includes(`agent ${second}`)),
    ).toBe(true);
    expect(failoverPushes(harness).at(-1)?.data).toMatchObject({ agentId: first });

    // The revived handle's old error is history, not a new cap.
    await expect.poll(() => managed(harness, first).lifecycle).toBe("idle");
    harness.advanceClock(MINUTE_MS);
    await harness.sweep();
    expect(successorOf(harness, first)).toBe("");
    expect(agentCount(harness)).toBe(agentsBeforeReturn);
  }, 60_000);

  test("treats an old failure as history unless usage confirms the cap", async () => {
    const leader = await createAgent(harness, { provider: "claude", title: "Leader" });
    await failOnLimit(harness, leader);
    // Seen from far in the future, the failure row is older than the reactive window: the same
    // situation as a long-dead agent loaded after a daemon restart.
    harness.setClock(Date.parse("2100-01-01T00:00:00.000Z"));

    await harness.sweep();
    expect(successorOf(harness, leader)).toBeUndefined();

    harness.setUsage([usageRow("claude", [100])]);
    await harness.sweep();
    expect(managed(harness, successorOf(harness, leader)!).provider).toBe("claude-personal");
  }, 60_000);

  test("does nothing while disabled in config, and resumes when re-enabled live", async () => {
    await harness.client.patchDaemonConfig({ accountFailover: { enabled: false } });
    const leader = await createAgent(harness, { provider: "claude", title: "Leader" });
    await failOnLimit(harness, leader);

    await harness.sweep();
    expect(successorOf(harness, leader)).toBeUndefined();

    await harness.client.patchDaemonConfig({ accountFailover: { enabled: true } });
    await harness.sweep();
    expect(managed(harness, successorOf(harness, leader)!).provider).toBe("claude-personal");
  }, 60_000);
});
