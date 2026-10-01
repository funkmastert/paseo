import type {
  JevSavingsEvent,
  JevSavingsFeatureSummary,
  JevSavingsRange,
  JevSavingsSummary,
} from "@/jev/jev-savings-types";

/**
 * Canned savings data standing in for `jev.savings.summary` / `jev.savings.events` until the
 * savings ledger's handlers land. Shapes a believable story across the three ranges: `spawnHint`,
 * `notificationTriage`, `stallJudgment` and `readCheck` are shadow and not yet past their evidence
 * rule; `remediationTriage` is shadow and past it, ready for Tyler to flip; `agentTools` and
 * `askJev` are live; `compactionTiming` is dormant; `awayReply` is dry run.
 */

function zeroTotals() {
  return { involvements: 0, changed: 0, tokens: 0, otherBenefit: null, pending: 0 };
}

const TODAY_FEATURES: JevSavingsFeatureSummary[] = [
  {
    feature: "spawnHint",
    state: "shadow",
    benefit: "tokens",
    asked: 14,
    notAsked: { excluded: 2, inactive: 1 },
    live: zeroTotals(),
    shadow: { involvements: 14, changed: 3, tokens: 1840, otherBenefit: null, pending: 0 },
    validation: { checked: 0, held: 0, wrong: 0 },
    jevUsd: 0.0021,
    evidence: {
      rule: "50 settled unlabelled children, and a positive would-have sum after upward moves",
      observed: "31 of 50 settled, would-have sum +12,460 tokens",
      met: false,
    },
  },
  {
    feature: "remediationTriage",
    state: "shadow",
    benefit: "tokens",
    asked: 3,
    notAsked: {},
    live: zeroTotals(),
    shadow: { involvements: 3, changed: 1, tokens: 9400, otherBenefit: null, pending: 0 },
    validation: { checked: 3, held: 3, wrong: 0 },
    jevUsd: 0.0009,
    evidence: {
      rule: "20 would-be skips or deferrals, at most 1 in 5 contradicted",
      observed: "22 would-be skips or deferrals, 1 contradicted (4.5%)",
      met: true,
    },
  },
  {
    feature: "notificationTriage",
    state: "shadow",
    benefit: "attention",
    asked: 6,
    notAsked: {},
    live: zeroTotals(),
    shadow: {
      involvements: 6,
      changed: 2,
      tokens: 0,
      otherBenefit: { unit: "pushes-held", value: 4 },
      pending: 0,
    },
    validation: { checked: 4, held: 4, wrong: 0 },
    jevUsd: 0.0004,
    evidence: {
      rule: "50 would-be notices with a follow-up, at least 80% held",
      observed: "41 would-be notices with a follow-up, 100% held",
      met: false,
    },
  },
  {
    feature: "agentTools",
    state: "live",
    benefit: "tokens",
    asked: 22,
    notAsked: { "secret-path": 2, "outside-cwd": 1 },
    live: { involvements: 22, changed: 22, tokens: 15200, otherBenefit: null, pending: 2 },
    shadow: zeroTotals(),
    validation: { checked: 18, held: 15, wrong: 3 },
    jevUsd: 0.0187,
    evidence: {
      rule: "over half of the file tools' calls end in a regret read, or the D8 report's kill rule",
      observed: "3 of 18 checked calls ended in a regret (16.7%)",
      met: false,
    },
  },
  {
    feature: "compactionTiming",
    state: "dormant",
    benefit: "none",
    asked: 0,
    notAsked: {},
    live: zeroTotals(),
    shadow: zeroTotals(),
    validation: { checked: 0, held: 0, wrong: 0 },
    jevUsd: 0,
    evidence: { rule: "—", observed: "Dormant while leader compaction is off", met: null },
  },
  {
    feature: "stallJudgment",
    state: "shadow",
    benefit: "tokens",
    asked: 2,
    notAsked: {},
    live: zeroTotals(),
    shadow: { involvements: 2, changed: 1, tokens: 4100, otherBenefit: null, pending: 1 },
    validation: { checked: 1, held: 1, wrong: 0 },
    jevUsd: 0.0003,
    evidence: {
      rule: "10 person-first labels whose agent ran, at least 70% of those agents ended NOT FIXED",
      observed: "4 of 10 person-first labels",
      met: false,
    },
  },
  {
    feature: "awayReply",
    state: "shadow",
    benefit: "time",
    asked: 5,
    notAsked: { excluded: 3 },
    live: zeroTotals(),
    shadow: {
      involvements: 5,
      changed: 4,
      tokens: 0,
      otherBenefit: { unit: "minutes", value: 86 },
      pending: 1,
    },
    validation: { checked: 2, held: 2, wrong: 0 },
    jevUsd: 0.0006,
    evidence: {
      rule: "20 follow-ups, sameChoice in at least 90%",
      observed: "2 follow-ups, sameChoice in 100%",
      met: false,
    },
  },
  {
    feature: "askJev",
    state: "live",
    benefit: "none",
    asked: 9,
    notAsked: {},
    live: { involvements: 9, changed: 0, tokens: 0, otherBenefit: null, pending: 0 },
    shadow: zeroTotals(),
    validation: { checked: 0, held: 0, wrong: 0 },
    jevUsd: 0.0041,
    evidence: { rule: "—", observed: "No flip rule: a person's own question", met: null },
  },
  {
    feature: "readCheck",
    state: "shadow",
    benefit: "tokens",
    asked: 312,
    notAsked: { "below-floor": 2340, excluded: 18, "not-text": 54, dedup: 22, repeat: 9 },
    live: zeroTotals(),
    shadow: { involvements: 312, changed: 0, tokens: 48700, otherBenefit: null, pending: 6 },
    validation: { checked: 180, held: 142, wrong: 38 },
    jevUsd: 0.0298,
    evidence: {
      rule: "200 would-skips of reads of 8,000 tokens or more, at most 30% false skips, a positive projected net",
      observed: "180 checked, 38 false skips (21.1%), projected net +41,200 tokens",
      met: false,
    },
  },
];

