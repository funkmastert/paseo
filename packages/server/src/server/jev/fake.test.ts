import { describe, expect, test } from "vitest";
import type { JevQuestions, JevWireRequest } from "./contract.js";
import { createFakeJevTransport } from "./fake.js";
import { validateJevResponse } from "./wire.js";

const QUESTIONS: JevQuestions = {
  task_class: {
    type: "choice",
    instructions: "Which class of work does the prompt hand to the new agent?",
    criteria: {
      mechanical: "Rote and fully specified: a rename, a formatting pass, a version bump",
      standard: "Ordinary engineering in a known area",
      other: "Not a task",
    },
  },
  urgent: {
    type: "noul",
    instructions: "Does the evidence show the problem happening right now?",
    criteria: { true: "Current readings match", false: "Stale or contradicts" },
  },
  reasoning: {
    type: "score",
    instructions: "How much reasoning does this need?",
    criteria: [
      "None: steps are spelled out",
      "Some: follow an existing pattern",
      "Deep: weigh approaches",
    ],
  },
};

function request(
  state: unknown = { title: "rename a variable", prompt: "rename foo to bar everywhere" },
): JevWireRequest {
  return { model: "jev-fake", state: state as JevWireRequest["state"], questions: QUESTIONS };
}

describe("createFakeJevTransport: unscripted answers", () => {
  test("produces a contract-valid answer for every declared question", async () => {
    const transport = createFakeJevTransport();
    const result = await transport.send(request(), { signal: new AbortController().signal });
    expect(result.status).toBe(200);
    const validated = validateJevResponse(result.body, QUESTIONS);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.response.model).toBe("jev-fake");
    expect(validated.response.usage).toEqual({
      input_tokens: Math.ceil(Buffer.byteLength(JSON.stringify(request()), "utf8") / 2.5),
      output_tokens: 0,
      cost: 0,
    });
  });

  test("is deterministic for the same state and questions", async () => {
    const transport = createFakeJevTransport();
    const first = await transport.send(request(), { signal: new AbortController().signal });
    const second = await transport.send(request(), { signal: new AbortController().signal });
    expect(second.body).toEqual(first.body);
  });

  test("produces valid answers across several different states and question shapes", async () => {
    const transport = createFakeJevTransport();
    const states = [
      "a totally unrelated plain-text state",
      { title: "", prompt: "" },
      {
        title: "investigate a root cause across modules",
        prompt: "figure out why the daemon wedges under load",
      },
      ["array", "shaped", "state"],
    ];
    for (const state of states) {
      const result = await transport.send(request(state), { signal: new AbortController().signal });
      expect(validateJevResponse(result.body, QUESTIONS).ok).toBe(true);
    }
  });
});

describe("createFakeJevTransport: scripted answers", () => {
  test("a scripted choice gets the named option at confidence, remainder spread evenly", async () => {
    const transport = createFakeJevTransport({
      answers: { task_class: { type: "choice", choice: "mechanical", confidence: 0.9 } },
    });
    const result = await transport.send(request(), { signal: new AbortController().signal });
    const validated = validateJevResponse(result.body, QUESTIONS);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const answer = validated.response.answers.task_class;
    if (answer.type !== "choice") throw new Error("expected a choice answer");
    expect(answer.choice).toBe("mechanical");
    expect(answer.confidence).toBe(0.9);
    expect(answer.probabilities.mechanical).toBe(0.9);
    expect(answer.probabilities.standard).toBeCloseTo(0.05);
    expect(answer.probabilities.other).toBeCloseTo(0.05);
  });

  test("a scripted noul is returned exactly", async () => {
    const transport = createFakeJevTransport({ answers: { urgent: { type: "noul", noul: 0.17 } } });
    const result = await transport.send(request(), { signal: new AbortController().signal });
    const validated = validateJevResponse(result.body, QUESTIONS);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.response.answers.urgent).toEqual({ type: "noul", noul: 0.17 });
  });

  test("a scripted score gets a legend built from the question's levels", async () => {
    const transport = createFakeJevTransport({
      answers: { reasoning: { type: "score", score: 1.4 } },
    });
    const result = await transport.send(request(), { signal: new AbortController().signal });
    const validated = validateJevResponse(result.body, QUESTIONS);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const answer = validated.response.answers.reasoning;
    if (answer.type !== "score") throw new Error("expected a score answer");
    expect(answer.score).toBe(1.4);
    expect(answer.legend).toEqual({
      "0": "None: steps are spelled out",
      "1": "Some: follow an existing pattern",
      "2": "Deep: weigh approaches",
    });
  });

  test("setAnswers replaces the script for later calls", async () => {
    const transport = createFakeJevTransport({ answers: { urgent: { type: "noul", noul: 0.1 } } });
    transport.setAnswers({ urgent: { type: "noul", noul: 0.9 } });
    const result = await transport.send(request(), { signal: new AbortController().signal });
    const validated = validateJevResponse(result.body, QUESTIONS);
    if (!validated.ok) throw new Error("expected ok");
    expect(validated.response.answers.urgent).toEqual({ type: "noul", noul: 0.9 });
  });

  test("throws when a scripted answer's type doesn't match the question's type", async () => {
    const transport = createFakeJevTransport({
      answers: { urgent: { type: "score", score: 1 } as never },
    });
    await expect(
      transport.send(request(), { signal: new AbortController().signal }),
    ).rejects.toThrow(/scripted answer for "urgent"/);
  });
});

