import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountAuthReadingAt } from "../../services/quota-fetcher/service.js";
import type { PushPayload, PushSendMeta } from "../push/index.js";
import type { RemediationObservation, RemediationSink } from "../remediation/contract.js";
import { RemediationLadder, type RemediationLadderDependencies } from "../remediation/ladder.js";
import type { AccountFailoverAgentSummary } from "./agent-manager.js";
import { AccountAuthTracker } from "./account-auth-health.js";
import { AccountAuthProbe } from "./account-auth-probe.js";
import { AccountAuthSweep } from "./account-auth-sweep.js";
import type { PoolAccount } from "./account-pool-providers.js";

const T0 = Date.parse("2026-10-12T18:00:00.000Z");
const MIN = 60_000;
const silent = pino({ level: "silent" });
const OAUTH_EXPIRED = "Failed to authenticate: OAuth session expired and could not be refreshed";

const ACCOUNTS: PoolAccount[] = [
  { providerId: "claude", role: "leader", priority: 0, enabled: true, configDir: "/acct/leader" },
  {
    providerId: "claude-personal",
    role: "worker",
    priority: 1,
    enabled: true,
    configDir: "/acct/personal",
  },
  {
    providerId: "claude-backup",
    role: "worker",
    priority: 2,
    enabled: false,
    configDir: "/acct/backup",
  },
];

function agent(overrides: Partial<AccountFailoverAgentSummary> = {}): AccountFailoverAgentSummary {
  return {
    id: "agent-1",
    provider: "claude-personal",
    cwd: "/work",
    workspaceId: undefined,
    internal: false,
    lifecycle: "idle",
    lastError: undefined,
    title: null,
    busy: false,
    pendingPermissionCount: 0,
    runningProviderSubagentCount: 0,
    lastActivityAt: null,
    timelineSeq: null,
    lastTimelineAt: null,
    labels: {},
    sessionId: undefined,
    model: undefined,
    modeId: undefined,
    thinkingOptionId: undefined,
    ...overrides,
  };
}

/** A sweep with a recorded probe and a usage source the test writes readings into. */
function buildSweep(input: { now: () => number; sink: RemediationSink }) {
  const probeRuns: string[] = [];
  const readings = new Map<string, AccountAuthReadingAt>();
  const sweep = new AccountAuthSweep({
    tracker: new AccountAuthTracker(),
    probe: new AccountAuthProbe({
      logger: silent,
      runProcess: async (_command, _args, options) => {
        probeRuns.push(options.envOverlay["CLAUDE_CONFIG_DIR"] ?? "");
        return { stdout: "", stderr: "network error", exitCode: 1, timedOut: false };
      },
      resolveBinary: async () => "claude",
      scratchDir: () => tmpdir(),
      now: input.now,
    }),
    providerUsage: { getAuthReadings: () => new Map(readings) },
    remediationSink: input.sink,
    now: input.now,
  });
  return { sweep, probeRuns, readings };
}

class FleetWithoutAgents implements RemediationLadderDependencies {
  async createAgent(): Promise<{ agentId: string }> {
    throw new Error("a signed-out account has no remedy agent");
  }
  async inspectAgent() {
    return { status: "gone" as const };
  }
  async cancelAgent(): Promise<void> {}
  async archiveAgent(): Promise<void> {}
  async findAccountBlocker(): Promise<string | null> {
    return null;
  }
}

