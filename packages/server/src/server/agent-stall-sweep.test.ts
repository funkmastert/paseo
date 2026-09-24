import { beforeEach, describe, expect, test } from "vitest";
import pino from "pino";

import {
  AgentStallSweep,
  type StallHandoffResult,
  type StallNudgeResult,
} from "./agent-stall-sweep.js";
import type { StallSweepAgentSummary } from "./agent/agent-manager.js";
import type { ProcessSampleRow } from "./agent/process-sampler.js";
import type { ProviderHealth } from "./agent-done-janitor.js";
import type { RemediationConfig } from "./remediation/config.js";
import type {
  RemediationObservation,
  RemediationSink,
  WorktreeSnapshotRequest,
  WorktreeSnapshotResult,
  WorktreeSnapshotter,
} from "./remediation/contract.js";

const logger = pino({ level: "silent" });
const MINUTE = 60_000;
const SWEEP = 5 * MINUTE;
const START = Date.parse("2026-09-24T12:00:00.000Z");

interface FakeAgent {
  summary: StallSweepAgentSummary;
  /** Cumulative CPU seconds of the agent's root process. */
  cpuSeconds: number;
  /** Added to `cpuSeconds` every sweep: 150 is 50% of one core over five minutes. */
  cpuSecondsPerSweep: number;
  /** No `callerAgentId` process at all. */
  noProcess?: boolean;
}

class Harness {
  nowMs = START;
  readonly agents = new Map<string, FakeAgent>();
  readonly observations: RemediationObservation[] = [];
  readonly snapshots: WorktreeSnapshotRequest[] = [];
  readonly nudges: Array<{ agentId: string; prompt: string }> = [];
  readonly handoffs: string[] = [];
  health = new Map<string, ProviderHealth>();
  config: RemediationConfig | undefined = undefined;
  psFails = false;
  snapshotResult: (request: WorktreeSnapshotRequest) => WorktreeSnapshotResult = (request) => ({
    kind: "snapshotted",
    worktreePath: request.cwd,
    ref: "refs/backup/2026-09-24/stuck",
    commit: "abc1234",
    dirtyFiles: 3,
    unpushedCommits: 1,
    skippedFiles: [],
    offsite: { kind: "none", reason: "test" },
  });
  nudgeResult: StallNudgeResult = { kind: "sent", via: "replace" };
  handoffResult: StallHandoffResult = { kind: "handed-off", lastError: "usage limit" };

  readonly sink: RemediationSink = {
    observe: async (observation) => {
      this.observations.push(observation);
    },
  };

  readonly snapshotter: WorktreeSnapshotter = {
    snapshot: async (request) => {
      this.snapshots.push(request);
      return this.snapshotResult(request);
    },
  };

  readonly sweep = new AgentStallSweep({
    dependencies: {
      listAgents: () => [...this.agents.values()].map((agent) => structuredClone(agent.summary)),
      sampleProcesses: async () => (this.psFails ? [] : this.psRows()),
      getProviderHealth: async (provider) => this.health.get(provider) ?? { askable: true },
      snapshotter: this.snapshotter,
      nudgeAgent: async (input) => {
        this.nudges.push(input);
        return this.nudgeResult;
      },
      handOffToFailover: async (agentId) => {
        this.handoffs.push(agentId);
        return this.handoffResult;
      },
    },
    sink: this.sink,
    readRemediationConfig: () => this.config,
    logger,
    now: () => this.nowMs,
  });

  add(
    id: string,
    overrides: Partial<StallSweepAgentSummary> = {},
    cpu: Partial<Omit<FakeAgent, "summary">> = {},
  ): FakeAgent {
    const agent: FakeAgent = {
      summary: {
        id,
        provider: "claude",
        cwd: `/work/${id}`,
        workspaceId: `ws-${id}`,
        internal: false,
        lifecycle: "running",
        busy: true,
        pendingPermissionCount: 0,
        requiresAttention: false,
        attentionReason: null,
        hasAlert: false,
        runningProviderSubagentCount: 0,
        lastActivityAt: new Date(START - 20 * 60 * MINUTE).toISOString(),
        labels: {},
        title: `Agent ${id}`,
        sessionId: `session-${id}`,
        quietTurn: false,
        usageFingerprint: "{}",
        runningSubagentActivityAt: [],
        ...overrides,
      },
      cpuSeconds: 100,
      cpuSecondsPerSweep: 0,
      ...cpu,
    };
    this.agents.set(id, agent);
    return agent;
  }

