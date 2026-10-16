import { describe, expect, it } from "vitest";
import type { JevStatus } from "@getpaseo/protocol/jev/rpc-schemas";
import {
  ASK_JEV_DEADLINE_MS,
  ASK_JEV_MAX_CONTEXT_BYTES,
  ASK_JEV_MAX_LEVELS,
  openAskJevForm,
  resolveAskJevAvailability,
  utf8ByteLength,
  type AskJevFormModel,
} from "./ask-jev-form-model";
import type { AskJevPayload } from "./ask-jev-result";

const HOSTS = [
  { serverId: "srv-a", label: "Studio" },
  { serverId: "srv-b", label: "Laptop" },
];

function readyForm(defaultServerId: string | null = "srv-a"): AskJevFormModel {
  const model = openAskJevForm({ hosts: HOSTS, defaults: { serverId: defaultServerId } });
  model.applyAvailability(model.getState().selectedServerId ?? "", { kind: "ready", fake: false });
  return model;
}

const ANSWERED_NOUL: AskJevPayload = {
  requestId: "req-1",
  callId: "call-1",
  outcome: "answered",
  reason: null,
  answer: { type: "noul", noul: 0.82 },
  model: "jev-fake",
  elapsedMs: 12,
  cost: { usd: 0, source: "fake" },
  redactions: 0,
};

