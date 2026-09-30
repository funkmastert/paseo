import type {
  JevDecisionRecord,
  JevFeatureId,
  JevLane,
  JevLaneStatus,
  JevSpendTotals,
  JevStatus,
} from "../../../server/jev/contract.js";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageDetail,
} from "../../../server/messages.js";
import type { ProviderUsageFetcher } from "../provider.js";

/**
 * JEV's spend and features for the budget strip (docs/jev.md, "Feature 11: UI"). It reads the
 * daemon's own `JevService`, never the network, so it answers from memory.
 */

const PROVIDER_ID = "jev";
const DISPLAY_NAME = "JEV";

/**
 * Deliberate off states hide the row: nobody opted in, or JEV is switched off. Every other reason
 * JEV cannot send is one it went quiet for on its own, so the row stays and says why.
 */
const HIDDEN_REASONS = new Set<string>(["no-key", "disabled"]);

const UNAVAILABLE_HINTS: Readonly<Record<string, string>> = {
  "config-unreadable": "agents.jev in config.json is invalid; JEV is off until it is fixed",
  "key-rejected": "The JEV key was rejected; JEV is off until the key is replaced",
};

// Strip order: the features that steer the daemon, then the ones an agent or a person asks.
const FEATURE_ORDER: readonly JevFeatureId[] = [
  "spawnHint",
  "remediationTriage",
  "notificationTriage",
  "stallJudgment",
  "compactionTiming",
  "awayReply",
  "agentTools",
  "askJev",
];

const FEATURE_LABELS: Readonly<Record<string, string>> = {
  spawnHint: "Spawn hint",
  remediationTriage: "Remediation triage",
  notificationTriage: "Finish triage",
  stallJudgment: "Stall judgment",
  compactionTiming: "Compaction timing",
  awayReply: "Away reply",
  agentTools: "Agent tools",
  askJev: "Ask JEV",
};

const LANE_LABELS: Readonly<Record<JevLane, string>> = {
  control: "Control",
  agentTools: "Agent tools",
  interactive: "Ask JEV",
};

const LANE_BALANCE_IDS: Readonly<Record<JevLane, string>> = {
  control: "control-today",
  agentTools: "tools-today",
  interactive: "ask-today",
};

const LANES: readonly JevLane[] = ["control", "agentTools", "interactive"];

// The spawn hint's note carries its answers as "task_class mechanical 0.91, reasoning 0.6"
// (`formatVerdict` in session/jev/jev-session.ts); the class is what a shadow day is judged on.
const TASK_CLASS_VERDICT = /(?:^|,\s*)task_class\s+(\S+)/;

export interface JevUsageFetcherOptions {
  /** Null when this daemon has no JEV service. */
  readStatus: () => JevStatus | null;
  /** Every decision the host holds for its agents, any day; the fetcher keeps today's. */
  readDecisions?: () => readonly JevDecisionRecord[];
  now?: () => number;
}

export class JevUsageFetcher implements ProviderUsageFetcher {
  readonly providerId = PROVIDER_ID;
  readonly displayName = DISPLAY_NAME;
  readonly live = true;

  private readonly readStatus: () => JevStatus | null;
  private readonly readDecisions: () => readonly JevDecisionRecord[];
  private readonly now: () => number;

  constructor(options: JevUsageFetcherOptions) {
    this.readStatus = options.readStatus;
    this.readDecisions = options.readDecisions ?? (() => []);
    this.now = options.now ?? Date.now;
  }

  async fetchUsage(): Promise<ProviderUsage | null> {
    const status = this.readStatus();
    if (!status) return null;
    return buildJevUsage(status, this.readDecisions(), this.now());
  }
}

/** The strip row for a status and the host's decisions, as of `nowMs`. */
export function buildJevUsage(
  status: JevStatus,
  decisions: readonly JevDecisionRecord[],
  nowMs: number,
): ProviderUsage {
  const base = {
    providerId: PROVIDER_ID,
    displayName: DISPLAY_NAME,
    planLabel: planLabel(status),
    fetchedAt: new Date(nowMs).toISOString(),
    windows: [],
  };
  // A spent lane is not a reason to hide the row: that is when it matters most.
  if (!status.available && status.reason !== null && status.reason !== "daily-budget") {
    if (HIDDEN_REASONS.has(status.reason)) {
      return { ...base, status: "unavailable", balances: [], details: [], error: null };
    }
    return {
      ...base,
      status: "error",
      balances: [],
      details: [],
      error: UNAVAILABLE_HINTS[status.reason] ?? `JEV is off: ${status.reason}`,
    };
  }
  const today = decisionsToday(decisions, nowMs);
  return {
    ...base,
    status: "available",
    balances: [...LANES.map((lane) => laneBalance(lane, status.lanes[lane])), callsBalance(status)],
    details: [...laneAlerts(status), ...featureDetails(status, today)],
    error: null,
  };
}