  private psRows(): ProcessSampleRow[] {
    const rows: ProcessSampleRow[] = [
      {
        pid: 1,
        ppid: 0,
        uid: 0,
        rssKb: 1,
        cpuPercent: 0,
        etime: "10-00:00:00",
        command: "launchd",
      },
    ];
    let pid = 100;
    for (const agent of this.agents.values()) {
      pid += 1;
      if (agent.noProcess) continue;
      rows.push({
        pid,
        ppid: 1,
        uid: 501,
        rssKb: 1000,
        // ps's lifetime average: deliberately high, so a test fails if it is ever trusted.
        cpuPercent: 90,
        etime: "1-00:00:00",
        cpuSeconds: agent.cpuSeconds,
        command: `claude --mcp-config http://127.0.0.1:6767/mcp?callerAgentId=${agent.summary.id}`,
      });
    }
    return rows;
  }

  /** Advances the clock one sweep interval, moves each process's CPU on, and sweeps. */
  async tick() {
    this.nowMs += SWEEP;
    for (const agent of this.agents.values()) agent.cpuSeconds += agent.cpuSecondsPerSweep;
    return this.sweep.tick();
  }

  /** Sweeps until the process trees have been sampled enough to be trusted. */
  async warmUp() {
    await this.sweep.tick();
    await this.tick();
    await this.tick();
  }

  observationsFor(agentId: string) {
    return this.observations.filter((entry) => entry.key === `stalled-agent:${agentId}`);
  }
}

let h: Harness;
beforeEach(() => {
  h = new Harness();
});

