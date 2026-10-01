import type { Logger } from "pino";

import type { JevEgressScope, JevOutcome, JevQuestions, JevService } from "../jev/contract.js";
import { createJsonlAppender } from "../jsonl-appender.js";
import { levelAtLeast, type NotifyLevel } from "../notify-policy/levels.js";
import { reachesPhoneNow, type NotifyDeliveryPreview } from "../notify-policy/notify-policy.js";
import type { RemediationObservation, RemedyState } from "./contract.js";
import { MAX_EVIDENCE_CHARS } from "./escalation.js";

/**
 * Feature 3a, remediation triage (docs/jev.md). Before the ladder starts a remediation agent, JEV
 * says whether an agent is the right next step. Code turns the answer into one of three actions;
 * the ladder applies it only when the outcome is `answered`, only sends the episode to a person
 * when that person will be told now (`willEscalationPush`), and only holds it while a live remedy
 * is acting. Anything else starts the agent.
 */

export const REMEDIATION_TRIAGE_CALL_SITE = "remediation.triage";

/** `needs_person` at or over this sends the episode to a person, when the push will reach one. */
export const NEEDS_PERSON_FLOOR = 0.8;
/**
 * `clearing_on_its_own` at or over this, with `evidence_current` under the ceiling, defers once,
 * and only while a live remedy is acting on the condition.
 */
export const CLEARING_FLOOR = 0.8;
export const EVIDENCE_CURRENT_CEILING = 0.4;
/** A deferral lasts the condition's grace window, but at least this long... */
export const MIN_DEFER_MS = 10 * 60_000;
/** ...and never longer than this, whatever the grace; the ladder enforces it on read too. */
export const MAX_DEFER_MS = 15 * 60_000;

export const REMEDIATION_TRIAGE_QUESTIONS: JevQuestions = {
  route: {
    type: "choice",
    instructions:
      "An automatic remedy has already run for the problem in `summary` and `evidence`; `attempts` lists what it did. What should happen next?",
    criteria: {
      agent_can_fix:
        "A coding agent with a shell on this machine could plausibly clear it by doing `agent_task`: stop leftover processes, reclaim files it can prove are safe, restart or unstick an agent",
      needs_person:
        "Only a person can clear it: signing in again, paying, deciding about someone's work, or anything off this machine",
      clearing_on_its_own:
        "The readings show it already easing or likely to clear within minutes: a spike, a burst, a job that is finishing, a value sitting right at its threshold",
      other: "None of these",
    },
  },
  evidence_current: {
    type: "noul",
    instructions: "Does `evidence` show the problem in `summary` happening now?",
    criteria: {
      true: "Current readings, process lists or file sizes that match `summary`",
      false: "`evidence` is empty, stale, contradicts `summary`, or only restates it",
    },
  },
};

/**
 * Advisory episodes have nothing to fix, and an `urgent` one cannot wait: the ladder is
 * serialized, so a triage would hold every queued observation, disk-critical included.
 */
export function shouldTriage(observation: RemediationObservation): boolean {
  if (!observation.escalation) return false;
  if (observation.escalation.advice === true) return false;
  return observation.level !== "urgent";
}

export function buildRemediationTriageState(observation: RemediationObservation) {
  const evidence = observation.evidence ?? "";
  return {
    condition: observation.kind,
    title: observation.title,
    summary: observation.summary,
    evidence:
      evidence.length <= MAX_EVIDENCE_CHARS
        ? evidence
        : `${evidence.slice(0, MAX_EVIDENCE_CHARS)}\n… (${evidence.length - MAX_EVIDENCE_CHARS} more characters cut)`,
    attempts: (observation.attempts ?? []).map(
      (attempt) => `${attempt.remedy}: ${attempt.outcome} - ${attempt.detail}`,
    ),
    agent_task: observation.escalation?.task ?? "",
  };
}

/**
 * What the state is about, for the D7 exclusion. The linked agent covers its own, ancestor and
 * descendant cwds, which include its workspace's; the remediation agent's cwd is added so a task
 * aimed at company code sends nothing. A workspace link with no agent cannot be resolved here, so
 * the call is excluded. Machine-wide observations, the work-at-risk sweep's included (its key is
 * plain `work-at-risk`; the worktree paths are in its evidence), rely on the service's text scan.
 */
export function remediationTriageScope(observation: RemediationObservation): JevEgressScope {
  const link = observation.link;
  if (link?.workspaceId && !link.agentId) return { cwds: [], missing: true };
  const cwds = observation.escalation?.cwd ? [observation.escalation.cwd] : [];
  return link?.agentId ? { cwds, agentIds: [link.agentId] } : { cwds };
}

/** What JEV said, read off the outcome. `error`: the triage itself threw or ran out of time. */
export interface EscalationTriage {
  callId: string | null;
  outcome: JevOutcome["kind"] | "error";
  /** The unavailable or failure reason, or why the triage errored. */
  reason: string | null;
  route: string | null;
  routeConfidence: number | null;
  evidenceCurrent: number | null;
  costUsd: number | null;
}

