import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveJevConfig } from "../../jev/config.js";
import type { JevQuestion } from "../../jev/contract.js";
import { createTestJevService, type TestJevServiceOptions } from "../../jev/fake.js";
import { createJevService } from "../../jev/service.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { JEV_ASK_QUESTION_ID, JevSession, type JevAskAgentThread } from "./jev-session.js";

// `jev.ask` end to end through the real JEV service over the fake transport (docs/jev.md,
// "Feature 15: Ask JEV"): the same scope check, redactor, lanes, ledger and audit as every feature.

type AskRequest = Extract<SessionInboundMessage, { type: "jev.ask.request" }>;
type AskResponse = Extract<SessionOutboundMessage, { type: "jev.ask.response" }>;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function harness(
  options: TestJevServiceOptions & {
    readAgentThread?: (agentId: string) => JevAskAgentThread | null;
  } = {},
) {
  const home = tempDir("jev-ask-");
  mkdirSync(path.join(home, "safe"), { recursive: true });
  mkdirSync(path.join(home, "mobile-worktrees", "app"), { recursive: true });
  const { readAgentThread, ...serviceOptions } = options;
  const service = createTestJevService({ paseoHome: home, homeDir: home, ...serviceOptions });
  const emitted: SessionOutboundMessage[] = [];
  const session = new JevSession({
    host: { emit: (msg) => emitted.push(msg) },
    service,
    logger: { warn: vi.fn() },
    readAgentThread,
  });
  async function ask(fields: Partial<AskRequest> & { question: JevQuestion }) {
    await session.handleAsk({
      type: "jev.ask.request",
      requestId: `req-${emitted.length + 1}`,
      context: "",
      ...fields,
    });
    const last = emitted.at(-1) as AskResponse | undefined;
    if (!last || last.type !== "jev.ask.response") throw new Error("no jev.ask.response");
    return last.payload;
  }
  return { home, service, transport: service.transport, ask };
}

const YES_NO: JevQuestion = { type: "noul", instructions: "Is the build still broken?" };
const PICK_ONE: JevQuestion = {
  type: "choice",
  instructions: "Which area does this stack trace point at?",
  criteria: { parser: "Tokenizing and parsing", network: null, storage: "Files on disk" },
};
const SCORE: JevQuestion = {
  type: "score",
  instructions: "How risky is this change?",
  criteria: ["Low", "Medium", "High"],
};

