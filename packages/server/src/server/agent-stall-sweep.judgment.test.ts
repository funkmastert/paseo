import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";

import {
  AgentStallSweep,
  resumeIdleAgentWaitingOnBackground,
  type IdleResumeResult,
} from "./agent-stall-sweep.js";
import type { AgentManager, StallSweepAgentSummary } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { AgentTimelineItem } from "./agent/agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent/agent-timeline-store-types.js";
import type { ProcessSampleRow } from "./agent/process-sampler.js";
import { createJevStallJudge, MAX_JUDGMENTS_PER_AGENT_PER_HOUR } from "./agent/stall-judgment.js";
import type { StallMeasurementLine } from "./agent/stall-judgment-log.js";
import type { ProviderHealth } from "./agent-done-janitor.js";
import { createTestJevService, type JevFakeBehavior, type JevScriptedAnswer } from "./jev/fake.js";
import type { RemediationConfig } from "./remediation/config.js";
import type { RemediationObservation } from "./remediation/contract.js";

/**
 * Feature 10 in the stalled-agent sweep (docs/jev.md, "Feature 10: stall judgment"), and the
 * code-only rule for idle agents waiting on background work (docs/stalled-agents.md). The JEV side
 * is the real service over the fake transport; nothing leaves the machine.
 */

const logger = pino({ level: "silent" });
const MINUTE = 60_000;
const SWEEP = 5 * MINUTE;
const START = Date.parse("2026-09-29T12:00:00.000Z");

interface FakeAgent {
  summary: StallSweepAgentSummary;
  cpuSeconds: number;
  cpuSecondsPerSweep: number;
  /** Commands of processes under the agent's root, e.g. a background shell. */
  children: string[];
  /** False: no process carries its id, as for Codex's app-server. */
  attributable: boolean;
}

interface HarnessOptions {
  answers?: Record<string, JevScriptedAnswer>;
  behavior?: JevFakeBehavior;
  /** `agents.jev`. Shadow stays on unless it says. */
  jev?: Record<string, unknown>;
  /** No judge at all: today's sweep. */
  noJudge?: boolean;
  /** The background-wait rule live; absent: `BACKGROUND_WAIT_LIVE`, as in production. */
  backgroundWaitLive?: boolean;
}

const ANSWERED = { stallJudgment: { shadow: false } };

function choice(label: string, confidence: number): Record<string, JevScriptedAnswer> {
  return { activity: { type: "choice", choice: label, confidence } };
}

class Harness {
  nowMs = START;
  readonly root = mkdtempSync(path.join(os.tmpdir(), "stall-sweep-judgment-"));
  readonly agents = new Map<string, FakeAgent>();
  readonly timelines = new Map<string, AgentTimelineRow[]>();
  readonly observations: RemediationObservation[] = [];
  readonly nudges: Array<{ agentId: string; prompt: string }> = [];
  readonly handoffs: string[] = [];
  readonly idleResumes: Array<{ agentId: string; prompt: string }> = [];
  readonly lines: StallMeasurementLine[] = [];
  readonly lastErrors = new Map<string, string>();
  readonly scheduled = new Set<string>();
  readonly claimedByRecovery = new Set<string>();
  readonly sessionFamilies = new Map<string, string>();
  health = new Map<string, ProviderHealth>();
  config: RemediationConfig | undefined = undefined;
  loopWatch = true;
  idleResult: IdleResumeResult = { kind: "sent" };
  readonly jev: ReturnType<typeof createTestJevService>;
  readonly sweep: AgentStallSweep;

  constructor(options: HarnessOptions = {}) {
    this.jev = createTestJevService({
      answers: options.answers ?? choice("other", 0.9),
      behavior: options.behavior,
      paseoHome: path.join(this.root, "paseo"),
      homeDir: this.root,
      config: options.jev,
      service: {
        now: () => this.nowMs,
        resolveAgentCwds: async (ids) => {
          const cwds = ids.map((id) => this.agents.get(id)?.summary.cwd);
          return cwds.every((cwd) => cwd !== undefined) ? (cwds as string[]) : null;
        },
      },
    });
    const judge = options.noJudge
      ? undefined
      : createJevStallJudge({
          jev: this.jev,
          readLoopWatch: () => this.loopWatch,
          now: () => this.nowMs,
        });
    this.sweep = new AgentStallSweep({
      dependencies: {
        listAgents: () => [...this.agents.values()].map((agent) => structuredClone(agent.summary)),
        sampleProcesses: async () => this.psRows(),
        getProviderHealth: async (provider) => this.health.get(provider) ?? { askable: true },
        snapshotter: {
          snapshot: async (request) => ({
            kind: "nothing-at-risk",
            worktreePath: request.cwd,
          }),
        },
        nudgeAgent: async (input) => {
          this.nudges.push(input);
          return { kind: "sent", via: "replace" };
        },
        handOffToFailover: async (agentId) => {
          this.handoffs.push(agentId);
          return { kind: "handed-off", lastError: "usage limit" };
        },
        readRecentActivity: (agentId, limit) => (this.timelines.get(agentId) ?? []).slice(-limit),
        readAssignment: (agentId) => {
          const first = this.timelines.get(agentId)?.[0]?.item;
          return first?.type === "user_message" ? first.text : null;
        },
        judgeStall: judge,
        readLastError: (agentId) => this.lastErrors.get(agentId),
        resumeIdleAgent: async (input) => {
          this.idleResumes.push(input);
          return this.idleResult;
        },
        recordMeasurement: (line) => this.lines.push(line),
        listScheduledAgentIds: async () => this.scheduled,
        isClaimedByRestartRecovery: (agentId) => this.claimedByRecovery.has(agentId),
        readSessionFamily: (agentId) => this.sessionFamilies.get(agentId),
      },
      sink: { observe: async (observation) => void this.observations.push(observation) },
      readRemediationConfig: () => this.config,
      logger,
      now: () => this.nowMs,
      backgroundWaitLive: options.backgroundWaitLive,
    });
  }

