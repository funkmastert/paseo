import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { resolveJevConfig } from "../jev/config.js";
import type { JevScriptedAnswer } from "../jev/fake.js";
import { createJevService } from "../jev/service.js";
import { AWAY_REPLY_GUARD } from "./decision.js";
import { readTylerChoice } from "./job.js";
import {
  MINUTE,
  T0,
  assistant,
  leaderView,
  planRequest,
  questionRequest,
  toolRequest,
} from "./test-utils/fixtures.js";
import {
  GO_WITH_B,
  KEEP_GOING,
  MARKER,
  OPTIONS_MESSAGE,
  harness,
  type Harness,
} from "./test-utils/harness.js";

const SENTINEL = "SENTINEL-LAST-MESSAGE-4d2a";
const GO_WITH_B_TEXT = `${MARKER} Go with option B. ${AWAY_REPLY_GUARD}`;

const open: Harness[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(options: Parameters<typeof harness>[0] = {}): Harness {
  const h = harness(options);
  open.push(h);
  return h;
}

const READ_ONLY: Record<string, JevScriptedAnswer> = {
  read_only: { type: "noul", noul: 0.99 },
  destructive: { type: "noul", noul: 0.01 },
  tyler_hold: { type: "noul", noul: 0.01 },
};

function pendingLeader(
  h: Harness,
  request: ReturnType<typeof toolRequest>,
  id = "leader-1",
  cwd = h.safeCwd,
) {
  h.fleet.add(
    leaderView({ id, cwd, lifecycle: "running", busy: true, pendingPermissions: [request] }),
    [],
  );
  h.tyler(id, "Take a look", T0);
  h.fleet.append(id, [assistant("Checking.", T0 + MINUTE)]);
}

describe("AwayReplyJob", () => {
  it("does nothing before the threshold, and replies once it has passed", async () => {
    const h = setup();
    h.waitingLeader();

    h.at(T0 + 60 * MINUTE);
    expect((await h.job.tick())?.entries).toEqual([]);
    expect(h.calls()).toBe(0);

    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "replied", reason: "option" }]);
    expect(h.fleet.turns).toEqual([{ agentId: "leader-1", text: GO_WITH_B_TEXT }]);
  });

  it("honours a configured threshold", async () => {
    const h = setup({ awayReply: { dryRun: false, thresholdMinutes: 120 } });
    h.waitingLeader();
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
    const h = setup();
    h.waitingLeader();
    const late = h.makeJob(() => T0 + 62 * MINUTE);
    h.at(T0 + 62 * MINUTE);
    // Booted at T0 + 62 min: the old wait counts from boot, not from T0 + 1 min.
    expect((await late.tick())?.entries).toEqual([]);
    late.stop();
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("goes with the leader's recommendation by its id alone", async () => {
    const h = setup();
    h.waitingLeader(
      "Option A: add a retry.\nOption B (recommended): wait for the ready event.\nWhich?",
    );
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    expect(h.fleet.turns[0].text).toBe(
      `${MARKER} Go with your recommendation, option B. ${AWAY_REPLY_GUARD}`,
    );
  });

  it("leaves an FYI alone", async () => {
    const h = setup({
      answers: {
        ...GO_WITH_B,
        needs_reply: { type: "noul", noul: 0.2 },
        wait_kind: { type: "choice", choice: "fyi", confidence: 0.9 },
      },
    });
    h.waitingLeader("All done: the build is green and the tests pass.");
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
    const h = setup();
    h.waitingLeader(
      "PR #12 is green.\nOption A: merge it now.\nOption B: wait for review.\nShould I merge PR #12?",
    );
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "skipped", reason: "excluded-merge" }]);
    expect(h.calls()).toBe(0);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it.each([
    ["just over the floor", 0.05],
    ["well inside JEV's error bars", 0.2],
  ])("sends nothing when JEV's destructive answer is %s", async (_name, value) => {
    const h = setup({ answers: { ...GO_WITH_B, destructive: { type: "noul", noul: value } } });
    h.waitingLeader();
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "no-reply", reason: "destructive-intent" }]);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("sends nothing when JEV reads a hold in Tyler's messages the words missed", async () => {
    const h = setup({ answers: { ...GO_WITH_B, tyler_hold: { type: "noul", noul: 0.3 } } });
    h.waitingLeader();
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "no-reply", reason: "tyler-said-hold" }]);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("sends JEV the whole thread since Tyler's last message, and his recent messages", async () => {
    const states: Array<Record<string, unknown>> = [];
    const h = setup({
      wrapJev: (jev) => ({
        ...jev,
        decide: async (input) => {
          states.push(input.state as Record<string, unknown>);
          return jev.decide(input);
        },
      }),
    });
    h.fleet.add(leaderView({ cwd: h.safeCwd }), []);
    h.tyler("leader-1", "Earlier ask", T0 - 10 * MINUTE);
    h.fleet.append("leader-1", [
      assistant("Old answer, before his last message.", T0 - 9 * MINUTE),
    ]);
    h.tyler("leader-1", "Fix the flaky test", T0);
    h.fleet.append("leader-1", [
      assistant("First I looked at the socket code.", T0 + 1000),
      assistant(OPTIONS_MESSAGE, T0 + MINUTE),
    ]);
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    expect(states).toHaveLength(1);
    expect(states[0]["tyler_recent_messages"]).toEqual(["Earlier ask", "Fix the flaky test"]);
    const thread = String(states[0]["thread_since_tyler"]);
    expect(thread).toContain("First I looked at the socket code.");
    expect(thread).not.toContain("Old answer");
  });

  it("does not answer a thread whose last Tyler message it cannot see", async () => {
    const h = setup();
    h.fleet.add(leaderView({ cwd: h.safeCwd }), []);
    // A user row with no record of an app client behind it: not Tyler.
    h.fleet.append("leader-1", [
      { at: T0, item: { type: "user_message", text: "Fix the flaky test" } },
      assistant(OPTIONS_MESSAGE, T0 + MINUTE),
    ]);
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "skipped", reason: "no-tyler-message" }]);
    expect(h.calls()).toBe(0);
  });

  it.each([
    "wait for me",
    "Hold off on this until I'm back",
    "don't touch the store yet",
    "not yet",
    "I'll decide when I'm back",
    "leave it",
    "pause here",
  ])("never replies when Tyler's latest message says %j", async (text) => {
    const h = setup();
    h.fleet.add(leaderView({ cwd: h.safeCwd }), []);
    h.tyler("leader-1", text, T0);
    h.fleet.append("leader-1", [assistant(OPTIONS_MESSAGE, T0 + MINUTE)]);
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "skipped", reason: "tyler-said-hold" }]);
    expect(h.calls()).toBe(0);
  });

  it("does not act on company code named anywhere in the thread", async () => {
    const h = setup();
    h.waitingLeader(`${OPTIONS_MESSAGE}\nThis is for backend-net#10032.`);
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "skipped", reason: "company-code" }]);
    expect(h.calls()).toBe(0);
    h.at(T0 + 70 * MINUTE);
    expect((await h.job.tick())?.entries).toEqual([]);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("does not act on a leader in company code, or with a child there", async () => {
    const h = setup();
    h.fleet.add(leaderView({ id: "company", cwd: h.companyCwd }), []);
    h.tyler("company", "Fix the flaky test", T0);
    h.fleet.append("company", [assistant(OPTIONS_MESSAGE, T0 + MINUTE)]);
    h.fleet.add(leaderView({ id: "parent", cwd: h.safeCwd }), []);
    h.tyler("parent", "Fix the flaky test", T0);
    h.fleet.append("parent", [assistant(OPTIONS_MESSAGE, T0 + MINUTE)]);
    h.fleet.add(
      leaderView({
        id: "child",
        cwd: path.join(h.root, "ts-monorepo"),
        labels: { "paseo.parent-agent-id": "parent" },
      }),
      [],
    );
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries.filter((entry) => entry.reason === "company-code")).toHaveLength(2);
    expect(h.calls()).toBe(0);
  });

  it("replies at most once per waiting episode, across sweeps and restarts", async () => {
    const h = setup();
    h.waitingLeader();
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    await h.job.tick();
    expect(h.fleet.turns).toHaveLength(1);
    await h.job.flush();
    h.job.stop();

    // A restart between the send and the reply's own row: the daemon's record says answered.
    h.fleet.timelines.set("leader-1", h.fleet.timelines.get("leader-1")!.slice(0, -1));
    const restarted = h.makeJob();
    h.at(T0 + 200 * MINUTE);
    const report = await restarted.tick();
    restarted.stop();
    expect(report?.entries).toMatchObject([{ action: "skipped", reason: "already-replied" }]);
    expect(h.calls()).toBe(1);
    expect(h.fleet.turns).toHaveLength(1);
  });

  it("stops after two auto-replies in a row until Tyler writes from the app", async () => {
    const h = setup();
    h.waitingLeader();
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    h.fleet.append("leader-1", [assistant(OPTIONS_MESSAGE, T0 + 63 * MINUTE)]);
    h.at(T0 + 130 * MINUTE);
    await h.job.tick();
    expect(h.fleet.turns).toHaveLength(2);

    h.fleet.append("leader-1", [assistant(OPTIONS_MESSAGE, T0 + 131 * MINUTE)]);
    h.at(T0 + 200 * MINUTE);
    const third = await h.job.tick();
    expect(third?.entries).toMatchObject([{ action: "skipped", reason: "consecutive-limit" }]);
    expect(h.fleet.turns).toHaveLength(2);

    // Tyler writes; the leader answers and waits again. The streak starts over.
    h.tyler("leader-1", "B was right. Now the docs.", T0 + 205 * MINUTE);
    h.fleet.append("leader-1", [assistant(OPTIONS_MESSAGE, T0 + 206 * MINUTE)]);
    h.at(T0 + 270 * MINUTE);
    await h.job.tick();
    expect(h.fleet.turns).toHaveLength(3);
  });

  it("keeps the streak off the agent's labels, so the agent cannot reset it", async () => {
    const h = setup();
    h.waitingLeader();
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    h.fleet.append("leader-1", [assistant(OPTIONS_MESSAGE, T0 + 63 * MINUTE)]);
    h.at(T0 + 130 * MINUTE);
    await h.job.tick();
    expect(h.fleet.agent("leader-1").labels).toEqual({});
    // Whatever the agent writes on itself, the daemon's record decides.
    h.fleet.agent("leader-1").labels = {
      "paseo.auto-replied-at": "",
      "paseo.auto-reply-streak": "0",
    };
    h.fleet.append("leader-1", [assistant(OPTIONS_MESSAGE, T0 + 131 * MINUTE)]);
    h.at(T0 + 200 * MINUTE);
    const third = await h.job.tick();
    expect(third?.entries).toMatchObject([{ action: "skipped", reason: "consecutive-limit" }]);
  });

  it("keeps an opt-out even after the agent removes the label from itself", async () => {
    const h = setup();
    h.waitingLeader();
    h.fleet.agent("leader-1").labels = { "paseo.away-reply": "off" };
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    h.fleet.agent("leader-1").labels = {};
    h.at(T0 + 70 * MINUTE);
    await h.job.tick();
    expect(h.calls()).toBe(0);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("stops at the per-leader daily cap, and the cap survives a restart", async () => {
    const h = setup({ awayReply: { dryRun: false, maxRepliesPerAgentPerDay: 1 } });
    h.waitingLeader();
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    expect(h.fleet.turns).toHaveLength(1);
    await h.job.flush();
    h.job.stop();

    const restarted = h.makeJob();
    h.tyler("leader-1", "Thanks. Next one.", T0 + 64 * MINUTE);
    h.fleet.append("leader-1", [assistant(OPTIONS_MESSAGE, T0 + 65 * MINUTE)]);
    h.at(T0 + 130 * MINUTE);
    const report = await restarted.tick();
    restarted.stop();
    expect(report?.entries).toMatchObject([{ action: "skipped", reason: "agent-daily-cap" }]);
    expect(h.fleet.turns).toHaveLength(1);
  });

  it("stops at the global daily cap", async () => {
    const h = setup({ awayReply: { dryRun: false, maxRepliesPerDay: 1 } });
    h.waitingLeader(OPTIONS_MESSAGE, "leader-1");
    h.waitingLeader(OPTIONS_MESSAGE, "leader-2");
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries.map((entry) => entry.action)).toEqual(["replied", "skipped"]);
    expect(report?.entries[1]).toMatchObject({ agentId: "leader-2", reason: "daily-cap" });
    expect(h.fleet.turns).toHaveLength(1);
  });

  it("never starts a turn on a running agent", async () => {
    const h = setup();
    h.waitingLeader();
    Object.assign(h.fleet.agent("leader-1"), { lifecycle: "running", busy: true });
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    expect(h.calls()).toBe(0);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("sends nothing when the agent starts working while JEV is deciding", async () => {
    const h = setup({
      wrapJev: (jev) => ({
        ...jev,
        decide: async (input) => {
          const outcome = await jev.decide(input);
          Object.assign(h.fleet.agent("leader-1"), { lifecycle: "running", busy: true });
          return outcome;
        },
      }),
    });
    h.waitingLeader();
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "not-sent", reason: "thread-moved" }]);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("sends nothing when Tyler opens the app while JEV is deciding", async () => {
    const h = setup({
      wrapJev: (jev) => ({
        ...jev,
        decide: async (input) => {
          const outcome = await jev.decide(input);
          h.fleet.presence = {
            clients: [{ focusedAgentId: null, appVisible: true, lastActivityAtMs: h.now() }],
            availability: "available",
          };
          return outcome;
        },
      }),
    });
    h.waitingLeader();
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([
      { action: "not-sent", reason: "tyler-active-recently" },
    ]);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("sends nothing when Tyler opts the leader out while JEV is deciding", async () => {
    const h = setup({
      wrapJev: (jev) => ({
        ...jev,
        decide: async (input) => {
          const outcome = await jev.decide(input);
          h.fleet.agent("leader-1").labels["paseo.away-reply"] = "off";
          return outcome;
        },
      }),
    });
    h.waitingLeader();
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "not-sent", reason: "opted-out" }]);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it.each([
    [
      "used the app in the last hour",
      { focusedAgentId: "other", appVisible: false, lastActivityAtMs: T0 + 20 * MINUTE },
      "available",
      "tyler-active-recently",
    ],
    [
      "has this leader open",
      { focusedAgentId: "leader-1", appVisible: true, lastActivityAtMs: T0 },
      "available",
      "tyler-viewing-agent",
    ],
    ["is in focus mode", null, "focus", "tyler-in-focus-mode"],
  ] as const)("does not reply while Tyler %s", async (_name, client, availability, reason) => {
    const h = setup();
    h.waitingLeader();
    h.fleet.presence = { clients: client ? [client] : [], availability };
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "skipped", reason }]);
    expect(h.calls()).toBe(0);
  });

  it("does not reply when presence cannot be read", async () => {
    const h = setup();
    h.waitingLeader();
    h.fleet.presence = null;
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "skipped", reason: "presence-unknown" }]);
  });

  it("does not answer a finished turn Tyler has already read", async () => {
    const h = setup();
    h.waitingLeader();
    h.fleet.agent("leader-1").requiresAttention = false;
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "skipped", reason: "tyler-read-thread" }]);
    expect(h.calls()).toBe(0);
  });

  it("does not count a cancel from an earlier turn against a later one", async () => {
    const h = setup();
    h.fleet.add(leaderView({ cwd: h.safeCwd }), []);
    h.signal({
      kind: "turn-canceled",
      agentId: "leader-1",
      at: new Date(T0 - 5 * MINUTE),
      reason: "user",
    });
    h.tyler("leader-1", "Fix the flaky test", T0);
    h.fleet.append("leader-1", [assistant(OPTIONS_MESSAGE, T0 + MINUTE)]);
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    expect(h.fleet.turns).toHaveLength(1);
  });

  it("asks again next sweep when nothing was sent for a reason that can pass", async () => {
    let refusals = 1;
    const h = setup({
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
    h.waitingLeader();
    h.at(T0 + 62 * MINUTE);
    const first = await h.job.tick();
    expect(first?.entries).toMatchObject([
      { action: "skipped", reason: "jev-unavailable-circuit-open" },
    ]);
    h.at(T0 + 67 * MINUTE);
    const second = await h.job.tick();
    expect(second?.entries).toMatchObject([{ action: "replied" }]);
  });

  it("sends nothing when the idle-only start refuses", async () => {
    const h = setup();
    h.waitingLeader();
    h.fleet.refuseTurns = true;
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([{ action: "not-sent", reason: "not-idle" }]);
  });

  it.each([
    ["an HTTP error", { kind: "http", status: 500 } as const, "jev-failed-http"],
    ["a contract violation", { kind: "contract-violation" } as const, "jev-failed-contract"],
    ["a timeout", { kind: "timeout" } as const, "jev-failed-timeout"],
  ])("sends nothing on %s", async (_name, behavior, reason) => {
    const h = setup({ behavior, awayReply: { dryRun: false, timeoutMs: 50 } });
    h.waitingLeader();
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
    const h = setup({ jev: noKey });
    h.waitingLeader();
    h.at(T0 + 62 * MINUTE);
    expect((await h.job.tick())?.entries).toEqual([]);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("answers a pending question by its position, not its text", async () => {
    const h = setup({
      answers: { ...GO_WITH_B, option: { type: "choice", choice: "1", confidence: 0.9 } },
    });
    pendingLeader(h, questionRequest());
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    expect(h.fleet.turns).toHaveLength(0);
    expect(h.fleet.responses).toHaveLength(1);
    const { response } = h.fleet.responses[0];
    expect(response.behavior).toBe("allow");
    const answers = response.behavior === "allow" ? response.updatedInput?.["answers"] : null;
    expect(answers).toEqual({
      "Cache store": `${MARKER} Go with your recommendation, the 1st option you listed. ${AWAY_REPLY_GUARD}`,
    });
  });

  it("approves a pending plan with implement_resume and the marked note", async () => {
    const h = setup({ answers: KEEP_GOING });
    const plan = "1. Add the parser tests\n2. Refactor the parser\n3. Update the docs";
    pendingLeader(h, planRequest(plan));
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    expect(h.fleet.responses).toHaveLength(1);
    const { response } = h.fleet.responses[0];
    expect(response).toMatchObject({ behavior: "allow", selectedActionId: "implement_resume" });
    const sentPlan = response.behavior === "allow" ? response.updatedInput?.["plan"] : null;
    expect(sentPlan).toBe(
      `${plan}\n\n${MARKER} Keep going with the plan you described. ${AWAY_REPLY_GUARD}`,
    );
  });

  it("leaves a plan alone when approving it would change the leader's mode", async () => {
    const h = setup({ answers: KEEP_GOING });
    const request = planRequest("1. Add the parser tests\n2. Refactor the parser");
    request.actions = request.actions?.filter((action) => action.intent !== "implement_resume");
    pendingLeader(h, request);
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries).toMatchObject([
      { action: "skipped", reason: "plan-would-change-mode" },
    ]);
    expect(h.calls()).toBe(0);
    expect(h.fleet.responses).toHaveLength(0);
  });

  it("keeps going after a finished turn only when the agent spelled out a plan", async () => {
    const h = setup({ answers: KEEP_GOING });
    h.waitingLeader("I can carry on from here. OK to proceed?", "vague");
    h.waitingLeader("1. Add the parser tests\n2. Refactor the parser\nOK to proceed?", "planned");
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.entries.find((entry) => entry.agentId === "vague")).toMatchObject({
      action: "no-reply",
      reason: "no-plan-to-approve",
    });
    expect(h.fleet.turns).toEqual([
      {
        agentId: "planned",
        text: `${MARKER} Keep going with the plan you described. ${AWAY_REPLY_GUARD}`,
      },
    ]);
  });

  it("approves a Read inside the leader's cwd, and never Bash, a secret or anything outside", async () => {
    const h = setup({ answers: READ_ONLY });
    writeFileSync(path.join(h.safeCwd, "notes.md"), "notes");
    mkdirSync(path.join(h.root, ".ssh"), { recursive: true });
    writeFileSync(path.join(h.root, ".ssh", "id_ed25519"), "key");
    symlinkSync(path.join(h.root, ".ssh", "id_ed25519"), path.join(h.safeCwd, "linked"));
    writeFileSync(path.join(h.safeCwd, ".env"), "SECRET=1");
    const requests = {
      reader: toolRequest("Read", { file_path: path.join(h.safeCwd, "notes.md") }),
      bash: toolRequest("Bash", { command: "git status" }),
      ssh: toolRequest("Read", { file_path: "~/.ssh/id_ed25519" }),
      link: toolRequest("Read", { file_path: path.join(h.safeCwd, "linked") }),
      env: toolRequest("Read", { file_path: path.join(h.safeCwd, ".env") }),
      outside: toolRequest("Read", { file_path: "/etc/hosts" }),
    };
    for (const [id, request] of Object.entries(requests)) pendingLeader(h, request, id);
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(h.fleet.responses).toEqual([
      { agentId: "reader", requestId: "perm-Read", response: { behavior: "allow" } },
    ]);
    for (const id of ["bash", "ssh", "link", "env", "outside"]) {
      expect(report?.entries.find((entry) => entry.agentId === id)).toMatchObject({
        action: "skipped",
        reason: "not-read-only",
      });
    }
  });

  it("leaves tool permissions alone when approving them is switched off", async () => {
    const h = setup({
      answers: READ_ONLY,
      awayReply: { dryRun: false, approveReadOnlyPermissions: false },
    });
    writeFileSync(path.join(h.safeCwd, "notes.md"), "notes");
    pendingLeader(h, toolRequest("Read", { file_path: path.join(h.safeCwd, "notes.md") }));
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    expect(h.fleet.responses).toHaveLength(0);
    expect(h.calls()).toBe(0);
  });

  it("raises the attention flag, and sends nothing, when only Tyler can unblock it", async () => {
    const h = setup({
      answers: {
        ...GO_WITH_B,
        wait_kind: { type: "choice", choice: "blocked_on_person", confidence: 0.9 },
      },
    });
    h.waitingLeader(
      "I need you to click Allow on the Xcode dialog on the Mac before I can continue.",
    );
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    expect(h.fleet.attention).toEqual(["leader-1"]);
    expect(h.fleet.turns).toHaveLength(0);
  });

  it("logs one structured line and the decision, with no state in the log", async () => {
    const h = setup();
    h.waitingLeader();
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
      "option B 0.9",
      "destructive 0.01",
      "tyler_hold 0.02",
    ]);
    expect(h.logs()).not.toContain(SENTINEL);
    expect(h.service.listDecisions("leader-1")[0]).toMatchObject({
      feature: "awayReply",
      applied: true,
      action: "replied on Tyler's behalf (option)",
    });
  });
});

