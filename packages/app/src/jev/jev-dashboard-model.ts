import type {
  JevFeatureState,
  JevOtherBenefit,
  JevSavingsDay,
  JevSavingsFeature,
  JevSavingsFeatureSummary,
  JevSavingsSummary,
} from "@/jev/jev-savings-types";

/**
 * Feature order and labels, local to the dashboard until the ui track's `JEV_FEATURE_LANES` /
 * `FEATURE_LABELS` (docs/jev.md, "Feature 11") land on `multi-account-orchestrator`. At merge,
 * delete these two and import the shared source instead.
 */
export const JEV_SAVINGS_FEATURE_ORDER: JevSavingsFeature[] = [
  "spawnHint",
  "remediationTriage",
  "notificationTriage",
  "agentTools",
  "compactionTiming",
  "stallJudgment",
  "awayReply",
  "askJev",
  "readCheck",
];

export const JEV_SAVINGS_FEATURE_LABELS: Record<JevSavingsFeature, string> = {
  spawnHint: "Spawn hint",
  remediationTriage: "Remediation triage",
  notificationTriage: "Finish triage",
  agentTools: "Agent tools",
  compactionTiming: "Compaction timing",
  stallJudgment: "Stall judgment",
  awayReply: "Away reply",
  askJev: "Ask JEV",
  readCheck: "File-read check",
};

/**
 * Away reply's own vocabulary is "dry run", not "shadow" (`agents.jev.awayReply.dryRun`); every
 * other feature's `shadow` state reads as "Shadow". `off` and `live` read the same everywhere.
 */
export function jevFeatureStateLabel(feature: JevSavingsFeature, state: JevFeatureState): string {
  switch (state) {
    case "off":
      return "Off";
    case "dormant":
      return "Dormant";
    case "live":
      return "Live";
    case "shadow":
      return feature === "awayReply" ? "Dry run" : "Shadow";
  }
}

export interface JevDashboardTile {
  id: "saved" | "would-have-saved" | "cost" | "net";
  label: string;
  tokens: number | null;
  usd: number | null;
  caption: string;
  tone: "live" | "shadow" | "neutral";
}

/**
 * The four headline tiles. Saved (live) and would-have-saved (shadow) are never added: each is
 * its own tile, its own tone, so the dashboard can't be read as "JEV saved N tokens" when half of
 * N never left shadow (docs/jev.md, "The JEV dashboard").
 */
export function buildJevDashboardTiles(summary: JevSavingsSummary): JevDashboardTile[] {
  return [
    {
      id: "saved",
      label: "Saved",
      tokens: summary.live.tokensSaved,
      usd: null,
      caption: `${summary.live.involvements} involvement${summary.live.involvements === 1 ? "" : "s"}`,
      tone: "live",
    },
    {
      id: "would-have-saved",
      label: "Would have saved",
      tokens: summary.shadow.tokensWouldSave,
      usd: null,
      caption: `${summary.shadow.involvements} in shadow`,
      tone: "shadow",
    },
    {
      id: "cost",
      label: "JEV cost",
      tokens: summary.jevSpend.tokensEquivalent,
      usd: summary.jevSpend.usd,
      caption: `${summary.jevSpend.calls} call${summary.jevSpend.calls === 1 ? "" : "s"}`,
      tone: "neutral",
    },
    {
      id: "net",
      label: "Net",
      tokens: summary.net.live,
      usd: null,
      caption: `If every shadow answer went live: ${formatSignedTokens(summary.net.ifLive)}`,
      tone: summary.net.live >= 0 ? "live" : "shadow",
    },
  ];
}

