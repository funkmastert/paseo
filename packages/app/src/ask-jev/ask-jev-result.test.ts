import { describe, expect, it } from "vitest";
import type { JevQuestion } from "@getpaseo/protocol/jev/rpc-schemas";
import {
  askJevReasonCopy,
  formatLatency,
  formatUsd,
  mapAskJevClientFailure,
  mapAskJevPayload,
  type AskJevPayload,
} from "./ask-jev-result";

function payload(overrides: Partial<AskJevPayload>): AskJevPayload {
  return {
    requestId: "req-1",
    callId: "call-1",
    outcome: "answered",
    reason: null,
    answer: null,
    model: "typesafe/jev-1.13",
    elapsedMs: 312,
    cost: { usd: 0.00012, source: "reported" },
    redactions: 0,
    ...overrides,
  };
}

const YES_NO: JevQuestion = { type: "noul", instructions: "Is the build broken?" };
const PICK_ONE: JevQuestion = {
  type: "choice",
  instructions: "Which area?",
  criteria: { parser: "Parsing", network: null, storage: null },
};
const SCORE: JevQuestion = {
  type: "score",
  instructions: "How risky?",
  criteria: ["Low", "Medium", "High"],
};

describe("mapAskJevPayload", () => {
  it("shows a yes/no answer as the verdict, the probability of yes and two bars", () => {
    const view = mapAskJevPayload(payload({ answer: { type: "noul", noul: 0.82 } }), YES_NO);

    expect(view).toEqual({
      kind: "answer",
      answerType: "noul",
      headline: "Yes",
      detail: "82% probability of yes",
      bars: [
        { key: "yes", label: "Yes", fraction: 0.82, chosen: true },
        { key: "no", label: "No", fraction: expect.closeTo(0.18, 5), chosen: false },
      ],
      position: null,
      meta: {
        costLabel: "$0.0001",
        latencyLabel: "312 ms",
        modelLabel: "typesafe/jev-1.13",
        redactionLabel: null,
        sent: true,
      },
    });
  });

  it("answers No below one half", () => {
    const view = mapAskJevPayload(payload({ answer: { type: "noul", noul: 0.3 } }), YES_NO);
    expect(view).toMatchObject({
      kind: "answer",
      headline: "No",
      detail: "30% probability of yes",
    });
  });

  it("shows a pick-one answer with a bar per option in the order they were asked", () => {
    const view = mapAskJevPayload(
      payload({
        answer: {
          type: "choice",
          choice: "storage",
          probabilities: { storage: 0.7, parser: 0.2, network: 0.1 },
          confidence: 0.7,
        },
      }),
      PICK_ONE,
    );

    expect(view).toMatchObject({
      kind: "answer",
      headline: "storage",
      detail: "70% confidence",
      bars: [
        { key: "parser", fraction: 0.2, chosen: false },
        { key: "network", fraction: 0.1, chosen: false },
        { key: "storage", fraction: 0.7, chosen: true },
      ],
    });
  });

  it("shows a score as the nearest level, its position on the scale and a bar per level", () => {
    const view = mapAskJevPayload(
      payload({
        answer: {
          type: "score",
          score: 1.4,
          legend: { "0": "Low", "1": "Medium", "2": "High" },
          probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 },
          confidence: 0.5,
        },
      }),
      SCORE,
    );

    expect(view).toMatchObject({
      kind: "answer",
      headline: "Medium",
      detail: "1.4 on a 0–2 scale · 50% confidence",
      position: { fraction: 0.7, lowLabel: "Low", highLabel: "High" },
      bars: [
        { key: "0", label: "Low", chosen: false },
        { key: "1", label: "Medium", chosen: true },
        { key: "2", label: "High", chosen: false },
      ],
    });
  });

  it("labels fake, estimated and redacted calls", () => {
    const fake = mapAskJevPayload(
      payload({ answer: { type: "noul", noul: 0.5 }, cost: { usd: 0, source: "fake" } }),
      YES_NO,
    );
    const estimated = mapAskJevPayload(
      payload({
        answer: { type: "noul", noul: 0.5 },
        cost: { usd: 0.02, source: "estimated" },
        redactions: 2,
        elapsedMs: 1400,
      }),
      YES_NO,
    );

    expect(fake.meta?.costLabel).toBe("$0 (fake backend)");
    expect(estimated.meta).toMatchObject({
      costLabel: "~$0.02 (estimated)",
      latencyLabel: "1.4 s",
      redactionLabel: "2 values redacted before sending",
    });
  });

  it("explains not configured with the variable and the file, and that nothing was sent", () => {
    const view = mapAskJevPayload(
      payload({ outcome: "unavailable", reason: "no-key", cost: null, model: null }),
      YES_NO,
    );

    expect(view).toMatchObject({ kind: "notice", tone: "warning", meta: null });
    if (view.kind !== "notice") throw new Error("expected a notice");
    expect(view.title).toBe("JEV is not configured on this host");
    expect(view.description).toContain("PASEO_JEV_API_KEY");
    expect(view.description).toContain("~/.config/paseo/jev.env");
    expect(view.description).toContain("Nothing was sent.");
  });

  it("names the Wonderly exclusion plainly", () => {
    const view = mapAskJevPayload(
      payload({ outcome: "unavailable", reason: "excluded", cost: null }),
      YES_NO,
    );
    expect(view).toMatchObject({
      kind: "notice",
      title: "Blocked by the Wonderly exclusion",
      description:
        "This touches Wonderly company code, which is never sent to JEV. Nothing was sent.",
    });
  });

  it("keeps the cost of a timeout that was sent", () => {
    const view = mapAskJevPayload(
      payload({ outcome: "failed", reason: "timeout", cost: { usd: 0.0002, source: "estimated" } }),
      YES_NO,
    );
    expect(view).toMatchObject({
      kind: "notice",
      title: "JEV did not answer in time",
      meta: { costLabel: "~$0.0002 (estimated)", sent: true },
    });
  });

  it("drops an answer of the wrong type as malformed", () => {
    const view = mapAskJevPayload(payload({ answer: { type: "noul", noul: 0.5 } }), PICK_ONE);
    expect(view).toMatchObject({ kind: "notice", title: "JEV's answer did not fit the question" });
  });

  it("has words for every reason the daemon gives, and a fallback for new ones", () => {
    for (const reason of [
      "no-key",
      "disabled",
      "feature-disabled",
      "daily-budget",
      "key-rejected",
      "circuit-open",
      "saturated",
      "excluded",
      "config-unreadable",
      "timeout",
      "aborted",
      "http",
      "network",
      "contract",
      "state-too-large",
      "request-too-large",
      "invalid-request",
      "redaction",
      "agent-unavailable",
    ]) {
      expect(askJevReasonCopy(reason).title, reason).not.toBe("JEV did not answer");
    }
    expect(askJevReasonCopy("some-future-reason")).toEqual({
      tone: "error",
      title: "JEV did not answer",
      description: 'The host answered "some-future-reason".',
    });
  });
});

describe("mapAskJevClientFailure", () => {
  it("says the host did not reply on an RPC timeout", () => {
    expect(
      mapAskJevClientFailure(new Error("Timeout waiting for message (17000ms)")),
    ).toMatchObject({ kind: "notice", title: "The host did not reply" });
  });

  it("passes other errors through", () => {
    expect(mapAskJevClientFailure(new Error("socket closed"))).toMatchObject({
      kind: "notice",
      title: "Unable to ask the host",
      description: "socket closed",
    });
  });
});

describe("formatting", () => {
  it("formats small costs and latencies", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.00001)).toBe("<$0.0001");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(0.25)).toBe("$0.25");
    expect(formatLatency(12.4)).toBe("12 ms");
    expect(formatLatency(15_000)).toBe("15.0 s");
  });
});
