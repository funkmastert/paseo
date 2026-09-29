import { describe, expect, test } from "vitest";
import type { JevQuestions } from "./contract.js";
import {
  choice,
  JEV_MAX_QUESTIONS,
  noul,
  reportedCostUsd,
  score,
  STATE_AS_DATA_SENTENCE,
  validateJevRequest,
  validateJevResponse,
  verdictLine,
  withStateAsDataSentence,
} from "./wire.js";

describe("withStateAsDataSentence", () => {
  test("appends the sentence to string instructions", () => {
    const questions: JevQuestions = { q: { type: "noul", instructions: "Is this urgent?" } };
    const result = withStateAsDataSentence(questions);
    expect(result.q.instructions).toBe(`Is this urgent? ${STATE_AS_DATA_SENTENCE}`);
  });

  test("leaves object instructions unchanged", () => {
    const instructions = { text: "Is this urgent?", field: "summary" };
    const questions: JevQuestions = { q: { type: "noul", instructions } };
    const result = withStateAsDataSentence(questions);
    expect(result.q.instructions).toBe(instructions);
  });

  test("is pure: the input map and its questions are not mutated", () => {
    const questions: JevQuestions = { q: { type: "noul", instructions: "Is this urgent?" } };
    withStateAsDataSentence(questions);
    expect(questions.q.instructions).toBe("Is this urgent?");
  });

  test("returns a new map, not the same reference", () => {
    const questions: JevQuestions = { q: { type: "noul", instructions: "Is this urgent?" } };
    expect(withStateAsDataSentence(questions)).not.toBe(questions);
  });
});

describe("validateJevRequest", () => {
  test("accepts a well-formed set of questions", () => {
    const questions: JevQuestions = {
      task_class: choice("Which class of work?", {
        mechanical: "Rote",
        standard: "Ordinary",
        other: null,
      }),
      urgent: noul("Is this urgent?", { true: "Right now", false: "Can wait" }),
      reasoning: score("How much reasoning?", ["None", "Some", "Deep"]),
    };
    expect(validateJevRequest(questions)).toBeNull();
  });

  test("rejects an empty question map", () => {
    expect(validateJevRequest({})).toBe("no questions");
  });

  test("rejects more than JEV_MAX_QUESTIONS questions", () => {
    const questions: JevQuestions = {};
    for (let i = 0; i < JEV_MAX_QUESTIONS + 1; i++) {
      questions[`q${i}`] = noul("Is this urgent?");
    }
    const reason = validateJevRequest(questions);
    expect(reason).not.toBeNull();
    expect(reason).toContain("too many questions");
  });

  test("accepts exactly JEV_MAX_QUESTIONS questions", () => {
    const questions: JevQuestions = {};
    for (let i = 0; i < JEV_MAX_QUESTIONS; i++) {
      questions[`q${i}`] = noul("Is this urgent?");
    }
    expect(validateJevRequest(questions)).toBeNull();
  });

  test("rejects blank string instructions", () => {
    const questions: JevQuestions = { q: { type: "noul", instructions: "   " } };
    const reason = validateJevRequest(questions);
    expect(reason).toBe('question "q" has blank instructions');
  });

  test("rejects invalid noul criteria keys", () => {
    const questions: JevQuestions = {
      q: {
        type: "noul",
        instructions: "Is this urgent?",
        criteria: { maybe: "sometimes" } as never,
      },
    };
    expect(validateJevRequest(questions)).toBe('question "q" has invalid noul criteria keys');
  });

  test("rejects a choice question with no options", () => {
    const questions: JevQuestions = { q: choice("Which?", {}) };
    expect(validateJevRequest(questions)).toBe('question "q" has no options');
  });

  test("rejects a choice question with more than 255 options", () => {
    const criteria: Record<string, string | null> = {};
    for (let i = 0; i < 256; i++) criteria[`option_${i}`] = null;
    const questions: JevQuestions = { q: choice("Which?", criteria) };
    expect(validateJevRequest(questions)).toBe('question "q" has too many options');
  });

  test("rejects a choice question with a non-string, non-null description", () => {
    const questions: JevQuestions = { q: choice("Which?", { a: 1 as never }) };
    expect(validateJevRequest(questions)).toBe('question "q" has an invalid option description');
  });

  test("rejects a score question with fewer than 2 levels", () => {
    const questions: JevQuestions = { q: score("How much?", ["Only one"]) };
    expect(validateJevRequest(questions)).toBe('question "q" has an invalid level count');
  });

  test("rejects a score question with more than 10 levels", () => {
    const questions: JevQuestions = {
      q: score(
        "How much?",
        Array.from({ length: 11 }, (_, i) => `level ${i}`),
      ),
    };
    expect(validateJevRequest(questions)).toBe('question "q" has an invalid level count');
  });

  test("rejects a score question with a blank level", () => {
    const questions: JevQuestions = { q: score("How much?", ["fine", "  "]) };
    expect(validateJevRequest(questions)).toBe('question "q" has a blank level');
  });

  test("reasons never contain the question's own text", () => {
    const secretInstructions = "SECRET_MARKER_TEXT_DO_NOT_LEAK";
    const questions: JevQuestions = {
      q: { type: "noul", instructions: secretInstructions, criteria: { maybe: "x" } as never },
    };
    const reason = validateJevRequest(questions);
    expect(reason).not.toBeNull();
    expect(reason).not.toContain(secretInstructions);
  });
});

