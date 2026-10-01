import { promises as fs } from "node:fs";

import type { FinishTriageLine } from "../attention-push-triage.js";
import type { AwayReplyDecisionLine } from "../away-reply/decision-file.js";
import type { RemediationTriageEvent } from "../remediation/jev-triage.js";
import type { JevSavingsFeature, JevSavingsSink } from "./contract.js";
import { JevSavingsLedger, savingsIdForCall } from "./savings.js";
import { priceWeight, shadowDeferVerdict, type JevSavingsFacts } from "./savings-formulas.js";

/**
 * How the features already built report to the savings ledger (docs/jev.md, "Savings", "Hooking in
 * the features already built"). Each hook reads what its feature already records, reports facts,
 * and never changes what the feature decides. None throws.
 */

const DAY_MS = 24 * 60 * 60_000;
const MEDIAN_WINDOW_MS = 30 * DAY_MS;
/** Tyler answering a would-be notice this soon means he needed the alert (feature 3b). */
const FINISH_CONTRADICTED_WITHIN_MINUTES = 30;
const STALLED_AGENT_KEY_PREFIX = "stalled-agent:";

/** In-memory pending records of a feature, for joins; empty for a sink that keeps no records. */
export function pendingSavingsFor(
  sink: JevSavingsSink | null | undefined,
  feature: JevSavingsFeature,
): Array<{ id: string; callId: string; facts: Readonly<JevSavingsFacts> }> {
  return sink instanceof JevSavingsLedger ? sink.pendingRecords(feature) : [];
}

function guard(run: () => void): void {
  try {
    run();
  } catch {
    // A savings hook never breaks the feature it measures.
  }
}

/**
 * What remediation agents cost, per condition kind: `A x w(m)` of each agent that ended in the last
 * 30 days, from `remediation-triage.jsonl`'s `agent-ended` lines. A live skip prices the agent that
 * never ran at its kind's median.
 */
export class RemediationAgentCosts {
  private readonly samples = new Map<string, Array<{ atMs: number; tokens: number }>>();

  add(
    kind: string,
    atMs: number,
    agentTotalTokens: number | null,
    agentModel: string | null,
  ): void {
    const weight = priceWeight(agentModel);
    if (agentTotalTokens === null || weight === null || !Number.isFinite(atMs)) return;
    const list = this.samples.get(kind) ?? [];
    list.push({ atMs, tokens: agentTotalTokens * weight });
    this.samples.set(kind, list);
  }

  median(kind: string, nowMs: number): { median: number | null; samples: number } {
    const list = (this.samples.get(kind) ?? []).filter(
      (sample) => nowMs - sample.atMs <= MEDIAN_WINDOW_MS,
    );
    this.samples.set(kind, list);
    if (list.length === 0) return { median: null, samples: 0 };
    const sorted = list.map((sample) => sample.tokens).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
    return { median: Math.round(median), samples: sorted.length };
  }

  /** Reads the agents of the last 30 days from the triage file and its rotation. */
  async loadFrom(filePaths: readonly string[], nowMs: number): Promise<void> {
    for (const filePath of filePaths) {
      let text: string;
      try {
        text = await fs.readFile(filePath, "utf8");
      } catch {
        continue;
      }
      for (const raw of text.split("\n")) {
        const line = parseLine(raw);
        if (line?.["type"] !== "agent-ended" || typeof line["kind"] !== "string") continue;
        const atMs = Date.parse(String(line["at"]));
        if (nowMs - atMs > MEDIAN_WINDOW_MS) continue;
        this.add(
          line["kind"],
          atMs,
          typeof line["agentTotalTokens"] === "number" ? line["agentTotalTokens"] : null,
          typeof line["agentModel"] === "string" ? line["agentModel"] : null,
        );
      }
    }
  }
}

