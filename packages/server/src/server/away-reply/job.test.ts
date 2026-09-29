import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import type { IdleTurnOutcome } from "../agent/agent-manager.js";
import type { AgentPermissionResponse } from "../agent/agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import { resolveJevConfig } from "../jev/config.js";
import type { JevService } from "../jev/contract.js";
import { createTestJevService, type JevScriptedAnswer, type JevFakeBehavior } from "../jev/fake.js";
import { createJevService } from "../jev/service.js";
import { resolveAwayReplyConfig } from "./config.js";
import { AWAY_REPLY_GUARD } from "./decision.js";
import {
  AUTO_REPLIED_AT_LABEL,
  AUTO_REPLY_STREAK_LABEL,
  type AwayReplyAgentView,
} from "./detect.js";
import { AwayReplyJob, type AwayReplyDependencies } from "./job.js";
import {
  MINUTE,
  T0,
  assistant,
  leaderView,
  planRequest,
  questionRequest,
  rowsOf,
  toolRequest,
  user,
} from "./test-utils/fixtures.js";

const MARKER = "[Auto-reply on Tyler's behalf — away >1h, JEV]";
const SENTINEL = "SENTINEL-LAST-MESSAGE-4d2a";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The agent manager, as far as the job can see it. */
class FakeFleet {
  agents: AwayReplyAgentView[] = [];
  timelines = new Map<string, AgentTimelineRow[]>();
  turns: Array<{ agentId: string; text: string }> = [];
  responses: Array<{ agentId: string; requestId: string; response: AgentPermissionResponse }> = [];
  attention: string[] = [];
  refuseTurns = false;
  clock: () => number = () => T0;

  add(agent: AwayReplyAgentView, rows: AgentTimelineRow[]): void {
    this.agents.push(agent);
    this.timelines.set(agent.id, rows);
  }

  agent(id: string): AwayReplyAgentView {
    const found = this.agents.find((entry) => entry.id === id);
    if (!found) throw new Error(`no agent ${id}`);
    return found;
  }

  append(agentId: string, entries: Parameters<typeof rowsOf>[0]): void {
    const rows = this.timelines.get(agentId) ?? [];
    const nextSeq = (rows.at(-1)?.seq ?? 0) + 1;
    this.timelines.set(agentId, [...rows, ...rowsOf(entries, nextSeq)]);
  }

  deps(): AwayReplyDependencies {
    return {
      listAgents: async () =>
        this.agents.map((agent) => ({ ...agent, labels: { ...agent.labels } })),
      readTimelineTail: (agentId, limit) => (this.timelines.get(agentId) ?? []).slice(-limit),
      listPinnedWorkspaceIds: async () => new Set(["ws-pinned"]),
      startTurnIfIdle: (agentId, text): Promise<IdleTurnOutcome> | null => {
        const agent = this.agent(agentId);
        if (
          this.refuseTurns ||
          agent.lifecycle !== "idle" ||
          agent.busy ||
          agent.pendingPermissions.length > 0
        ) {
          return null;
        }
        this.turns.push({ agentId, text });
        this.append(agentId, [user(text, this.clock())]);
        return Promise.resolve({ status: "completed", finalText: "" });
      },
      respondToPermission: async (agentId, requestId, response) => {
        const agent = this.agent(agentId);
        if (!agent.pendingPermissions.some((request) => request.id === requestId)) {
          throw new Error(`No pending permission request with id '${requestId}'`);
        }
        agent.pendingPermissions = agent.pendingPermissions.filter(
          (request) => request.id !== requestId,
        );
        this.responses.push({ agentId, requestId, response });
      },
      setLabels: async (agentId, labels) => {
        const agent = this.agent(agentId);
        agent.labels = { ...agent.labels, ...labels };
      },
      raiseAttention: async (agentId) => {
        this.attention.push(agentId);
      },
    };
  }
}

interface HarnessOptions {
  answers?: Record<string, JevScriptedAnswer>;
  behavior?: JevFakeBehavior | JevFakeBehavior[];
  awayReply?: Record<string, unknown>;
  jev?: JevService;
  wrapJev?: (jev: JevService) => JevService;
}