describe("validateJevResponse", () => {
  const questions: JevQuestions = {
    task_class: choice("Which class?", { mechanical: "Rote", standard: "Ordinary", other: null }),
    urgent: noul("Is this urgent?"),
    reasoning: score("How much reasoning?", ["None", "Some", "Deep"]),
  };

  function validResponse(): unknown {
    return {
      model: "jev-1.13",
      answers: {
        task_class: {
          type: "choice",
          choice: "mechanical",
          probabilities: { mechanical: 0.7, standard: 0.2, other: 0.1 },
          confidence: 0.7,
        },
        urgent: { type: "noul", noul: 0.4 },
        reasoning: {
          type: "score",
          score: 1.2,
          legend: { "0": "None", "1": "Some", "2": "Deep" },
          probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
          confidence: 0.7,
        },
      },
      usage: { input_tokens: 100, output_tokens: 20, cost: 0.0003 },
    };
  }

  test("accepts a well-formed response", () => {
    const result = validateJevResponse(validResponse(), questions);
    expect(result.ok).toBe(true);
  });

  test("drops unknown top-level and answer fields, and undeclared answer ids", () => {
    const raw = validResponse() as Record<string, unknown>;
    raw.extra = "unexpected";
    (raw.answers as Record<string, unknown>).undeclared = { type: "noul", noul: 0.9 };
    const answers = raw.answers as Record<string, Record<string, unknown>>;
    answers.urgent.extra = "unexpected";

    const result = validateJevResponse(raw, questions);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.response).toEqual({
      model: "jev-1.13",
      answers: {
        task_class: {
          type: "choice",
          choice: "mechanical",
          probabilities: { mechanical: 0.7, standard: 0.2, other: 0.1 },
          confidence: 0.7,
        },
        urgent: { type: "noul", noul: 0.4 },
        reasoning: {
          type: "score",
          score: 1.2,
          legend: { "0": "None", "1": "Some", "2": "Deep" },
          probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
          confidence: 0.7,
        },
      },
      usage: { input_tokens: 100, output_tokens: 20, cost: 0.0003 },
    });
  });

  test("rejects a blank model", () => {
    const raw = validResponse() as Record<string, unknown>;
    raw.model = "  ";
    expect(validateJevResponse(raw, questions)).toEqual({
      ok: false,
      problem: "response has no model",
    });
  });

  test("rejects negative usage tokens", () => {
    const raw = validResponse() as Record<string, unknown>;
    raw.usage = { input_tokens: -1, output_tokens: 20 };
    const result = validateJevResponse(raw, questions);
    expect(result).toEqual({ ok: false, problem: "response has invalid usage" });
  });

  test("rejects a missing answer", () => {
    const raw = validResponse() as { answers: Record<string, unknown> };
    delete raw.answers.urgent;
    expect(validateJevResponse(raw, questions)).toEqual({
      ok: false,
      problem: 'answer "urgent" is missing or the wrong type',
    });
  });

  test("rejects an answer of the wrong type", () => {
    const raw = validResponse() as { answers: Record<string, unknown> };
    raw.answers.urgent = { type: "score", score: 1, legend: {}, probabilities: {}, confidence: 1 };
    expect(validateJevResponse(raw, questions)).toEqual({
      ok: false,
      problem: 'answer "urgent" is missing or the wrong type',
    });
  });

  test("rejects a noul out of [0,1]", () => {
    const raw = validResponse() as { answers: Record<string, { noul: number }> };
    raw.answers.urgent.noul = 1.5;
    expect(validateJevResponse(raw, questions)).toEqual({
      ok: false,
      problem: 'answer "urgent" has an invalid noul',
    });
  });

  test("rejects a distribution with mismatched keys", () => {
    const raw = validResponse() as {
      answers: Record<string, { probabilities: Record<string, number> }>;
    };
    raw.answers.task_class.probabilities = { mechanical: 0.7, standard: 0.3 };
    expect(validateJevResponse(raw, questions)).toEqual({
      ok: false,
      problem: `answer "task_class" has a distribution that doesn't match the declared options`,
    });
  });

  test("rejects a distribution that doesn't sum to one", () => {
    const raw = validResponse() as {
      answers: Record<string, { probabilities: Record<string, number> }>;
    };
    raw.answers.task_class.probabilities = { mechanical: 0.5, standard: 0.5, other: 0.5 };
    expect(validateJevResponse(raw, questions)).toEqual({
      ok: false,
      problem: `answer "task_class" has a distribution that doesn't sum to one`,
    });
  });

  test("accepts a distribution within the 0.025 sum tolerance", () => {
    const raw = validResponse() as {
      answers: Record<string, { probabilities: Record<string, number> }>;
    };
    raw.answers.task_class.probabilities = { mechanical: 0.71, standard: 0.2, other: 0.1 };
    expect(validateJevResponse(raw, questions).ok).toBe(true);
  });

  test("rejects an undeclared choice", () => {
    const raw = validResponse() as { answers: Record<string, { choice: string }> };
    raw.answers.task_class.choice = "hard";
    expect(validateJevResponse(raw, questions)).toEqual({
      ok: false,
      problem: 'answer "task_class" chose an undeclared option',
    });
  });

  test("rejects a score out of range", () => {
    const raw = validResponse() as { answers: Record<string, { score: number }> };
    raw.answers.reasoning.score = 5;
    expect(validateJevResponse(raw, questions)).toEqual({
      ok: false,
      problem: 'answer "reasoning" has a score out of range',
    });
  });

  test("rejects a legend that doesn't match the declared levels", () => {
    const raw = validResponse() as { answers: Record<string, { legend: Record<string, string> }> };
    raw.answers.reasoning.legend = { "0": "None", "1": "Some", "2": "WRONG" };
    expect(validateJevResponse(raw, questions)).toEqual({
      ok: false,
      problem: 'answer "reasoning" has a legend that doesn\'t match the declared levels',
    });
  });

  test("rejects a non-object response", () => {
    expect(validateJevResponse("nope", questions)).toEqual({
      ok: false,
      problem: "response is not an object",
    });
  });
});

