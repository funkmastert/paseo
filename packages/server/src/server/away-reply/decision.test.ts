import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { JevAnswer } from "../jev/contract.js";
import {
  AWAY_REPLY_GUARD,
  awayReplyMarker,
  buildAwayReplyContext,
  buildAwayReplyRequest,
  formatAwayReply,
  mapAwayReplyAnswers,
  type AwayReplyBody,
  type AwayReplyContext,
} from "./decision.js";
import type { WaitingEpisode } from "./detect.js";
import { MINUTE, T0, planRequest, questionRequest, toolRequest } from "./test-utils/fixtures.js";
import type { AwayReplyThread } from "./thread.js";

const CONFIG = { destructiveThreshold: 0.05 };
const SCOPE = { cwd: "/nonexistent/away-reply-cwd", home: null };

function thread(overrides: Partial<AwayReplyThread> = {}): AwayReplyThread {
  return {
    tylerMessages: ["Fix the flaky test"],
    scanText: "",
    jevText: "",
    otherUserMessages: [],
    hasPlan: false,
    ...overrides,
  };
}

function episode(overrides: Partial<WaitingEpisode>): WaitingEpisode {
  return {
    agentId: "leader-1",
    kind: "turn-ended",
    key: "leader-1:turn:1",
    waitingSinceMs: T0,
    lastMessage: "",
    request: null,
    ...overrides,
  };
}

function context(
  overrides: Partial<WaitingEpisode>,
  threadOverrides: Partial<AwayReplyThread> = {},
): AwayReplyContext {
  const built = buildAwayReplyContext(episode(overrides), thread(threadOverrides), SCOPE);
  if (!built.ok) throw new Error(built.reason);
  return built.context;
}

function noul(value: number): JevAnswer {
  return { type: "noul", noul: value };
}

function choice(value: string, confidence: number): JevAnswer {
  return { type: "choice", choice: value, probabilities: { [value]: confidence }, confidence };
}

function answers(overrides: Record<string, JevAnswer> = {}): Record<string, JevAnswer> {
  return {
    needs_reply: noul(0.93),
    wait_kind: choice("choose_option", 0.82),
    destructive: noul(0.01),
    tyler_hold: noul(0.02),
    ...overrides,
  };
}

const RECOMMENDED = "Option A: retry the connect.\nOption B (recommended): wait for ready.\nWhich?";
const UNMARKED =
  "Option A: retry the connect.\nOption B: wait for ready.\nOption C: skip it.\nWhich?";

describe("buildAwayReplyRequest", () => {
  it("keys the option question on the leader's own options, with a none exit", () => {
    const request = buildAwayReplyRequest(
      context({ lastMessage: RECOMMENDED }, { jevText: `agent: ${RECOMMENDED}` }),
    );
    expect(request.state).toEqual({
      waiting_on: "the end of its turn: its last message is the newest in the thread",
      last_message: RECOMMENDED,
      tyler_recent_messages: ["Fix the flaky test"],
      thread_since_tyler: `agent: ${RECOMMENDED}`,
      options: { A: "retry the connect.", B: "wait for ready." },
      recommended_option: "B",
    });
    const option = request.questions["option"];
    expect(option?.type).toBe("choice");
    expect(Object.keys(option?.type === "choice" ? option.criteria : {})).toEqual([
      "A",
      "B",
      "none",
    ]);
    expect(Object.keys(request.questions)).toEqual([
      "needs_reply",
      "wait_kind",
      "option",
      "destructive",
      "tyler_hold",
    ]);
  });

  it("asks read_only, destructive and tyler_hold, for a tool permission", () => {
    const request = buildAwayReplyRequest(
      context({ kind: "permission", request: toolRequest("Read", { file_path: "/tmp/x" }) }),
    );
    expect(Object.keys(request.questions)).toEqual(["read_only", "destructive", "tyler_hold"]);
    expect(request.state["request"]).toBe('Read: {"file_path":"/tmp/x"}');
  });

  it("caps the last message at its last 4,000 characters", () => {
    const long = `${"x".repeat(5000)}END`;
    expect(
      buildAwayReplyRequest(context({ lastMessage: long })).state["last_message"],
    ).toHaveLength(4000);
  });
});

