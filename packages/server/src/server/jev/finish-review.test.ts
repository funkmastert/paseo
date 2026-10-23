import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

import {
  buildFinishReviewState,
  FINISH_REVIEW_DEFAULT_MIN_CONFIDENCE,
  reviewFinishReport,
} from "./finish-review.js";
import type { JevDecisionNote, JevOutcome } from "./contract.js";
import { createTestJevService } from "./fake.js";

const BASE_INPUT = {
  childAgentId: "child-1",
  ownerAgentId: "owner-1",
  title: "Rename the helper",
  task: "Rename formatThing to formatWidget across the repo",
  minConfidence: FINISH_REVIEW_DEFAULT_MIN_CONFIDENCE,
};

function makeJev(options: Parameters<typeof createTestJevService>[0] = {}) {
  return createTestJevService({
    ...options,
    service: { resolveAgentCwds: async () => [tmpdir()], ...options.service },
  });
}

describe("buildFinishReviewState", () => {
  it("clips the task and the final message", () => {
    const state = buildFinishReviewState({
      title: "  Rename the helper  ",
      task: `a${"b".repeat(900)}`,
      finalMessage: `c${"d".repeat(4100)}`,
    });
    expect(state.title).toBe("Rename the helper");
    expect(state.task).toBe(`a${"b".repeat(799)}`);
    expect(state.final_message).toBe("d".repeat(4000));
  });

  it("sends empty strings when title or task is missing", () => {
    const state = buildFinishReviewState({ title: null, task: null, finalMessage: "done" });
    expect(state).toEqual({ title: "", task: "", final_message: "done" });
  });
});

