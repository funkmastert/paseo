import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type {
  JevDecisionRecord,
  JevFeatureId,
  JevLane,
  JevLaneStatus,
  JevSpendTotals,
  JevStatus,
} from "../../../server/jev/contract.js";
import { createTestJevService } from "../../../server/jev/fake.js";
import type { ProviderUsage } from "../../../server/messages.js";
import { buildJevUsage, JevUsageFetcher, summarizeFeatureDay } from "./jev.js";

// Noon local, so "today" is unambiguous whatever zone the test runs in.
const NOW = new Date(2026, 8, 29, 12, 0, 0).getTime();
const YESTERDAY = new Date(2026, 8, 28, 23, 0, 0).toISOString();
const MIDNIGHT = new Date(2026, 8, 30).toISOString();

function totals(overrides: Partial<JevSpendTotals> = {}): JevSpendTotals {
  return {
    calls: 0,
    answered: 0,
    failed: 0,
    unavailable: 0,
    inputTokens: 0,
    usd: 0,
    usdSource: "none",
    ...overrides,
  };
}

function lane(overrides: Partial<JevLaneStatus> = {}): JevLaneStatus {
  return {
    today: totals(),
    maxUsdPerDay: 1,
    exhausted: false,
    circuit: "closed",
    resetsAt: MIDNIGHT,
    ...overrides,
  };
}

const FEATURES: JevFeatureId[] = [
  "spawnHint",
  "remediationTriage",
  "notificationTriage",
  "agentTools",
  "compactionTiming",
  "stallJudgment",
  "awayReply",
  "askJev",
];

function status(overrides: Partial<JevStatus> = {}): JevStatus {
  const features = Object.fromEntries(
    FEATURES.map((feature) => [
      feature,
      { enabled: true, shadow: feature !== "agentTools" && feature !== "askJev" },
    ]),
  ) as JevStatus["features"];
  const byFeature = Object.fromEntries(
    FEATURES.map((feature) => [feature, totals()]),
  ) as JevStatus["todayByFeature"];
  return {
    available: true,
    reason: null,
    keyPresent: true,
    provider: "openrouter",
    providerInferred: false,
    model: "jev-1",
    features,
    lanes: {
      control: lane({ maxUsdPerDay: 1 }),
      agentTools: lane({ maxUsdPerDay: 0.5 }),
      interactive: lane({ maxUsdPerDay: 0.25 }),
    },
    spawnHint: { applyHard: false, applyRole: false },
    agentTools: { assignShare: 0.5 },
    todayByFeature: byFeature,
    last7Days: [],
    ...overrides,
  };
}

function decision(overrides: Partial<JevDecisionRecord> = {}): JevDecisionRecord {
  return {
    agentId: "agent-1",
    callId: "call-1",
    feature: "remediationTriage",
    question: "Should a remediation agent handle this?",
    verdict: "person (0.91)",
    confidence: 0.91,
    action: "remediation agent started",
    applied: false,
    at: new Date(NOW - 60_000).toISOString(),
    costUsd: 0.0002,
    ...overrides,
  };
}

function must<T>(value: T | null): T {
  expect(value).not.toBeNull();
  return value as T;
}

function detail(usage: ProviderUsage, id: string) {
  return usage.details?.find((entry) => entry.id === id);
}

