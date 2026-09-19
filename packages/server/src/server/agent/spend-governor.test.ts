import { describe, expect, test } from "vitest";
import {
  isFanOutBlocked,
  parseBudgetLabel,
  planSpendGovernorActions,
  SPEND_BUDGET_LABEL,
  type SpendGovernorAgentInput,
  type SpendGovernorConfig,
  type SpendGovernorState,
} from "./spend-governor.js";

function config(overrides: Partial<SpendGovernorConfig> = {}): SpendGovernorConfig {
  return {
    enabled: true,
    dryRun: false,
    defaultBudgetTokens: null,
    downgradeToModel: "claude-sonnet-5",
    notify: { enabled: true, atFraction: 0.75 },
    downgrade: { enabled: true, atFraction: 1 },
    stopFanOut: { enabled: true, atFraction: 1 },
    pause: { enabled: true, atFraction: 1.5 },
    ...overrides,
  };
}

function agent(overrides: Partial<SpendGovernorAgentInput> = {}): SpendGovernorAgentInput {
  return {
    id: "agent-1",
    labels: { [SPEND_BUDGET_LABEL]: "1M" },
    totalTokens: 0,
    isRunning: true,
    model: "claude-opus-5",
    ...overrides,
  };
}

function stagesFor(input: {
  agent?: Partial<SpendGovernorAgentInput>;
  config?: Partial<SpendGovernorConfig>;
  previousState?: SpendGovernorState;
}): string[] {
  return planSpendGovernorActions({
    agent: agent(input.agent),
    config: config(input.config),
    previousState: input.previousState,
  }).actions.map((action) => action.stage);
}

describe("parseBudgetLabel", () => {
  test.each([
    ["300000", 300_000],
    ["300k", 300_000],
    ["300K", 300_000],
    ["1.5M", 1_500_000],
    ["2_000_000", 2_000_000],
    [" 500k ", 500_000],
  ])("parses %s", (value, expected) => {
    expect(parseBudgetLabel(value)).toBe(expected);
  });

  test.each([
    ["", null],
    ["lots", null],
    ["-5", null],
    ["0", null],
    ["3 tokens", null],
  ])("refuses to guess at %s", (value, expected) => {
    // A misread budget either throttles healthy work or governs nothing, so anything that
    // isn't unambiguously a token count is treated as no budget at all.
    expect(parseBudgetLabel(value)).toBe(expected);
  });

  test("undefined is no budget, not zero", () => {
    expect(parseBudgetLabel(undefined)).toBeNull();
  });
});