function scale(features: JevSavingsFeatureSummary[], factor: number): JevSavingsFeatureSummary[] {
  return features.map((entry) => ({
    ...entry,
    asked: Math.round(entry.asked * factor),
    live: { ...entry.live, tokens: Math.round(entry.live.tokens * factor) },
    shadow: { ...entry.shadow, tokens: Math.round(entry.shadow.tokens * factor) },
    jevUsd: entry.jevUsd * factor,
  }));
}

const SEVEN_DAY_FEATURES = scale(TODAY_FEATURES, 6.4);
const ALL_TIME_FEATURES = scale(TODAY_FEATURES, 24);

function sumTokens(
  features: JevSavingsFeatureSummary[],
  mode: "live" | "shadow",
): { involvements: number; tokens: number } {
  return features.reduce(
    (totals, entry) => ({
      involvements: totals.involvements + entry[mode].involvements,
      tokens: totals.tokens + (entry.benefit === "tokens" ? entry[mode].tokens : 0),
    }),
    { involvements: 0, tokens: 0 },
  );
}

function sumJevUsd(features: JevSavingsFeatureSummary[]): number {
  return features.reduce((sum, entry) => sum + entry.jevUsd, 0);
}

const OPUS_INPUT_USD_PER_MILLION_TOKENS = 4;

function buildSummary(
  range: JevSavingsRange,
  from: string,
  to: string,
  features: JevSavingsFeatureSummary[],
  days: JevSavingsSummary["days"],
): JevSavingsSummary {
  const live = sumTokens(features, "live");
  const shadow = sumTokens(features, "shadow");
  const usd = sumJevUsd(features);
  const tokensEquivalent = (usd / OPUS_INPUT_USD_PER_MILLION_TOKENS) * 1_000_000;
  const netLive = live.tokens - tokensEquivalent;
  const netIfLive = live.tokens + shadow.tokens - tokensEquivalent;
  return {
    range,
    from,
    to,
    unit: "opus-equivalent-weighted-tokens",
    live: { involvements: live.involvements, tokensSaved: live.tokens },
    shadow: { involvements: shadow.involvements, tokensWouldSave: shadow.tokens },
    jevSpend: {
      calls: features.reduce((sum, entry) => sum + entry.asked, 0),
      usd,
      tokensEquivalent,
    },
    net: { live: netLive, ifLive: netIfLive },
    features,
    topAgents: [
      {
        id: "fx_agent_mobile_bugfix",
        label: "fix sidebar hover regression",
        involvements: 9,
        liveTokens: 6200,
        shadowTokens: 4100,
      },
      {
        id: "fx_agent_jev_tools_fixer",
        label: "JEV tools fixer",
        involvements: 7,
        liveTokens: 9100,
        shadowTokens: 1200,
      },
      {
        id: "fx_agent_release_notes",
        label: "release notes draft",
        involvements: 3,
        liveTokens: 0,
        shadowTokens: 2600,
      },
    ],
    topWorkspaces: [
      {
        id: "fx_ws_mobile",
        label: "mobile",
        involvements: 14,
        liveTokens: 8900,
        shadowTokens: 7100,
      },
      { id: "fx_ws_paseo", label: "paseo", involvements: 11, liveTokens: 6400, shadowTokens: 3900 },
    ],
    days,
  };
}

function lastNDays(n: number, baseIso: string): string[] {
  const base = new Date(baseIso);
  return Array.from({ length: n }, (_, index) => {
    const day = new Date(base);
    day.setUTCDate(day.getUTCDate() - (n - 1 - index));
    return day.toISOString().slice(0, 10);
  });
}

