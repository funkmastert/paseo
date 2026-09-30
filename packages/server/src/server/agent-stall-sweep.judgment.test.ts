import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";

import { AgentStallSweep, type IdleResumeResult } from "./agent-stall-sweep.js";
import type { StallSweepAgentSummary } from "./agent/agent-manager.js";
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
}

interface HarnessOptions {
  answers?: Record<string, JevScriptedAnswer>;
  behavior?: JevFakeBehavior;
  /** `agents.jev`. Shadow stays on unless it says. */
  jev?: Record<string, unknown>;
  /** No judge at all: today's sweep. */
  noJudge?: boolean;
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
      },
      sink: { observe: async (observation) => void this.observations.push(observation) },
      readRemediationConfig: () => this.config,
      logger,
      now: () => this.nowMs,
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
      ...process,
    };
    this.agents.set(id, agent);
    if (!this.timelines.has(id)) this.timelines.set(id, [userRow(`Do the task for ${id}`)]);
    return agent;
  }

  /** An agent idle since `quietMinutes` ago whose last message is `message`. */
  addIdle(
    id: string,
    message: string,
    quietMinutes: number,
    overrides: Partial<StallSweepAgentSummary> = {},
  ) {
    const agent = this.add(id, {
      lifecycle: "idle",
      busy: false,
      lastActivityAt: new Date(this.nowMs - quietMinutes * MINUTE).toISOString(),
      ...overrides,
    });
    this.timelines.set(id, [
      userRow("Ship the fix"),
      bashRow("npm run gate &"),
      assistantRow(message),
    ]);
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
function bashRow(command: string, status: "running" | "completed" | "failed" = "completed") {
  callSeq += 1;
  const base = {
    type: "tool_call" as const,
    callId: `call-${callSeq}`,
    name: "Bash",
    detail: { type: "shell" as const, command },
  };
  return status === "failed"
    ? row({ ...base, status, error: "3 tests failed" })
    : row({ ...base, status, error: null });
}
function repeated(command: string, times: number) {
  return Array.from({ length: times }, () => bashRow(command, "failed"));
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
    // The ladder's grace moves with the hold, so its recheck still starts from the nudge.
    expect(h.stallObservations("a1").at(-1)).toMatchObject({ active: true, graceMs: 50 * MINUTE });

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

  test("a looping agent cannot spend past its hourly cap", async () => {
    const h = new Harness({ jev: ANSWERED, answers: choice("other", 0.9) });
    busyLooper(h);
    await h.sweep.tick();
    for (let sweep = 0; sweep < 11; sweep += 1) await h.tick();
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

describe("an idle agent waiting on background work", () => {
  const WAIT = "The full gate is running in the background; I'll report back when it finishes.";

  test("with no shell left under it, it gets one resume prompt, and no JEV call", async () => {
    const h = new Harness({ jev: ANSWERED });
    h.addIdle("a1", WAIT, 12);
    const report = await h.sweep.tick();
    expect(h.idleResumes).toHaveLength(1);
    const prompt = h.idleResumes[0]?.prompt ?? "";
    expect(prompt).toMatch(/^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/);
    expect(prompt).toContain(`"${WAIT}"`);
    expect(report?.entries).toContainEqual({ agentId: "a1", action: "resumed-idle", detail: WAIT });
    expect(h.jev.transport.calls).toHaveLength(0);
    expect(h.linesOf("background-wait")).toEqual([
      expect.objectContaining({ agentId: "a1", action: "resumed", quietMinutes: 12, quote: WAIT }),
    ]);
  });

  test("works with JEV off: it is code only", async () => {
    const h = new Harness({ jev: { enabled: false } });
    h.addIdle("a1", WAIT, 12);
    await h.sweep.tick();
    expect(h.idleResumes).toHaveLength(1);
  });

  test("waits while a shell still runs under it, and resumes once it ends", async () => {
    const h = new Harness();
    const agent = h.addIdle("a1", WAIT, 12);
    agent.children = [
      "/bin/zsh -c source ~/.claude/shell-snapshots/snapshot.sh && eval 'npm run gate'",
    ];
    await h.sweep.tick();
    expect(h.idleResumes).toEqual([]);
    agent.children = ["<defunct>"];
    await h.tick();
    expect(h.idleResumes).toHaveLength(1);
  });

  test("is left alone before 10 quiet minutes", async () => {
    const h = new Harness();
    h.addIdle("a1", WAIT, 9);
    await h.sweep.tick();
    expect(h.idleResumes).toEqual([]);
  });

  test.each([
    ["a provider subagent still runs", { runningProviderSubagentCount: 1 }],
    ["a permission is pending", { pendingPermissionCount: 1 }],
    ["it is busy", { busy: true }],
    ["it is internal", { internal: true }],
  ])("is left alone when %s", async (_name, overrides) => {
    const h = new Harness();
    h.addIdle("a1", WAIT, 12, overrides);
    await h.sweep.tick();
    expect(h.idleResumes).toEqual([]);
  });

  test("is left alone while a Paseo child it started is running: its finish report wakes it", async () => {
    const h = new Harness();
    h.addIdle("a1", "Spawned the reviewer agent in the background; waiting on its report.", 12);
    h.add(
      "child",
      {
        labels: { "paseo.parent-agent-id": "a1" },
        lastActivityAt: new Date(START).toISOString(),
      },
      { cpuSecondsPerSweep: 150 },
    );
    await h.sweep.tick();
    expect(h.idleResumes).toEqual([]);
  });

  test("is left alone when its last turn failed: that is account failover's or a person's", async () => {
    const h = new Harness();
    h.addIdle("a1", WAIT, 12);
    h.lastErrors.set("a1", "Claude usage limit reached");
    await h.sweep.tick();
    expect(h.idleResumes).toEqual([]);
  });

  test.each([
    ["a question", "The gate is green. Should I merge the branch?"],
    ["a wait on a person", "Everything is staged; waiting for your go-ahead before I push."],
    ["a finished turn", "Merged and pushed. All tests pass."],
  ])("is left alone when its last message is %s", async (_name, message) => {
    const h = new Harness();
    h.addIdle("a1", message, 12);
    await h.sweep.tick();
    expect(h.idleResumes).toEqual([]);
  });

  test("once per final message, and at most 3 a day", async () => {
    const h = new Harness();
    const agent = h.addIdle("a1", WAIT, 12);
    await h.sweep.tick();
    await h.tick();
    expect(h.idleResumes).toHaveLength(1);

    for (let round = 0; round < 3; round += 1) {
      // It resumed, started the gate again, and ended its turn the same way.
      h.timelines.get("a1")?.push(userRow("resume"), assistantRow(WAIT));
      agent.summary.lastActivityAt = new Date(h.nowMs - 11 * MINUTE).toISOString();
      await h.tick();
    }
    expect(h.idleResumes).toHaveLength(3);
    expect(h.linesOf("background-wait").map((line) => line.action)).toEqual([
      "resumed",
      "resumed",
      "resumed",
      "capped",
    ]);
  });

  test("a dry-run sweep only reports it, once", async () => {
    const h = new Harness();
    h.config = { stalledAgents: { dryRun: true } };
    h.addIdle("a1", WAIT, 12);
    const report = await h.sweep.tick();
    await h.tick();
    expect(h.idleResumes).toEqual([]);
    expect(report?.entries).toContainEqual(
      expect.objectContaining({ action: "would-resume-idle" }),
    );
    expect(h.linesOf("background-wait").map((line) => line.action)).toEqual(["would-resume"]);
  });

  test("a disabled sweep leaves it alone", async () => {
    const h = new Harness();
    h.config = { stalledAgents: { enabled: false } };
    h.addIdle("a1", WAIT, 12);
    await h.sweep.tick();
    expect(h.idleResumes).toEqual([]);
  });

  test("shares the sweep's nudge budget, after the stalls", async () => {
    const h = new Harness({ noJudge: true });
    h.config = { stalledAgents: { maxNudgesPerSweep: 1 } };
    h.add("stuck");
    await h.sweep.tick();
    await h.tick();
    h.addIdle("a1", WAIT, 12);
    await h.tick();
    expect(h.nudges.map((nudge) => nudge.agentId)).toEqual(["stuck"]);
    expect(h.idleResumes).toEqual([]);
    await h.tick();
    expect(h.idleResumes).toHaveLength(1);
  });

  test("a resume the agent refused is not counted against the day", async () => {
    const h = new Harness();
    h.idleResult = { kind: "skipped", reason: "no longer idle" };
    h.addIdle("a1", WAIT, 12);
    await h.sweep.tick();
    expect(h.linesOf("background-wait")).toEqual([
      expect.objectContaining({ action: "skipped", detail: "no longer idle" }),
    ]);
  });
});