describe("openAskJevForm", () => {
  it("opens on the default host with a yes/no question, empty context and a Low–High scale", () => {
    const state = openAskJevForm({ hosts: HOSTS, defaults: { serverId: "srv-b" } }).getState();

    expect(state.selectedServerId).toBe("srv-b");
    expect(state.hostDisplay).toEqual({ label: "Laptop" });
    expect(state.answerType).toBe("noul");
    expect(state.options).toHaveLength(2);
    expect(state.levels.map((level) => level.label)).toEqual(["Low", "Medium", "High"]);
    expect(state.scalePreset).toBe("low-high");
    expect(state.availability).toEqual({ kind: "checking" });
    expect(state.canSubmit).toBe(false);
  });

  it("falls back to the first host when the default is unknown", () => {
    const state = openAskJevForm({ hosts: HOSTS, defaults: { serverId: "gone" } }).getState();
    expect(state.selectedServerId).toBe("srv-a");
  });

  it("builds a yes/no request, with criteria only when described", () => {
    const model = readyForm();
    model.setContext("npm run build exits 2");
    model.setQuestion("  Is the build broken?  ");

    const plain = model.submit();
    expect(plain).toEqual({
      token: 1,
      serverId: "srv-a",
      request: {
        context: "npm run build exits 2",
        question: { type: "noul", instructions: "Is the build broken?" },
        deadlineMs: ASK_JEV_DEADLINE_MS,
      },
    });

    model.cancel();
    model.setDescribeOptions(true);
    model.setYesMeans("It fails on main");
    const described = model.submit();
    expect(described?.request.question).toEqual({
      type: "noul",
      instructions: "Is the build broken?",
      criteria: { true: "It fails on main" },
    });
  });

  it("builds a pick-one request from the filled options, with descriptions when asked", () => {
    const model = readyForm();
    model.setAnswerType("choice");
    model.setQuestion("Which area?");
    const [first, second] = model.getState().options;
    model.setOptionLabel(first!.id, "parser");
    model.setOptionLabel(second!.id, "network");
    model.addOption();
    model.setDescribeOptions(true);
    model.setOptionDescription(first!.id, "Tokenizing and parsing");

    const submission = model.submit();

    // The blank third row is dropped, and an undescribed option is null.
    expect(submission?.request.question).toEqual({
      type: "choice",
      instructions: "Which area?",
      criteria: { parser: "Tokenizing and parsing", network: null },
    });
  });

  it("builds a score request from the levels, lowest first", () => {
    const model = readyForm();
    model.setAnswerType("score");
    model.setQuestion("How risky?");
    model.setScalePreset("one-to-five");

    expect(model.submit()?.request.question).toEqual({
      type: "score",
      instructions: "How risky?",
      criteria: ["1", "2", "3", "4", "5"],
    });
  });

  it("attaches the selected agent and drops it when the host changes", () => {
    const model = readyForm();
    model.setAgent("agent-1", { label: "Fix login" });
    model.setQuestion("Is it stuck?");
    expect(model.submit()?.request.agentId).toBe("agent-1");

    model.setHost("srv-b", { label: "Laptop" });
    const state = model.getState();
    expect(state.agentId).toBeNull();
    expect(state.agentDisplay).toBeNull();
    expect(state.run).toEqual({ status: "idle" });
    expect(state.availability).toEqual({ kind: "checking" });
  });

  it("shows field errors only after a submit, and does not send", () => {
    const model = readyForm();
    model.setAnswerType("choice");
    expect(model.getState().errors).toEqual({
      context: null,
      question: null,
      options: null,
      levels: null,
    });

    expect(model.submit()).toBeNull();

    const state = model.getState();
    expect(state.errors.question).toBe("Enter a question");
    expect(state.errors.options).toBe("Add at least two options");
    expect(state.run).toEqual({ status: "idle" });
  });

  it("refuses duplicate options and unnamed levels", () => {
    const model = readyForm();
    model.setQuestion("Which?");
    model.setAnswerType("choice");
    const [first, second] = model.getState().options;
    model.setOptionLabel(first!.id, "same");
    model.setOptionLabel(second!.id, " same ");
    expect(model.submit()).toBeNull();
    expect(model.getState().errors.options).toBe("Each option needs a different name");

    model.setAnswerType("score");
    model.setLevelLabel(model.getState().levels[1]!.id, "  ");
    expect(model.submit()).toBeNull();
    expect(model.getState().errors.levels).toBe("Name every level");
  });

  it("flags an over-size context while typing", () => {
    const model = readyForm();
    model.setContext("x".repeat(ASK_JEV_MAX_CONTEXT_BYTES + 1));
    expect(model.getState().errors.context).toBe("Context is over 60 KB");
    model.setQuestion("Too big?");
    expect(model.submit()).toBeNull();
  });

  it("switches the scale to custom when a level is edited, and back when it matches a preset", () => {
    const model = readyForm();
    model.setAnswerType("score");
    const first = model.getState().levels[0]!;

    model.setLevelLabel(first.id, "None");
    expect(model.getState().scalePreset).toBe("custom");

    model.setLevelLabel(first.id, "Low");
    expect(model.getState().scalePreset).toBe("low-high");
  });

  it("keeps two options and two levels, and caps levels at JEV's ten", () => {
    const model = readyForm();
    const options = model.getState().options;
    model.removeOption(options[0]!.id);
    expect(model.getState().options).toHaveLength(2);

    const levels = model.getState().levels;
    model.removeLevel(levels[0]!.id);
    model.removeLevel(levels[1]!.id);
    expect(model.getState().levels).toHaveLength(2);

    for (let index = 0; index < 20; index += 1) model.addLevel();
    expect(model.getState().levels).toHaveLength(ASK_JEV_MAX_LEVELS);
    expect(model.getState().canAddLevel).toBe(false);
  });

  it("cannot submit until the host is ready", () => {
    const model = openAskJevForm({ hosts: HOSTS, defaults: { serverId: "srv-a" } });
    model.setQuestion("Anything?");
    model.applyAvailability("srv-a", { kind: "not-configured" });
    expect(model.getState().canSubmit).toBe(false);
    expect(model.submit()).toBeNull();

    // Availability for another host is ignored.
    model.applyAvailability("srv-b", { kind: "ready", fake: false });
    expect(model.getState().canSubmit).toBe(false);

    model.applyAvailability("srv-a", { kind: "ready", fake: false });
    expect(model.getState().canSubmit).toBe(true);
  });

  it("settles the pending run with the mapped answer and ignores a stale token", () => {
    const model = readyForm();
    model.setQuestion("Is it done?");
    const submission = model.submit()!;
    expect(model.getState().run).toEqual({ status: "pending", token: submission.token });
    expect(model.getState().canSubmit).toBe(false);

    model.settle(submission.token + 1, ANSWERED_NOUL);
    expect(model.getState().run.status).toBe("pending");

    model.settle(submission.token, ANSWERED_NOUL);
    const run = model.getState().run;
    if (run.status !== "settled") throw new Error("expected settled");
    expect(run.result).toMatchObject({ kind: "answer", headline: "Yes" });
  });

  it("drops an answer that arrives after cancel", () => {
    const model = readyForm();
    model.setQuestion("Is it done?");
    const submission = model.submit()!;

    model.cancel();
    model.settle(submission.token, ANSWERED_NOUL);

    expect(model.getState().run).toEqual({ status: "cancelled" });
    expect(model.getState().canSubmit).toBe(true);
  });

  it("settles a client failure as a notice", () => {
    const model = readyForm();
    model.setQuestion("Is it done?");
    const submission = model.submit()!;

    model.fail(submission.token, new Error("Timeout waiting for message (17000ms)"));

    const run = model.getState().run;
    if (run.status !== "settled") throw new Error("expected settled");
    expect(run.result).toMatchObject({ kind: "notice", title: "The host did not reply" });
  });

  it("moves to the next host when the selected one disappears", () => {
    const model = readyForm();
    model.setAgent("agent-1", { label: "Fix login" });

    model.applyHosts([HOSTS[1]!]);

    const state = model.getState();
    expect(state.selectedServerId).toBe("srv-b");
    expect(state.hostDisplay).toEqual({ label: "Laptop" });
    expect(state.agentId).toBeNull();
  });
});

