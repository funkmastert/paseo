import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import type { AgentAccountAuth, AgentPromptInput } from "./agent/agent-sdk-types.js";
import {
  ACCOUNT_FAILOVER_HOME_PROVIDER_LABEL,
  ACCOUNT_FAILOVER_MIGRATED_TO_LABEL,
  HANDOFF_FROM_LABEL,
} from "./agent/account-failover-detector.js";
import { createPaseoDaemon, type PaseoDaemon } from "./bootstrap.js";
import type { PushPayload } from "./push/index.js";
import type { PushSendMeta } from "./notify-policy/levels.js";
import type { RemediationObservation } from "./remediation/contract.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestAgentClient } from "./test-utils/fake-agent-client.js";

// The exact message a real account produced when it ran dry.
const REAL_LIMIT_MESSAGE =
  "You've hit your monthly spend limit · raise it at " +
  "claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets " +
  "3:10pm (America/Los_Angeles)";
// The weekly cap that stranded claude-personal's agents on 2026-09-18, verbatim from a transcript.
// It shares no phrase with the message above.
const REAL_WEEKLY_LIMIT_MESSAGE = "You've hit your weekly limit · resets 7am (America/Los_Angeles)";
const REACTIVE_TTL_MS = 5 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const POOL_PROVIDERS = ["claude", "claude-personal", "claude-backup"] as const;
type PoolProvider = (typeof POOL_PROVIDERS)[number];

