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

const CONFIG = { destructiveThreshold: 0.2 };

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

function context(overrides: Partial<WaitingEpisode>): AwayReplyContext {
  const built = buildAwayReplyContext(episode(overrides));
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
    destructive: noul(0.03),
    ...overrides,
  };
}

const RECOMMENDED = "Option A: retry the connect.\nOption B (recommended): wait for ready.\nWhich?";
const UNMARKED =
  "Option A: retry the connect.\nOption B: wait for ready.\nOption C: skip it.\nWhich?";

describe("buildAwayReplyRequest", () => {
  it("keys the option question on the leader's own options, with a none exit", () => {
    const request = buildAwayReplyRequest(context({ lastMessage: RECOMMENDED }));
    expect(request.state).toEqual({
      waiting_on: "the end of its turn: its last message is the newest in the thread",
      last_message: RECOMMENDED,
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
    ]);
  });

  it("asks read_only and destructive only, for a tool permission", () => {
    const request = buildAwayReplyRequest(
      context({ kind: "permission", request: toolRequest("Read", { file_path: "/tmp/x" }) }),
    );
    expect(Object.keys(request.questions)).toEqual(["read_only", "destructive"]);
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
      answers({ option: choice("B", 0.71) }),
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
        answers({ option: choice(id, 0.8) }),
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
    ["a low-confidence pick", { option: choice("B", 0.65) }, "low-confidence-option"],
    ["FYI", { wait_kind: choice("fyi", 0.9) }, "fyi"],
    ["an open question", { wait_kind: choice("open_question", 0.9) }, "open-question"],
    ["no reply needed", { needs_reply: noul(0.3) }, "no-reply-needed"],
    ["a low-confidence wait kind", { wait_kind: choice("choose_option", 0.5) }, "low-confidence"],
    [
      "destructive intent",
      { destructive: noul(0.2), option: choice("B", 0.9) },
      "destructive-intent",
    ],
    ["a missing answer", { destructive: choice("x", 1) }, "malformed"],
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

  it("keeps going on an approve-plan answer to a finished turn or a plan approval", () => {
    const plan = mapAwayReplyAnswers(
      context({ lastMessage: "Next I will add the tests, then the docs. OK?" }),
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
    const read = context({
      kind: "permission",
      request: toolRequest("Bash", { command: "git status" }),
    });
    expect(
      mapAwayReplyAnswers(read, { read_only: noul(0.95), destructive: noul(0.02) }, CONFIG).choice,
    ).toEqual({ kind: "approve-permission" });
    expect(
      mapAwayReplyAnswers(read, { read_only: noul(0.85), destructive: noul(0.02) }, CONFIG).choice,
    ).toMatchObject({ kind: "none", reason: "jev-not-read-only" });
    const write = context({
      kind: "permission",
      request: toolRequest("Bash", { command: "npm i x" }),
    });
    expect(
      mapAwayReplyAnswers(write, { read_only: noul(0.99), destructive: noul(0.01) }, CONFIG).choice,
    ).toMatchObject({ kind: "none", reason: "not-read-only" });
  });

  it("reports verdicts without any state", () => {
    const decision = mapAwayReplyAnswers(
      context({ lastMessage: RECOMMENDED }),
      answers({ option: choice("B", 0.71) }),
      CONFIG,
    );
    expect(decision.verdicts).toEqual([
      "needs_reply 0.93",
      "wait_kind choose_option 0.82",
      "destructive 0.03",
      "option B 0.71",
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

  it("uses exactly the fixed templates", () => {
    expect(formatAwayReply(bodies[0], "turn-ended", 60)).toBe(
      `${awayReplyMarker(60)} Go with your recommendation, option B ("wait for ready"). ${AWAY_REPLY_GUARD}`,
    );
    expect(formatAwayReply(bodies[1], "question", 90)).toBe(
      `[Auto-reply on Tyler's behalf — away >90m, JEV] Go with option "Use 'SQLite' now". ${AWAY_REPLY_GUARD}`,
    );
    expect(formatAwayReply(bodies[2], "turn-ended", 120)).toBe(
      `[Auto-reply on Tyler's behalf — away >2h, JEV] Keep going with the plan you described. ${AWAY_REPLY_GUARD}`,
    );
  });

  it("states the guard in the words Tyler asked for", () => {
    expect(AWAY_REPLY_GUARD).toBe(
      "Do not merge any PR, and do not take any destructive, irreversible or outward-facing action on the strength of this reply; leave those for Tyler.",
    );
    expect(MINUTE).toBe(60_000);
  });
});