describe("reportedCostUsd", () => {
  test("returns the cost when finite and non-negative", () => {
    expect(reportedCostUsd({ input_tokens: 1, output_tokens: 1, cost: 0.002 })).toBe(0.002);
  });

  test("returns null when cost is negative", () => {
    expect(reportedCostUsd({ input_tokens: 1, output_tokens: 1, cost: -1 })).toBeNull();
  });

  test("returns null when cost is not a number", () => {
    expect(reportedCostUsd({ input_tokens: 1, output_tokens: 1, cost: "0.01" })).toBeNull();
  });

  test("returns null when cost is missing", () => {
    expect(reportedCostUsd({ input_tokens: 1, output_tokens: 1 })).toBeNull();
  });

  test("returns null when cost is not finite", () => {
    expect(
      reportedCostUsd({ input_tokens: 1, output_tokens: 1, cost: Number.POSITIVE_INFINITY }),
    ).toBeNull();
  });
});

describe("question builders", () => {
  test("noul without criteria", () => {
    expect(noul("Is this urgent?")).toEqual({ type: "noul", instructions: "Is this urgent?" });
  });

  test("noul with criteria", () => {
    expect(noul("Is this urgent?", { true: "now" })).toEqual({
      type: "noul",
      instructions: "Is this urgent?",
      criteria: { true: "now" },
    });
  });

  test("choice", () => {
    expect(choice("Which?", { a: "A", b: null })).toEqual({
      type: "choice",
      instructions: "Which?",
      criteria: { a: "A", b: null },
    });
  });

  test("score", () => {
    expect(score("How much?", ["low", "high"])).toEqual({
      type: "score",
      instructions: "How much?",
      criteria: ["low", "high"],
    });
  });
});

describe("verdictLine", () => {
  test("choice: option and confidence", () => {
    expect(
      verdictLine({
        type: "choice",
        choice: "routine",
        probabilities: { routine: 0.91 },
        confidence: 0.9099,
      }),
    ).toBe("routine 0.91");
  });

  test("noul: literal yes and the raw probability", () => {
    expect(verdictLine({ type: "noul", noul: 0.12 })).toBe("yes 0.12");
  });

  test("score: literal score and the value", () => {
    expect(
      verdictLine({ type: "score", score: 1.4, legend: {}, probabilities: {}, confidence: 0.6 }),
    ).toBe("score 1.4");
  });
});