const GO_WITH_B: Record<string, JevScriptedAnswer> = {
  needs_reply: { type: "noul", noul: 0.94 },
  wait_kind: { type: "choice", choice: "choose_option", confidence: 0.85 },
  option: { type: "choice", choice: "B", confidence: 0.8 },
  destructive: { type: "noul", noul: 0.03 },
};

function harness(options: HarnessOptions = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "away-reply-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const safeCwd = path.join(root, "work", "bozeo");
  const companyCwd = path.join(root, "mobile-worktrees", "app");
  mkdirSync(safeCwd, { recursive: true });
  mkdirSync(companyCwd, { recursive: true });
  const fleet = new FakeFleet();
  let nowMs = T0;
  fleet.clock = () => nowMs;
  let logText = "";
  const logger = pino(
    { level: "info" },
    new Writable({
      write(chunk, _encoding, callback) {
        logText += chunk.toString();
        callback();
      },
    }),
  );
  const awayReply = options.awayReply ?? {};
  const service =
    options.jev ??
    createTestJevService({
      answers: options.answers ?? GO_WITH_B,
      behavior: options.behavior,
      paseoHome: path.join(root, "paseo-home"),
      homeDir: root,
      config: { awayReply },
      service: {
        now: () => nowMs,
        resolveAgentCwds: async (ids) =>
          ids.map((id) => fleet.agents.find((agent) => agent.id === id)?.cwd ?? "/nonexistent"),
      },
    });
  const jev = options.wrapJev ? options.wrapJev(service) : service;
  const job = new AwayReplyJob({
    dependencies: fleet.deps(),
    jev,
    readConfig: () => resolveAwayReplyConfig(awayReply),
    logger,
    now: () => nowMs,
  });
  return {
    fleet,
    job,
    service,
    safeCwd,
    companyCwd,
    logs: () => logText,
    at: (ms: number) => {
      nowMs = ms;
    },
    calls: () =>
      "transport" in service
        ? (service as { transport: { calls: unknown[] } }).transport.calls.length
        : 0,
  };
}

const OPTIONS_MESSAGE = [
  `Two ways to fix the flaky socket test. ${SENTINEL}`,
  "Option A: add a retry around connect.",
  "Option B: wait for the ready event first.",
  "Which do you want?",
].join("\n");

function waitingLeader(h: ReturnType<typeof harness>, message = OPTIONS_MESSAGE, id = "leader-1") {
  h.fleet.add(
    leaderView({ id, cwd: h.safeCwd }),
    rowsOf([user("Fix the flaky test", T0), assistant(message, T0 + MINUTE)]),
  );
}