describe("reviewFinishReport", () => {
  it("asks nothing and returns null when there is no final message", async () => {
    const jev = makeJev();
    const decide = vi.spyOn(jev, "decide");
    const note = await reviewFinishReport({ ...BASE_INPUT, jev, finalMessage: "   " });
    expect(note).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it("returns null when the feature is disabled", async () => {
    const jev = makeJev({ config: { finishReview: { enabled: false } } });
    const note = await reviewFinishReport({ ...BASE_INPUT, jev, finalMessage: "All done." });
    expect(note).toBeNull();
  });

  it("asks with the child as the scope and subject, and the feature's call site", async () => {
    const jev = makeJev({
      answers: { finish_quality: { type: "choice", choice: "done", confidence: 0.9 } },
    });
    const decide = vi.spyOn(jev, "decide");
    await reviewFinishReport({
      ...BASE_INPUT,
      jev,
      finalMessage: "Renamed it everywhere and pushed.",
    });
    expect(decide.mock.calls[0]?.[0]).toMatchObject({
      feature: "finishReview",
      callSite: "finish-obligation.finish-review",
      scope: { cwds: [], agentIds: ["child-1"] },
      subject: { agentId: "child-1" },
      state: {
        title: "Rename the helper",
        task: BASE_INPUT.task,
        final_message: "Renamed it everywhere and pushed.",
      },
    });
  });

  it("adds no note for a confident 'done', but records the decision for the child and the owner", async () => {
    const jev = makeJev({
      answers: { finish_quality: { type: "choice", choice: "done", confidence: 0.9 } },
    });
    const record = vi.spyOn(jev.decisions, "record");
    const note = await reviewFinishReport({
      ...BASE_INPUT,
      jev,
      finalMessage: "Renamed and pushed.",
    });
    expect(note).toBeNull();
    expect(record).toHaveBeenCalledTimes(2);
    const notes = record.mock.calls.map((call) => call[0] as JevDecisionNote);
    expect(notes).toMatchObject([
      { agentId: "child-1", feature: "finishReview", applied: false, verdict: "done (0.90)" },
      { agentId: "owner-1", feature: "finishReview", applied: false },
    ]);
  });

  it("flags a confident missing-tests verdict, with a matching note and decision", async () => {
    const jev = makeJev({
      answers: { finish_quality: { type: "choice", choice: "missing_tests", confidence: 0.9 } },
    });
    const record = vi.spyOn(jev.decisions, "record");
    const savings = vi.spyOn(jev.savings, "record");
    const note = await reviewFinishReport({
      ...BASE_INPUT,
      jev,
      finalMessage: "Renamed formatThing to formatWidget everywhere.",
    });
    expect(note).toBe("JEV flagged this report: it doesn't mention tests for the change.");
    const notes = record.mock.calls.map((call) => call[0] as JevDecisionNote);
    expect(notes).toMatchObject([
      {
        agentId: "child-1",
        feature: "finishReview",
        applied: true,
        verdict: "missing_tests (0.90)",
      },
      { agentId: "owner-1", feature: "finishReview", applied: true },
    ]);
    expect(savings).toHaveBeenCalledTimes(1);
    expect(savings.mock.calls[0]?.[0]).toMatchObject({
      feature: "finishReview",
      decision: { changed: true },
    });
  });

  it("does not flag a missing choice below the confidence floor, and records it as unsure", async () => {
    const jev = makeJev({
      answers: { finish_quality: { type: "choice", choice: "missing_scope", confidence: 0.5 } },
    });
    const record = vi.spyOn(jev.decisions, "record");
    const note = await reviewFinishReport({
      ...BASE_INPUT,
      jev,
      finalMessage: "Did part of it.",
      minConfidence: 0.75,
    });
    expect(note).toBeNull();
    const notes = record.mock.calls.map((call) => call[0] as JevDecisionNote);
    expect(notes).toMatchObject([
      { agentId: "child-1", feature: "finishReview", applied: false, verdict: "unsure (0.50)" },
      { agentId: "owner-1", feature: "finishReview", applied: false },
    ]);
  });

  it("flags a confident in_progress verdict as a wait, not a gap in scope", async () => {
    const jev = makeJev({
      answers: { finish_quality: { type: "choice", choice: "in_progress", confidence: 0.9 } },
    });
    const note = await reviewFinishReport({
      ...BASE_INPUT,
      jev,
      finalMessage: "Still waiting on the quality and efficiency reviewers to finish.",
    });
    expect(note).toBe(
      "JEV flagged this report: the final message reads like the agent is still waiting on its own work, not finished yet.",
    );
  });

  it("never flags 'unclear' or 'other', even at high confidence", async () => {
    for (const choice of ["unclear", "other"]) {
      const jev = makeJev({
        answers: { finish_quality: { type: "choice", choice, confidence: 0.95 } },
      });
      const note = await reviewFinishReport({ ...BASE_INPUT, jev, finalMessage: "Hard to tell." });
      expect(note).toBeNull();
    }
  });

  it("fails open on a timeout, a throw, and a hang, without recording anything", async () => {
    const timeoutJev = makeJev({
      answers: { finish_quality: { type: "choice", choice: "missing_tests", confidence: 0.9 } },
      behavior: { kind: "timeout" },
    });
    const timeoutRecord = vi.spyOn(timeoutJev.decisions, "record");
    expect(
      await reviewFinishReport({ ...BASE_INPUT, jev: timeoutJev, finalMessage: "Done." }),
    ).toBeNull();
    expect(timeoutRecord).not.toHaveBeenCalled();

    const base = makeJev();
    const throwingJev = { ...base, decide: async () => Promise.reject(new Error("boom")) };
    expect(
      await reviewFinishReport({ ...BASE_INPUT, jev: throwingJev, finalMessage: "Done." }),
    ).toBeNull();

    const hangingJev = { ...base, decide: () => new Promise<JevOutcome>(() => undefined) };
    expect(
      await reviewFinishReport({
        ...BASE_INPUT,
        jev: hangingJev,
        finalMessage: "Done.",
        hardTimeoutMs: 20,
      }),
    ).toBeNull();
  });
});