function planLabel(status: JevStatus): string | null {
  if (status.provider === "fake") return "fake backend";
  if (status.provider === "openrouter") return "via OpenRouter";
  return null;
}

function laneBalance(lane: JevLane, laneStatus: JevLaneStatus): ProviderUsageBalance {
  return {
    id: LANE_BALANCE_IDS[lane],
    label: `${LANE_LABELS[lane]} today`,
    used: laneStatus.today.usd,
    limit: laneStatus.maxUsdPerDay,
    unit: "usd",
    resetsAt: laneStatus.resetsAt,
    ...(laneStatus.exhausted ? { tone: "warning" as const } : {}),
  };
}

/** Calls that reached JEV or failed trying. A refusal (no key, excluded, budget) sent nothing. */
function sentCalls(totals: JevSpendTotals | undefined): number {
  if (!totals) return 0;
  return Math.max(0, totals.calls - totals.unavailable);
}

function callsBalance(status: JevStatus): ProviderUsageBalance {
  const used = LANES.reduce((sum, lane) => sum + sentCalls(status.lanes[lane]?.today), 0);
  return { id: "calls-today", label: "Calls today", used, unit: "requests" };
}

/**
 * A lane that stopped sending says so first: a spent cap turns its features off until the host's
 * midnight, and an open circuit pauses them. Without these the day's JEV simply goes quiet.
 */
function laneAlerts(status: JevStatus): ProviderUsageDetail[] {
  const alerts: ProviderUsageDetail[] = [];
  for (const lane of LANES) {
    const laneStatus = status.lanes[lane];
    if (!laneStatus) continue;
    if (laneStatus.exhausted) {
      alerts.push({
        id: `lane:${lane}:spent`,
        label: `${LANE_LABELS[lane]} budget spent`,
        value: `${laneFeatureNames(status, lane)} off until midnight`,
        tone: "warning",
      });
    } else if (laneStatus.circuit === "open") {
      alerts.push({
        id: `lane:${lane}:circuit`,
        label: `${LANE_LABELS[lane]} paused`,
        value: "JEV kept failing; retrying shortly",
        tone: "warning",
      });
    }
  }
  return alerts;
}

const FEATURE_LANES: Readonly<Record<string, JevLane>> = {
  agentTools: "agentTools",
  askJev: "interactive",
};

function laneOf(feature: string): JevLane {
  return FEATURE_LANES[feature] ?? "control";
}

function laneFeatureNames(status: JevStatus, lane: JevLane): string {
  if (lane !== "control") return LANE_LABELS[lane];
  const enabled = orderedFeatures(status).filter(
    (feature) => laneOf(feature) === "control" && status.features[feature]?.enabled,
  );
  return enabled.length > 0 ? enabled.map(featureLabel).join(", ") : "Control features";
}

/** The strip's order, then any feature a newer service reports that this one does not name. */
function orderedFeatures(status: JevStatus): JevFeatureId[] {
  const known = FEATURE_ORDER.filter((feature) => feature in status.features);
  const extra = (Object.keys(status.features) as JevFeatureId[]).filter(
    (feature) => !FEATURE_ORDER.includes(feature),
  );
  return [...known, ...extra];
}

function featureLabel(feature: string): string {
  return FEATURE_LABELS[feature] ?? feature;
}