interface Harness {
  daemon: PaseoDaemon;
  client: DaemonClient;
  cwd: string;
  pushes: PushPayload[];
  /** Every push with the level it was sent at. */
  sends: Array<{ payload: PushPayload; meta: PushSendMeta | undefined }>;
  /** What the monitor told the remediation ladder. */
  observations: RemediationObservation[];
  prompts: Record<PoolProvider, string[]>;
  setUsage(providers: ProviderUsage[]): void;
  /** Make the next `times` resume prompts on `provider` fail the way a busy provider would. */
  failResumes(provider: PoolProvider, times: number): void;
  /** What `describeAccountAuth` reports for a provider — which Claude login it runs as. */
  setAccount(provider: PoolProvider, auth: AgentAccountAuth): void;
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
  const sends: Harness["sends"] = [];
  const observations: RemediationObservation[] = [];
  const prompts: Record<PoolProvider, string[]> = {
    claude: [],
    "claude-personal": [],
    "claude-backup": [],
  };
  let usage: ProviderUsage[] = [];
  const resumeFailures: Record<PoolProvider, number> = {
    claude: 0,
    "claude-personal": 0,
    "claude-backup": 0,
  };
  // "unknown" is what a config dir the CLI never wrote reports, and what every test that does not
  // care about account identity gets: two shrugs never read as one account.
  const accounts: Record<PoolProvider, AgentAccountAuth> = {
    claude: { state: "unknown" },
    "claude-personal": { state: "unknown" },
    "claude-backup": { state: "unknown" },
  };
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
            accountAuth: () => accounts[provider],
            onStartTurn: (prompt) => {
              const text = promptText(prompt);
              if (text.includes("Account handoff") && resumeFailures[provider] > 0) {
                resumeFailures[provider] -= 1;
                throw new Error("provider is busy");
              }
              prompts[provider].push(text);
            },
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
        send: async (payload, meta) => {
          pushes.push(payload);
          sends.push({ payload, meta });
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
        remediationSink: {
          observe: async (observation) => {
            observations.push(observation);
          },
        },
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
    sends,
    observations,
    prompts,
    failResumes: (provider, times) => {
      resumeFailures[provider] = times;
    },
    setAccount: (provider, auth) => {
      accounts[provider] = auth;
    },
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

async function failOnLimit(
  harness: Harness,
  agentId: string,
  message: string = REAL_LIMIT_MESSAGE,
): Promise<void> {
  await harness.client.sendMessage(agentId, `emit a turn failure: ${message}`);
  await expect.poll(() => managed(harness, agentId).lastError, { timeout: 10_000 }).toBe(message);
  await expect
    .poll(() => managed(harness, agentId).lifecycle, { timeout: 10_000 })
    .not.toBe("running");
}

function successorOf(harness: Harness, agentId: string): string | undefined {
  return managed(harness, agentId).labels[ACCOUNT_FAILOVER_MIGRATED_TO_LABEL];
}

function providerOf(harness: Harness, agentId: string): string {
  return managed(harness, agentId).provider;
}

/** Null once the label is blanked, which is how it is removed. */
function homeOf(harness: Harness, agentId: string): string | null {
  const home = managed(harness, agentId).labels[ACCOUNT_FAILOVER_HOME_PROVIDER_LABEL];
  return home === undefined || home === "" ? null : home;
}

/**
 * Put the monitor clock far enough past the wall clock that every real agent timestamp reads as
 * long-settled and every reactive sighting has expired — the state of the pool five hours after a
 * cap, which is when a return becomes possible. The tests before this point deliberately keep the
 * clock *behind* the wall clock so the failure-dating clamp is in effect.
 */
function windowHasReset(harness: Harness): void {
  harness.setClock(Date.now() + REACTIVE_TTL_MS + HOUR_MS);
}

async function settle(harness: Harness, agentId: string): Promise<void> {
  await expect.poll(() => managed(harness, agentId).lifecycle, { timeout: 10_000 }).toBe("idle");
}

function returnPushes(harness: Harness): PushPayload[] {
  return failoverPushes(harness).filter((push) => push.data?.outcome === "returned_home");
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

function poolExhaustedPushes(harness: Harness): PushPayload[] {
  return harness.pushes.filter((push) => push.data?.reason === "account_pool_exhausted");
}

function strandedObservations(harness: Harness): RemediationObservation[] {
  return harness.observations.filter(
    (observation) => observation.key === "account-failover-stranded",
  );
}

function levelOf(harness: Harness, payload: PushPayload | undefined): string | undefined {
  return harness.sends.find((send) => send.payload === payload)?.meta?.level;
}

/** A child of a leader that is not in the pool test, so only the label matters. */
const PARENT_ID = "parent-leader";

async function createChild(
  harness: Harness,
  input: { provider: PoolProvider; title: string; modeId?: string },
): Promise<string> {
  return createAgent(harness, { ...input, parentAgentId: PARENT_ID });
}

/** How many of these agents are on `provider` now. */
function countOn(harness: Harness, agentIds: readonly string[], provider: PoolProvider): number {
  let count = 0;
  for (const agentId of agentIds) {
    if (providerOf(harness, agentId) === provider) count += 1;
  }
  return count;
}

/** Same shape as usageRow, with every window resetting at `resetsAt`. */
function cappedUntil(providerId: string, resetsAt: string): ProviderUsage {
  const row = usageRow(providerId, [100]);
  for (const window of row.windows) window.resetsAt = resetsAt;
  return row;
}

// The lastError the stalled-agent sweep leaves when it cancels a turn that died on a capped
// account (workstream S). Failover reads only its shape: limit-shaped, naming the account.
function stallCancelError(provider: string): string {
  return (
    `Account ${provider} is at its usage limit or unusable, and this turn stalled in running ` +
    "with no activity; the daemon canceled it so account failover can move the agent."
  );
}

describe("AccountFailoverMonitor (e2e)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  }, 30_000);

  afterEach(async () => {
    await harness.close();
  });

  test("moves a capped leader to a healthy account without minting a second agent", async () => {
    // Live counter-example: a worker whose usage cannot be read is still a valid target.
    harness.setUsage([usageRow("claude-personal", [], "unavailable")]);
    const leader = await createAgent(harness, { provider: "claude", title: "Build failover" });
    await converse(harness, leader, "CONTEXT-MARKER-42");
    await failOnLimit(harness, leader);
    const agentsBeforeSweep = agentCount(harness);

    await harness.sweep();

    const moved = managed(harness, leader);
    expect(moved.provider).toBe("claude-personal");
    expect(agentCount(harness)).toBe(agentsBeforeSweep);
    expect(successorOf(harness, leader)).toBeUndefined();
    expect(moved.config).toMatchObject({
      model: "sonnet",
      thinkingOptionId: "max",
      modeId: "bypassPermissions",
    });
    expect(assistantText(harness, leader)).toContain("CONTEXT-MARKER-42");
    expect(moved.lastError).toBeUndefined();

    const resumePrompt = harness.prompts["claude-personal"].find((prompt) =>
      prompt.includes("Account handoff"),
    );
    expect(resumePrompt).toContain(`You are the same agent (${leader})`);
    expect(resumePrompt).toContain('provider "claude-personal/sonnet"');

    // Nothing is retired: there is no predecessor to retire.
    const record = await harness.daemon.agentStorage.get(leader);
    expect(record?.title).toBe("Build failover");
    expect(record?.provider).toBe("claude-personal");
    expect(record?.persistence?.provider).toBe("claude-personal");

    expect(failoverPushes(harness)).toEqual([
      expect.objectContaining({
        title: "Agent moved to a new account",
        body: expect.stringContaining(`still as ${leader}`),
        data: expect.objectContaining({ agentId: leader, reason: "account_failover" }),
      }),
    ]);

    // Same episode, second sweep: nothing new happens.
    await expect.poll(() => managed(harness, leader).lifecycle, { timeout: 10_000 }).toBe("idle");
    await harness.sweep();
    expect(agentCount(harness)).toBe(agentsBeforeSweep);
    expect(failoverPushes(harness)).toHaveLength(1);
    expect(providerOf(harness, leader)).toBe("claude-personal");
  }, 60_000);

  test("paces the resumes of a mass move through the shared resume budget", async () => {
    // One resume a minute, burst one: of three capped leaders only the first restarts now.
    await harness.client.patchDaemonConfig({ admission: { bulkResumesPerMinute: 1 } });
    const leaders: string[] = [];
    for (const title of ["First", "Second", "Third"]) {
      const leader = await createAgent(harness, { provider: "claude", title });
      await failOnLimit(harness, leader);
      leaders.push(leader);
    }
    const resumes = () =>
      harness.prompts["claude-personal"].filter((prompt) => prompt.includes("Account handoff"));

    // The sweep waits on the budget; afterEach stops the daemon, which lets it go.
    void harness.sweep().catch(() => undefined);
    await expect.poll(() => resumes().length, { timeout: 10_000 }).toBe(1);
    await expect
      .poll(() => countOn(harness, leaders, "claude-personal"), { timeout: 10_000 })
      .toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(resumes()).toHaveLength(1);
  }, 60_000);

  test("moves an agent capped by the weekly limit, the cap that stranded agents on 2026-09-18", async () => {
    const worker = await createChild(harness, { provider: "claude-personal", title: "Weekly" });
    await converse(harness, worker, "WEEKLY-MARKER");
    await failOnLimit(harness, worker, REAL_WEEKLY_LIMIT_MESSAGE);

    await harness.sweep();

    expect(providerOf(harness, worker)).toBe("claude-backup");
    expect(assistantText(harness, worker)).toContain("WEEKLY-MARKER");
  }, 60_000);

  test("retries a resume the target refused, and says nothing extra once it lands", async () => {
    // The move itself succeeded, so the agent carries no limit error any more and the detector
    // will never pick it up again: `planAccountFailoverSweep` only considers limit-shaped errors,
    // and "provider is busy" is not one. Only the retry queue can finish this migration.
    harness.failResumes("claude-personal", 1);
    const leader = await createAgent(harness, { provider: "claude", title: "Build failover" });
    await converse(harness, leader, "CONTEXT-MARKER-42");
    await failOnLimit(harness, leader);

    await harness.sweep();

    expect(providerOf(harness, leader)).toBe("claude-personal");
    expect(harness.prompts["claude-personal"]).toHaveLength(0);
    expect(managed(harness, leader).lifecycle).toBe("error");
    // The move is real and worth reporting; only the restart is outstanding.
    expect(failoverPushes(harness)).toHaveLength(1);
    expect(failoverPushes(harness)[0]?.title).toBe("Agent moved to a new account");

    await harness.sweep();

    const resumePrompt = harness.prompts["claude-personal"].find((prompt) =>
      prompt.includes("Account handoff"),
    );
    expect(resumePrompt).toContain(`You are the same agent (${leader})`);
    await expect.poll(() => managed(harness, leader).lifecycle, { timeout: 10_000 }).toBe("idle");
    // A retry that worked is not news: no second push.
    expect(failoverPushes(harness)).toHaveLength(1);

    // Nothing left queued, so a later sweep does not prompt it again.
    await harness.sweep();
    expect(
      harness.prompts["claude-personal"].filter((prompt) => prompt.includes("Account handoff")),
    ).toHaveLength(1);
  }, 60_000);

  test("gives up after three resume attempts and tells Tyler the agent needs a prompt", async () => {
    harness.failResumes("claude-personal", 99);
    const leader = await createAgent(harness, { provider: "claude", title: "Build failover" });
    await converse(harness, leader, "CONTEXT-MARKER-42");
    await failOnLimit(harness, leader);

    // The original send, then one retry per sweep.
    await harness.sweep();
    await harness.sweep();
    await harness.sweep();

    expect(failoverPushes(harness)).toHaveLength(2);
    expect(failoverPushes(harness)[1]).toMatchObject({
      title: "Agent moved but did not restart",
      body: expect.stringContaining("could not be restarted"),
      data: expect.objectContaining({
        agentId: leader,
        reason: "account_failover",
        outcome: "needs_prompt",
      }),
    });
    // It says what to do about it, since the agent is one message away from continuing.
    expect(failoverPushes(harness)[1]?.body).toContain("send any message to continue");

    // Given up means given up: no fourth attempt, and no second complaint.
    await harness.sweep();
    expect(failoverPushes(harness)).toHaveLength(2);
    // The conversation is intact on the new account — it is stalled, not lost.
    expect(providerOf(harness, leader)).toBe("claude-personal");
    expect(assistantText(harness, leader)).toContain("CONTEXT-MARKER-42");
    expect(successorOf(harness, leader)).toBeUndefined();
  }, 60_000);

  test("keeps the account it left out of rotation until the evidence expires", async () => {
    const worker = await createChild(harness, { provider: "claude-personal", title: "Worker" });
    await failOnLimit(harness, worker);
    await harness.sweep();
    expect(providerOf(harness, worker)).toBe("claude-backup");

    // The failure moved with the agent and was cleared, so nothing on claude-personal still
    // reports the cap. It must stay condemned anyway, or this next agent lands on it.
    const leader = await createAgent(harness, { provider: "claude", title: "Leader" });
    await failOnLimit(harness, leader);
    harness.advanceClock(MINUTE_MS);
    await harness.sweep();
    expect(providerOf(harness, leader)).toBe("claude-backup");

    // It is a five-hour window, not a permanent exclusion.
    const later = await createAgent(harness, { provider: "claude", title: "Later leader" });
    await failOnLimit(harness, later);
    harness.advanceClock(REACTIVE_TTL_MS);
    harness.setUsage([usageRow("claude", [100])]);
    await harness.sweep();
    expect(providerOf(harness, later)).toBe("claude-personal");
  }, 60_000);

  test("moves a subagent under its parent without telling the parent anything", async () => {
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
    expect(providerOf(harness, busyChild)).toBe("claude-backup");
    expect(providerOf(harness, idleChild)).toBe("claude-backup");
    expect(managed(harness, busyChild).labels[PARENT_AGENT_ID_LABEL]).toBe(busyParent);

    // A moved subagent keeps its id, so the parent's handle to it and its finish notification
    // still work. The steered message the import path needed has nothing left to say.
    expect(harness.prompts.claude.slice(promptsBeforeSweep)).toEqual([]);
    expect(managed(harness, idleParent).lifecycle).toBe("idle");
  }, 60_000);

  test("skips a worker whose usage is at 100% and picks the next one", async () => {
    harness.setUsage([usageRow("claude-personal", [35, 100]), usageRow("claude-backup", [20])]);
    const leader = await createAgent(harness, { provider: "claude", title: "Leader" });
    await failOnLimit(harness, leader);

    await harness.sweep();

    expect(providerOf(harness, leader)).toBe("claude-backup");
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
    expect(providerOf(harness, leader)).toBe("claude");

    harness.setUsage([usageRow("claude-personal", [100]), usageRow("claude-backup", [10])]);
    harness.advanceClock(MINUTE_MS);
    await harness.sweep();

    expect(providerOf(harness, leader)).toBe("claude-backup");
  }, 60_000);

  test("hops between accounts on one agent id, with no handles left behind", async () => {
    const hopper = await createChild(harness, { provider: "claude-personal", title: "Hopper" });
    await converse(harness, hopper, "HOP-MARKER");
    const session = managed(harness, hopper).persistence?.sessionId;
    const agentsBefore = agentCount(harness);
    await failOnLimit(harness, hopper);

    await harness.sweep();
    expect(providerOf(harness, hopper)).toBe("claude-backup");

    // Backup caps too, while personal's cap is still fresh: both workers are out, so the pool
    // collapses onto the leader account rather than leaving the agent stuck on a dead one.
    harness.advanceClock(REACTIVE_TTL_MS - MINUTE_MS);
    await expect.poll(() => managed(harness, hopper).lifecycle, { timeout: 10_000 }).toBe("idle");
    await failOnLimit(harness, hopper);
    await harness.sweep();
    expect(providerOf(harness, hopper)).toBe("claude");

    // Personal's evidence expires while the leader account caps: the conversation goes back to
    // an account it already left, on the same id and the same session.
    harness.advanceClock(2 * MINUTE_MS);
    await expect.poll(() => managed(harness, hopper).lifecycle, { timeout: 10_000 }).toBe("idle");
    await failOnLimit(harness, hopper);
    await harness.sweep();

    expect(providerOf(harness, hopper)).toBe("claude-personal");
    expect(agentCount(harness)).toBe(agentsBefore);
    expect(managed(harness, hopper).persistence?.sessionId).toBe(session);
    expect(assistantText(harness, hopper)).toContain("HOP-MARKER");
    expect(failoverPushes(harness).at(-1)?.data).toMatchObject({ agentId: hopper });
  }, 60_000);

  test("revives a retired handle an earlier import left on the target account", async () => {
    // The shape a pre-move daemon left behind: a retired predecessor on one account and the
    // imported successor on another, both on the same session.
    const retired = await createChild(harness, { provider: "claude-personal", title: "Hopper" });
    await converse(harness, retired, "IMPORTED-MARKER");
    const session = managed(harness, retired).persistence!.sessionId;
    const successor = await harness.client.importAgent({
      providerId: "claude-backup",
      providerHandleId: session,
      cwd: harness.cwd,
      labels: { [HANDOFF_FROM_LABEL]: retired, [PARENT_AGENT_ID_LABEL]: PARENT_ID },
    });
    await harness.client.updateAgent(retired, {
      name: `[MOVED → ${successor.id}, out of budget] Hopper`,
      labels: { [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: successor.id },
    });
    await failOnLimit(harness, successor.id);
    const agentsBefore = agentCount(harness);

    await harness.sweep();

    // Moving in place would put a second live agent on claude-personal's copy of the session,
    // so the monitor falls back to reusing the handle that is already there.
    expect(providerOf(harness, successor.id)).toBe("claude-backup");
    expect(successorOf(harness, successor.id)).toBe(retired);
    expect(agentCount(harness)).toBe(agentsBefore);
    const revived = managed(harness, retired);
    expect(revived.labels[ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]).toBe("");
    expect(revived.labels[HANDOFF_FROM_LABEL]).toBe(successor.id);
    expect((await harness.daemon.agentStorage.get(retired))?.title).toBe("Hopper");
  }, 60_000);

  test("treats an old failure as history unless usage confirms the cap", async () => {
    const leader = await createAgent(harness, { provider: "claude", title: "Leader" });
    await failOnLimit(harness, leader);
    // Seen from far in the future, the failure row is older than the reactive window: the same
    // situation as a long-dead agent loaded after a daemon restart.
    harness.setClock(Date.parse("2100-01-01T00:00:00.000Z"));

    await harness.sweep();
    expect(providerOf(harness, leader)).toBe("claude");

    harness.setUsage([usageRow("claude", [100])]);
    await harness.sweep();
    expect(providerOf(harness, leader)).toBe("claude-personal");
  }, 60_000);

  test("does nothing while disabled in config, and resumes when re-enabled live", async () => {
    await harness.client.patchDaemonConfig({ accountFailover: { enabled: false } });
    const leader = await createAgent(harness, { provider: "claude", title: "Leader" });
    await failOnLimit(harness, leader);

    await harness.sweep();
    expect(providerOf(harness, leader)).toBe("claude");

    await harness.client.patchDaemonConfig({ accountFailover: { enabled: true } });
    await harness.sweep();
    expect(providerOf(harness, leader)).toBe("claude-personal");
  }, 60_000);

  test("sends the agent to the account with the most budget left, not the lowest priority number", async () => {
    // claude-personal is priority 1 and nearly spent; claude-backup is priority 2 and barely
    // used. Priority order alone sends the agent to the account about to cap.
    harness.setUsage([
      usageRow("claude", [100]),
      usageRow("claude-personal", [85]),
      usageRow("claude-backup", [20]),
    ]);
    const leader = await createAgent(harness, { provider: "claude", title: "Build failover" });
    await converse(harness, leader, "CONTEXT-MARKER-42");
    await failOnLimit(harness, leader);

    await harness.sweep();

    expect(providerOf(harness, leader)).toBe("claude-backup");
  });

  test("collapses onto the leader account when no worker can take the agent", async () => {
    // Both workers out for the week, the leader account still has budget. Strict isolation
    // stranded the agent here; a shared account runs it.
    harness.setUsage([
      usageRow("claude", [30]),
      usageRow("claude-personal", [100]),
      usageRow("claude-backup", [100]),
    ]);
    const worker = await createAgent(harness, {
      provider: "claude-personal",
      title: "Worker one",
    });
    await converse(harness, worker, "CONTEXT-MARKER-77");
    await failOnLimit(harness, worker);

    await harness.sweep();

    expect(providerOf(harness, worker)).toBe("claude");
    // Moved in place, conversation intact — not handed to a second agent.
    expect(successorOf(harness, worker)).toBeUndefined();
    expect(assistantText(harness, worker)).toContain("CONTEXT-MARKER-77");
  });

  test("strands the agent and reports it to the ladder, not as a push of its own", async () => {
    harness.setUsage([
      cappedUntil("claude", "2026-09-26T14:00:00.000Z"),
      cappedUntil("claude-personal", "2026-09-24T22:10:00.000Z"),
      cappedUntil("claude-backup", "2026-09-26T14:00:00.000Z"),
    ]);
    const worker = await createChild(harness, {
      provider: "claude-personal",
      title: "Worker one",
    });
    await converse(harness, worker, "CONTEXT-MARKER-88");
    await failOnLimit(harness, worker);

    await harness.sweep();

    // Nothing moved: every target would fail on its first turn.
    expect(providerOf(harness, worker)).toBe("claude-personal");
    expect(successorOf(harness, worker)).toBeUndefined();
    expect(failoverPushes(harness)).toHaveLength(0);
    expect(poolExhaustedPushes(harness)).toHaveLength(0);
    expect(agentCount(harness)).toBe(1);

    // The ladder owns the one push. No remedy is left and no agent could help: it would need an
    // account to run on.
    const [observation] = strandedObservations(harness);
    expect(observation).toMatchObject({
      key: "account-failover-stranded",
      kind: "account-pool-exhausted",
      active: true,
      remedy: "none",
      level: "urgent",
    });
    expect(observation?.escalation).toBeUndefined();
    expect(observation?.evidence).toContain(worker);
    expect(observation?.evidence).toContain("Worker one");
    expect(observation?.evidence).toContain("2026-09-24T22:10:00.000Z");
    expect(observation?.summary).toContain("claude-personal");

    // Repeats while it holds are the contract, and all one episode.
    await harness.sweep();
    expect(strandedObservations(harness).every((o) => o.active)).toBe(true);
    expect(new Set(strandedObservations(harness).map((o) => o.key)).size).toBe(1);
  });

  test("reports the stranding over once an account recovers and the agent moves", async () => {
    harness.setUsage([
      usageRow("claude", [100]),
      usageRow("claude-personal", [100]),
      usageRow("claude-backup", [100]),
    ]);
    const worker = await createChild(harness, {
      provider: "claude-personal",
      title: "Worker one",
    });
    await converse(harness, worker, "CONTEXT-MARKER-99");
    await failOnLimit(harness, worker);
    await harness.sweep();
    expect(strandedObservations(harness)).toHaveLength(1);

    harness.setUsage([
      usageRow("claude", [100]),
      usageRow("claude-personal", [100]),
      usageRow("claude-backup", [10]),
    ]);
    await harness.sweep();

    expect(providerOf(harness, worker)).toBe("claude-backup");
    expect(strandedObservations(harness).at(-1)).toMatchObject({
      key: "account-failover-stranded",
      active: false,
    });

    // Closed once; a quiet pool says nothing more.
    const count = strandedObservations(harness).length;
    await harness.sweep();
    expect(strandedObservations(harness)).toHaveLength(count);
  });

  test("brings a rescued leader home once its own account's window has reset", async () => {
    harness.setUsage([
      usageRow("claude", [5]),
      usageRow("claude-personal", [5]),
      usageRow("claude-backup", [50]),
    ]);
    const leader = await createAgent(harness, { provider: "claude", title: "Build failover" });
    await converse(harness, leader, "CONTEXT-MARKER-42");
    await failOnLimit(harness, leader);

    await harness.sweep();
    expect(providerOf(harness, leader)).toBe("claude-personal");
    // The rescue remembers where the conversation came from; nothing else does.
    expect(homeOf(harness, leader)).toBe("claude");
    await settle(harness, leader);
    const promptsBefore = harness.prompts.claude.length;

    windowHasReset(harness);
    await harness.sweep();

    expect(providerOf(harness, leader)).toBe("claude");
    // Same agent, same conversation, and nothing to resume — a return never starts a turn.
    expect(assistantText(harness, leader)).toContain("CONTEXT-MARKER-42");
    expect(harness.prompts.claude.slice(promptsBefore)).toEqual([]);
    expect(managed(harness, leader).lifecycle).toBe("idle");
    // Home is cleared, so it is not a candidate to move anywhere on the next sweep.
    expect(homeOf(harness, leader)).toBeNull();
    const record = await harness.daemon.agentStorage.get(leader);
    expect(record?.provider).toBe("claude");
    expect(record?.persistence?.provider).toBe("claude");

    expect(returnPushes(harness)).toEqual([
      expect.objectContaining({
        title: "Agent returned to its own account",
        body: expect.stringContaining("went back to claude from claude-personal"),
        data: expect.objectContaining({ agentId: leader, outcome: "returned_home" }),
      }),
    ]);

    // The round trip is finished: a later sweep has nothing left to do.
    await harness.sweep();
    expect(providerOf(harness, leader)).toBe("claude");
    expect(returnPushes(harness)).toHaveLength(1);

    // And the conversation still runs, on its own budget, with its history intact.
    await converse(harness, leader, "HOME-AGAIN");
    expect(assistantText(harness, leader)).toContain("CONTEXT-MARKER-42");
    expect(providerOf(harness, leader)).toBe("claude");
  }, 60_000);

  test("brings agents home even while another agent is stuck with nowhere to go", async () => {
    harness.setUsage([usageRow("claude", [5])]);
    const rescued = await createAgent(harness, { provider: "claude", title: "Rescued" });
    await failOnLimit(harness, rescued);
    await harness.sweep();
    expect(providerOf(harness, rescued)).toBe("claude-personal");
    await settle(harness, rescued);

    // Both workers capped and collapse switched off: this child is a migration candidate on every
    // sweep and can never be moved. It must not hold up the round trip.
    await harness.client.patchDaemonConfig({ accountFailover: { collapseToSharedAccount: false } });
    const stranded = await createChild(harness, { provider: "claude-backup", title: "Stranded" });
    windowHasReset(harness);
    await failOnLimit(harness, stranded);
    harness.setUsage([
      usageRow("claude", [5]),
      usageRow("claude-personal", [100]),
      usageRow("claude-backup", [100]),
    ]);

    await harness.sweep();

    expect(providerOf(harness, stranded)).toBe("claude-backup");
    expect(providerOf(harness, rescued)).toBe("claude");
  }, 60_000);

  test("a conversation that hops twice still belongs to the account it started on", async () => {
    harness.setUsage([usageRow("claude", [5])]);
    const leader = await createAgent(harness, { provider: "claude", title: "Hopper" });
    await converse(harness, leader, "HOP-MARKER");
    await failOnLimit(harness, leader);

    await harness.sweep();
    expect(providerOf(harness, leader)).toBe("claude-personal");
    expect(homeOf(harness, leader)).toBe("claude");

    // The rescuer caps too, so it hops again. Home must stay the leader account, not become the
    // rescuer it happened to pass through — otherwise a week of hops walks it onto the workers.
    await settle(harness, leader);
    await failOnLimit(harness, leader);
    harness.advanceClock(MINUTE_MS);
    await harness.sweep();
    expect(providerOf(harness, leader)).toBe("claude-backup");
    expect(homeOf(harness, leader)).toBe("claude");

    await settle(harness, leader);
    windowHasReset(harness);
    await harness.sweep();

    expect(providerOf(harness, leader)).toBe("claude");
    expect(homeOf(harness, leader)).toBeNull();
  }, 60_000);

  test("a rescue that lands back on home finishes the round trip by itself", async () => {
    const hopper = await createChild(harness, { provider: "claude-personal", title: "Hopper" });
    await failOnLimit(harness, hopper);
    await harness.sweep();
    expect(providerOf(harness, hopper)).toBe("claude-backup");
    expect(homeOf(harness, hopper)).toBe("claude-personal");

    // Backup caps while personal's evidence expires, so the ordinary rescue leg sends it back to
    // the account it came from. It is home; there is nothing left for the return leg to want.
    // The leader account is out too, so the rescue cannot collapse onto it in the meantime.
    harness.setUsage([usageRow("claude", [100])]);
    await settle(harness, hopper);
    harness.advanceClock(REACTIVE_TTL_MS - MINUTE_MS);
    await failOnLimit(harness, hopper);
    await harness.sweep();
    harness.advanceClock(2 * MINUTE_MS);
    await harness.sweep();

    expect(providerOf(harness, hopper)).toBe("claude-personal");
    expect(homeOf(harness, hopper)).toBeNull();
  }, 60_000);

  test("will not come home to a window that has reset into someone else's spending", async () => {
    harness.setUsage([usageRow("claude", [5])]);
    const leader = await createAgent(harness, { provider: "claude", title: "Leader" });
    await failOnLimit(harness, leader);
    await harness.sweep();
    await settle(harness, leader);

    // Past the reset, below the 100% that condemns an account, and still far too hot to return to:
    // the clock passing `resetsAt` is not the signal, a fresh reading with real headroom is.
    windowHasReset(harness);
    harness.setUsage([usageRow("claude", [80])]);
    await harness.sweep();

    expect(providerOf(harness, leader)).toBe("claude-personal");
    expect(homeOf(harness, leader)).toBe("claude");
    expect(returnPushes(harness)).toEqual([]);

    // A window the leader can actually use.
    harness.setUsage([usageRow("claude", [12])]);
    await harness.sweep();
    expect(providerOf(harness, leader)).toBe("claude");
  }, 60_000);

  test("never takes the account out from under an agent that is working", async () => {
    harness.setUsage([usageRow("claude", [5])]);
    const leader = await createAgent(harness, {
      provider: "claude",
      title: "Leader",
      modeId: "default",
    });
    await failOnLimit(harness, leader);
    await harness.sweep();
    expect(providerOf(harness, leader)).toBe("claude-personal");
    await settle(harness, leader);

    // Mid-turn, holding on a permission prompt: a rescue is worth interrupting a turn for, a
    // tidy-up is not.
    await harness.client.sendMessage(leader, 'create a file named "hold.txt" with the content "x"');
    await expect
      .poll(() => managed(harness, leader).pendingPermissions.size, { timeout: 10_000 })
      .toBe(1);

    windowHasReset(harness);
    await harness.sweep();
    expect(providerOf(harness, leader)).toBe("claude-personal");
    expect(homeOf(harness, leader)).toBe("claude");

    const [permission] = harness.daemon.agentManager.getPendingPermissions(leader);
    if (!permission) throw new Error("expected a pending permission to release");
    await harness.client.respondToPermission(leader, permission.id, { behavior: "allow" });
    await settle(harness, leader);

    await harness.sweep();
    expect(providerOf(harness, leader)).toBe("claude");
  }, 60_000);

  test("drops a home account that was disabled instead of retrying it forever", async () => {
    harness.setUsage([usageRow("claude", [5])]);
    const leader = await createAgent(harness, { provider: "claude", title: "Leader" });
    await failOnLimit(harness, leader);
    await harness.sweep();
    expect(homeOf(harness, leader)).toBe("claude");
    await settle(harness, leader);

    // The leader slot is turned off. Its home label now points at nothing the monitor may use, so
    // it goes, and the agent stays on the healthy account it is already working on.
    await harness.client.patchDaemonConfig({ providers: { claude: { enabled: false } } });
    windowHasReset(harness);
    await harness.sweep();

    expect(homeOf(harness, leader)).toBeNull();
    expect(providerOf(harness, leader)).toBe("claude-personal");
    expect(returnPushes(harness)).toEqual([]);
  }, 60_000);

  test("treats two providers signed into one Claude account as one account", async () => {
    // Tyler's live shape: ~/.claude-personal and ~/.claude-leader on the same login. Their usage
    // windows are the same windows, so moving between them buys no budget at all.
    const shared: AgentAccountAuth = { state: "signed-in", accountLabel: "tyler@example.com" };
    harness.setAccount("claude", shared);
    harness.setAccount("claude-personal", { ...shared });
    harness.setAccount("claude-backup", {
      state: "signed-in",
      accountLabel: "worker@example.com",
    });

    const leader = await createAgent(harness, { provider: "claude", title: "Leader" });
    await failOnLimit(harness, leader);

    await harness.sweep();

    // claude-personal is the higher-priority worker, and is skipped: it is the exhausted account
    // under another name. The rescue goes to the one account that has its own budget.
    expect(providerOf(harness, leader)).toBe("claude-backup");
    expect(homeOf(harness, leader)).toBe("claude");
  }, 60_000);

  test("drops a home label that turns out to name the account the agent is already on", async () => {
    const leader = await createAgent(harness, { provider: "claude", title: "Leader" });
    await failOnLimit(harness, leader);
    await harness.sweep();
    expect(providerOf(harness, leader)).toBe("claude-personal");
    expect(homeOf(harness, leader)).toBe("claude");
    await settle(harness, leader);

    // Tyler logs the leader slot into the same account the rescuer uses. Going "home" would move
    // the agent onto the same windows it is already spending, so the label is dropped instead.
    const shared: AgentAccountAuth = { state: "signed-in", accountLabel: "tyler@example.com" };
    harness.setAccount("claude", shared);
    harness.setAccount("claude-personal", { ...shared });
    harness.setUsage([usageRow("claude", [5])]);
    windowHasReset(harness);
    await harness.sweep();

    expect(homeOf(harness, leader)).toBeNull();
    expect(providerOf(harness, leader)).toBe("claude-personal");
    expect(returnPushes(harness)).toEqual([]);
  }, 60_000);

  test("drops a home account nobody is signed into any more", async () => {
    const leader = await createAgent(harness, { provider: "claude", title: "Leader" });
    await failOnLimit(harness, leader);
    await harness.sweep();
    expect(homeOf(harness, leader)).toBe("claude");
    await settle(harness, leader);

    harness.setAccount("claude", { state: "signed-out", signInCommand: "claude /login" });
    harness.setUsage([usageRow("claude", [5])]);
    windowHasReset(harness);
    await harness.sweep();

    expect(homeOf(harness, leader)).toBeNull();
    expect(providerOf(harness, leader)).toBe("claude-personal");
  }, 60_000);

  test("keeps the home label when home refuses the move, and moves nothing", async () => {
    harness.setUsage([usageRow("claude", [5])]);
    const leader = await createAgent(harness, { provider: "claude", title: "Leader" });
    await converse(harness, leader, "REFUSED-MARKER");
    const session = managed(harness, leader).persistence!.sessionId;
    await failOnLimit(harness, leader);
    await harness.sweep();
    expect(providerOf(harness, leader)).toBe("claude-personal");
    await settle(harness, leader);

    // Somebody imported the same conversation back onto the home account by hand, so the move
    // home is refused with session_conflict. A return is an optimisation: it gives up quietly and
    // keeps the label, rather than falling back to minting a second agent the way a rescue does.
    const squatter = await harness.client.importAgent({
      provider: "claude",
      sessionId: session,
      cwd: harness.cwd,
    });
    const agentsBefore = agentCount(harness);

    windowHasReset(harness);
    await harness.sweep();

    expect(providerOf(harness, leader)).toBe("claude-personal");
    expect(homeOf(harness, leader)).toBe("claude");
    expect(agentCount(harness)).toBe(agentsBefore);
    expect(returnPushes(harness)).toEqual([]);
    expect(providerOf(harness, squatter.id)).toBe("claude");
  }, 60_000);

  test("does not return anything while the return leg is switched off", async () => {
    await harness.client.patchDaemonConfig({ accountFailover: { returnHome: false } });
    harness.setUsage([usageRow("claude", [5])]);
    const leader = await createAgent(harness, { provider: "claude", title: "Leader" });
    await failOnLimit(harness, leader);
    await harness.sweep();
    expect(providerOf(harness, leader)).toBe("claude-personal");
    await settle(harness, leader);

    windowHasReset(harness);
    await harness.sweep();
    expect(providerOf(harness, leader)).toBe("claude-personal");
    // Still remembered, so turning the leg back on completes the round trip rather than starting it.
    expect(homeOf(harness, leader)).toBe("claude");

    await harness.client.patchDaemonConfig({ accountFailover: { returnHome: true } });
    await harness.sweep();
    expect(providerOf(harness, leader)).toBe("claude");
  }, 60_000);

  test("moves an idle root off an exhausted account onto the leader account, and sends it nothing", async () => {
    // 2026-09-24: "Check mobile support needs" sat on claude-backup, out for the week, while the
    // leader account had nearly all its budget.
    harness.setUsage([usageRow("claude", [12]), usageRow("claude-backup", [100])]);
    const root = await createAgent(harness, {
      provider: "claude-backup",
      title: "Check mobile support needs",
    });
    await converse(harness, root, "ROOT-MARKER");
    const promptsBefore = harness.prompts.claude.length;

    await harness.sweep();

    expect(providerOf(harness, root)).toBe("claude");
    expect(assistantText(harness, root)).toContain("ROOT-MARKER");
    expect(harness.prompts.claude.slice(promptsBefore)).toEqual([]);
    expect(managed(harness, root).lifecycle).toBe("idle");
    // The move is on the record, not a push.
    const [moved] = failoverPushes(harness);
    expect(moved?.data).toMatchObject({ agentId: root });
    expect(levelOf(harness, moved)).toBe("record");

    // It answers the next message on the account it moved to.
    await converse(harness, root, "ANSWERED");
    expect(harness.prompts.claude.at(-1)).toContain("ANSWERED");
  }, 60_000);

  test("moves a root cut off mid-turn by the cap to the leader account and resumes it", async () => {
    const root = await createAgent(harness, { provider: "claude-backup", title: "Root" });
    await converse(harness, root, "CUT-OFF-MARKER");
    await failOnLimit(harness, root, REAL_WEEKLY_LIMIT_MESSAGE);

    await harness.sweep();

    expect(providerOf(harness, root)).toBe("claude");
    const resume = harness.prompts.claude.find((prompt) => prompt.includes("Account handoff"));
    expect(resume).toContain(`You are the same agent (${root})`);
    expect(levelOf(harness, failoverPushes(harness)[0])).toBe("record");
  }, 60_000);

  test("resumes a root whose dead turn the stalled-agent sweep cancelled", async () => {
    // The stalled-agent sweep cancels a turn stuck in running on a capped account and leaves a
    // limit-shaped lastError. That is a turn cut off mid-way, so it is resumed, not just moved.
    // (It lands the agent idle rather than in error; the detector unit test covers that.)
    const root = await createAgent(harness, { provider: "claude-backup", title: "Stalled root" });
    await converse(harness, root, "STALLED-MARKER");
    await failOnLimit(harness, root, stallCancelError("claude-backup"));

    await harness.sweep();

    expect(providerOf(harness, root)).toBe("claude");
    expect(harness.prompts.claude.some((prompt) => prompt.includes("Account handoff"))).toBe(true);
  }, 60_000);

  test("leaves an idle child until asked, then rescues it to a worker or the leader account", async () => {
    harness.setUsage([usageRow("claude-backup", [100]), usageRow("claude-personal", [30])]);
    const child = await createChild(harness, { provider: "claude-backup", title: "Child one" });
    await converse(harness, child, "CHILD-MARKER");

    // A child answers its leader, not Tyler: nothing moves it while nobody asks it anything.
    await harness.sweep();
    expect(providerOf(harness, child)).toBe("claude-backup");

    await failOnLimit(harness, child);
    await harness.sweep();
    expect(providerOf(harness, child)).toBe("claude-personal");
    expect(
      harness.prompts["claude-personal"].some((prompt) => prompt.includes("Account handoff")),
    ).toBe(true);

    // Both workers out: the next rescue collapses onto the leader account.
    await settle(harness, child);
    harness.setUsage([usageRow("claude-backup", [100]), usageRow("claude-personal", [100])]);
    await failOnLimit(harness, child);
    harness.advanceClock(MINUTE_MS);
    await harness.sweep();
    expect(providerOf(harness, child)).toBe("claude");
  }, 60_000);

  test("never moves an agent onto an account at 90% or more", async () => {
    // claude-personal is the first worker by priority and is not dead, but at 92% it would cap
    // the agent again within a turn or two.
    harness.setUsage([usageRow("claude-personal", [92]), usageRow("claude-backup", [60])]);
    const child = await createChild(harness, { provider: "claude", title: "Child" });
    await failOnLimit(harness, child);
    await harness.sweep();
    expect(providerOf(harness, child)).toBe("claude-backup");

    // With every other account at 90% or more, nothing can take the next one: it is stranded.
    const other = await createChild(harness, { provider: "claude-backup", title: "Other" });
    harness.setUsage([usageRow("claude-personal", [92]), usageRow("claude", [95])]);
    await failOnLimit(harness, other);
    harness.advanceClock(MINUTE_MS);
    await harness.sweep();
    expect(providerOf(harness, other)).toBe("claude-backup");
    expect(strandedObservations(harness).at(-1)).toMatchObject({ active: true });
  }, 60_000);

  test("returns an idle child the leader account holds to a worker under 90%, with no label needed", async () => {
    // Placement collapsed this child onto the leader account at spawn; failover never moved it.
    const child = await createChild(harness, { provider: "claude", title: "Collapsed child" });
    await converse(harness, child, "COLLAPSED-MARKER");
    windowHasReset(harness);
    // claude-personal at 70% is under the watcher's usable line, though over returnMaxHomeUsedPct.
    harness.setUsage([usageRow("claude-personal", [70]), usageRow("claude-backup", [100])]);
    const promptsBefore = harness.prompts["claude-personal"].length;

    await harness.sweep();

    expect(providerOf(harness, child)).toBe("claude-personal");
    expect(harness.prompts["claude-personal"].slice(promptsBefore)).toEqual([]);
    expect(assistantText(harness, child)).toContain("COLLAPSED-MARKER");
  }, 60_000);

  test("retires a duplicate record the leader account already holds, and never retries it", async () => {
    // 2026-09-24: three moves failed three times each with "Provider 'claude' already holds
    // agent Y for session Z". The conversation was already live under another record.
    const holder = await createAgent(harness, { provider: "claude", title: "Review PR #87" });
    await converse(harness, holder, "HOLDER-MARKER");
    const session = managed(harness, holder).persistence!.sessionId;
    const duplicate = await harness.client.importAgent({
      provider: "claude-backup",
      sessionId: session,
      cwd: harness.cwd,
    });
    await failOnLimit(harness, duplicate.id);
    const agentsBefore = agentCount(harness);

    await harness.sweep();

    expect(successorOf(harness, duplicate.id)).toBe(holder);
    expect(providerOf(harness, duplicate.id)).toBe("claude-backup");
    expect(providerOf(harness, holder)).toBe("claude");
    expect(agentCount(harness)).toBe(agentsBefore);
    expect(harness.prompts.claude.filter((prompt) => prompt.includes("Account handoff"))).toEqual(
      [],
    );
    // Done, not failed: nobody is told, and nothing is stranded.
    expect(failoverPushes(harness)).toEqual([]);
    expect(strandedObservations(harness)).toEqual([]);

    await harness.sweep();
    expect(successorOf(harness, duplicate.id)).toBe(holder);
    expect(failoverPushes(harness)).toEqual([]);
  }, 60_000);

  test("returns a child to a worker once one regains budget, only when idle, with no prompt", async () => {
    harness.setUsage([usageRow("claude-backup", [100])]);
    const child = await createChild(harness, {
      provider: "claude-personal",
      title: "Child",
      modeId: "default",
    });
    await failOnLimit(harness, child);
    await harness.sweep();
    // Both workers out: collapsed onto the leader account.
    expect(providerOf(harness, child)).toBe("claude");
    expect(homeOf(harness, child)).toBe("claude-personal");
    await settle(harness, child);

    // Hold it mid-turn on a permission prompt: a return is never worth interrupting a turn for.
    await harness.client.sendMessage(child, 'create a file named "hold.txt" with the content "x"');
    await expect
      .poll(() => managed(harness, child).pendingPermissions.size, { timeout: 10_000 })
      .toBe(1);
    windowHasReset(harness);
    harness.setUsage([usageRow("claude-personal", [100]), usageRow("claude-backup", [5])]);
    await harness.sweep();
    expect(providerOf(harness, child)).toBe("claude");

    const [permission] = harness.daemon.agentManager.getPendingPermissions(child);
    if (!permission) throw new Error("expected a pending permission to release");
    await harness.client.respondToPermission(child, permission.id, { behavior: "allow" });
    await settle(harness, child);
    const promptsBefore = harness.prompts["claude-backup"].length;

    // Its own worker is still out, and claude-backup has budget: any worker restores isolation.
    await harness.sweep();
    expect(providerOf(harness, child)).toBe("claude-backup");
    expect(harness.prompts["claude-backup"].slice(promptsBefore)).toEqual([]);
    expect(managed(harness, child).lifecycle).toBe("idle");
    expect(homeOf(harness, child)).toBeNull();
    expect(levelOf(harness, returnPushes(harness)[0])).toBe("record");
  }, 60_000);

  test("keeps a root on the leader account after the worker it came from recovers", async () => {
    const root = await createAgent(harness, { provider: "claude-backup", title: "Root" });
    await failOnLimit(harness, root);
    await harness.sweep();
    expect(providerOf(harness, root)).toBe("claude");
    await settle(harness, root);

    windowHasReset(harness);
    harness.setUsage([usageRow("claude-backup", [5]), usageRow("claude", [40])]);
    await harness.sweep();

    expect(providerOf(harness, root)).toBe("claude");
    expect(homeOf(harness, root)).toBeNull();
    expect(returnPushes(harness)).toEqual([]);
  }, 60_000);
});