describe("buildJevUsage", () => {
  it("reports each lane's spend against its cap, and today's sent calls", () => {
    const usage = must(
      buildJevUsage(
        status({
          lanes: {
            control: lane({
              today: totals({ calls: 9, unavailable: 2, usd: 0.0123 }),
              maxUsdPerDay: 1,
            }),
            agentTools: lane({ today: totals({ calls: 4, usd: 0.004 }), maxUsdPerDay: 0.5 }),
            interactive: lane({ today: totals({ calls: 1, unavailable: 1 }), maxUsdPerDay: 0.25 }),
          },
        }),
        [],
        NOW,
      ),
    );

    expect(usage).toMatchObject({ providerId: "jev", displayName: "JEV", status: "available" });
    expect(usage.windows).toEqual([]);
    expect(usage.balances).toEqual([
      {
        id: "control-today",
        label: "Control today",
        used: 0.0123,
        limit: 1,
        unit: "usd",
        resetsAt: MIDNIGHT,
      },
      {
        id: "tools-today",
        label: "Agent tools today",
        used: 0.004,
        limit: 0.5,
        unit: "usd",
        resetsAt: MIDNIGHT,
      },
      {
        id: "ask-today",
        label: "Ask JEV today",
        used: 0,
        limit: 0.25,
        unit: "usd",
        resetsAt: MIDNIGHT,
      },
      // 7 + 4 + 0: a refusal sent nothing, so it is not a call.
      { id: "calls-today", label: "Calls today", used: 11, unit: "requests" },
    ]);
  });

  it("is absent (no row at all, not just hidden on the strip) when nobody opted in or JEV is off", () => {
    for (const reason of ["no-key", "disabled"] as const) {
      expect(buildJevUsage(status({ available: false, reason }), [], NOW)).toBeNull();
    }
  });

  it("says why when JEV went quiet on its own", () => {
    const rejected = buildJevUsage(status({ available: false, reason: "key-rejected" }), [], NOW);
    expect(rejected?.status).toBe("error");
    expect(rejected?.error).toMatch(/key was rejected/);

    const unreadable = buildJevUsage(
      status({ available: false, reason: "config-unreadable" }),
      [],
      NOW,
    );
    expect(unreadable?.status).toBe("error");
    expect(unreadable?.error).toMatch(/config\.json/);
  });

  it("turns a spent lane's balance to the warning tone and says its features are off", () => {
    const usage = must(
      buildJevUsage(
        status({
          lanes: {
            control: lane({ today: totals({ usd: 1.02 }), maxUsdPerDay: 1, exhausted: true }),
            agentTools: lane({ maxUsdPerDay: 0.5 }),
            interactive: lane({ maxUsdPerDay: 0.25 }),
          },
        }),
        [],
        NOW,
      ),
    );

    expect(usage.status).toBe("available");
    expect(usage.balances?.find((balance) => balance.id === "control-today")?.tone).toBe("warning");
    expect(usage.balances?.find((balance) => balance.id === "tools-today")?.tone).toBeUndefined();
    // First among the details, so it is the first thing under the balances.
    expect(usage.details?.[0]).toEqual({
      id: "lane:control:spent",
      label: "Control budget spent",
      value:
        "Spawn hint, Remediation triage, Finish triage, Stall judgment, Compaction timing, Away reply off until local midnight",
      tone: "warning",
    });
  });

  it("flags a lane whose circuit is open", () => {
    const usage = must(
      buildJevUsage(
        status({
          lanes: {
            control: lane(),
            agentTools: lane({ circuit: "open", maxUsdPerDay: 0.5 }),
            interactive: lane({ maxUsdPerDay: 0.25 }),
          },
        }),
        [],
        NOW,
      ),
    );
    expect(detail(usage, "lane:agentTools:circuit")).toMatchObject({
      label: "Agent tools paused",
      tone: "warning",
    });
  });

  it("lists every feature with its mode, in strip order", () => {
    const base = status();
    const usage = must(
      buildJevUsage(
        status({
          features: {
            ...base.features,
            compactionTiming: { enabled: false, shadow: true },
            stallJudgment: { enabled: true, shadow: false },
          },
        }),
        [],
        NOW,
      ),
    );

    expect(usage.details?.map((entry) => [entry.label, entry.value])).toEqual([
      ["Spawn hint", "Shadow"],
      ["Remediation triage", "Shadow"],
      ["Finish triage", "Shadow"],
      ["Stall judgment", "Live"],
      ["Compaction timing", "Off"],
      // Feature 14's shadow is its dry run, and it says so in its own word.
      ["Away reply", "Dry run"],
      ["Agent tools", "Live"],
      ["Ask JEV", "Live"],
    ]);
  });

  it("summarizes today's shadow decisions as what they would have changed, with the cost", () => {
    const base = status();
    const usage = must(
      buildJevUsage(
        status({
          todayByFeature: {
            ...base.todayByFeature,
            remediationTriage: totals({ calls: 4, answered: 4, usd: 0.0008 }),
          },
        }),
        [
          decision({ action: "would have: no remediation agent; sent to a person (not applied)" }),
          decision({ action: "would have: no remediation agent; sent to a person (not applied)" }),
          decision({
            action: "would have: remediation agent held for one grace window (not applied)",
          }),
          decision({ action: "remediation agent started" }),
          // Yesterday's decision is not today's.
          decision({ action: "would have: something else (not applied)", at: YESTERDAY }),
        ],
        NOW,
      ),
    );

    expect(detail(usage, "feature:remediationTriage")?.value).toBe(
      "Shadow · 2× would have: no remediation agent; sent to a person, +1 other of 4 decisions · $0.0008",
    );
  });

  it("groups a shadow decision by 'would' wherever it falls, not only at the start", () => {
    const base = status();
    const usage = must(
      buildJevUsage(
        status({
          todayByFeature: {
            ...base.todayByFeature,
            notificationTriage: totals({ calls: 1, answered: 1 }),
          },
        }),
        [
          decision({
            feature: "notificationTriage",
            action: "sent as an alert; would have sent a digest (shadow)",
          }),
        ],
        NOW,
      ),
    );

    expect(detail(usage, "feature:notificationTriage")?.value).toBe(
      "Shadow · 1× would have sent a digest of 1 decision",
    );
  });

  it("reports the spawn hint's answered classes, and how many were applied once live", () => {
    const hints = [
      decision({ feature: "spawnHint", verdict: "task_class mechanical 0.91, reasoning 0.6" }),
      decision({ feature: "spawnHint", verdict: "task_class mechanical 0.88, reasoning 0.4" }),
      decision({
        feature: "spawnHint",
        verdict: "task_class hard 0.7, reasoning 2.1",
        applied: true,
      }),
    ];
    expect(summarizeFeatureDay("spawnHint", true, hints, undefined)).toBe(
      "3 creates answered 2 mechanical, 1 hard",
    );
    expect(summarizeFeatureDay("spawnHint", false, hints, undefined)).toBe(
      "3 creates answered 2 mechanical, 1 hard; 1 changed what code did",
    );
  });

  it("summarizes the away reply's dry run and Ask JEV's questions", () => {
    const replies = [
      decision({
        feature: "awayReply",
        action: "would reply (routine confirmation); dry run, nothing sent",
      }),
      decision({ feature: "awayReply", action: "no reply: needs Tyler" }),
    ];
    expect(summarizeFeatureDay("awayReply", true, replies, undefined)).toBe(
      "1× would reply of 2 decisions",
    );
    expect(
      summarizeFeatureDay(
        "askJev",
        false,
        [decision({ feature: "askJev", applied: true })],
        undefined,
      ),
    ).toBe("1 question today");
    expect(
      summarizeFeatureDay(
        "notificationTriage",
        true,
        [decision({ feature: "notificationTriage", action: "sent as an alert" })],
        undefined,
      ),
    ).toBe("1 decision, none would change anything");
    expect(summarizeFeatureDay("agentTools", false, [], totals({ calls: 5, unavailable: 1 }))).toBe(
      "4 calls today",
    );
    // A live feature whose code kept today's behaviour reads as agreement, not as ignored advice.
    expect(
      summarizeFeatureDay(
        "stallJudgment",
        false,
        [
          decision({ feature: "stallJudgment", applied: true }),
          decision({ feature: "stallJudgment" }),
        ],
        undefined,
      ),
    ).toBe("1 of 2 changed what code did");
  });

  it("labels the fake backend so its $0 is not read as free JEV", () => {
    expect(must(buildJevUsage(status({ provider: "fake" }), [], NOW)).planLabel).toBe(
      "fake backend",
    );
    expect(must(buildJevUsage(status({ provider: "typesafe" }), [], NOW)).planLabel).toBeNull();
  });

  it("keeps a feature's spend readable under a cent, matching the popover's cost format", () => {
    const base = status();
    const usage = must(
      buildJevUsage(
        status({
          todayByFeature: { ...base.todayByFeature, stallJudgment: totals({ usd: 0.0004 }) },
        }),
        [],
        NOW,
      ),
    );
    expect(detail(usage, "feature:stallJudgment")?.value).toBe("Shadow · $0.0004");
  });
});