/** The host's local midnight before `nowMs`: the ledger's day. */
function startOfLocalDay(nowMs: number): number {
  const now = new Date(nowMs);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function decisionsToday(
  decisions: readonly JevDecisionRecord[],
  nowMs: number,
): Map<string, JevDecisionRecord[]> {
  const since = startOfLocalDay(nowMs);
  const byFeature = new Map<string, JevDecisionRecord[]>();
  for (const decision of decisions) {
    const at = Date.parse(decision.at);
    if (!Number.isFinite(at) || at < since) continue;
    const list = byFeature.get(decision.feature) ?? [];
    list.push(decision);
    byFeature.set(decision.feature, list);
  }
  return byFeature;
}

/** One line per feature: whether it is live, in shadow or off, then what it did today. */
function featureDetails(
  status: JevStatus,
  today: ReadonlyMap<string, JevDecisionRecord[]>,
): ProviderUsageDetail[] {
  return orderedFeatures(status).map((feature) => {
    const featureStatus = status.features[feature];
    const id = `feature:${feature}`;
    const label = featureLabel(feature);
    if (!featureStatus?.enabled) return { id, label, value: "Off" };
    const mode = featureStatus.shadow ? shadowWord(feature) : "Live";
    const totals = status.todayByFeature[feature];
    const summary = summarizeFeatureDay(
      feature,
      featureStatus.shadow,
      today.get(feature) ?? [],
      totals,
    );
    const parts = [mode];
    if (summary) parts.push(summary);
    if (totals && totals.usd > 0) parts.push(formatUsd(totals.usd));
    return { id, label, value: parts.join(" · ") };
  });
}

/** Feature 14's shadow is its dry run, and the strip says so in its own word. */
function shadowWord(feature: JevFeatureId): string {
  return feature === "awayReply" ? "Dry run" : "Shadow";
}

/**
 * What a feature did today, from its decision notes, or null when it did nothing. In shadow the
 * notes are how Tyler decides to turn a feature live, so the line leads with what it would have
 * changed.
 */
export function summarizeFeatureDay(
  feature: string,
  shadow: boolean,
  records: readonly JevDecisionRecord[],
  totals: JevSpendTotals | undefined,
): string | null {
  if (records.length === 0) {
    const calls = sentCalls(totals);
    return calls > 0 ? `${calls} ${plural(calls, "call")} today` : null;
  }
  if (feature === "spawnHint") return summarizeSpawnHints(records, shadow);
  const applied = records.filter((record) => record.applied).length;
  if (shadow) return summarizeWouldHave(records);
  if (feature === "askJev") return `${records.length} ${plural(records.length, "question")} today`;
  return `${applied} of ${records.length} applied`;
}

function summarizeSpawnHints(records: readonly JevDecisionRecord[], shadow: boolean): string {
  const classes = new Map<string, number>();
  for (const record of records) {
    const taskClass = TASK_CLASS_VERDICT.exec(record.verdict)?.[1];
    if (taskClass) classes.set(taskClass, (classes.get(taskClass) ?? 0) + 1);
  }
  const counts = [...classes.entries()].sort((a, b) => b[1] - a[1]);
  const creates = `${records.length} ${plural(records.length, "create")}`;
  const answered =
    counts.length > 0
      ? `${creates} answered ${counts.map(([name, count]) => `${count} ${name}`).join(", ")}`
      : `${creates} asked`;
  if (shadow) return answered;
  const applied = records.filter((record) => record.applied).length;
  return `${answered}; ${applied} applied`;
}

/**
 * Shadow notes whose action starts "would" are the ones where the answer would have changed what
 * code did; every other shadow note did exactly what today's code does. Grouped by the action up
 * to its first parenthesis, so "would reply (a reason); dry run" groups by "would reply".
 */
function summarizeWouldHave(records: readonly JevDecisionRecord[]): string {
  const groups = new Map<string, number>();
  for (const record of records) {
    if (record.applied || !/^would\b/i.test(record.action)) continue;
    const phrase = record.action.split(" (")[0].trim();
    groups.set(phrase, (groups.get(phrase) ?? 0) + 1);
  }
  const decided = `${records.length} ${plural(records.length, "decision")}`;
  if (groups.size === 0) return `${decided}, none would change anything`;
  const [top, ...rest] = [...groups.entries()].sort((a, b) => b[1] - a[1]);
  const lead = `${top[1]}× ${top[0]}`;
  const more = rest.length > 0 ? `, +${rest.reduce((sum, [, count]) => sum + count, 0)} other` : "";
  return `${lead}${more} of ${decided}`;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

// Sub-cent spend is the normal case for JEV (about $0.0002 a call), so it keeps three places.
function formatUsd(usd: number): string {
  return usd >= 0.1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
}