export function readEscalationTriage(outcome: JevOutcome): EscalationTriage {
  const base = { callId: outcome.callId, outcome: outcome.kind };
  if (outcome.kind === "unavailable" || outcome.kind === "failed") {
    return {
      ...base,
      reason: outcome.reason,
      route: null,
      routeConfidence: null,
      evidenceCurrent: null,
      costUsd: outcome.kind === "failed" ? (outcome.meta?.cost.usd ?? null) : null,
    };
  }
  const route = outcome.answers.route;
  const evidence = outcome.answers.evidence_current;
  return {
    ...base,
    reason: null,
    route: route?.type === "choice" ? route.choice : null,
    routeConfidence: route?.type === "choice" ? route.confidence : null,
    evidenceCurrent: evidence?.type === "noul" ? evidence.noul : null,
    costUsd: outcome.meta.cost.usd,
  };
}

export function erroredTriage(reason: string): EscalationTriage {
  return {
    callId: null,
    outcome: "error",
    reason,
    route: null,
    routeConfidence: null,
    evidenceCurrent: null,
    costUsd: null,
  };
}

/** `person`: rung 3 now, no agent. `defer`: hold rung 2 once. `start-agent`: today's behaviour. */
export type TriageAction = "start-agent" | "person" | "defer";

export interface TriageDecision {
  /** What JEV's answer maps to, shadow included. What the shadow week is measured on. */
  wouldBe: TriageAction;
  /** What the ladder does: `wouldBe` when answered, otherwise `start-agent`. */
  action: TriageAction;
  /** True only for an `answered` outcome. False in shadow and every fail-open branch. */
  applied: boolean;
  deferMs: number;
}

/**
 * The doc's threshold table. `willPush` is the ladder's: a `needs_person` answer never skips the
 * agent unless the escalation reaches a phone now, because rung 3 is final and nobody would fix
 * it or be told. A missing `evidence_current` never defers, and neither does a condition with no
 * live remedy: nothing is acting on it, so it cannot clear by itself, and a monitor that stops
 * observing (the work-at-risk sweep closes its episode on the next sweep, handed over or not)
 * would close the held episode with no fixer and no push.
 */
export function decideTriageAction(
  triage: EscalationTriage,
  context: { willPush: boolean; graceMs: number; remedy: RemedyState },
): TriageDecision {
  const deferMs = Math.min(Math.max(context.graceMs, MIN_DEFER_MS), MAX_DEFER_MS);
  const wouldBe = mapRoute(triage, context);
  const applied = triage.outcome === "answered";
  return { wouldBe, action: applied ? wouldBe : "start-agent", applied, deferMs };
}

function mapRoute(
  triage: EscalationTriage,
  { willPush, remedy }: { willPush: boolean; remedy: RemedyState },
): TriageAction {
  if (triage.outcome !== "answered" && triage.outcome !== "shadow") return "start-agent";
  const confidence = triage.routeConfidence ?? 0;
  if (triage.route === "needs_person" && confidence >= NEEDS_PERSON_FLOOR) {
    return willPush ? "person" : "start-agent";
  }
  if (
    remedy === "live" &&
    triage.route === "clearing_on_its_own" &&
    confidence >= CLEARING_FLOOR &&
    triage.evidenceCurrent !== null &&
    triage.evidenceCurrent < EVIDENCE_CURRENT_CEILING
  ) {
    return "defer";
  }
  return "start-agent";
}

/**
 * Whether rung 3 would reach a person now: the notify rung and the condition's own switch are on,
 * the level `escalate` sends at is at least `notice`, and the notify policy's preview of that push
 * (its level and `remediation:<key>` dedupe key) says it goes out at once to a registered phone.
 * A fold into a push from the last hour, a digest hold, a log-only level and a phone with no token
 * all fail, and so does a missing preview (`null`: absent or it threw). The same rule governs
 * `escalation.personFirst`.
 */
export function willEscalationPush(input: {
  notify: boolean;
  level: NotifyLevel;
  preview: NotifyDeliveryPreview | null;
}): boolean {
  return (
    input.notify &&
    levelAtLeast(input.level, "notice") &&
    input.preview !== null &&
    reachesPhoneNow(input.preview)
  );
}

export function formatConfidence(value: number | null): string {
  return value === null ? "?" : value.toFixed(2);
}

/** The escalation outcome line for a `person` action; the push body carries it. */
export function describePersonSkip(triage: EscalationTriage): string {
  return `No agent started: JEV judged this needs a person (${formatConfidence(triage.routeConfidence)}).`;
}