describe("a stalled agent on a healthy account", () => {
  test("is snapshotted, nudged once in a system envelope, and put on the ladder", async () => {
    h.add("a1");
    await h.warmUp();

    expect(h.snapshots).toEqual([
      expect.objectContaining({ cwd: "/work/a1", reason: expect.stringContaining("a1") }),
    ]);
    expect(h.nudges).toHaveLength(1);
    const prompt = h.nudges[0]?.prompt ?? "";
    expect(prompt).toMatch(/^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/);
    expect(prompt).toContain("no activity");
    expect(prompt).toMatch(/\d+ minutes/);
    expect(prompt).toContain("claude");
    expect(prompt).toContain("refs/backup/2026-09-24/stuck");
    expect(prompt).toContain("abc1234");
    expect(prompt).toContain("Resume from where you left off");
    expect(prompt).toMatch(/waiting on/);

    const [observation] = h.observationsFor("a1");
    expect(observation).toMatchObject({
      key: "stalled-agent:a1",
      kind: "stalled-agent",
      active: true,
      remedy: "live",
      graceMs: 20 * MINUTE,
      level: "alert",
      link: { agentId: "a1", workspaceId: "ws-a1" },
      escalation: { taskClass: "standard", cwd: "/work/a1" },
    });
    expect(observation?.escalation?.task).toContain("refs/backup/2026-09-24/stuck");
    expect(observation?.attempts?.map((attempt) => [attempt.remedy, attempt.outcome])).toEqual([
      ["snapshot", "acted"],
      ["nudge", "acted"],
    ]);
  });

  test("is nudged once per episode, and reported every sweep until it resumes", async () => {
    const agent = h.add("a1");
    await h.warmUp();
    await h.tick();
    await h.tick();
    expect(h.nudges).toHaveLength(1);
    expect(h.observationsFor("a1").map((entry) => entry.active)).toEqual([true, true, true]);

    // The nudge's own prompt row is not the agent resuming; output after it is.
    agent.summary.lastActivityAt = new Date(h.nowMs + 10 * MINUTE).toISOString();
    await h.tick();
    expect(h.observationsFor("a1").at(-1)).toMatchObject({ active: false, remedy: "live" });
    expect(h.observationsFor("a1").at(-1)?.attempts).toHaveLength(2);

    await h.tick();
    expect(h.observationsFor("a1")).toHaveLength(4);
  });

  test("the nudge's own prompt row does not close the episode", async () => {
    const agent = h.add("a1");
    await h.warmUp();
    agent.summary.lastActivityAt = new Date(h.nowMs + 1_000).toISOString();
    await h.tick();
    expect(h.observationsFor("a1").at(-1)).toMatchObject({ active: true });
  });

  test("an agent that leaves running closes its episode", async () => {
    const agent = h.add("a1");
    await h.warmUp();
    agent.summary.lifecycle = "idle";
    await h.tick();
    expect(h.observationsFor("a1").at(-1)).toMatchObject({ active: false });
  });

  test("snapshots off: nudged without one, and the attempt says so", async () => {
    h.config = { stalledAgents: { snapshot: false } };
    h.add("a1");
    await h.warmUp();
    expect(h.snapshots).toEqual([]);
    expect(h.nudges).toHaveLength(1);
    expect(h.observationsFor("a1")[0]?.attempts?.[0]).toMatchObject({
      remedy: "snapshot",
      outcome: "skipped",
    });
  });

  test("a failed snapshot is recorded and does not block the nudge", async () => {
    h.snapshotResult = () => ({ kind: "failed", worktreePath: null, error: "no snapshotter" });
    h.add("a1");
    await h.warmUp();
    expect(h.nudges).toHaveLength(1);
    expect(h.nudges[0]?.prompt).toContain("no snapshotter");
    expect(h.observationsFor("a1")[0]?.attempts?.[0]).toMatchObject({
      remedy: "snapshot",
      outcome: "failed",
    });
  });

  test("an agent that cannot be nudged goes on the ladder with no remedy", async () => {
    h.nudgeResult = { kind: "failed", error: "cancel refused; reload failed" };
    h.add("a1");
    await h.warmUp();
    await h.tick();
    expect(h.nudges).toHaveLength(1);
    const observation = h.observationsFor("a1").at(-1);
    expect(observation).toMatchObject({ active: true, remedy: "none" });
    expect(observation?.escalation?.task).toBeTruthy();
    expect(observation?.attempts?.at(-1)).toMatchObject({ remedy: "nudge", outcome: "failed" });
  });
});

describe("what is not a stall", () => {
  test("activity inside the threshold", async () => {
    h.add("a1", { lastActivityAt: new Date(START).toISOString() });
    await h.warmUp();
    expect(h.nudges).toEqual([]);
    expect(h.observations).toEqual([]);
  });

  test("a long build: the process tree is busy", async () => {
    h.add("a1", {}, { cpuSecondsPerSweep: 150 });
    await h.warmUp();
    await h.tick();
    expect(h.nudges).toEqual([]);
    expect(h.observations).toEqual([]);
  });

  test("ps's lifetime average is never trusted: the first two sweeps cannot act", async () => {
    h.add("a1");
    await h.sweep.tick();
    await h.tick();
    expect(h.nudges).toEqual([]);
    await h.tick();
    expect(h.nudges).toHaveLength(1);
  });

  test("a pending permission", async () => {
    h.add("a1", { pendingPermissionCount: 1 });
    await h.warmUp();
    expect(h.observations).toEqual([]);
  });

  test("the done janitor's quiet turn", async () => {
    h.add("a1", { quietTurn: true });
    await h.warmUp();
    expect(h.observations).toEqual([]);
  });

  test("token usage moving", async () => {
    const agent = h.add("a1");
    await h.sweep.tick();
    await h.tick();
    agent.summary.usageFingerprint = '{"outputTokens":5}';
    await h.tick();
    expect(h.nudges).toEqual([]);
  });

  test("an internal agent", async () => {
    h.add("a1", { internal: true });
    await h.warmUp();
    expect(h.observations).toEqual([]);
  });

  test("no attributable process reads as idle, as in the resource monitor", async () => {
    h.add("a1", {}, { noProcess: true });
    await h.warmUp();
    expect(h.nudges.map((nudge) => nudge.agentId)).toEqual(["a1"]);
  });

  test("nothing acts when ps returned nothing", async () => {
    h.psFails = true;
    h.add("a1");
    await h.warmUp();
    expect(h.nudges).toEqual([]);
  });
});