describe("planSpendGovernorActions", () => {
  test("a healthy busy agent well inside its budget is never acted on", () => {
    // The regression that matters most: this agent is spending hard — 900K weighted tokens,
    // more than either real implementation agent measured on this machine spent in total — and
    // it is doing exactly what it was asked to. Nothing fires because its caller sized the task.
    expect(stagesFor({ agent: { totalTokens: 700_000 } })).toEqual([]);
    expect(stagesFor({ agent: { totalTokens: 749_999 } })).toEqual([]);
  });

  test("an agent with no declared budget is not governed at all", () => {
    expect(stagesFor({ agent: { labels: {}, totalTokens: 50_000_000 } })).toEqual([]);
  });

  test("an unbudgeted agent is governed once defaultBudgetTokens is set", () => {
    expect(
      stagesFor({
        agent: { labels: {}, totalTokens: 900_000 },
        config: { defaultBudgetTokens: 1_000_000 },
      }),
    ).toEqual(["notify"]);
  });

  test("a declared budget wins over the configured default", () => {
    expect(
      stagesFor({
        agent: { labels: { [SPEND_BUDGET_LABEL]: "10M" }, totalTokens: 900_000 },
        config: { defaultBudgetTokens: 1_000_000 },
      }),
    ).toEqual([]);
  });

  test("a provider that reports no spend is never governed", () => {
    expect(stagesFor({ agent: { totalTokens: undefined } })).toEqual([]);
  });

  test("the ladder fires in order as spend climbs", () => {
    const cfg = config();
    let state: SpendGovernorState | undefined;
    const seen: string[][] = [];
    for (const totalTokens of [700_000, 800_000, 1_100_000, 1_600_000]) {
      const result = planSpendGovernorActions({
        agent: agent({ totalTokens }),
        config: cfg,
        previousState: state,
      });
      state = result.nextState;
      seen.push(result.actions.map((action) => action.stage));
    }
    expect(seen).toEqual([[], ["notify"], ["downgrade", "stopFanOut"], ["pause"]]);
  });

  test("a stage fires once per episode, not once per sweep", () => {
    const cfg = config();
    const first = planSpendGovernorActions({
      agent: agent({ totalTokens: 800_000 }),
      config: cfg,
      previousState: undefined,
    });
    expect(first.actions.map((a) => a.stage)).toEqual(["notify"]);

    const second = planSpendGovernorActions({
      agent: agent({ totalTokens: 850_000 }),
      config: cfg,
      previousState: first.nextState,
    });
    expect(second.actions).toEqual([]);
  });

  test("an agent that jumps past several thresholds in one sweep gets the whole ladder at once", () => {
    // 60 seconds at the measured healthy rate is ~200K weighted tokens, so a small budget can
    // be blown through several stages between two sweeps. It must still be told before it is
    // paused, which is what the ladder ordering guarantees.
    expect(stagesFor({ agent: { totalTokens: 2_000_000 } })).toEqual([
      "notify",
      "downgrade",
      "stopFanOut",
      "pause",
    ]);
  });

  test("each stage switches independently", () => {
    expect(
      stagesFor({
        agent: { totalTokens: 2_000_000 },
        config: {
          notify: { enabled: false, atFraction: 0.75 },
          downgrade: { enabled: false, atFraction: 1 },
          pause: { enabled: false, atFraction: 1.5 },
        },
      }),
    ).toEqual(["stopFanOut"]);
  });

  test("the whole governor off means no actions and no carried state", () => {
    const result = planSpendGovernorActions({
      agent: agent({ totalTokens: 5_000_000 }),
      config: config({ enabled: false }),
      previousState: {
        budgetTokens: 1_000_000,
        firedStages: ["stopFanOut"],
        fanOutBlocked: true,
        wasRunning: true,
        undeliveredStages: [],
      },
    });
    expect(result.actions).toEqual([]);
    // State is dropped, which is what releases an agent whose fan-out was blocked.
    expect(result.nextState).toBeUndefined();
    expect(isFanOutBlocked(result.nextState)).toBe(false);
  });

  test("downgrade and pause wait for a running agent instead of being written off", () => {
    const idle = planSpendGovernorActions({
      agent: agent({ totalTokens: 2_000_000, isRunning: false }),
      config: config(),
      previousState: undefined,
    });
    expect(idle.actions.map((a) => a.stage)).toEqual(["notify", "stopFanOut"]);

    const resumed = planSpendGovernorActions({
      agent: agent({ totalTokens: 2_000_000, isRunning: true }),
      config: config(),
      previousState: idle.nextState,
    });
    // The two that fired while it was idle are said to it now, and the two that waited for a
    // running agent happen now. Ladder order throughout.
    expect(resumed.actions).toEqual([
      expect.objectContaining({ stage: "notify", redelivery: true }),
      expect.objectContaining({ stage: "stopFanOut", redelivery: true }),
      expect.objectContaining({ stage: "downgrade" }),
      expect.objectContaining({ stage: "pause" }),
    ]);
  });

  // `notify` is the only stage on by default and its whole value is the chance to wrap up
  // early. An agent that crossed 0.75x between turns was marked told and never heard a word.
  test("notify reaches an agent that was idle when it crossed", () => {
    const crossedWhileIdle = planSpendGovernorActions({
      agent: agent({ totalTokens: 800_000, isRunning: false }),
      config: config({
        downgrade: { enabled: false, atFraction: 1 },
        stopFanOut: { enabled: false, atFraction: 1 },
        pause: { enabled: false, atFraction: 1.5 },
      }),
      previousState: undefined,
    });
    expect(crossedWhileIdle.actions.map((a) => a.stage)).toEqual(["notify"]);
    expect(crossedWhileIdle.nextState?.undeliveredStages).toEqual(["notify"]);

    const resumed = planSpendGovernorActions({
      agent: agent({ totalTokens: 850_000, isRunning: true }),
      config: config({
        downgrade: { enabled: false, atFraction: 1 },
        stopFanOut: { enabled: false, atFraction: 1 },
        pause: { enabled: false, atFraction: 1.5 },
      }),
      previousState: crossedWhileIdle.nextState,
    });
    expect(resumed.actions).toEqual([
      // The spend as it reads now, not as it read when the stage fired: the agent is about to
      // read this sentence and should get the number it can still act on.
      expect.objectContaining({ stage: "notify", redelivery: true, spentTokens: 850_000 }),
    ]);
    expect(resumed.nextState?.undeliveredStages).toEqual([]);
  });

  test("a message owed is said once, not every sweep after", () => {
    const idle = planSpendGovernorActions({
      agent: agent({ totalTokens: 800_000, isRunning: false }),
      config: config({ pause: { enabled: false, atFraction: 1.5 } }),
      previousState: undefined,
    });
    const resumed = planSpendGovernorActions({
      agent: agent({ totalTokens: 850_000, isRunning: true }),
      config: config({ pause: { enabled: false, atFraction: 1.5 } }),
      previousState: idle.nextState,
    });
    expect(resumed.actions.filter((a) => a.redelivery)).not.toEqual([]);

    const later = planSpendGovernorActions({
      agent: agent({ totalTokens: 900_000, isRunning: true }),
      config: config({ pause: { enabled: false, atFraction: 1.5 } }),
      previousState: resumed.nextState,
    });
    expect(later.actions).toEqual([]);
  });

  test("a dry run owes nothing, because it says nothing", () => {
    const idle = planSpendGovernorActions({
      agent: agent({ totalTokens: 800_000, isRunning: false }),
      config: config({ dryRun: true }),
      previousState: undefined,
    });
    expect(idle.nextState?.undeliveredStages).toEqual([]);

    const resumed = planSpendGovernorActions({
      agent: agent({ totalTokens: 850_000, isRunning: true }),
      config: config({ dryRun: true }),
      previousState: idle.nextState,
    });
    expect(resumed.actions.filter((a) => a.redelivery)).toEqual([]);
  });

  test("downgrade is skipped, and not retried forever, when there is nowhere to go", () => {
    const noTarget = planSpendGovernorActions({
      agent: agent({ totalTokens: 1_100_000 }),
      config: config({ downgradeToModel: null }),
      previousState: undefined,
    });
    expect(noTarget.actions.map((a) => a.stage)).toEqual(["notify", "stopFanOut"]);
    expect(noTarget.nextState?.firedStages).toContain("downgrade");

    const already = planSpendGovernorActions({
      agent: agent({ totalTokens: 1_100_000, model: "claude-sonnet-5" }),
      config: config(),
      previousState: undefined,
    });
    expect(already.actions.map((a) => a.stage)).toEqual(["notify", "stopFanOut"]);
  });

  test("raising the budget starts a fresh episode so a paused agent can be released", () => {
    const capped = planSpendGovernorActions({
      agent: agent({ totalTokens: 2_000_000 }),
      config: config(),
      previousState: undefined,
    });
    expect(isFanOutBlocked(capped.nextState)).toBe(true);

    const raised = planSpendGovernorActions({
      agent: agent({ totalTokens: 2_000_000, labels: { [SPEND_BUDGET_LABEL]: "4M" } }),
      config: config(),
      previousState: capped.nextState,
    });
    expect(raised.actions).toEqual([]);
    expect(isFanOutBlocked(raised.nextState)).toBe(false);
  });

  test("a dry run plans every stage but never blocks fan-out", () => {
    const result = planSpendGovernorActions({
      agent: agent({ totalTokens: 2_000_000 }),
      config: config({ dryRun: true }),
      previousState: undefined,
    });
    expect(result.actions.map((a) => a.stage)).toEqual([
      "notify",
      "downgrade",
      "stopFanOut",
      "pause",
    ]);
    // Reported once — the stages are marked fired — but the gate `create_agent` reads stays open.
    expect(result.nextState?.firedStages).toContain("stopFanOut");
    expect(isFanOutBlocked(result.nextState)).toBe(false);
  });

  test("a downgrade action carries the model to move to", () => {
    const [action] = planSpendGovernorActions({
      agent: agent({ totalTokens: 1_100_000 }),
      config: config({
        notify: { enabled: false, atFraction: 0.75 },
        stopFanOut: { enabled: false, atFraction: 1 },
      }),
      previousState: undefined,
    }).actions;
    expect(action).toMatchObject({
      agentId: "agent-1",
      stage: "downgrade",
      budgetTokens: 1_000_000,
      spentTokens: 1_100_000,
      targetModel: "claude-sonnet-5",
    });
  });
  // A guard rail that fires once and then never again reads as protection while the agent it
  // stopped runs on unbounded. Measured before this: an agent paused at 450K of a 300K budget,
  // re-prompted, and taken to 2.45M — eight times its budget — planned nothing at all.
  test("pause re-arms when somebody starts the agent again", () => {
    const paused = planSpendGovernorActions({
      agent: agent({ totalTokens: 1_600_000 }),
      config: config(),
      previousState: undefined,
    });
    expect(paused.actions.map((action) => action.stage)).toContain("pause");
    // The sweep that pauses records the agent as stopped: the cancel it just planned is what
    // stops it, and the restart may land before the next sweep looks.
    expect(paused.nextState?.wasRunning).toBe(false);

    const restarted = planSpendGovernorActions({
      agent: agent({ totalTokens: 2_400_000, isRunning: true }),
      config: config(),
      previousState: paused.nextState,
    });
    expect(restarted.actions.map((action) => action.stage)).toContain("pause");
  });

  test("pause does not re-fire twice for one turn", () => {
    const paused = planSpendGovernorActions({
      agent: agent({ totalTokens: 1_600_000 }),
      config: config(),
      previousState: undefined,
    });

    // The cancel has not settled yet, so the agent is still mid-turn on the next sweep. It was
    // never observed stopped, so there is no restart to answer.
    const stillSettling = planSpendGovernorActions({
      agent: agent({ totalTokens: 1_650_000, isRunning: true }),
      config: config(),
      previousState: { ...paused.nextState!, wasRunning: true },
    });
    expect(stillSettling.actions).toEqual([]);
  });

  test("an agent left idle over its budget is not paused again on its own", () => {
    const paused = planSpendGovernorActions({
      agent: agent({ totalTokens: 1_600_000 }),
      config: config(),
      previousState: undefined,
    });

    const stillIdle = planSpendGovernorActions({
      agent: agent({ totalTokens: 1_600_000, isRunning: false }),
      config: config(),
      previousState: paused.nextState,
    });
    expect(stillIdle.actions).toEqual([]);
  });

  test("raising the budget past the spend releases a paused agent", () => {
    const paused = planSpendGovernorActions({
      agent: agent({ totalTokens: 1_600_000 }),
      config: config(),
      previousState: undefined,
    });

    // A human raises the label to 4M. That is a fresh episode, and 1.6M is under every stage.
    const released = planSpendGovernorActions({
      agent: agent({ totalTokens: 1_600_000, labels: { [SPEND_BUDGET_LABEL]: "4M" } }),
      config: config(),
      previousState: paused.nextState,
    });
    expect(released.actions).toEqual([]);
    expect(released.nextState?.firedStages).toEqual([]);
  });
});