describe("dry run (D6), the default", () => {
  it("asks JEV, sends and writes nothing, and records what it would have said", async () => {
    const h = setup({ awayReply: {} });
    h.waitingLeader();
    h.at(T0 + 62 * MINUTE);
    const report = await h.job.tick();
    expect(report?.dryRun).toBe(true);
    expect(h.calls()).toBe(1);
    expect(report?.entries).toMatchObject([{ action: "would-reply", reason: "option" }]);
    expect(h.fleet.turns).toHaveLength(0);
    expect(h.fleet.attention).toHaveLength(0);
    expect(h.fleet.agent("leader-1").labels).toEqual({});
    const lines = await h.decisionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      v: 1,
      type: "decision",
      agentId: "leader-1",
      episode: "turn-ended",
      dryRun: true,
      action: "would-reply",
      reason: "option",
      optionId: "B",
      text: GO_WITH_B_TEXT,
      verdicts: [
        "needs_reply 0.94",
        "wait_kind choose_option 0.85",
        "option B 0.9",
        "destructive 0.01",
        "tyler_hold 0.02",
      ],
    });
    expect(JSON.stringify(lines)).not.toContain(SENTINEL);
    if (process.platform !== "win32") {
      expect(statSync(h.decisionPath).mode & 0o777).toBe(0o600);
      expect(statSync(h.statePath).mode & 0o777).toBe(0o600);
    }
  });

  it("reports to the savings ledger: a dry-run reply is pending until Tyler's answer settles its minutes", async () => {
    const h = setup({ awayReply: {} });
    await h.service.start();
    h.waitingLeader();
    h.waitingLeader(OPTIONS_MESSAGE, "leader-2");
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    const pending = h.service.savings.events({ range: "all" }).events;
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({
      feature: "awayReply",
      mode: "shadow",
      decision: { did: "no-reply", wouldBe: "reply:option", changed: false },
      benefit: "time",
      pending: true,
    });
    expect(h.service.listDecisions("leader-1")[0]).toMatchObject({
      mode: "shadow",
      wouldBe: "reply:option",
      savingsId: expect.stringMatching(/^sv_/),
    });

    h.tyler("leader-1", "go with B", T0 + 90 * MINUTE);
    h.tyler("leader-2", "Option A please", T0 + 91 * MINUTE);
    h.at(T0 + 95 * MINUTE);
    await h.job.tick();

    const byAgent = new Map(
      h.service.savings.events({ range: "all" }).events.map((e) => [e.agentId, e]),
    );
    expect(byAgent.get("leader-1")).toMatchObject({
      pending: false,
      tokensSavedEstimate: null,
      otherBenefit: { unit: "minutes", value: 28 },
      validation: { outcome: "held", signal: "same-choice" },
    });
    expect(byAgent.get("leader-2")).toMatchObject({
      otherBenefit: { unit: "minutes", value: 0 },
      validation: { outcome: "contradicted" },
    });
    await h.service.stop();
  });

  it("fills in whether Tyler made the same choice when he answers", async () => {
    const h = setup({ awayReply: {} });
    h.waitingLeader();
    h.waitingLeader(OPTIONS_MESSAGE, "leader-2");
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    h.tyler("leader-1", "go with B", T0 + 90 * MINUTE);
    h.tyler("leader-2", "Option A please", T0 + 91 * MINUTE);
    h.at(T0 + 95 * MINUTE);
    await h.job.tick();
    const followUps = (await h.decisionLines()).filter((line) => line["type"] === "followup");
    expect(followUps).toEqual([
      expect.objectContaining({
        agentId: "leader-1",
        outcome: "tyler-message",
        minutesAfterDecision: 28,
        would: { kind: "option", optionId: "B" },
        tyler: "B",
        sameChoice: true,
      }),
      expect.objectContaining({
        agentId: "leader-2",
        tyler: "A",
        sameChoice: false,
      }),
    ]);
    expect(JSON.stringify(followUps)).not.toContain("please");
  });

  it("fills in a follow-up when Tyler answers the request in the app", async () => {
    const h = setup({
      awayReply: {},
      answers: { ...GO_WITH_B, option: { type: "choice", choice: "1", confidence: 0.9 } },
    });
    pendingLeader(h, questionRequest());
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    h.signal({
      kind: "human-permission-response",
      agentId: "leader-1",
      at: new Date(T0 + 70 * MINUTE),
      requestId: "perm-question",
      response: { behavior: "allow", updatedInput: { answers: { "Cache store": "JSON file" } } },
    });
    const followUps = (await h.decisionLines()).filter((line) => line["type"] === "followup");
    expect(followUps).toEqual([
      expect.objectContaining({
        outcome: "tyler-answered-request",
        would: { kind: "recommendation", optionId: "1" },
        tyler: "2",
        sameChoice: false,
      }),
    ]);
  });

  it("closes a follow-up Tyler never answered after a day", async () => {
    const h = setup({ awayReply: {} });
    h.waitingLeader();
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    h.at(T0 + 62 * MINUTE + 25 * 60 * MINUTE);
    await h.job.tick();
    const followUps = (await h.decisionLines()).filter((line) => line["type"] === "followup");
    expect(followUps).toMatchObject([{ outcome: "no-tyler-action-24h", sameChoice: null }]);
  });

  it("writes a skip line once per episode and reason", async () => {
    const h = setup({ awayReply: {} });
    h.waitingLeader("Option A: merge it.\nOption B: wait.\nWhich?");
    h.at(T0 + 62 * MINUTE);
    await h.job.tick();
    await h.job.tick();
    expect(await h.decisionLines()).toMatchObject([
      { type: "skip", reason: "excluded-merge", dryRun: true },
    ]);
  });
});

describe("readTylerChoice", () => {
  it.each([
    ["B", "B"],
    ["b.", "B"],
    ["go with B", "B"],
    ["Option 2 please", "2"],
    ["let's do A", "A"],
    ["yes, keep going", "approve"],
    ["wait, not yet", "hold"],
    ["hmm, what about the other thing?", null],
    ["Z", null],
  ])("reads %j as %j", (text, expected) => {
    expect(readTylerChoice(text, ["A", "B", "2"])).toBe(expected);
  });
});