describe("jev.ask through the fake transport", () => {
  it("answers a yes/no question with the probability, the model and the cost", async () => {
    const { ask, transport } = harness({ answers: { answer: { type: "noul", noul: 0.82 } } });

    const payload = await ask({ context: "npm run build exits 2 on main", question: YES_NO });

    expect(payload).toMatchObject({
      outcome: "answered",
      reason: null,
      answer: { type: "noul", noul: 0.82 },
      model: "jev-fake",
      cost: { usd: 0, source: "fake" },
      redactions: 0,
    });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.state).toEqual({ context: "npm run build exits 2 on main" });
    const sent = transport.calls[0]?.questions[JEV_ASK_QUESTION_ID];
    expect(sent?.type).toBe("noul");
    expect(String(sent?.instructions)).toContain("Is the build still broken?");
  });

  it("answers a pick-one question with the chosen option and a distribution over every option", async () => {
    const { ask } = harness({
      answers: { answer: { type: "choice", choice: "storage", confidence: 0.7 } },
    });

    const payload = await ask({ context: "ENOSPC while writing the ledger", question: PICK_ONE });

    expect(payload.outcome).toBe("answered");
    expect(payload.answer).toMatchObject({ type: "choice", choice: "storage", confidence: 0.7 });
    const answer = payload.answer;
    if (answer?.type !== "choice") throw new Error("expected a choice");
    expect(Object.keys(answer.probabilities).sort()).toEqual(["network", "parser", "storage"]);
  });

  it("answers a score question with a position on the declared scale", async () => {
    const { ask } = harness({ answers: { answer: { type: "score", score: 1.4 } } });

    const payload = await ask({ context: "Renames one field", question: SCORE });

    expect(payload.outcome).toBe("answered");
    const answer = payload.answer;
    if (answer?.type !== "score") throw new Error("expected a score");
    expect(answer.score).toBe(1.4);
    expect(answer.legend).toEqual({ "0": "Low", "1": "Medium", "2": "High" });
  });

  it("refuses company text under D7 and sends nothing", async () => {
    const { ask, transport, home } = harness();

    const payload = await ask({
      context: "git clone git@github.com:wonderlydotcom/mobile.git",
      question: YES_NO,
    });

    expect(payload).toMatchObject({
      outcome: "unavailable",
      reason: "excluded",
      answer: null,
      cost: null,
    });
    expect(transport.calls).toHaveLength(0);
    expect(() => readFileSync(path.join(home, "jev", "audit.jsonl"), "utf8")).toThrow();
  });

  it("refuses an attached agent whose cwd is under a D7 root and sends nothing", async () => {
    const { ask, transport, home } = harness({
      service: {
        resolveAgentCwds: async () => [path.join(home, "mobile-worktrees", "app")],
      },
      readAgentThread: () => ({ title: "Fix login", activity: "ran the tests" }),
    });

    const payload = await ask({ agentId: "agent-1", question: YES_NO });

    expect(payload).toMatchObject({ outcome: "unavailable", reason: "excluded" });
    expect(transport.calls).toHaveLength(0);
  });

  it("puts an attached agent's recent activity in the state and records the decision for it", async () => {
    const { ask, transport, home, service } = harness({
      answers: { answer: { type: "noul", noul: 0.3 } },
      service: { resolveAgentCwds: async () => [path.join(home, "safe")] },
      readAgentThread: () => ({ title: "Tidy the parser", activity: "edited parser.ts" }),
    });

    const payload = await ask({ context: "", agentId: "agent-1", question: YES_NO });

    expect(payload.outcome).toBe("answered");
    expect(transport.calls[0]?.state).toEqual({
      context: "",
      agent: { title: "Tidy the parser", recent_activity: "edited parser.ts" },
    });
    expect(service.listDecisions("agent-1")).toMatchObject([
      {
        agentId: "agent-1",
        feature: "askJev",
        question: "Is the build still broken?",
        verdict: "0.3",
        action: "asked by a person in the app",
        applied: true,
      },
    ]);
  });

  it("refuses an agent the host has not loaded without sending", async () => {
    const { ask, transport } = harness({ readAgentThread: () => null });

    const payload = await ask({ agentId: "agent-gone", question: YES_NO });

    expect(payload).toMatchObject({ outcome: "failed", reason: "agent-unavailable", cost: null });
    expect(transport.calls).toHaveLength(0);
  });

  it("reports a timeout with the cost of the attempt it sent", async () => {
    const { ask, transport } = harness({ behavior: { kind: "timeout" } });

    const payload = await ask({ context: "ping", question: YES_NO, deadlineMs: 50 });

    expect(payload).toMatchObject({ outcome: "failed", reason: "timeout", answer: null });
    expect(payload.cost).not.toBeNull();
    expect(transport.calls).toHaveLength(1);
  });

  it("refuses over the interactive lane's daily cap without sending", async () => {
    const { ask, transport } = harness({ config: { askJev: { maxUsdPerDay: 0.000_000_1 } } });

    const payload = await ask({ context: "a question", question: YES_NO });

    expect(payload).toMatchObject({ outcome: "unavailable", reason: "daily-budget" });
    expect(transport.calls).toHaveLength(0);
  });

  it("still answers when the control lane's budget is spent: the lanes are separate", async () => {
    const { ask, service } = harness({
      config: { maxUsdPerDay: 0.000_000_1 },
      answers: { answer: { type: "noul", noul: 0.5 } },
    });

    const payload = await ask({ context: "a question", question: YES_NO });

    expect(payload.outcome).toBe("answered");
    expect(service.status().lanes.interactive.today.answered).toBe(1);
    expect(service.status().lanes.control.today.calls).toBe(0);
  });

  it("tags the audit line as asked by a person on the interactive lane", async () => {
    const { ask, service, home } = harness({ answers: { answer: { type: "noul", noul: 0.9 } } });

    await ask({ context: "is this done", question: YES_NO });
    await service.stop();

    const lines = readFileSync(path.join(home, "jev", "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      feature: "askJev",
      lane: "interactive",
      callSite: "app.ask-jev",
      initiator: "person",
      outcome: "answered",
    });
  });

  it("answers not configured with no key, and never reaches the network", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("no network in this test");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const home = tempDir("jev-ask-nokey-");
    const config = resolveJevConfig({}, { homeDir: home });
    // No transport and no key: the service a daemon builds on a machine without
    // PASEO_JEV_API_KEY. `env` is empty so the Vitest guard is not what stops it.
    const service = createJevService({
      paseoHome: home,
      homeDir: home,
      logger: pino({ level: "silent" }),
      capturedKey: { present: false, value: () => null },
      env: {},
      configReader: { read: () => ({ ok: true, config }) },
    });
    const emitted: SessionOutboundMessage[] = [];
    const session = new JevSession({
      host: { emit: (msg) => emitted.push(msg) },
      service,
      logger: { warn: vi.fn() },
    });

    await session.handleAsk({
      type: "jev.ask.request",
      requestId: "req-1",
      context: "anything",
      question: YES_NO,
    });

    expect(emitted).toEqual([
      {
        type: "jev.ask.response",
        payload: expect.objectContaining({
          requestId: "req-1",
          outcome: "unavailable",
          reason: "no-key",
          cost: null,
        }),
      },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(service.status()).toMatchObject({ available: false, reason: "no-key" });
  });
});