  add(
    id: string,
    overrides: Partial<StallSweepAgentSummary> = {},
    process: Partial<Omit<FakeAgent, "summary">> = {},
  ): FakeAgent {
    const cwd = path.join(this.root, "work", id);
    mkdirSync(cwd, { recursive: true });
    const agent: FakeAgent = {
      summary: {
        id,
        provider: "claude",
        cwd,
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
      children: [],
      attributable: true,
      ...process,
    };
    this.agents.set(id, agent);
    if (!this.timelines.has(id)) this.timelines.set(id, [userRow(`Do the task for ${id}`)]);
    return agent;
  }

  /**
   * An agent idle since `quietMinutes` ago whose last message is `message`. Its final turn ran
   * `turn`: by default a background shell, which makes the wait its own work.
   */
  addIdle(
    id: string,
    message: string,
    quietMinutes: number,
    overrides: Partial<StallSweepAgentSummary> = {},
    turn: AgentTimelineRow[] = [backgroundBashRow("npm run gate")],
  ) {
    const agent = this.add(id, {
      lifecycle: "idle",
      busy: false,
      lastActivityAt: new Date(this.nowMs - quietMinutes * MINUTE).toISOString(),
      ...overrides,
    });
    this.timelines.set(id, [userRow("Ship the fix"), ...turn, assistantRow(message)]);
    return agent;
  }

  timeline(id: string, rows: AgentTimelineRow[]): void {
    this.timelines.set(id, [userRow(`Do the task for ${id}`), ...rows]);
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
      pid += 10;
      if (!agent.attributable) continue;
      const rootPid = pid;
      rows.push({
        pid: rootPid,
        ppid: 1,
        uid: 501,
        rssKb: 1000,
        cpuPercent: 90,
        etime: "1-00:00:00",
        cpuSeconds: agent.cpuSeconds,
        command: `claude --mcp-config http://127.0.0.1:6767/mcp?callerAgentId=${agent.summary.id}`,
      });
      agent.children.forEach((command, index) => {
        rows.push({
          pid: rootPid + 1 + index,
          ppid: rootPid,
          uid: 501,
          rssKb: 10,
          cpuPercent: 0,
          etime: "00:10",
          cpuSeconds: 0,
          command,
        });
      });
    }
    return rows;
  }

  async tick() {
    this.nowMs += SWEEP;
    for (const agent of this.agents.values()) agent.cpuSeconds += agent.cpuSecondsPerSweep;
    return this.sweep.tick();
  }

  /** Three sweeps: the first stall acts on the third. */
  async warmUp() {
    await this.sweep.tick();
    await this.tick();
    return this.tick();
  }

  stallObservations(agentId: string) {
    return this.observations.filter((entry) => entry.key === `stalled-agent:${agentId}`);
  }

  loopObservations(agentId: string) {
    return this.observations.filter((entry) => entry.key === `looping-agent:${agentId}`);
  }

  linesOf<T extends StallMeasurementLine["type"]>(type: T) {
    return this.lines.filter(
      (line): line is Extract<StallMeasurementLine, { type: T }> => line.type === type,
    );
  }
}

let seq = 0;
let callSeq = 0;
function row(item: AgentTimelineItem): AgentTimelineRow {
  seq += 1;
  return { seq, timestamp: new Date(START + seq).toISOString(), item };
}
function userRow(text: string) {
  return row({ type: "user_message", text });
}
function assistantRow(text: string) {
  return row({ type: "assistant_message", text });
}
function bashRow(
  command: string,
  status: "running" | "completed" | "failed" = "completed",
  output?: string,
) {
  callSeq += 1;
  const base = {
    type: "tool_call" as const,
    callId: `call-${callSeq}`,
    name: "Bash",
    detail: { type: "shell" as const, command, ...(output ? { output } : {}) },
  };
  return status === "failed"
    ? row({ ...base, status, error: "3 tests failed" })
    : row({ ...base, status, error: null });
}
/** A `run_in_background` Bash call, as Claude answers it. */
function backgroundBashRow(command: string) {
  return bashRow(
    command,
    "completed",
    `Command running in background with ID: b${callSeq}. Output is being written to: /private/tmp/claude-501/x/tasks/b${callSeq}.output`,
  );
}
function toolRow(name: string) {
  callSeq += 1;
  return row({
    type: "tool_call",
    callId: `call-${callSeq}`,
    name,
    detail: { type: "unknown", input: {}, output: null },
    status: "completed",
    error: null,
  });
}
function repeated(command: string, times: number) {
  return Array.from({ length: times }, () => bashRow(command, "failed"));
}

function actions(lines: readonly { action: string }[]): string[] {
  return lines.map((line) => line.action);
}
function agentIds(entries: readonly { agentId: string }[]): string[] {
  return entries.map((entry) => entry.agentId);
}