/** The async triage the ladder calls, built from the JEV service in bootstrap. Never rejects. */
export function createEscalationTriage(
  jev: Pick<JevService, "decide">,
): (input: {
  episodeKey: string;
  observation: RemediationObservation;
}) => Promise<EscalationTriage> {
  return async ({ observation }) => {
    try {
      const agentId = observation.link?.agentId;
      const outcome = await jev.decide({
        feature: "remediationTriage",
        callSite: REMEDIATION_TRIAGE_CALL_SITE,
        state: buildRemediationTriageState(observation),
        questions: REMEDIATION_TRIAGE_QUESTIONS,
        scope: remediationTriageScope(observation),
        ...(agentId ? { subject: { agentId } } : {}),
      });
      return readEscalationTriage(outcome);
    } catch {
      return erroredTriage("threw");
    }
  };
}

/**
 * The measurement record (docs/jev.md, Feature 3a, "Pays if"). One `triage` line when the ladder
 * asks, then an `agent-ended` line with the agent's tokens and a `closed` line when the episode
 * closes, joined on `episode`. Untriaged episodes that ran an agent get the last two too, so the
 * file also holds the typical cost of a remediation agent.
 */
export type RemediationTriageEvent =
  | {
      type: "triage";
      at: string;
      episode: string;
      key: string;
      kind: string;
      level: NotifyLevel;
      willPush: boolean;
      /** The notify policy's preview behind `willPush`; null when absent or unreadable. */
      pushPreview: NotifyDeliveryPreview | null;
      linkedAgentId: string | null;
      triage: EscalationTriage;
      decision: TriageDecision;
    }
  | {
      type: "person-first";
      at: string;
      episode: string;
      key: string;
      kind: string;
      willPush: boolean;
      pushPreview: NotifyDeliveryPreview | null;
      reason: string;
      confidence: number;
      /** True when the agent was skipped; false when the escalation would not push. */
      skipped: boolean;
    }
  | {
      type: "agent-ended";
      at: string;
      episode: string;
      key: string;
      kind: string;
      agentId: string;
      result: "fixed" | "not-fixed";
      cause: RemediationAgentEndCause;
      /** The agent's total tokens as the ladder reads them for `paseo.budget`; null when unread. */
      agentTotalTokens: number | null;
      agentModel: string | null;
      minutesRunning: number;
      triageCallId: string | null;
      triageWouldBe: string | null;
      triageApplied: boolean | null;
    }
  | {
      type: "closed";
      at: string;
      episode: string;
      key: string;
      kind: string;
      minutesOpen: number;
      minutesSinceTriage: number | null;
      /** Closed while a JEV deferral held rung 2. */
      duringDeferral: boolean;
      /**
       * Closed inside the hold by a monitor whose remedy was live, before any agent ran: the
       * condition cleared on its own. The only close of a deferred episode that counts as an
       * agent avoided.
       */
      clearedDuringHold: boolean;
      agentRan: boolean;
      escalated: boolean;
      triageCallId: string | null;
      triageWouldBe: string | null;
      triageApplied: boolean | null;
    };

export type RemediationAgentEndCause = "report" | "timeout" | "budget" | "error" | "gone";

const TRIAGE_FILE_MAX_BYTES = 1_000_000;

/**
 * Appends events to `filePath` (0600, one rotation to `.1` at 1 MB, about 1,500 episodes), logs
 * each as a `remediation-triage` line, and puts a `triage` about a linked agent in the JEV
 * decision store. Never throws; the write happens off the ladder's path.
 */
export function createRemediationTriageRecorder(options: {
  jev: Pick<JevService, "decisions">;
  filePath: string;
  logger: Logger;
}): (event: RemediationTriageEvent) => void {
  const { logger } = options;
  const file = createJsonlAppender({
    filePath: options.filePath,
    maxBytes: TRIAGE_FILE_MAX_BYTES,
    logger,
  });
  return (event) => {
    try {
      logger.info({ remediationTriage: event }, "remediation-triage");
      if (event.type === "triage" && event.linkedAgentId && event.triage.callId) {
        options.jev.decisions.record({
          agentId: event.linkedAgentId,
          callId: event.triage.callId,
          feature: "remediationTriage",
          question: "Should a remediation agent handle this?",
          verdict: describeVerdict(event.triage),
          confidence: event.triage.routeConfidence,
          action: describeAction(event.decision),
          applied: event.decision.applied,
        });
      }
    } catch {
      // Recording never breaks the ladder.
    }
    file.append({ v: 1, ...event });
  };
}

function describeVerdict(triage: EscalationTriage): string {
  if (triage.route === null) return `${triage.outcome}: ${triage.reason ?? "no answer"}`;
  const evidence =
    triage.evidenceCurrent === null
      ? ""
      : `, evidence current ${triage.evidenceCurrent.toFixed(2)}`;
  return `${triage.route} (${formatConfidence(triage.routeConfidence)})${evidence}`;
}

function describeAction(decision: TriageDecision): string {
  const words: Record<TriageAction, string> = {
    "start-agent": "remediation agent started",
    person: "no remediation agent; sent to a person",
    defer: "remediation agent held once, while the live remedy acts",
  };
  if (decision.applied) return words[decision.action];
  if (decision.wouldBe === "start-agent") return words["start-agent"];
  return `would have: ${words[decision.wouldBe]} (not applied; agent started)`;
}