describe("AccountAuthSweep across a daemon restart", () => {
  let dir: string;
  let statePath: string;
  let nowMs: number;
  const pushes: Array<{ payload: PushPayload; meta: PushSendMeta | undefined }> = [];

  function ladder(): RemediationLadder {
    return new RemediationLadder({
      dependencies: new FleetWithoutAgents(),
      getPushNotificationSender: () => ({
        send: async (payload, meta) => {
          pushes.push({ payload, meta });
        },
      }),
      serverId: "srv",
      readDaemonConfig: () => ({}),
      statePath,
      logger: silent,
      now: () => nowMs,
      pollIntervalMs: 60 * 60 * MIN,
    });
  }

  const urgentPushes = () =>
    pushes.filter(
      (push) =>
        push.meta?.level === "urgent" &&
        push.meta.dedupeKey === "remediation:account-signed-out:claude-personal",
    );

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "account-auth-sweep-"));
    statePath = path.join(dir, "remediation", "state.json");
    nowMs = T0;
    pushes.length = 0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("closes the episode an earlier process left open, so the next sign-out pushes again", async () => {
    // The process before the restart: the account signs out and the ladder pushes once.
    const before = buildSweep({ now: () => nowMs, sink: ladder() });
    await before.sweep.observe({
      accounts: ACCOUNTS,
      agents: [agent({ lastError: OAUTH_EXPIRED, lastTimelineAt: new Date(T0).toISOString() })],
      nowMs,
    });
    expect(urgentPushes()).toHaveLength(1);

    // The daemon restarts. The ladder's episode is on disk; the sweep's memory of it is gone.
    // Someone signed the account back in while the daemon was down.
    nowMs = T0 + 30 * MIN;
    const after = buildSweep({ now: () => nowMs, sink: ladder() });
    after.readings.set("claude-personal", { reading: "ok", atMs: nowMs });
    await after.sweep.observe({ accounts: ACCOUNTS, agents: [], nowMs });

    // It signs out again later: a new episode, and a new push.
    nowMs += 30 * MIN;
    await after.sweep.observe({
      accounts: ACCOUNTS,
      agents: [agent({ lastError: OAUTH_EXPIRED, lastTimelineAt: new Date(nowMs).toISOString() })],
      nowMs,
    });
    expect(urgentPushes()).toHaveLength(2);
  });

  it("tells the ladder once, on its first sweep, that every account not signed out is fine", async () => {
    const observations: RemediationObservation[] = [];
    const { sweep } = buildSweep({
      now: () => nowMs,
      sink: { observe: async (observation) => void observations.push(observation) },
    });
    await sweep.observe({
      accounts: ACCOUNTS,
      agents: [
        agent({
          provider: "claude",
          lastError: OAUTH_EXPIRED,
          lastTimelineAt: new Date(T0).toISOString(),
        }),
      ],
      nowMs,
    });
    nowMs += MIN;
    await sweep.observe({ accounts: ACCOUNTS, agents: [], nowMs });

    expect(observations.map((o) => [o.key, o.active])).toEqual([
      ["account-signed-out:claude", true],
      // Disabled accounts too: an episode may predate the account being turned off.
      ["account-signed-out:claude-personal", false],
      ["account-signed-out:claude-backup", false],
    ]);
  });
});

describe("AccountAuthSweep evidence", () => {
  const quietSink: RemediationSink = { observe: async () => undefined };

  it("ignores a sign-in failure older than this process, and counts one after it", async () => {
    // An agent restored from storage still carries the error from before the restart.
    let nowMs = T0;
    const { sweep } = buildSweep({ now: () => nowMs, sink: quietSink });
    const stale = agent({
      lastError: OAUTH_EXPIRED,
      lastTimelineAt: new Date(T0 - 10 * MIN).toISOString(),
    });
    await sweep.observe({ accounts: ACCOUNTS, agents: [stale], nowMs });
    expect(sweep.isSignedOut("claude-personal")).toBe(false);

    nowMs += MIN;
    const fresh = agent({
      lastError: OAUTH_EXPIRED,
      lastTimelineAt: new Date(nowMs).toISOString(),
    });
    await sweep.observe({ accounts: ACCOUNTS, agents: [fresh], nowMs });
    expect(sweep.isSignedOut("claude-personal")).toBe(true);
  });

  it("never probes an account while restart recovery is about to resume a turn on it", async () => {
    const nowMs = T0;
    const { sweep, probeRuns, readings } = buildSweep({ now: () => nowMs, sink: quietSink });
    readings.set("claude-personal", { reading: "rejected_expired", atMs: nowMs });
    // Idle now, but recovery has claimed it and will send its resume prompt any moment.
    const resuming = agent({ id: "resuming", lifecycle: "idle" });

    await sweep.observe({
      accounts: ACCOUNTS,
      agents: [resuming],
      isClaimedByRestartRecovery: (agentId) => agentId === "resuming",
      nowMs,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(probeRuns).toEqual([]);
  });
});