describe("a stalled agent on a capped account", () => {
  beforeEach(() => {
    h.health.set("claude-personal", { askable: false, reason: "account is at its usage cap" });
  });

  test("is handed to account failover after the shorter threshold, never nudged", async () => {
    h.add("a1", {
      provider: "claude-personal",
      lastActivityAt: new Date(START + 4 * MINUTE).toISOString(),
    });
    await h.warmUp();
    expect(h.handoffs).toEqual(["a1"]);
    expect(h.nudges).toEqual([]);
    const observation = h.observationsFor("a1").at(-1);
    expect(observation).toMatchObject({ active: true, remedy: "live", graceMs: 20 * MINUTE });
    expect(observation?.summary).toContain("usage cap");
    expect(observation?.attempts?.at(-1)).toMatchObject({ remedy: "handoff", outcome: "acted" });
  });

  test("inside the shorter threshold it waits", async () => {
    h.add("a1", {
      provider: "claude-personal",
      lastActivityAt: new Date(START + 12 * MINUTE).toISOString(),
    });
    await h.warmUp();
    expect(h.handoffs).toEqual([]);
  });

  test("a refused handoff leaves no remedy", async () => {
    h.handoffResult = { kind: "failed", error: "the session refused the cancel" };
    h.add("a1", { provider: "claude-personal" });
    await h.warmUp();
    expect(h.observationsFor("a1").at(-1)).toMatchObject({ remedy: "none" });
  });

  test("a healthy account inside the long threshold is not stalled at all", async () => {
    h.add("a1", { lastActivityAt: new Date(START + 4 * MINUTE).toISOString() });
    await h.warmUp();
    expect(h.observations).toEqual([]);
  });
});

describe("modes and limits", () => {
  test("dry run reports and touches nothing", async () => {
    h.config = { stalledAgents: { dryRun: true } };
    h.add("a1");
    await h.warmUp();
    await h.tick();
    expect(h.snapshots).toEqual([]);
    expect(h.nudges).toEqual([]);
    expect(h.observationsFor("a1").at(-1)).toMatchObject({ active: true, remedy: "dry-run" });
  });

  test("remedies off: detected and reported as disabled, touches nothing", async () => {
    h.config = { remedies: { enabled: false } };
    h.add("a1");
    await h.warmUp();
    expect(h.nudges).toEqual([]);
    expect(h.observationsFor("a1").at(-1)).toMatchObject({ active: true, remedy: "disabled" });
  });

  test("a dry-run episode acts once the sweep goes live", async () => {
    h.config = { stalledAgents: { dryRun: true } };
    h.add("a1");
    await h.warmUp();
    h.config = undefined;
    await h.tick();
    expect(h.nudges).toHaveLength(1);
  });

  test("at most maxNudgesPerSweep a sweep, longest stalled first; the rest wait a sweep", async () => {
    h.config = { stalledAgents: { maxNudgesPerSweep: 2 } };
    h.add("newest", { lastActivityAt: new Date(START - 2 * 60 * MINUTE).toISOString() });
    h.add("oldest", { lastActivityAt: new Date(START - 30 * 60 * MINUTE).toISOString() });
    h.add("middle", { lastActivityAt: new Date(START - 10 * 60 * MINUTE).toISOString() });
    await h.warmUp();
    expect(h.nudges.map((nudge) => nudge.agentId)).toEqual(["oldest", "middle"]);
    expect(h.observationsFor("newest").at(-1)).toMatchObject({ active: true, attempts: [] });
    await h.tick();
    expect(h.nudges.map((nudge) => nudge.agentId)).toEqual(["oldest", "middle", "newest"]);
  });

  test("no overlapping sweeps", async () => {
    h.add("a1");
    const [first, second] = await Promise.all([h.sweep.tick(), h.sweep.tick()]);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});