export function formatSignedTokens(tokens: number): string {
  const rounded = Math.round(tokens);
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${formatTokens(rounded)}`;
}

/** Opus-equivalent weighted tokens, compacted for a tile or a row: 1,284 / 12.4k / 3.1M. */
export function formatTokens(tokens: number): string {
  const abs = Math.abs(tokens);
  if (abs >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return Math.round(tokens).toLocaleString("en-US");
}

export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatOtherBenefit(benefit: JevOtherBenefit): string {
  switch (benefit.unit) {
    case "pushes-held":
      return `${Math.round(benefit.value)} push${Math.round(benefit.value) === 1 ? "" : "es"} held`;
    case "minutes": {
      if (benefit.value < 60) return `${Math.round(benefit.value)} min of waiting`;
      return `${(benefit.value / 60).toFixed(1)} h of waiting`;
    }
  }
}

export interface JevDashboardFeatureRow {
  feature: JevSavingsFeature;
  label: string;
  stateLabel: string;
  involvements: number;
  notAskedTotal: number;
  liveTokens: number | null;
  shadowTokens: number | null;
  otherBenefitText: string | null;
  wrongRatePct: number | null;
  jevUsd: number;
  evidenceRule: string;
  evidenceObserved: string;
  evidenceMet: boolean | null;
}

/**
 * One row per feature, in `JEV_SAVINGS_FEATURE_ORDER`, including a feature the summary never
 * mentions (e.g. a fixture or a daemon that hasn't recorded it yet) as a zeroed row — the table's
 * shape doesn't depend on what has happened yet.
 */
export function buildJevDashboardFeatureRows(summary: JevSavingsSummary): JevDashboardFeatureRow[] {
  const byFeature = new Map(summary.features.map((entry) => [entry.feature, entry]));
  return JEV_SAVINGS_FEATURE_ORDER.map((feature) => {
    const entry = byFeature.get(feature) ?? zeroedFeatureSummary(feature);
    return buildFeatureRow(entry);
  });
}

function zeroedFeatureSummary(feature: JevSavingsFeature): JevSavingsFeatureSummary {
  const zeroTotals = { involvements: 0, changed: 0, tokens: 0, otherBenefit: null, pending: 0 };
  return {
    feature,
    state: "off",
    benefit: "none",
    asked: 0,
    notAsked: {},
    live: { ...zeroTotals },
    shadow: { ...zeroTotals },
    validation: { checked: 0, held: 0, wrong: 0 },
    jevUsd: 0,
    evidence: { rule: "—", observed: "No data yet", met: null },
  };
}

function buildOtherBenefitText(entry: JevSavingsFeatureSummary): string | null {
  if (entry.live.otherBenefit != null) return formatOtherBenefit(entry.live.otherBenefit);
  if (entry.shadow.otherBenefit != null) {
    return `Would have: ${formatOtherBenefit(entry.shadow.otherBenefit)}`;
  }
  return null;
}

function buildFeatureRow(entry: JevSavingsFeatureSummary): JevDashboardFeatureRow {
  const notAskedTotal = Object.values(entry.notAsked).reduce((sum, count) => sum + (count ?? 0), 0);
  const checked = entry.validation.checked;
  const wrongRatePct = checked > 0 ? (entry.validation.wrong / checked) * 100 : null;
  const otherBenefitText = buildOtherBenefitText(entry);
  return {
    feature: entry.feature,
    label: JEV_SAVINGS_FEATURE_LABELS[entry.feature],
    stateLabel: jevFeatureStateLabel(entry.feature, entry.state),
    involvements: entry.live.involvements + entry.shadow.involvements,
    notAskedTotal,
    liveTokens: entry.benefit === "tokens" ? entry.live.tokens : null,
    shadowTokens: entry.benefit === "tokens" ? entry.shadow.tokens : null,
    otherBenefitText,
    wrongRatePct,
    jevUsd: entry.jevUsd,
    evidenceRule: entry.evidence.rule,
    evidenceObserved: entry.evidence.observed,
    evidenceMet: entry.evidence.met,
  };
}

export interface JevDashboardDayBar {
  day: string;
  liveFraction: number;
  shadowFraction: number;
  liveTokens: number;
  shadowTokens: number;
}

/** Normalizes each day's live/shadow tokens to a 0–1 fraction of the range's tallest day. */
export function buildJevDashboardDayBars(days: JevSavingsDay[]): JevDashboardDayBar[] {
  const max = days.reduce((peak, day) => Math.max(peak, day.liveTokens, day.shadowTokens), 0);
  if (max <= 0) {
    return days.map((day) => ({
      day: day.day,
      liveFraction: 0,
      shadowFraction: 0,
      liveTokens: day.liveTokens,
      shadowTokens: day.shadowTokens,
    }));
  }
  return days.map((day) => ({
    day: day.day,
    liveFraction: day.liveTokens / max,
    shadowFraction: day.shadowTokens / max,
    liveTokens: day.liveTokens,
    shadowTokens: day.shadowTokens,
  }));
}