const BASE_STATUS: JevStatus = {
  available: true,
  reason: null,
  keyPresent: true,
  provider: "openrouter",
  model: "~typesafe/jev-latest",
  features: { askJev: { enabled: true, shadow: false } },
  lanes: {
    interactive: {
      today: {
        calls: 0,
        answered: 0,
        failed: 0,
        unavailable: 0,
        inputTokens: 0,
        usd: 0,
        usdSource: "none",
      },
      maxUsdPerDay: 0.25,
      exhausted: false,
      circuit: "closed",
      resetsAt: "2026-09-30T07:00:00.000Z",
    },
  },
  spawnHint: { applyHard: false, applyRole: false },
  agentTools: { assignShare: 0.5 },
  todayByFeature: {},
  last7Days: [],
};

describe("resolveAskJevAvailability", () => {
  const base = { hasHost: true, connected: true, supportsAsk: true, statusFailed: false };

  it("asks for a host update when the daemon predates jev.ask", () => {
    expect(resolveAskJevAvailability({ ...base, supportsAsk: false, status: undefined })).toEqual({
      kind: "update-host",
    });
  });

  it("says not configured when the host has no key", () => {
    expect(
      resolveAskJevAvailability({
        ...base,
        status: { ...BASE_STATUS, available: false, reason: "no-key", keyPresent: false },
      }),
    ).toEqual({ kind: "not-configured" });
  });

  it("reports a switched-off feature and a spent lane", () => {
    expect(
      resolveAskJevAvailability({
        ...base,
        status: { ...BASE_STATUS, features: { askJev: { enabled: false, shadow: false } } },
      }),
    ).toEqual({ kind: "off", reason: "feature-disabled" });
    expect(
      resolveAskJevAvailability({
        ...base,
        status: {
          ...BASE_STATUS,
          lanes: { interactive: { ...BASE_STATUS.lanes.interactive!, exhausted: true } },
        },
      }),
    ).toEqual({ kind: "budget-spent", capUsd: 0.25, resetsAt: "2026-09-30T07:00:00.000Z" });
  });

  it("is ready, and says when the backend is the fake", () => {
    expect(resolveAskJevAvailability({ ...base, status: BASE_STATUS })).toEqual({
      kind: "ready",
      fake: false,
    });
    expect(
      resolveAskJevAvailability({ ...base, status: { ...BASE_STATUS, provider: "fake" } }),
    ).toEqual({ kind: "ready", fake: true });
  });

  it("waits for a connection and a status, but a failed status read does not block", () => {
    expect(resolveAskJevAvailability({ ...base, connected: false, status: undefined })).toEqual({
      kind: "connecting",
    });
    expect(resolveAskJevAvailability({ ...base, status: undefined })).toEqual({
      kind: "checking",
    });
    expect(resolveAskJevAvailability({ ...base, status: undefined, statusFailed: true })).toEqual({
      kind: "ready",
      fake: false,
    });
  });
});

describe("utf8ByteLength", () => {
  it("counts multi-byte characters and surrogate pairs", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("中")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
  });
});