describe("mapAwayReplyAnswers", () => {
  it("goes with the leader's recommendation when JEV picks it", () => {
    const decision = mapAwayReplyAnswers(
      context({ lastMessage: RECOMMENDED }),
      answers({ option: choice("B", 0.8) }),
      CONFIG,
    );
    expect(decision.choice).toEqual({
      kind: "reply",
      body: { kind: "recommendation", optionId: "B", optionLabel: "wait for ready." },
    });
  });

  it("sends nothing when JEV disagrees with the leader's recommendation", () => {
    const decision = mapAwayReplyAnswers(
      context({ lastMessage: RECOMMENDED }),
      answers({ option: choice("A", 0.95) }),
      CONFIG,
    );
    expect(decision.choice).toMatchObject({
      kind: "none",
      reason: "disagrees-with-recommendation",
    });
  });

  it("names option X only from the leader's own options", () => {
    for (const id of ["A", "B", "C"]) {
      const decision = mapAwayReplyAnswers(
        context({ lastMessage: UNMARKED }),
        answers({ option: choice(id, 0.9) }),
        CONFIG,
      );
      expect(decision.choice).toMatchObject({
        kind: "reply",
        body: { kind: "option", optionId: id },
      });
    }
    const invented = mapAwayReplyAnswers(
      context({ lastMessage: UNMARKED }),
      answers({ option: choice("D", 0.99) }),
      CONFIG,
    );
    expect(invented.choice).toMatchObject({ kind: "none", reason: "option-not-offered" });
  });

  it.each([
    ["the none exit", { option: choice("none", 0.9) }, "no-option-picked"],
    ["a low-confidence pick", { option: choice("B", 0.8) }, "low-confidence-option"],
    ["FYI", { wait_kind: choice("fyi", 0.9) }, "fyi"],
    ["an open question", { wait_kind: choice("open_question", 0.9) }, "open-question"],
    ["no reply needed", { needs_reply: noul(0.75) }, "no-reply-needed"],
    ["a low-confidence wait kind", { wait_kind: choice("choose_option", 0.7) }, "low-confidence"],
    [
      "destructive intent just over the floor",
      { destructive: noul(0.05), option: choice("B", 0.9) },
      "destructive-intent",
    ],
    [
      "a hold in Tyler's messages",
      { tyler_hold: noul(0.2), option: choice("B", 0.9) },
      "tyler-said-hold",
    ],
    ["a missing answer", { destructive: choice("x", 1) }, "malformed"],
    ["a missing hold answer", { tyler_hold: choice("x", 1) }, "malformed"],
  ])("sends nothing on %s", (_name, override, reason) => {
    const decision = mapAwayReplyAnswers(
      context({ lastMessage: UNMARKED }),
      answers(override),
      CONFIG,
    );
    expect(decision.choice).toMatchObject({ kind: "none", reason });
  });

  it("raises attention, and sends nothing, when only Tyler can unblock a finished turn", () => {
    const decision = mapAwayReplyAnswers(
      context({ lastMessage: "I need you to approve the Xcode prompt on the Mac." }),
      answers({ wait_kind: choice("blocked_on_person", 0.88) }),
      CONFIG,
    );
    expect(decision.choice).toEqual({
      kind: "none",
      reason: "blocked-on-tyler",
      raiseAttention: true,
    });
  });

  it("keeps going on a plan approval, or a finished turn that spelled out its plan", () => {
    const vague = mapAwayReplyAnswers(
      context({ lastMessage: "Next I will add the tests, then the docs. OK?" }),
      answers({ wait_kind: choice("approve_plan", 0.8) }),
      CONFIG,
    );
    expect(vague.choice).toMatchObject({ kind: "none", reason: "no-plan-to-approve" });
    const plan = mapAwayReplyAnswers(
      context({ lastMessage: "1. add the tests\n2. add the docs\nOK?" }, { hasPlan: true }),
      answers({ wait_kind: choice("approve_plan", 0.8) }),
      CONFIG,
    );
    expect(plan.choice).toEqual({ kind: "reply", body: { kind: "keep-going" } });
    const approval = mapAwayReplyAnswers(
      context({ kind: "plan", request: planRequest("1. add tests\n2. add docs") }),
      answers({ wait_kind: choice("approve_plan", 0.8) }),
      CONFIG,
    );
    expect(approval.choice).toEqual({ kind: "reply", body: { kind: "keep-going" } });
  });

  it("answers a question only with one of its options", () => {
    const question = context({ kind: "question", request: questionRequest() });
    expect(
      mapAwayReplyAnswers(question, answers({ option: choice("1", 0.8) }), CONFIG).choice,
    ).toMatchObject({ kind: "reply", body: { kind: "recommendation", optionId: "1" } });
    expect(
      mapAwayReplyAnswers(
        question,
        answers({ wait_kind: choice("approve_plan", 0.8), option: choice("1", 0.8) }),
        CONFIG,
      ).choice,
    ).toMatchObject({ kind: "reply", body: { kind: "recommendation" } });
  });

  it("re-checks the chosen option's text against the exclusion", () => {
    const decision = mapAwayReplyAnswers(
      context({
        kind: "question",
        request: questionRequest({
          input: {
            questions: [
              {
                question: "Next?",
                header: "Next",
                options: [{ label: "Tidy the docs" }, { label: "Squash and merge" }],
              },
            ],
          },
        }),
      }),
      answers({ option: choice("2", 0.9) }),
      CONFIG,
    );
    expect(decision.choice).toMatchObject({ kind: "none", reason: "excluded-option-merge" });
  });

  it("approves a tool permission only when code and JEV both call it read-only", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "away-reply-decision-"));
    try {
      writeFileSync(path.join(root, "notes.md"), "notes");
      const scope = { cwd: root, home: null };
      const read = buildAwayReplyContext(
        episode({ kind: "permission", request: toolRequest("Read", { file_path: "notes.md" }) }),
        thread(),
        scope,
      );
      if (!read.ok) throw new Error(read.reason);
      const hold = { tyler_hold: noul(0.01) };
      expect(
        mapAwayReplyAnswers(
          read.context,
          { read_only: noul(0.97), destructive: noul(0.01), ...hold },
          CONFIG,
        ).choice,
      ).toEqual({ kind: "approve-permission" });
      expect(
        mapAwayReplyAnswers(
          read.context,
          { read_only: noul(0.9), destructive: noul(0.01), ...hold },
          CONFIG,
        ).choice,
      ).toMatchObject({ kind: "none", reason: "jev-not-read-only" });
      const bash = buildAwayReplyContext(
        episode({ kind: "permission", request: toolRequest("Bash", { command: "git status" }) }),
        thread(),
        scope,
      );
      if (!bash.ok) throw new Error(bash.reason);
      expect(
        mapAwayReplyAnswers(
          bash.context,
          { read_only: noul(0.99), destructive: noul(0.01), ...hold },
          CONFIG,
        ).choice,
      ).toMatchObject({ kind: "none", reason: "not-read-only" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a plan approval that would move the leader out of its mode", () => {
    const request = planRequest("1. add tests\n2. add docs");
    request.actions = request.actions?.filter((action) => action.intent !== "implement_resume");
    expect(buildAwayReplyContext(episode({ kind: "plan", request }), thread(), SCOPE)).toEqual({
      ok: false,
      reason: "plan-would-change-mode",
    });
  });

  it("reports verdicts without any state", () => {
    const decision = mapAwayReplyAnswers(
      context({ lastMessage: RECOMMENDED }),
      answers({ option: choice("B", 0.8) }),
      CONFIG,
    );
    expect(decision.verdicts).toEqual([
      "needs_reply 0.93",
      "wait_kind choose_option 0.82",
      "destructive 0.01",
      "tyler_hold 0.02",
      "option B 0.8",
    ]);
  });
});