describe("AwayReplyJob", () => {
  it("does nothing before the threshold, and replies once it has passed", async () => {
    const h = harness();
    waitingLeader(h);

    h.at(T0 + 60 * MINUTE);
    expect((await h.job.tick())?.entries).toEqual([]);
    expect(h.calls()).toBe(0);

    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "replied", reason: "option" }]);
    expect(h.fleet.turns).toHaveLength(1);
    expect(h.fleet.turns[0].text).toBe(
      `${MARKER} Go with option B ("wait for the ready event first."). ${AWAY_REPLY_GUARD}`,
    );
  });

  it("honours a configured threshold", async () => {
    const h = harness({ awayReply: { thresholdMinutes: 120 } });
    waitingLeader(h);
    h.at(T0 + 100 * MINUTE);
    await h.job.tick();
    expect(h.fleet.turns).toHaveLength(0);
    h.at(T0 + 125 * MINUTE);
    await h.job.tick();
    expect(
      h.fleet.turns[0].text.startsWith("[Auto-reply on Tyler's behalf — away >2h, JEV] "),
    ).toBe(true);
  });

  it("restarts every wait's clock when the daemon starts", async () => {
    const h = harness();
    h.at(T0 + 30 * MINUTE);
    const late = new AwayReplyJob({
      dependencies: h.fleet.deps(),
      jev: h.service,
      readConfig: () => resolveAwayReplyConfig({}),
      logger: pino({ level: "silent" }),
      now: () => T0 + 62 * MINUTE,
    });
    waitingLeader(h);
    // Booted at T0 + 62 min: the old wait counts from boot, not from T0 + 1 min.
    await late.tick();
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("goes with the leader's recommendation when it marked one", async () => {
    const h = harness();
    waitingLeader(
      h,
      "Option A: add a retry.\nOption B (recommended): wait for the ready event.\nWhich?",
    );
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    expect(h.fleet.turns[0].text).toBe(
      `${MARKER} Go with your recommendation, option B ("wait for the ready event."). ${AWAY_REPLY_GUARD}`,
    );
  });

  it("leaves an FYI alone", async () => {
    const h = harness({
      answers: {
        ...GO_WITH_B,
        needs_reply: { type: "noul", noul: 0.2 },
        wait_kind: { type: "choice", choice: "fyi", confidence: 0.9 },
      },
    });
    waitingLeader(h, "All done: the build is green and the tests pass.");
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "no-reply", reason: "no-reply-needed" }]);
    expect(h.fleet.turns).toHaveLength(0);
    expect(h.service.listDecisions("leader-1")[0]).toMatchObject({
      feature: "awayReply",
      applied: false,
      action: "no reply: no-reply-needed",
    });
  });

  it("never auto-replies to a merge question, even when JEV says go", async () => {
    const h = harness();
    waitingLeader(
      h,
      "PR #12 is green.\nOption A: merge it now.\nOption B: wait for review.\nShould I merge PR #12?",
    );
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "skipped", reason: "excluded-merge" }]);
    expect(h.calls()).toBe(0);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("sends nothing when JEV reads destructive intent", async () => {
    const h = harness({ answers: { ...GO_WITH_B, destructive: { type: "noul", noul: 0.25 } } });
    waitingLeader(h);
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "no-reply", reason: "destructive-intent" }]);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("honours a lower configured destructive threshold", async () => {
    const h = harness({
      answers: { ...GO_WITH_B, destructive: { type: "noul", noul: 0.08 } },
      awayReply: { destructiveThreshold: 0.05 },
    });
    waitingLeader(h);
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "no-reply", reason: "destructive-intent" }]);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("sends nothing when the thread names company code, and asks only once", async () => {
    const h = harness();
    waitingLeader(
      h,
      `${OPTIONS_MESSAGE}
This is for the Wonderly app.`,
    );
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([
      { action: "no-reply", reason: "jev-unavailable-excluded" },
    ]);
    expect(h.calls()).toBe(0);
    h.at(T0 + 70 * MINUTE);
    expect((await h.job.tick())?.entries).toEqual([]);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("replies at most once per waiting episode, across sweeps and restarts", async () => {
    const h = harness();
    waitingLeader(h);
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    await h.job.tick();
    expect(h.fleet.turns).toHaveLength(1);
    expect(h.fleet.agent("leader-1").labels[AUTO_REPLY_STREAK_LABEL]).toBe("1");
    expect(h.fleet.agent("leader-1").labels[AUTO_REPLIED_AT_LABEL]).toBe(
      new Date(T0 + 62 * MINUTE).toISOString(),
    );
  });

  it("reads a reply made before a restart off the label, and does not answer that wait again", async () => {
    const h = harness();
    // The label says this wait (since T0 + 1 min) was answered at T0 + 62 min, but the thread
    // does not show the reply yet: the state a restart can leave between the send and the row.
    h.fleet.add(
      leaderView({
        cwd: h.safeCwd,
        labels: {
          [AUTO_REPLIED_AT_LABEL]: new Date(T0 + 62 * MINUTE).toISOString(),
          [AUTO_REPLY_STREAK_LABEL]: "1",
        },
      }),
      rowsOf([user("Fix the flaky test", T0), assistant(OPTIONS_MESSAGE, T0 + MINUTE)]),
    );
    let jobNow = T0 - MINUTE;
    const restarted = new AwayReplyJob({
      dependencies: h.fleet.deps(),
      jev: h.service,
      readConfig: () => resolveAwayReplyConfig({}),
      logger: pino({ level: "silent" }),
      now: () => jobNow,
    });
    jobNow = T0 + 200 * MINUTE;
    h.at(jobNow);
    const report = await restarted.tick();
    expect(report?.entries).toMatchObject([{ action: "skipped", reason: "already-replied" }]);
    expect(h.calls()).toBe(0);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("stops after two auto-replies in a row until Tyler writes", async () => {
    const h = harness();
    waitingLeader(h);
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    h.fleet.append("leader-1", [assistant(OPTIONS_MESSAGE, T0 + 63 * MINUTE)]);
    h.at(T0 + 130 * MINUTE);
    await h.job.tick();
    expect(h.fleet.turns).toHaveLength(2);
    expect(h.fleet.agent("leader-1").labels[AUTO_REPLY_STREAK_LABEL]).toBe("2");

    h.fleet.append("leader-1", [assistant(OPTIONS_MESSAGE, T0 + 131 * MINUTE)]);
    h.at(T0 + 200 * MINUTE);
    const third = await h.job.tick();
    expect(third?.entries).toMatchObject([{ action: "skipped", reason: "consecutive-limit" }]);
    expect(h.fleet.turns).toHaveLength(2);

    // Tyler writes; the leader answers and waits again. The streak starts over.
    h.fleet.append("leader-1", [
      user("B was right. Now the docs.", T0 + 205 * MINUTE),
      assistant(OPTIONS_MESSAGE, T0 + 206 * MINUTE),
    ]);
    h.at(T0 + 270 * MINUTE);
    await h.job.tick();
    expect(h.fleet.turns).toHaveLength(3);
    expect(h.fleet.agent("leader-1").labels[AUTO_REPLY_STREAK_LABEL]).toBe("1");
  });

  it("stops at the per-leader daily cap", async () => {
    const h = harness({ awayReply: { maxRepliesPerAgentPerDay: 1 } });
    waitingLeader(h);
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    h.fleet.append("leader-1", [assistant(OPTIONS_MESSAGE, T0 + 63 * MINUTE)]);
    h.at(T0 + 130 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "skipped", reason: "agent-daily-cap" }]);
    expect(h.fleet.turns).toHaveLength(1);
  });

  it("stops at the global daily cap", async () => {
    const h = harness({ awayReply: { maxRepliesPerDay: 1 } });
    waitingLeader(h, OPTIONS_MESSAGE, "leader-1");
    waitingLeader(h, OPTIONS_MESSAGE, "leader-2");
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries.map((entry) => entry.action)).toEqual(["replied", "skipped"]);
    expect(report?.entries[1]).toMatchObject({ agentId: "leader-2", reason: "daily-cap" });
    expect(h.fleet.turns).toHaveLength(1);
  });

  it("never starts a turn on a running agent", async () => {
    const h = harness();
    h.fleet.add(
      leaderView({ cwd: h.safeCwd, lifecycle: "running", busy: true }),
      rowsOf([assistant(OPTIONS_MESSAGE, T0 + MINUTE)]),
    );
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    expect(h.calls()).toBe(0);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("sends nothing when the agent starts working while JEV is deciding", async () => {
    const h = harness({
      wrapJev: (jev) => ({
        ...jev,
        decide: async (input) => {
          const outcome = await jev.decide(input);
          const agent = h.fleet.agent("leader-1");
          agent.lifecycle = "running";
          agent.busy = true;
          return outcome;
        },
      }),
    });
    waitingLeader(h);
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "not-sent", reason: "thread-moved" }]);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("sends nothing when Tyler opts the leader out while JEV is deciding", async () => {
    const h = harness({
      wrapJev: (jev) => ({
        ...jev,
        decide: async (input) => {
          const outcome = await jev.decide(input);
          h.fleet.agent("leader-1").labels["paseo.away-reply"] = "off";
          return outcome;
        },
      }),
    });
    waitingLeader(h);
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "not-sent", reason: "opted-out" }]);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("asks again next sweep when nothing was sent for a reason that can pass", async () => {
    let refusals = 1;
    const h = harness({
      wrapJev: (jev) => ({
        ...jev,
        decide: async (input) => {
          if (refusals > 0) {
            refusals -= 1;
            return { kind: "unavailable", callId: "call-refused", reason: "circuit-open" };
          }
          return jev.decide(input);
        },
      }),
    });
    waitingLeader(h);
    h.at(T0 + 62 * MINUTE);
    const first = await h.job.tick();
    expect(first?.entries).toMatchObject([
      { action: "skipped", reason: "jev-unavailable-circuit-open" },
    ]);
    expect(h.fleet.turns).toHaveLength(0);
    h.at(T0 + 67 * MINUTE);
    const second = await h.job.tick();
    expect(second?.entries).toMatchObject([{ action: "replied" }]);
    expect(h.fleet.turns).toHaveLength(1);
  });

  it("sends nothing when the idle-only start refuses", async () => {
    const h = harness();
    waitingLeader(h);
    h.fleet.refuseTurns = true;
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "not-sent", reason: "not-idle" }]);
    expect(h.fleet.agent("leader-1").labels[AUTO_REPLIED_AT_LABEL]).toBeUndefined();
  });

  it.each([
    ["an HTTP error", { kind: "http", status: 500 } as JevFakeBehavior, "jev-failed-http"],
    [
      "a contract violation",
      { kind: "contract-violation" } as JevFakeBehavior,
      "jev-failed-contract",
    ],
    ["a timeout", { kind: "timeout" } as JevFakeBehavior, "jev-failed-timeout"],
  ])("sends nothing on %s", async (_name, behavior, reason) => {
    const h = harness({ behavior, awayReply: { timeoutMs: 50 } });
    waitingLeader(h);
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "no-reply", reason }]);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("does nothing at all without a key", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "away-reply-nokey-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const noKey = createJevService({
      paseoHome: root,
      homeDir: root,
      logger: pino({ level: "silent" }),
      capturedKey: { present: false, value: () => null },
      env: {},
      transport: {
        provider: "openrouter",
        send: () => {
          throw new Error("no request may leave without a key");
        },
      },
      configReader: { read: () => ({ ok: true, config: resolveJevConfig({}, { homeDir: root }) }) },
    });
    const h = harness({ jev: noKey });
    waitingLeader(h);
    h.at(T0 + 62 * MINUTE);
    expect((await h.job.tick())?.entries).toEqual([]);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("sends and writes nothing in a dry run, and records what it would have said", async () => {
    const h = harness({ awayReply: { dryRun: true } });
    waitingLeader(h);
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.dryRun).toBe(true);
    expect(report?.entries).toMatchObject([{ action: "would-reply", reason: "option" }]);
    expect(report?.entries[0].text).toContain(MARKER);
    expect(h.fleet.turns).toHaveLength(0);
    expect(h.fleet.agent("leader-1").labels).toEqual({});
    expect(h.service.listDecisions("leader-1")[0]).toMatchObject({ applied: false });
  });

  it("skips a leader in company code, before any request is built", async () => {
    const h = harness();
    h.fleet.add(
      leaderView({ cwd: h.companyCwd }),
      rowsOf([assistant(OPTIONS_MESSAGE, T0 + MINUTE)]),
    );
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "skipped", reason: "d7-excluded" }]);
    expect(h.calls()).toBe(0);
  });

  it("skips archived, remediation and schedule agents", async () => {
    const h = harness();
    const rows = () => rowsOf([assistant(OPTIONS_MESSAGE, T0 + MINUTE)]);
    h.fleet.add(
      leaderView({ id: "archived", cwd: h.safeCwd, archivedAt: "2026-09-29T08:30:00Z" }),
      rows(),
    );
    h.fleet.add(
      leaderView({ id: "fixer", cwd: h.safeCwd, labels: { "paseo.remediation": "disk" } }),
      rows(),
    );
    h.fleet.add(
      leaderView({ id: "cron", cwd: h.safeCwd, labels: { "paseo.schedule-id": "s1" } }),
      rows(),
    );
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    expect(h.calls()).toBe(0);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("answers a pending question through the app's permission path", async () => {
    const h = harness({
      answers: {
        ...GO_WITH_B,
        option: { type: "choice", choice: "1", confidence: 0.8 },
      },
    });
    const request = questionRequest();
    h.fleet.add(
      leaderView({
        cwd: h.safeCwd,
        lifecycle: "running",
        busy: true,
        pendingPermissions: [request],
      }),
      rowsOf([assistant("One decision before I build the cache.", T0 + MINUTE)]),
    );
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    expect(h.fleet.turns).toHaveLength(0);
    expect(h.fleet.responses).toHaveLength(1);
    const { response } = h.fleet.responses[0];
    expect(response.behavior).toBe("allow");
    const answers = response.behavior === "allow" ? response.updatedInput?.["answers"] : null;
    expect(answers).toEqual({
      "Cache store": `${MARKER} Go with your recommendation, option "SQLite". ${AWAY_REPLY_GUARD}`,
    });
  });

  it("approves a pending plan with the marked note on the plan text", async () => {
    const h = harness({
      answers: {
        ...GO_WITH_B,
        wait_kind: { type: "choice", choice: "approve_plan", confidence: 0.8 },
      },
    });
    const plan = "1. Add the parser tests\n2. Refactor the parser\n3. Update the docs";
    h.fleet.add(
      leaderView({
        cwd: h.safeCwd,
        lifecycle: "running",
        busy: true,
        pendingPermissions: [planRequest(plan)],
      }),
      rowsOf([assistant("Here is the plan.", T0 + MINUTE)]),
    );
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    expect(h.fleet.responses).toHaveLength(1);
    const { response } = h.fleet.responses[0];
    expect(response).toMatchObject({ behavior: "allow", selectedActionId: "implement" });
    const sentPlan = response.behavior === "allow" ? response.updatedInput?.["plan"] : null;
    expect(sentPlan).toBe(
      `${plan}\n\n${MARKER} Keep going with the plan you described. ${AWAY_REPLY_GUARD}`,
    );
  });

  it("approves a read-only tool permission, and never a write", async () => {
    const readOnly = {
      read_only: { type: "noul", noul: 0.96 },
      destructive: { type: "noul", noul: 0.02 },
    } satisfies Record<string, JevScriptedAnswer>;
    const h = harness({ answers: readOnly });
    h.fleet.add(
      leaderView({
        id: "reader",
        cwd: h.safeCwd,
        lifecycle: "running",
        busy: true,
        pendingPermissions: [toolRequest("Bash", { command: "git status" })],
      }),
      rowsOf([assistant("Checking the tree.", T0 + MINUTE)]),
    );
    h.fleet.add(
      leaderView({
        id: "writer",
        cwd: h.safeCwd,
        lifecycle: "running",
        busy: true,
        pendingPermissions: [toolRequest("Bash", { command: "npm install left-pad" })],
      }),
      rowsOf([assistant("Installing.", T0 + MINUTE)]),
    );
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(h.fleet.responses).toEqual([
      { agentId: "reader", requestId: "perm-Bash", response: { behavior: "allow" } },
    ]);
    expect(report?.entries.find((entry) => entry.agentId === "writer")).toMatchObject({
      action: "skipped",
      reason: "not-read-only",
    });
  });

  it("leaves tool permissions alone when approving them is switched off", async () => {
    const h = harness({ awayReply: { approveReadOnlyPermissions: false } });
    h.fleet.add(
      leaderView({
        cwd: h.safeCwd,
        lifecycle: "running",
        busy: true,
        pendingPermissions: [toolRequest("Read", { file_path: "/tmp/x" })],
      }),
      rowsOf([assistant("Reading.", T0 + MINUTE)]),
    );
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    expect(h.fleet.responses).toHaveLength(0);
    expect(h.calls()).toBe(0);
  });

  it("raises the attention flag, and sends nothing, when only Tyler can unblock it", async () => {
    const h = harness({
      answers: {
        ...GO_WITH_B,
        wait_kind: { type: "choice", choice: "blocked_on_person", confidence: 0.9 },
      },
    });
    waitingLeader(
      h,
      "I need you to click Allow on the Xcode dialog on the Mac before I can continue.",
    );
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    expect(h.fleet.attention).toEqual(["leader-1"]);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("logs one structured line and the decision, with no state in the log", async () => {
    const h = harness();
    waitingLeader(h);
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    const lines = h
      .logs()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line["msg"] === "away-reply");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      agentId: "leader-1",
      episode: "turn-ended",
      action: "replied",
      reason: "option",
      optionId: "B",
      outcome: "answered",
      dryRun: false,
    });
    expect(lines[0]["verdicts"]).toEqual([
      "needs_reply 0.94",
      "wait_kind choose_option 0.85",
      "option B 0.8",
      "destructive 0.03",
    ]);
    expect(h.logs()).not.toContain(SENTINEL);
    expect(h.service.listDecisions("leader-1")[0]).toMatchObject({
      feature: "awayReply",
      applied: true,
      action: "replied on Tyler's behalf (option)",
    });
  });
});
