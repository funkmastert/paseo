/**
 * The deterministic fake transport. Its unscripted answers are a port of
 * disler/ten-levels-of-jev, apps/ten-levels/src/core/mock.ts (MockJev), MIT License,
 * Copyright (c) 2026 IndyDevDan / AgenticEngineer.com: token overlap between the flattened
 * state and each option/level description, through a softmax, with confidence from the
 * distribution's peak.
 *
 * `createTestJevService` wraps the real service around it. The service never imports this file:
 * bootstrap passes the fake in when `PASEO_JEV_BACKEND=fake`.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino, { type Logger } from "pino";

import { resolveJevConfig } from "./config.js";
import { createJevService, type JevServiceOptions, type JevServiceRuntime } from "./service.js";
import type {
  JevAnswer,
  JevChoiceQuestion,
  JevNoulQuestion,
  JevQuestion,
  JevScoreQuestion,
  JevState,
  JevTransport,
  JevTransportResponse,
  JevWireRequest,
  JevWireResponse,
} from "./contract.js";

export type JevScriptedAnswer =
  | { type: "choice"; choice: string; confidence: number }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence?: number };

export type JevFakeBehavior =
  | { kind: "answer" }
  | { kind: "timeout" }
  | { kind: "http"; status: number; retryAfterMs?: number }
  | { kind: "contract-violation" }
  | { kind: "network" }
  | { kind: "hold" };

export interface FakeJevTransport extends JevTransport {
  readonly provider: "fake";
  readonly calls: JevWireRequest[];
  setAnswers(answers: Record<string, JevScriptedAnswer>): void;
  setBehavior(behavior: JevFakeBehavior | JevFakeBehavior[]): void;
  release(): void;
  readonly held: number;
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "then",
  "than",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "without",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "done",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "as",
  "by",
  "from",
  "into",
  "about",
  "against",
  "between",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "up",
  "down",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "any",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "too",
  "very",
  "s",
  "t",
  "can",
  "will",
  "just",
  "don",
  "should",
  "now",
  "d",
  "ll",
  "m",
  "o",
  "re",
  "ve",
  "y",
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
  "what",
  "which",
  "who",
  "whom",
  "am",
  "has",
  "have",
  "had",
  "having",
  "message",
  "text",
  "given",
]);

function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[`_*#>/[\]{}()"',.;:!?\\-]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1 && !STOPWORDS.has(token))
      .map(stem),
  );
}

function flattenState(state: JevState): string {
  return typeof state === "string" ? state : JSON.stringify(state, null, 2);
}

function instructionsText(question: JevQuestion): string {
  return typeof question.instructions === "string"
    ? question.instructions
    : JSON.stringify(question.instructions);
}

function softmax(values: number[], temperature = 0.6): number[] {
  if (values.every((value) => value === 0)) return values.map(() => 1 / values.length);
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp((value - max) / temperature));
  const sum = exps.reduce((total, exp) => total + exp, 0);
  return exps.map((exp) => exp / sum);
}

function affinity(stateTokens: Set<string>, description: string): number {
  const descriptionTokens = tokenize(description);
  let shared = 0;
  for (const token of descriptionTokens) if (stateTokens.has(token)) shared++;
  return shared;
}

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function mockNoulAnswer(question: JevNoulQuestion, stateTokens: Set<string>): JevAnswer {
  const yesText = `${instructionsText(question)} ${question.criteria?.true ?? ""}`;
  const noText = question.criteria?.false ?? "";
  const yes = affinity(stateTokens, yesText);
  const no = affinity(stateTokens, noText);
  const smoothing = 2.5;
  const signal = (yes - no) / (yes + no + smoothing);
  const probability = 1 / (1 + Math.exp(-4 * signal));
  return { type: "noul", noul: round(probability) };
}

function mockChoiceAnswer(question: JevChoiceQuestion, stateTokens: Set<string>): JevAnswer {
  const entries = Object.entries(question.criteria);
  const affinities = entries.map(
    ([option, description]) =>
      affinity(stateTokens, option.replace(/_/g, " ")) * 1.5 +
      affinity(stateTokens, description ?? "") * 1.0,
  );
  const probs = softmax(affinities);
  const probabilities: Record<string, number> = {};
  entries.forEach(([option], i) => {
    probabilities[option] = round(probs[i]);
  });
  let best = 0;
  probs.forEach((prob, i) => {
    if (prob > probs[best]) best = i;
  });
  return {
    type: "choice",
    choice: entries[best][0],
    probabilities,
    confidence: round(probs[best]),
  };
}

function mockScoreAnswer(question: JevScoreQuestion, stateTokens: Set<string>): JevAnswer {
  const affinities = question.criteria.map((level) => affinity(stateTokens, level) + 1e-9);
  const probs = softmax(affinities);
  const legend: Record<string, string> = {};
  const probabilities: Record<string, number> = {};
  question.criteria.forEach((level, i) => {
    legend[String(i)] = level;
    probabilities[String(i)] = round(probs[i]);
  });
  const scoreValue = probs.reduce((total, prob, i) => total + prob * i, 0);
  return {
    type: "score",
    score: round(scoreValue, 2),
    legend,
    probabilities,
    confidence: round(Math.max(...probs)),
  };
}

function mockAnswer(question: JevQuestion, stateTokens: Set<string>): JevAnswer {
  if (question.type === "noul") return mockNoulAnswer(question, stateTokens);
  if (question.type === "choice") return mockChoiceAnswer(question, stateTokens);
  return mockScoreAnswer(question, stateTokens);
}

function choiceDistribution(
  question: JevChoiceQuestion,
  chosen: string,
  confidence: number,
): { choice: string; probabilities: Record<string, number>; confidence: number } {
  const keys = Object.keys(question.criteria);
  const others = keys.filter((key) => key !== chosen);
  const probabilities: Record<string, number> = {};
  if (others.length === 0) {
    probabilities[chosen] = 1;
    return { choice: chosen, probabilities, confidence: 1 };
  }
  const remainder = (1 - confidence) / others.length;
  probabilities[chosen] = confidence;
  for (const key of others) probabilities[key] = remainder;
  return { choice: chosen, probabilities, confidence };
}

function scoreDistribution(
  question: JevScoreQuestion,
  value: number,
  confidenceOverride: number | undefined,
): {
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
} {
  const levelsCount = question.criteria.length;
  const clamped = Math.min(Math.max(value, 0), levelsCount - 1);
  const lower = Math.floor(clamped);
  const upper = Math.min(lower + 1, levelsCount - 1);
  const fraction = clamped - lower;
  const probabilities: Record<string, number> = {};
  for (let i = 0; i < levelsCount; i++) probabilities[String(i)] = 0;
  if (upper === lower) {
    probabilities[String(lower)] = 1;
  } else {
    probabilities[String(lower)] = round(1 - fraction);
    probabilities[String(upper)] = round(fraction);
  }
  const legend: Record<string, string> = {};
  question.criteria.forEach((level, i) => {
    legend[String(i)] = level;
  });
  const peak = Math.max(...Object.values(probabilities));
  return { score: value, legend, probabilities, confidence: confidenceOverride ?? peak };
}

function toBehaviorList(behavior: JevFakeBehavior | JevFakeBehavior[]): JevFakeBehavior[] {
  return Array.isArray(behavior) ? behavior : [behavior];
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("jev fake: timeout", "AbortError")),
      {
        once: true,
      },
    );
  });
}

class FakeJevTransportImpl implements FakeJevTransport {
  readonly provider = "fake" as const;
  readonly calls: JevWireRequest[] = [];
  private scriptedAnswers: Record<string, JevScriptedAnswer>;
  private behaviors: JevFakeBehavior[];
  private behaviorCallIndex = 0;
  private releaseWaiters: Array<() => void> = [];

  constructor(script?: {
    answers?: Record<string, JevScriptedAnswer>;
    behavior?: JevFakeBehavior | JevFakeBehavior[];
  }) {
    this.scriptedAnswers = script?.answers ?? {};
    this.behaviors =
      script?.behavior === undefined ? [{ kind: "answer" }] : toBehaviorList(script.behavior);
  }

  setAnswers(answers: Record<string, JevScriptedAnswer>): void {
    this.scriptedAnswers = answers;
  }

  setBehavior(behavior: JevFakeBehavior | JevFakeBehavior[]): void {
    this.behaviors = toBehaviorList(behavior);
    this.behaviorCallIndex = 0;
  }

  release(): void {
    const waiters = this.releaseWaiters;
    this.releaseWaiters = [];
    for (const waiter of waiters) waiter();
  }

  get held(): number {
    return this.releaseWaiters.length;
  }

  async send(
    request: JevWireRequest,
    { signal }: { signal: AbortSignal },
  ): Promise<JevTransportResponse> {
    this.calls.push(request);
    signal.throwIfAborted();
    const behavior = this.nextBehavior();
    switch (behavior.kind) {
      case "answer":
        return this.answerResponse(request);
      case "timeout":
        return waitForAbort(signal);
      case "http":
        return { status: behavior.status, retryAfterMs: behavior.retryAfterMs ?? null, body: null };
      case "contract-violation":
        return {
          status: 200,
          retryAfterMs: null,
          body: {
            model: "jev-fake",
            answers: {},
            usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
          },
        };
      case "network":
        throw new Error("jev: request failed");
      case "hold":
        return this.holdThenAnswer(request, signal);
    }
  }

  private nextBehavior(): JevFakeBehavior {
    const behavior = this.behaviors[Math.min(this.behaviorCallIndex, this.behaviors.length - 1)];
    this.behaviorCallIndex += 1;
    return behavior;
  }

  private holdThenAnswer(
    request: JevWireRequest,
    signal: AbortSignal,
  ): Promise<JevTransportResponse> {
    return new Promise((resolve, reject) => {
      const resolveHeld = () => {
        signal.removeEventListener("abort", onAbort);
        resolve(this.answerResponse(request));
      };
      const onAbort = () => {
        const index = this.releaseWaiters.indexOf(resolveHeld);
        if (index !== -1) this.releaseWaiters.splice(index, 1);
        reject(new DOMException("jev fake: held call aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.releaseWaiters.push(resolveHeld);
    });
  }

  private answerResponse(request: JevWireRequest): JevTransportResponse {
    const stateTokens = tokenize(flattenState(request.state));
    const answers: Record<string, JevAnswer> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      answers[id] = this.buildAnswer(id, question, stateTokens);
    }
    const bodyBytes = Buffer.byteLength(JSON.stringify(request), "utf8");
    const body: JevWireResponse = {
      model: "jev-fake",
      answers,
      usage: { input_tokens: Math.ceil(bodyBytes / 2.5), output_tokens: 0, cost: 0 },
    };
    return { status: 200, retryAfterMs: null, body };
  }

  private buildAnswer(id: string, question: JevQuestion, stateTokens: Set<string>): JevAnswer {
    const scripted = this.scriptedAnswers[id];
    if (scripted === undefined) return mockAnswer(question, stateTokens);
    if (question.type === "noul" && scripted.type === "noul") {
      return { type: "noul", noul: scripted.noul };
    }
    if (question.type === "choice" && scripted.type === "choice") {
      return {
        type: "choice",
        ...choiceDistribution(question, scripted.choice, scripted.confidence),
      };
    }
    if (question.type === "score" && scripted.type === "score") {
      return { type: "score", ...scoreDistribution(question, scripted.score, scripted.confidence) };
    }
    throw new Error(
      `jev fake: scripted answer for "${id}" is type "${scripted.type}", question is "${question.type}"`,
    );
  }
}

export function createFakeJevTransport(script?: {
  answers?: Record<string, JevScriptedAnswer>;
  behavior?: JevFakeBehavior | JevFakeBehavior[];
}): FakeJevTransport {
  return new FakeJevTransportImpl(script);
}

export interface TestJevServiceOptions {
  answers?: Record<string, JevScriptedAnswer>;
  behavior?: JevFakeBehavior | JevFakeBehavior[];
  /** `agents.jev` as it would appear in `config.json`. Shadow defaults stay on unless it says. */
  config?: Record<string, unknown>;
  /** Defaults to a fresh temporary directory, so the ledger and audit never touch a real home. */
  paseoHome?: string;
  /** Defaults to `paseoHome`, so the D7 roots and the env file resolve inside it. */
  homeDir?: string;
  logger?: Logger;
  transport?: FakeJevTransport;
  service?: Partial<Omit<JevServiceOptions, "transport" | "configReader">>;
}

/**
 * The JEV service over the fake, for any track's tests (docs/jev.md, "The fake"). It runs the same
 * scope check, redactor, lanes and ledger as the live service; only the transport is fake.
 */
export function createTestJevService(
  options: TestJevServiceOptions = {},
): JevServiceRuntime & { transport: FakeJevTransport; paseoHome: string } {
  const paseoHome = options.paseoHome ?? mkdtempSync(path.join(os.tmpdir(), "jev-test-"));
  const homeDir = options.homeDir ?? paseoHome;
  const transport =
    options.transport ??
    createFakeJevTransport({ answers: options.answers, behavior: options.behavior });
  const config = resolveJevConfig(options.config ?? {}, { homeDir });
  const service = createJevService({
    paseoHome,
    homeDir,
    logger: options.logger ?? pino({ level: "silent" }),
    capturedKey: { present: false, value: () => null },
    env: {},
    sleep: async () => undefined,
    ...options.service,
    transport,
    configReader: { read: () => ({ ok: true, config }) },
  });
  return Object.assign(service, { transport, paseoHome });
}