describe("createFakeJevTransport: recorded calls", () => {
  test("records every request sent through it", async () => {
    const transport = createFakeJevTransport();
    await transport.send(request({ title: "first" }), { signal: new AbortController().signal });
    await transport.send(request({ title: "second" }), { signal: new AbortController().signal });
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0].state).toEqual({ title: "first" });
    expect(transport.calls[1].state).toEqual({ title: "second" });
  });
});

describe("createFakeJevTransport: behaviors", () => {
  test("kind: http returns the given status and retryAfterMs without throwing", async () => {
    const transport = createFakeJevTransport();
    transport.setBehavior({ kind: "http", status: 429, retryAfterMs: 1500 });
    const result = await transport.send(request(), { signal: new AbortController().signal });
    expect(result).toEqual({ status: 429, retryAfterMs: 1500, body: null });
  });

  test("kind: contract-violation returns a body that fails validation", async () => {
    const transport = createFakeJevTransport();
    transport.setBehavior({ kind: "contract-violation" });
    const result = await transport.send(request(), { signal: new AbortController().signal });
    expect(result.status).toBe(200);
    expect(validateJevResponse(result.body, QUESTIONS).ok).toBe(false);
  });

  test("kind: network rejects the call", async () => {
    const transport = createFakeJevTransport();
    transport.setBehavior({ kind: "network" });
    await expect(
      transport.send(request(), { signal: new AbortController().signal }),
    ).rejects.toThrow();
  });

  test("kind: timeout never resolves until the signal aborts, then rejects", async () => {
    const transport = createFakeJevTransport();
    transport.setBehavior({ kind: "timeout" });
    const controller = new AbortController();
    const pending = transport.send(request(), { signal: controller.signal });

    let settled = false;
    pending.catch(() => {});
    pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("kind: hold resolves only after release(), and tracks the held count", async () => {
    const transport = createFakeJevTransport();
    transport.setBehavior({ kind: "hold" });
    const pending = transport.send(request(), { signal: new AbortController().signal });

    await Promise.resolve();
    expect(transport.held).toBe(1);

    transport.release();
    const result = await pending;
    expect(transport.held).toBe(0);
    expect(validateJevResponse(result.body, QUESTIONS).ok).toBe(true);
  });

  test("kind: hold rejects when the signal aborts before release", async () => {
    const transport = createFakeJevTransport();
    transport.setBehavior({ kind: "hold" });
    const controller = new AbortController();
    const pending = transport.send(request(), { signal: controller.signal });
    await Promise.resolve();
    expect(transport.held).toBe(1);

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.held).toBe(0);
  });

  test("a behavior array is a queue: one per call, the last one repeats", async () => {
    const transport = createFakeJevTransport();
    transport.setBehavior([
      { kind: "http", status: 500 },
      { kind: "http", status: 429 },
    ]);

    const first = await transport.send(request(), { signal: new AbortController().signal });
    const second = await transport.send(request(), { signal: new AbortController().signal });
    const third = await transport.send(request(), { signal: new AbortController().signal });

    expect(first.status).toBe(500);
    expect(second.status).toBe(429);
    expect(third.status).toBe(429);
  });
});