const BASE_DAY = "2026-09-30T00:00:00.000Z";

function buildDays(count: number, peakLive: number, peakShadow: number): JevSavingsSummary["days"] {
  const labels = lastNDays(count, BASE_DAY);
  return labels.map((day, index) => {
    const wave = 0.4 + 0.6 * Math.abs(Math.sin(index + 1));
    return {
      day,
      involvements: Math.round(4 * wave) + 1,
      liveTokens: Math.round(peakLive * wave),
      shadowTokens: Math.round(peakShadow * wave),
      jevUsd: Number((0.004 * wave).toFixed(4)),
    };
  });
}

export const JEV_SAVINGS_SUMMARY_FIXTURES: Record<JevSavingsRange, JevSavingsSummary> = {
  today: buildSummary(
    "today",
    "2026-09-30T00:00:00.000Z",
    "2026-09-30T23:59:59.000Z",
    TODAY_FEATURES,
    buildDays(1, 15200, 48700),
  ),
  "7d": buildSummary(
    "7d",
    "2026-09-24T00:00:00.000Z",
    "2026-09-30T23:59:59.000Z",
    SEVEN_DAY_FEATURES,
    buildDays(7, 15200, 48700),
  ),
  all: buildSummary(
    "all",
    "2026-08-15T00:00:00.000Z",
    "2026-09-30T23:59:59.000Z",
    ALL_TIME_FEATURES,
    buildDays(30, 15200, 48700),
  ),
};

function eventFromFeature(
  id: string,
  at: string,
  entry: JevSavingsFeatureSummary,
  mode: "live" | "shadow",
  involvement: string,
  decisionDid: string,
  decisionWouldBe: string | null,
): JevSavingsEvent {
  const totals = entry[mode];
  return {
    id,
    at,
    feature: entry.feature,
    agentId: "fx_agent_mobile_bugfix",
    agentTitle: "fix sidebar hover regression",
    workspaceId: "fx_ws_mobile",
    mode,
    outcome: mode === "live" ? "answered" : "shadow",
    involvement,
    decision: {
      did: decisionDid,
      wouldBe: decisionWouldBe,
      changed: mode === "live" && decisionWouldBe !== null && decisionWouldBe !== decisionDid,
      detail: { contextTokens: 4200, model: "claude-sonnet-5" },
    },
    benefit: entry.benefit,
    tokensSavedEstimate:
      entry.benefit === "tokens"
        ? Math.round(totals.tokens / Math.max(totals.involvements, 1))
        : null,
    otherBenefit: totals.otherBenefit,
    basis:
      entry.benefit === "tokens"
        ? { formula: "W × (w(base) − w(m))", inputs: { W: 4200, "w(base)": 0.5, "w(m)": 0.25 } }
        : null,
    pending: totals.pending > 0,
    validation:
      entry.validation.checked > 0 ? { outcome: "held", signal: "edited", afterMinutes: 6 } : null,
    jevCostUsd: entry.jevUsd > 0 ? entry.jevUsd / Math.max(totals.involvements, 1) : null,
  };
}

export const JEV_SAVINGS_EVENTS_FIXTURE: JevSavingsEvent[] = [
  eventFromFeature(
    "sv_001",
    "2026-09-30T21:40:00.000Z",
    TODAY_FEATURES.find((entry) => entry.feature === "readCheck")!,
    "shadow",
    "Does this agent need src/components/sidebar-workspace-list.tsx (14,200 tokens)?",
    "read the file",
    "skip: already summarized two calls ago",
  ),
  eventFromFeature(
    "sv_002",
    "2026-09-30T21:12:00.000Z",
    TODAY_FEATURES.find((entry) => entry.feature === "agentTools")!,
    "live",
    "Does ask_jev_files need packages/app/src/components/left-sidebar.tsx?",
    "answered from JEV's summary, 1,840 tokens avoided",
    "answered from JEV's summary, 1,840 tokens avoided",
  ),
  eventFromFeature(
    "sv_003",
    "2026-09-30T20:58:00.000Z",
    TODAY_FEATURES.find((entry) => entry.feature === "remediationTriage")!,
    "shadow",
    "Does this finish need Tyler?",
    "fixer started",
    "skip: routine (0.88)",
  ),
  eventFromFeature(
    "sv_004",
    "2026-09-30T20:30:00.000Z",
    TODAY_FEATURES.find((entry) => entry.feature === "spawnHint")!,
    "shadow",
    "Which model should this agent run?",
    "class standard on claude-sonnet-5",
    "class mechanical on claude-haiku-4-5",
  ),
  eventFromFeature(
    "sv_005",
    "2026-09-30T19:47:00.000Z",
    TODAY_FEATURES.find((entry) => entry.feature === "notificationTriage")!,
    "shadow",
    "Does this finish notice need an alert?",
    "sent as alert",
    "would hold for the digest",
  ),
];