/** The prompt a stall gets from today's sweep, with no judge at all. */
async function todaysPrompt(): Promise<string> {
  const h = new Harness({ noJudge: true });
  h.add("a1");
  await h.warmUp();
  return h.nudges[0]?.prompt ?? "";
}

describe("a stall candidate's judgment", () => {
  test("progressing with a tool call running holds one stall window, then nudges as today", async () => {
    const h = new Harness({ jev: ANSWERED, answers: choice("progressing", 0.9) });
    h.add("a1");
    h.timeline("a1", [
      assistantRow("Running the full build."),
      bashRow("npm run build", "running"),
    ]);
    const report = await h.warmUp();
    expect(h.nudges).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({ agentId: "a1", action: "held" }),
    );
    // The ladder adds the hold to its grace, an override's included, so its recheck still starts
    // from the nudge.
    expect(h.stallObservations("a1").at(-1)).toMatchObject({
      active: true,
      graceMs: 20 * MINUTE,
      holdMs: 30 * MINUTE,
    });

    for (let sweep = 0; sweep < 5; sweep += 1) await h.tick();
    expect(h.nudges).toEqual([]);
    await h.tick();
    expect(h.nudges).toHaveLength(1);
    expect(h.nudges[0]?.prompt).not.toContain("You appear");
    // Asked once per episode.
    expect(h.jev.transport.calls).toHaveLength(1);
  });

  test("progressing with nothing running nudges at once", async () => {
    const h = new Harness({ jev: ANSWERED, answers: choice("progressing", 0.95) });
    h.add("a1");
    h.timeline("a1", [bashRow("npm run build"), assistantRow("Build done; next I will")]);
    await h.warmUp();
    expect(h.nudges).toHaveLength(1);
  });

  test("an agent that moves during the hold closes the episode, and the measurement says so", async () => {
    const h = new Harness({ jev: ANSWERED, answers: choice("progressing", 0.9) });
    const agent = h.add("a1");
    h.timeline("a1", [bashRow("npm run build", "running")]);
    await h.warmUp();
    agent.summary.lastActivityAt = new Date(h.nowMs + MINUTE).toISOString();
    await h.tick();
    expect(h.nudges).toEqual([]);
    expect(h.stallObservations("a1").at(-1)).toMatchObject({ active: false });
    expect(h.linesOf("episode-closed")).toEqual([
      expect.objectContaining({
        episodeKey: "stalled-agent:a1",
        acted: null,
        held: true,
        closedDuringHold: true,
        judgment: { activity: "progressing", confidence: 0.9, applied: true },
      }),
    ]);
  });

  test("blocked on missing information: the nudge asks what is missing and the ladder is asked for a person first", async () => {
    const h = new Harness({ jev: ANSWERED, answers: choice("blocked_missing_info", 0.82) });
    h.add("a1");
    h.timeline("a1", [assistantRow("I need the staging credentials to continue.")]);
    await h.warmUp();
    expect(h.nudges).toHaveLength(1);
    expect(h.nudges[0]?.prompt).toContain("Name exactly what you are missing");
    expect(h.stallObservations("a1").at(-1)?.escalation?.personFirst).toEqual({
      reason: expect.stringContaining("blocked on missing information (0.82)"),
      confidence: 0.82,
    });
  });

  test("waiting on a person: the nudge says to end the turn with the question; person first", async () => {
    const h = new Harness({ jev: ANSWERED, answers: choice("waiting_on_human", 0.9) });
    h.add("a1");
    await h.warmUp();
    expect(h.nudges[0]?.prompt).toContain("end your turn with the question");
    expect(h.stallObservations("a1").at(-1)?.escalation?.personFirst?.confidence).toBe(0.9);
  });

  test("looping: the nudge names the repeated step, and no person first", async () => {
    const h = new Harness({ jev: ANSWERED, answers: choice("looping", 0.8) });
    h.add("a1");
    h.timeline("a1", repeated("npm test -- auth", 4));
    await h.warmUp();
    expect(h.nudges[0]?.prompt).toContain(
      "You appear to be repeating: tool Bash `npm test -- auth`.",
    );
    expect(h.stallObservations("a1").at(-1)?.escalation?.personFirst).toBeUndefined();
  });

  test("shadow by default: nudged exactly as today, and the would-be action recorded", async () => {
    const h = new Harness({ answers: choice("blocked_missing_info", 0.9) });
    h.add("a1");
    await h.warmUp();
    expect(h.nudges[0]?.prompt).toBe(await todaysPrompt());
    expect(h.stallObservations("a1").at(-1)?.escalation?.personFirst).toBeUndefined();
    expect(h.jev.transport.calls).toHaveLength(1);
    expect(h.jev.listDecisions("a1")).toEqual([
      expect.objectContaining({
        feature: "stallJudgment",
        verdict: "blocked_missing_info (0.90)",
        applied: false,
        action: expect.stringMatching(/^would have: .*person first/),
      }),
    ]);
    expect(h.linesOf("judgment")).toEqual([
      expect.objectContaining({
        branch: "candidate",
        episodeKey: "stalled-agent:a1",
        judgment: { activity: "blocked_missing_info", confidence: 0.9, applied: false },
        action: "nudged as today",
        costUsd: 0,
      }),
    ]);
  });

  test.each([
    ["a timeout", { behavior: { kind: "timeout" } as JevFakeBehavior, jev: ANSWERED }],
    [
      "an HTTP error",
      { behavior: { kind: "http", status: 503 } as JevFakeBehavior, jev: ANSWERED },
    ],
    [
      "a malformed answer",
      { behavior: { kind: "contract-violation" } as JevFakeBehavior, jev: ANSWERED },
    ],
    ["JEV switched off", { jev: { enabled: false } }],
    ["a low-confidence answer", { jev: ANSWERED, answers: choice("blocked_missing_info", 0.6) }],
  ])("fails open on %s: today's nudge, word for word", async (_name, options) => {
    const h = new Harness({ answers: choice("blocked_missing_info", 0.95), ...options });
    h.add("a1");
    await h.warmUp();
    expect(h.nudges).toHaveLength(1);
    expect(h.nudges[0]?.prompt).toBe(await todaysPrompt());
    expect(h.stallObservations("a1").at(-1)?.escalation?.personFirst).toBeUndefined();
  });

  test("an agent in company code is never sent, and is nudged as today (D7)", async () => {
    const h = new Harness({ jev: ANSWERED, answers: choice("blocked_missing_info", 0.95) });
    const agent = h.add("a1");
    agent.summary.cwd = path.join(h.root, "mobile-worktrees", "feature");
    mkdirSync(agent.summary.cwd, { recursive: true });
    await h.warmUp();
    expect(h.jev.transport.calls).toHaveLength(0);
    expect(h.nudges).toHaveLength(1);
    expect(h.nudges[0]?.prompt).not.toContain("You appear");
    expect(h.linesOf("judgment")[0]).toMatchObject({ reason: "excluded", callId: null });
  });

  test("a capped account's handoff is never judged", async () => {
    const h = new Harness({ jev: ANSWERED, answers: choice("blocked_missing_info", 0.95) });
    h.health.set("claude", { askable: false, reason: "at its weekly limit" });
    h.add("a1");
    await h.warmUp();
    expect(h.handoffs).toEqual(["a1"]);
    expect(h.jev.transport.calls).toHaveLength(0);
  });

  test("a dry-run sweep asks nothing", async () => {
    const h = new Harness({ jev: ANSWERED });
    h.config = { stalledAgents: { dryRun: true } };
    h.add("a1");
    await h.warmUp();
    expect(h.jev.transport.calls).toHaveLength(0);
  });

  test("the episode's close records its outcome beside the label, past the recheck or not", async () => {
    const h = new Harness({ answers: choice("waiting_on_human", 0.9) });
    const agent = h.add("a1");
    await h.warmUp();
    for (let sweep = 0; sweep < 5; sweep += 1) await h.tick();
    agent.summary.lifecycle = "idle";
    await h.tick();
    expect(h.linesOf("episode-closed")).toEqual([
      expect.objectContaining({
        why: "left running",
        acted: "nudge",
        minutesAfterAct: 30,
        pastRecheck: true,
        held: false,
        judgment: { activity: "waiting_on_human", confidence: 0.9, applied: false },
        personFirst: false,
      }),
    ]);
  });
});