describe("the reply text", () => {
  const bodies: AwayReplyBody[] = [
    { kind: "recommendation", optionId: "B", optionLabel: "wait for ready" },
    { kind: "option", optionId: "2", optionLabel: 'Use "SQLite"\nnow' },
    { kind: "keep-going" },
  ];

  it("always carries the marker first and the guard sentence last", () => {
    for (const body of bodies) {
      for (const kind of ["turn-ended", "question", "plan"] as const) {
        const text = formatAwayReply(body, kind, 60);
        expect(text.startsWith("[Auto-reply on Tyler's behalf — away >1h, JEV] ")).toBe(true);
        expect(text.endsWith(AWAY_REPLY_GUARD)).toBe(true);
        expect(text).not.toContain("\n");
      }
    }
  });

  it("uses exactly the fixed templates, naming an option by its id and never its text", () => {
    expect(formatAwayReply(bodies[0], "turn-ended", 60)).toBe(
      `${awayReplyMarker(60)} Go with your recommendation, option B. ${AWAY_REPLY_GUARD}`,
    );
    expect(formatAwayReply(bodies[1], "question", 90)).toBe(
      `[Auto-reply on Tyler's behalf — away >90m, JEV] Go with the 2nd option you listed. ${AWAY_REPLY_GUARD}`,
    );
    expect(formatAwayReply(bodies[2], "turn-ended", 120)).toBe(
      `[Auto-reply on Tyler's behalf — away >2h, JEV] Keep going with the plan you described. ${AWAY_REPLY_GUARD}`,
    );
    for (const body of bodies) {
      for (const kind of ["turn-ended", "question", "plan"] as const) {
        const text = formatAwayReply(body, kind, 60);
        expect(text).not.toContain("wait for ready");
        expect(text).not.toContain("SQLite");
      }
    }
  });

  it("states the guard in the words Tyler asked for", () => {
    expect(AWAY_REPLY_GUARD).toBe(
      "Do not merge any PR, and do not take any destructive, irreversible or outward-facing action on the strength of this reply; leave those for Tyler.",
    );
    expect(MINUTE).toBe(60_000);
  });
});