describe("JevUsageFetcher", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it("reports nothing on a daemon without a JEV service", async () => {
    const fetcher = new JevUsageFetcher({ readStatus: () => null });
    await expect(fetcher.fetchUsage()).resolves.toBeNull();
  });

  it("reads the real service over the fake: a call shows up in the lane and the feature line", async () => {
    const jev = createTestJevService({
      answers: { answer: { type: "choice", choice: "yes", confidence: 0.9 } },
    });
    homes.push(jev.paseoHome);
    const outcome = await jev.decide({
      feature: "askJev",
      callSite: "test",
      state: { context: "a question" },
      questions: {
        answer: { type: "choice", instructions: "Pick", criteria: { yes: null, no: null } },
      },
      scope: { cwds: [] },
    });
    expect(outcome.kind).toBe("answered");
    jev.decisions.record({
      agentId: "agent-1",
      callId: outcome.callId,
      feature: "askJev",
      question: "Pick",
      verdict: "yes 0.9",
      confidence: 0.9,
      action: "asked by a person in the app",
      applied: true,
    });

    const fetcher = new JevUsageFetcher({
      readStatus: () => jev.status(),
      readDecisions: () => jev.listDecisions("agent-1"),
    });
    const usage = await fetcher.fetchUsage();

    expect(usage?.status).toBe("available");
    expect(usage?.planLabel).toBe("fake backend");
    expect(usage?.balances?.find((balance) => balance.id === "calls-today")?.used).toBe(1);
    expect(usage?.details?.find((entry) => entry.id === "feature:askJev")?.value).toBe(
      "Live · 1 question today",
    );
    const lanes: JevLane[] = ["control", "agentTools", "interactive"];
    expect(lanes.map((id) => jev.status().lanes[id].exhausted)).toEqual([false, false, false]);
  });
});