describe("the loop watch", () => {
  /** A busy agent, so never a stall candidate, repeating one failing command. */
  function busyLooper(h: Harness, times = 4) {
    const agent = h.add(
      "a1",
      { lastActivityAt: new Date(START).toISOString() },
      { cpuSecondsPerSweep: 150 },
    );
    h.timeline("a1", repeated("npm test -- auth", times));
    return agent;
  }

  test("two looping answers in a row put a looping-agent notice on the ladder; nothing interrupts it", async () => {
    const h = new Harness({ jev: ANSWERED, answers: choice("looping", 0.85) });
    busyLooper(h);
    await h.sweep.tick();
    expect(h.loopObservations("a1")).toEqual([]);
    const report = await h.tick();
    expect(report?.entries).toContainEqual(
      expect.objectContaining({ agentId: "a1", action: "looping" }),
    );
    expect(h.loopObservations("a1")).toEqual([
      expect.objectContaining({
        kind: "looping-agent",
        active: true,
        remedy: "none",
        level: "notice",
        graceMs: 0,
      }),
    ]);
    // No agent can help: the ladder records it for the digest.
    expect(h.loopObservations("a1")[0]).not.toHaveProperty("escalation");
    expect(h.nudges).toEqual([]);
    expect(h.handoffs).toEqual([]);
    expect(h.jev.transport.calls).toHaveLength(2);

    // Reported: not asked again while the same repeat holds; the ladder hears it every sweep.
    await h.tick();
    expect(h.jev.transport.calls).toHaveLength(2);
    expect(h.loopObservations("a1").map((entry) => entry.active)).toEqual([true, true]);

    // The repeat stops: the episode closes.
    h.timeline("a1", [bashRow("npm test -- auth --fixture-reset")]);
    await h.tick();
    expect(h.loopObservations("a1").at(-1)).toMatchObject({ active: false });
    expect(h.linesOf("loop-closed")).toEqual([
      expect.objectContaining({ why: "the repeat stopped", applied: true, minutesOpen: 10 }),
    ]);
  });

  test("a looping answer under 0.80 does not count", async () => {
    const h = new Harness({ jev: ANSWERED, answers: choice("looping", 0.79) });
    busyLooper(h);
    await h.sweep.tick();
    await h.tick();
    await h.tick();
    expect(h.loopObservations("a1")).toEqual([]);
  });

  test("in shadow it only records what it would have reported", async () => {
    const h = new Harness({ answers: choice("looping", 0.9) });
    busyLooper(h);
    await h.sweep.tick();
    await h.tick();
    expect(h.loopObservations("a1")).toEqual([]);
    expect(h.linesOf("loop-reported")).toEqual([
      expect.objectContaining({ applied: false, step: "tool Bash `npm test -- auth`", count: 4 }),
    ]);
    expect(h.linesOf("judgment").map((line) => line.branch)).toEqual(["loop-watch", "loop-watch"]);
  });

  test("after progressing, the same repeat is left alone for 30 minutes; a new repeat is asked at once", async () => {
    const h = new Harness({ jev: ANSWERED, answers: choice("progressing", 0.6) });
    busyLooper(h);
    await h.sweep.tick();
    expect(h.jev.transport.calls).toHaveLength(1);
    for (let sweep = 0; sweep < 5; sweep += 1) await h.tick();
    expect(h.jev.transport.calls).toHaveLength(1);
    h.timeline("a1", repeated("npm run lint", 4));
    await h.tick();
    expect(h.jev.transport.calls).toHaveLength(2);
  });

  test("the prefilter asks nothing when nothing repeats, and known pollers do not count", async () => {
    const h = new Harness({ jev: ANSWERED, answers: choice("looping", 0.95) });
    busyLooper(h);
    h.timeline("a1", [
      ...Array.from({ length: 6 }, () => bashRow("gh run watch 42")),
      bashRow("ls"),
    ]);
    await h.sweep.tick();
    await h.tick();
    expect(h.jev.transport.calls).toHaveLength(0);
  });

  test("switched off, it asks nothing", async () => {
    const h = new Harness({ jev: ANSWERED, answers: choice("looping", 0.95) });
    h.loopWatch = false;
    busyLooper(h);
    await h.sweep.tick();
    await h.tick();
    expect(h.jev.transport.calls).toHaveLength(0);
  });

  test.each([
    ["other", choice("other", 0.9)],
    ["waiting on a person", choice("waiting_on_human", 0.9)],
    ["looping under 0.80", choice("looping", 0.79)],
  ])("after %s, the same repeat is left alone for 30 minutes too", async (_name, answers) => {
    const h = new Harness({ jev: ANSWERED, answers });
    busyLooper(h);
    await h.sweep.tick();
    for (let sweep = 0; sweep < 5; sweep += 1) await h.tick();
    expect(h.jev.transport.calls).toHaveLength(1);
    await h.tick();
    expect(h.jev.transport.calls).toHaveLength(2);
  });

  test("a looping agent cannot spend past its hourly cap", async () => {
    const h = new Harness({ jev: ANSWERED, answers: choice("other", 0.9) });
    busyLooper(h);
    await h.sweep.tick();
    // A repeat that changes every sweep is asked about every sweep.
    for (let sweep = 0; sweep < 11; sweep += 1) {
      h.timeline("a1", repeated(`npm test -- step${sweep}`, 4));
      await h.tick();
    }
    expect(h.jev.transport.calls).toHaveLength(MAX_JUDGMENTS_PER_AGENT_PER_HOUR);
    expect(
      h.linesOf("judgment").filter((line) => line.reason === "agent-hourly-cap").length,
    ).toBeGreaterThan(0);
  });

  test("asks at most 8 agents a sweep", async () => {
    const h = new Harness({ jev: ANSWERED, answers: choice("other", 0.9) });
    for (let index = 0; index < 10; index += 1) {
      const id = `a${index}`;
      h.add(id, { lastActivityAt: new Date(START).toISOString() }, { cpuSecondsPerSweep: 150 });
      h.timeline(id, repeated(`npm test -- ${id}`, 4));
    }
    await h.sweep.tick();
    expect(h.jev.transport.calls).toHaveLength(8);
  });
});