function parseLine(raw: string): Record<string, unknown> | null {
  if (raw.trim().length === 0) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Feature 3a's hook, called with every event `createRemediationTriageRecorder` writes. `triage`
 * records; `agent-ended` and `closed` settle; `agent-ended` validates a shadow skip. A stalled-agent
 * episode's `agent-ended` and `person-first` also settle feature 10's record for the same
 * observation key (docs/jev.md, "Formulas", row 10).
 */
export function createRemediationSavingsHook(options: {
  savings: JevSavingsSink;
  costs: RemediationAgentCosts;
  now?: () => number;
}): (event: RemediationTriageEvent) => string {
  const { savings, costs } = options;
  const now = options.now ?? Date.now;
  return (event) => {
    let id = "";
    guard(() => {
      switch (event.type) {
        case "triage":
          id = recordTriage(savings, costs, event, now());
          return;
        case "agent-ended":
          costs.add(event.kind, Date.parse(event.at), event.agentTotalTokens, event.agentModel);
          settleAgentEnded(savings, event);
          return;
        case "closed": {
          const triageId = savingsIdForCall(savings, event.triageCallId);
          if (triageId) {
            savings.settle(triageId, {
              closed: true,
              clearedDuringHold: event.clearedDuringHold,
              agentRan: event.agentRan,
              escalated: event.escalated,
              minutesSinceTriage: event.minutesSinceTriage,
            });
            if (event.triageWouldBe === "defer" && event.triageApplied === false) {
              validateShadowDefer(savings, triageId, event.minutesSinceTriage);
            }
          }
          return;
        }
        case "person-first":
          settleStallPersonFirst(savings, costs, event, now());
          return;
      }
    });
    return id;
  };
}

/**
 * The hook `createRemediationTriageRecorder` calls, with its agent costs read from the triage file
 * and its rotation in the background. Null when the service has no savings sink.
 */
export function remediationSavingsHookFor(
  savings: JevSavingsSink | null | undefined,
  triageFilePath: string,
): ((event: RemediationTriageEvent) => string) | null {
  if (!savings) return null;
  const costs = new RemediationAgentCosts();
  void costs.loadFrom([triageFilePath, `${triageFilePath}.1`], Date.now()).catch(() => undefined);
  return createRemediationSavingsHook({ savings, costs });
}

function recordTriage(
  savings: JevSavingsSink,
  costs: RemediationAgentCosts,
  event: Extract<RemediationTriageEvent, { type: "triage" }>,
  nowMs: number,
): string {
  const { triage, decision } = event;
  if (!triage.callId || triage.outcome === "error") return "";
  // `record` turns an unavailable call into its not-asked counter.
  if (triage.outcome === "unavailable") return savings.record(triageInput(event, null, {}));
  const answered = triage.outcome === "answered" || triage.outcome === "shadow";
  const { median, samples } = costs.median(event.kind, nowMs);
  return savings.record(
    triageInput(event, answered ? decision.wouldBe : null, {
      kind: event.kind,
      episode: event.episode,
      key: event.key,
      route: triage.route,
      confidence: triage.routeConfidence,
      willPush: event.willPush,
      deferMinutes: Math.round(decision.deferMs / 60_000),
      medianTokens: median,
      medianSamples: samples,
    }),
  );
}

function triageInput(
  event: Extract<RemediationTriageEvent, { type: "triage" }>,
  wouldBe: string | null,
  facts: JevSavingsFacts,
) {
  return {
    feature: "remediationTriage" as const,
    callSite: "remediation.triage",
    callId: event.triage.callId ?? "",
    agentId: event.linkedAgentId,
    involvement: `Should a remediation agent handle ${event.kind}?`,
    decision: {
      did: event.decision.action,
      wouldBe,
      changed: event.decision.applied && event.decision.action !== "start-agent",
    },
    facts,
    pending: wouldBe === "person" || wouldBe === "defer",
  };
}

function settleAgentEnded(
  savings: JevSavingsSink,
  event: Extract<RemediationTriageEvent, { type: "agent-ended" }>,
): void {
  const fixed = event.result === "fixed";
  const facts = {
    agentRan: true,
    fixed,
    agentTotalTokens: event.agentTotalTokens,
    agentModel: event.agentModel,
  };
  const id = savingsIdForCall(savings, event.triageCallId);
  if (id) {
    savings.settle(id, facts);
    if (event.triageWouldBe === "person" && event.triageApplied === false) {
      savings.validate(id, {
        outcome: fixed ? "contradicted" : "held",
        signal: fixed ? "fixed" : "not-fixed",
        afterMinutes: event.minutesRunning,
      });
    }
    if (event.triageWouldBe === "defer" && event.triageApplied === false) {
      validateShadowDefer(savings, id, event.minutesRunning);
    }
  }
  if (!event.key.startsWith(STALLED_AGENT_KEY_PREFIX)) return;
  for (const stall of pendingSavingsFor(savings, "stallJudgment")) {
    if (stall.facts["episodeKey"] !== event.key || stall.facts["personFirst"] !== true) continue;
    savings.settle(stall.id, facts);
    savings.validate(stall.id, {
      outcome: fixed ? "contradicted" : "held",
      signal: fixed ? "fixed" : "not-fixed",
      afterMinutes: event.minutesRunning,
    });
  }
}

/**
 * A shadow defer bets that the condition clears by itself inside the hold, not that the agent
 * fails: `held` when it cleared inside the hold and the agent did not fix it, `contradicted` when
 * the agent fixed it or the condition outlasted the hold. Waits while either fact is missing.
 */
function validateShadowDefer(savings: JevSavingsSink, id: string, afterMinutes: number | null) {
  const facts = savings instanceof JevSavingsLedger ? savings.factsOf(id) : null;
  if (!facts) return;
  const verdict = shadowDeferVerdict(facts);
  if (verdict === "pending" || verdict === "no-agent") return;
  savings.validate(id, {
    outcome: verdict === "cleared-within-hold" ? "held" : "contradicted",
    signal: verdict,
    afterMinutes,
  });
}

function settleStallPersonFirst(
  savings: JevSavingsSink,
  costs: RemediationAgentCosts,
  event: Extract<RemediationTriageEvent, { type: "person-first" }>,
  nowMs: number,
): void {
  if (!event.skipped || !event.key.startsWith(STALLED_AGENT_KEY_PREFIX)) return;
  const { median, samples } = costs.median(event.kind, nowMs);
  for (const stall of pendingSavingsFor(savings, "stallJudgment")) {
    if (stall.facts["episodeKey"] !== event.key) continue;
    savings.settle(stall.id, {
      personFirstSkipped: true,
      medianTokens: median,
      medianSamples: samples,
    });
  }
}

/** Feature 3b: one involvement per triaged finish that reached JEV. Returns its id, or "". */
export function recordFinishSavings(
  savings: JevSavingsSink | null | undefined,
  input: {
    agentId: string;
    callId: string;
    base: string;
    sent: string;
    wouldBe: string;
    choice: string | null;
    confidence: number | null;
    shadow: boolean;
  },
): string {
  if (!savings) return "";
  try {
    return savings.record({
      feature: "notificationTriage",
      callSite: "attention.finish-triage",
      callId: input.callId,
      agentId: input.agentId,
      involvement: "Does this finish need Tyler?",
      decision: { did: input.sent, wouldBe: input.wouldBe, changed: input.sent !== input.base },
      facts: {
        base: input.base,
        choice: input.choice,
        confidence: input.confidence,
        shadow: input.shadow,
      },
    });
  } catch {
    return "";
  }
}

/**
 * Feature 3b's validation, from the `followup` line: Tyler messaged within 30 minutes of a notice
 * (sent, or would-be in shadow) is `contradicted`; no message by then is `held`. Superseded and
 * evicted follow-ups are censored. An alert that stayed an alert has nothing to validate.
 */
export function validateFinishFollowup(
  savings: JevSavingsSink | null | undefined,
  line: FinishTriageLine,
): void {
  guard(() => {
    if (!savings || line.type !== "followup") return;
    if (line.sent !== "notice" && line.wouldBe !== "notice") return;
    if (line.closedBy !== "message" && line.closedBy !== "window") return;
    const id = savingsIdForCall(savings, line.callId);
    if (!id) return;
    const minutes = line.messagedAfterMinutes;
    const contradicted = minutes !== null && minutes <= FINISH_CONTRADICTED_WITHIN_MINUTES;
    savings.validate(id, {
      outcome: contradicted ? "contradicted" : "held",
      signal: contradicted ? "messaged-within-30m" : "no-message-30m",
      afterMinutes: minutes,
    });
  });
}

/** Feature 14: one involvement per evaluated episode that reached JEV. Returns its id, or "". */
export function recordAwayReplySavings(
  savings: JevSavingsSink | null | undefined,
  line: Extract<AwayReplyDecisionLine, { type: "decision" }>,
  wouldReply: { kind: string } | null,
): string {
  if (!savings || !line.callId) return "";
  try {
    const wouldBe = wouldReply ? `reply:${wouldReply.kind}` : "no-reply";
    return savings.record({
      feature: "awayReply",
      callSite: "away-reply.job",
      callId: line.callId,
      agentId: line.agentId,
      involvement: `Does this leader, waiting ${line.waitedMinutes} min, need Tyler?`,
      decision: {
        did: line.action === "replied" ? wouldBe : "no-reply",
        wouldBe,
        changed: line.action === "replied",
      },
      facts: {
        action: line.action,
        dryRun: line.dryRun,
        episode: line.episode,
        optionId: line.optionId,
        waitedMinutes: line.waitedMinutes,
      },
      pending: line.action === "would-reply",
    });
  } catch {
    return "";
  }
}

/**
 * Feature 14's follow-up: the minutes until Tyler answered settle the dry-run figure, and
 * `sameChoice` validates it. A follow-up whose choice cannot be read settles with no minutes.
 */
export function settleAwayReplyFollowup(
  savings: JevSavingsSink | null | undefined,
  line: Extract<AwayReplyDecisionLine, { type: "followup" }>,
): void {
  guard(() => {
    if (!savings) return;
    const id = savingsIdForCall(savings, line.callId);
    if (!id) return;
    savings.settle(id, {
      sameChoice: line.sameChoice,
      minutesAfterDecision: line.minutesAfterDecision,
    });
    if (line.sameChoice === null) return;
    savings.validate(id, {
      outcome: line.sameChoice ? "held" : "contradicted",
      signal: line.sameChoice ? "same-choice" : "different-choice",
      afterMinutes: line.minutesAfterDecision,
    });
  });
}