describe("an idle agent nothing will wake", () => {
  const WAIT = "The full gate is running in the background; I'll report back when it finishes.";
  const CI_WAIT =
    "[#6722](https://github.com/acme/mobile/pull/6722) is up; it's waiting on CI before I merge it.";
  const LIVE = { backgroundWaitLive: true };
  /** A final turn that ran only foreground commands: no background work of its own. */
  const FOREGROUND = () => [bashRow("git push", "completed", "pushed")];

  describe("record-only (BACKGROUND_WAIT_LIVE is false)", () => {
    test("records would-resume and sends nothing, with dryRun off", async () => {
      const h = new Harness();
      h.addIdle("a1", WAIT, 12);
      const report = await h.sweep.tick();
      await h.tick();
      expect(h.idleResumes).toEqual([]);
      expect(report?.entries).toContainEqual({
        agentId: "a1",
        action: "would-resume-idle",
        detail: `own-work: ${WAIT}`,
      });
      expect(h.linesOf("background-wait")).toEqual([
        expect.objectContaining({
          agentId: "a1",
          waitClass: "own-work",
          action: "would-resume",
          quietMinutes: 12,
          quote: WAIT,
          launched: ["a background shell"],
          target: null,
        }),
      ]);
    });

    test("records an external wait nothing watches", async () => {
      const h = new Harness();
      h.addIdle("a1", CI_WAIT, 16, {}, FOREGROUND());
      await h.sweep.tick();
      expect(h.idleResumes).toEqual([]);
      expect(h.linesOf("background-wait")).toEqual([
        expect.objectContaining({
          waitClass: "external-wait",
          action: "would-resume",
          target: "CI",
          launched: [],
        }),
      ]);
    });
  });

  describe("live", () => {
    test("own work: one prompt to check the result, and no JEV call", async () => {
      const h = new Harness({ jev: ANSWERED, ...LIVE });
      h.addIdle("a1", WAIT, 12);
      const report = await h.sweep.tick();
      expect(h.idleResumes).toHaveLength(1);
      const prompt = h.idleResumes[0]?.prompt ?? "";
      expect(prompt).toMatch(/^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/);
      expect(prompt).toContain(`"${WAIT}"`);
      expect(prompt).toContain("started background work (a background shell)");
      expect(prompt).toContain("Check the result");
      expect(report?.entries).toContainEqual({
        agentId: "a1",
        action: "resumed-idle",
        detail: `own-work: ${WAIT}`,
      });
      expect(h.jev.transport.calls).toHaveLength(0);
      expect(h.linesOf("background-wait")).toEqual([
        expect.objectContaining({ agentId: "a1", action: "resumed", waitClass: "own-work" }),
      ]);
    });

    test("an external wait: one prompt saying nothing is watching it", async () => {
      const h = new Harness(LIVE);
      h.addIdle("a1", CI_WAIT, 16, {}, FOREGROUND());
      await h.sweep.tick();
      expect(h.idleResumes[0]?.prompt).toContain("Nothing is watching CI");
    });

    test("works with JEV off: it is code only", async () => {
      const h = new Harness({ jev: { enabled: false }, ...LIVE });
      h.addIdle("a1", WAIT, 12);
      await h.sweep.tick();
      expect(h.idleResumes).toHaveLength(1);
    });

    test("once per final message, and at most 3 a day", async () => {
      const h = new Harness(LIVE);
      const agent = h.addIdle("a1", WAIT, 12);
      await h.sweep.tick();
      await h.tick();
      expect(h.idleResumes).toHaveLength(1);

      for (let round = 0; round < 3; round += 1) {
        // It resumed, started the gate again, and ended its turn the same way.
        h.timelines
          .get("a1")
          ?.push(userRow("resume"), backgroundBashRow("npm run gate"), assistantRow(WAIT));
        agent.summary.lastActivityAt = new Date(h.nowMs - 11 * MINUTE).toISOString();
        await h.tick();
      }
      expect(h.idleResumes).toHaveLength(3);
      expect(actions(h.linesOf("background-wait"))).toEqual([
        "resumed",
        "resumed",
        "resumed",
        "capped",
      ]);
    });

    test("a dry-run sweep only records it, once", async () => {
      const h = new Harness(LIVE);
      h.config = { stalledAgents: { dryRun: true } };
      h.addIdle("a1", WAIT, 12);
      const report = await h.sweep.tick();
      await h.tick();
      expect(h.idleResumes).toEqual([]);
      expect(report?.entries).toContainEqual(
        expect.objectContaining({ action: "would-resume-idle" }),
      );
      expect(actions(h.linesOf("background-wait"))).toEqual(["would-resume"]);
    });

    test("shares the sweep's nudge budget, after the stalls", async () => {
      const h = new Harness({ noJudge: true, ...LIVE });
      h.config = { stalledAgents: { maxNudgesPerSweep: 1 } };
      h.add("stuck");
      await h.sweep.tick();
      await h.tick();
      h.addIdle("a1", WAIT, 12);
      await h.tick();
      expect(agentIds(h.nudges)).toEqual(["stuck"]);
      expect(h.idleResumes).toEqual([]);
      await h.tick();
      expect(h.idleResumes).toHaveLength(1);
    });

    test("a resume the agent refused is not counted against the day", async () => {
      const h = new Harness(LIVE);
      h.idleResult = { kind: "skipped", reason: "no longer idle" };
      h.addIdle("a1", WAIT, 12);
      await h.sweep.tick();
      expect(h.linesOf("background-wait")).toEqual([
        expect.objectContaining({ action: "skipped", detail: "no longer idle" }),
      ]);
    });
  });

  test("a disabled sweep leaves it alone", async () => {
    const h = new Harness(LIVE);
    h.config = { stalledAgents: { enabled: false } };
    h.addIdle("a1", WAIT, 12);
    await h.sweep.tick();
    expect(h.idleResumes).toEqual([]);
    expect(h.linesOf("background-wait")).toEqual([]);
  });

  test("waits while a shell still runs under it, and records it once the shell ends", async () => {
    const h = new Harness();
    const agent = h.addIdle("a1", WAIT, 12);
    agent.children = [
      "/bin/zsh -c source ~/.claude/shell-snapshots/snapshot.sh && eval 'npm run gate'",
    ];
    await h.sweep.tick();
    expect(h.linesOf("background-wait")).toEqual([]);
    agent.children = ["<defunct>"];
    await h.tick();
    expect(h.linesOf("background-wait")).toHaveLength(1);
  });

  test("waits while Git Bash runs under a Windows agent", async () => {
    const h = new Harness();
    const agent = h.addIdle("a1", WAIT, 12);
    agent.children = ['"C:\\Program Files\\Git\\bin\\bash.exe" -c "npm run gate"'];
    await h.sweep.tick();
    expect(h.linesOf("background-wait")).toEqual([]);
  });

  test("is left alone before 10 quiet minutes", async () => {
    const h = new Harness();
    h.addIdle("a1", WAIT, 9);
    await h.sweep.tick();
    expect(h.linesOf("background-wait")).toEqual([]);
  });

  test.each([
    ["a provider subagent still runs", { runningProviderSubagentCount: 1 }],
    ["a permission is pending", { pendingPermissionCount: 1 }],
    ["it is busy", { busy: true }],
    ["it is internal", { internal: true }],
    [
      "account failover retired it: its successor carries the work",
      { labels: { "paseo.account-failover.migrated-to": "a2" } },
    ],
  ])("is left alone when %s", async (_name, overrides) => {
    const h = new Harness();
    h.addIdle("a1", WAIT, 12, overrides);
    await h.sweep.tick();
    expect(h.linesOf("background-wait")).toEqual([]);
  });

  test("is left alone when its last turn failed: that is account failover's or a person's", async () => {
    const h = new Harness();
    h.addIdle("a1", WAIT, 12);
    h.lastErrors.set("a1", "Claude usage limit reached");
    await h.sweep.tick();
    expect(h.linesOf("background-wait")).toEqual([]);
  });

  test("is left alone while its account is not askable, and recorded once it is", async () => {
    const h = new Harness();
    h.health.set("claude", { askable: false, reason: "at its usage limit" });
    h.addIdle("a1", WAIT, 12);
    await h.sweep.tick();
    expect(h.linesOf("background-wait")).toEqual([]);
    h.health.set("claude", { askable: true });
    await h.tick();
    expect(h.linesOf("background-wait")).toHaveLength(1);
  });

  describe("an agent whose process tree cannot be attributed", () => {
    test("on Codex it is skipped: a running build there cannot be seen", async () => {
      const h = new Harness();
      const agent = h.addIdle("a1", CI_WAIT, 16, { provider: "codex" }, FOREGROUND());
      agent.attributable = false;
      await h.sweep.tick();
      expect(h.linesOf("background-wait")).toEqual([]);
    });

    test("on a Claude account it is recorded: Claude's root always carries its id", async () => {
      const h = new Harness();
      const agent = h.addIdle("a1", WAIT, 12, { provider: "claude-backup" });
      h.sessionFamilies.set("a1", "claude");
      agent.attributable = false;
      await h.sweep.tick();
      expect(h.linesOf("background-wait")).toHaveLength(1);
    });
  });

  describe("something will wake it", () => {
    test("a Paseo child it started is running: its finish report wakes it", async () => {
      const h = new Harness();
      h.addIdle("a1", "I spawned the reviewer agent in the background.", 12, {}, [
        toolRow("mcp__paseo__create_agent"),
      ]);
      h.add(
        "child",
        {
          labels: { "paseo.parent-agent-id": "a1" },
          lastActivityAt: new Date(START).toISOString(),
        },
        { cpuSecondsPerSweep: 150 },
      );
      await h.sweep.tick();
      expect(h.linesOf("background-wait")).toEqual([]);
    });

    test("a child still names its moved parent: the successor down the chain is covered", async () => {
      const h = new Harness();
      h.add("old", {
        lifecycle: "idle",
        busy: false,
        labels: { "paseo.account-failover.migrated-to": "mid" },
      });
      h.add("mid", {
        lifecycle: "idle",
        busy: false,
        labels: { "paseo.account-failover.migrated-to": "new" },
      });
      h.addIdle("new", WAIT, 12);
      h.add(
        "child",
        {
          labels: { "paseo.parent-agent-id": "old" },
          lastActivityAt: new Date(START).toISOString(),
        },
        { cpuSecondsPerSweep: 150 },
      );
      await h.sweep.tick();
      expect(h.linesOf("background-wait")).toEqual([]);
    });

    test("an idle child with a live shell under it", async () => {
      const h = new Harness();
      h.addIdle("lead", WAIT, 12);
      const child = h.addIdle("child", "Merging.", 30, {
        labels: { "paseo.parent-agent-id": "lead" },
      });
      child.children = ["/bin/zsh -c 'npm run browser-test'"];
      await h.sweep.tick();
      expect(agentIds(h.linesOf("background-wait"))).not.toContain("lead");
    });

    test("an idle child with a provider subagent still running", async () => {
      const h = new Harness();
      h.addIdle("lead", WAIT, 12);
      h.addIdle("child", "Merging.", 30, {
        labels: { "paseo.parent-agent-id": "lead" },
        runningProviderSubagentCount: 1,
      });
      await h.sweep.tick();
      expect(h.linesOf("background-wait")).toEqual([]);
    });

    test("an external wait of a child: its parent got the finish report", async () => {
      const h = new Harness();
      h.add("lead", { lifecycle: "idle", busy: false });
      h.addIdle(
        "worker",
        "I'm now waiting for the follow-up PR's merge commit and final strings.",
        43,
        { labels: { "paseo.parent-agent-id": "lead" } },
        FOREGROUND(),
      );
      await h.sweep.tick();
      expect(h.linesOf("background-wait")).toEqual([]);
    });

    test("but not the child's own work, which its parent cannot see end", async () => {
      const h = new Harness();
      h.add("lead", { lifecycle: "idle", busy: false });
      h.addIdle("worker", WAIT, 12, { labels: { "paseo.parent-agent-id": "lead" } });
      await h.sweep.tick();
      expect(agentIds(h.linesOf("background-wait"))).toEqual(["worker"]);
    });

    test("a schedule or heartbeat targets it", async () => {
      const h = new Harness();
      h.scheduled.add("a1");
      h.addIdle("a1", CI_WAIT, 19, {}, FOREGROUND());
      await h.sweep.tick();
      expect(h.linesOf("background-wait")).toEqual([]);
    });

    test.each(["ScheduleWakeup", "mcp__paseo__create_schedule", "mcp__paseo__create_heartbeat"])(
      "its final turn set up a wakeup (%s)",
      async (name) => {
        const h = new Harness();
        h.addIdle("a1", CI_WAIT, 19, {}, [toolRow(name)]);
        await h.sweep.tick();
        expect(h.linesOf("background-wait")).toEqual([]);
      },
    );

    test("restart recovery is about to resume it", async () => {
      const h = new Harness();
      h.claimedByRecovery.add("a1");
      h.addIdle("a1", WAIT, 12);
      await h.sweep.tick();
      expect(h.linesOf("background-wait")).toEqual([]);
    });

    test("restart recovery is about to resume a child of it", async () => {
      const h = new Harness();
      h.addIdle("lead", WAIT, 12);
      h.add("child", {
        lifecycle: "closed",
        busy: false,
        labels: { "paseo.parent-agent-id": "lead" },
      });
      h.claimedByRecovery.add("child");
      await h.sweep.tick();
      expect(h.linesOf("background-wait")).toEqual([]);
    });
  });

  describe("endings that are neither class", () => {
    // The seven false positives the review's replay of 2026-09-22..29 found, shaped on their
    // final messages and turns.
    test.each([
      [
        "a worker waiting on its leader's review",
        "I'm waiting for the review findings.",
        [bashRow("git diff --stat", "completed", "3 files")],
      ],
      [
        "a recommendation to a person",
        "Recommend assigning it to C3 rather than waiting for it to surface as a confusing playtest report.",
        [bashRow("cat docs/plan.md", "completed", "...")],
      ],
      [
        "a handoff that waits on the orchestrator's go",
        "When you say bundle 3 has landed, I'll rebase. Then I'll run `gate:quick`, wait for them in the same turn, and report the SHA.",
        [bashRow("git status", "completed", "clean")],
      ],
      [
        "a wait on background work launched in an earlier turn",
        "Still waiting on the background build.",
        [bashRow("git status", "completed", "clean")],
      ],
      [
        "a question to a person after a wait",
        "Waiting on CI. **Merge now, or hold for the review?**",
        [backgroundBashRow("gh pr checks --watch")],
      ],
    ])("is left alone: %s", async (_name, message, turn) => {
      const h = new Harness();
      h.addIdle("a1", message, 20, {}, turn);
      await h.sweep.tick();
      expect(h.linesOf("background-wait")).toEqual([]);
    });
  });

  describe("the outcome line", () => {
    test("records what came of a would-resume at the next idle check", async () => {
      const h = new Harness();
      const agent = h.addIdle("a1", CI_WAIT, 16, {}, FOREGROUND());
      await h.sweep.tick();
      // A person prompted it; it merged and went idle again 9 minutes later.
      h.timelines
        .get("a1")
        ?.push(
          userRow("get it green and merge"),
          bashRow("gh pr merge 6722"),
          assistantRow("Merged."),
        );
      agent.summary.lastActivityAt = new Date(h.nowMs + 9 * MINUTE).toISOString();
      await h.tick();
      await h.tick();
      expect(h.linesOf("background-wait-outcome")).toEqual([
        expect.objectContaining({
          agentId: "a1",
          waitClass: "external-wait",
          resumed: false,
          woke: "prompt",
          toolWork: true,
          rewaited: false,
          minutesToNextIdle: 9,
        }),
      ]);
    });

    test("tells a resume that ended waiting again from one that worked", async () => {
      const h = new Harness(LIVE);
      const agent = h.addIdle("a1", WAIT, 12);
      await h.sweep.tick();
      h.timelines.get("a1")?.push(userRow(h.idleResumes[0]?.prompt ?? ""), assistantRow(WAIT));
      agent.summary.lastActivityAt = new Date(h.nowMs + 2 * MINUTE).toISOString();
      await h.tick();
      expect(h.linesOf("background-wait-outcome")).toEqual([
        expect.objectContaining({
          resumed: true,
          woke: "resume",
          toolWork: false,
          rewaited: true,
          minutesToNextIdle: 2,
        }),
      ]);
    });

    test("waits while the agent is still running", async () => {
      const h = new Harness();
      const agent = h.addIdle("a1", WAIT, 12);
      await h.sweep.tick();
      agent.summary.lifecycle = "running";
      agent.summary.busy = true;
      agent.summary.lastActivityAt = new Date(h.nowMs + MINUTE).toISOString();
      await h.tick();
      expect(h.linesOf("background-wait-outcome")).toEqual([]);
    });
  });
});

describe("the production resume", () => {
  test("skips an agent whose turn started while its record was read", async () => {
    let lifecycle = "idle";
    const agentManager = {
      getAgent: () => ({ lifecycle, labels: {} }),
    } as unknown as AgentManager;
    const agentStorage = {
      get: async () => {
        lifecycle = "running";
        return { archivedAt: null };
      },
    } as unknown as AgentStorage;
    const result = await resumeIdleAgentWaitingOnBackground(
      { agentManager, agentStorage, logger },
      { agentId: "a1", prompt: "check the result" },
    );
    expect(result).toEqual({ kind: "skipped", reason: "no longer idle" });
  });
});
