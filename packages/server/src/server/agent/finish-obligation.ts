import { z } from "zod";
import type { OwedFinishReport } from "@getpaseo/protocol/agent-types";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import { isLimitShapedError } from "./account-failover-detector.js";

/**
 * The finish report a delegated agent owes the agent that asked for it, stored on the child's
 * record so it outlives the daemon. Everything here is pure: the service
 * (finish-obligation-service.ts) gathers state, asks these functions what to do, and writes the
 * answer back. See docs/finish-reports.md.
 */

/** What a finish report says happened. The words go straight into the report body. */
export type FinishOutcomeReason =
  | "finished"
  | "errored"
  | "was closed"
  | "was canceled"
  | "stopped before reporting";

const FINISH_OBLIGATION_STATES = [
  // Armed; the child is working and has not reached an outcome.
  "pending",
  // The child reached an outcome; the report is being delivered up the ladder.
  "owed",
  // Terminal: the owner received it.
  "delivered",
  // Terminal: the owner could not be told; an orchestrator or the operator was.
  "escalated",
  // Terminal: nobody is owed it any more (owner archived, child detached).
  "released",
  // Terminal: a successor carries on the work and owes the report instead.
  "transferred",
] as const;
export type FinishObligationState = (typeof FINISH_OBLIGATION_STATES)[number];

const FINISH_OBLIGATION_RUNGS = ["owner", "orchestrator", "operator"] as const;
export type FinishObligationRung = (typeof FINISH_OBLIGATION_RUNGS)[number];

export const FINISH_OBLIGATION_SCHEMA = z.object({
  ownerAgentId: z.string(),
  /** Bumped on every arm. A watcher armed under an older generation is stale and stands down. */
  generation: z.number().int(),
  armedAt: z.string(),
  /** create_agent arms with this: the report is owed only while the child keeps that parent. */
  requireParentOwnership: z.boolean().optional(),
  /** The predecessor whose obligation this successor took over. */
  inheritedFrom: z.string().optional(),
  state: z.enum(FINISH_OBLIGATION_STATES),
  /** First sweep that found the child stopped while still owing the report. */
  parkedSince: z.string().optional(),
  outcome: z
    .object({
      reason: z.string(),
      at: z.string(),
      /**
       * The child's last answer, captured when the outcome was recorded. A report delivered
       * after a restart would otherwise arrive without it: the child is not loaded then.
       */
      message: z.string().optional(),
    })
    .optional(),
  rung: z.enum(FINISH_OBLIGATION_RUNGS).optional(),
  rungSince: z.string().optional(),
  attempts: z.number().int().optional(),
  nextAttemptAt: z.string().optional(),
  lastError: z.string().optional(),
  resolvedAt: z.string().optional(),
  /** A sentence saying how it ended, for logs and for whoever reads the record. */
  resolution: z.string().optional(),
  transferredTo: z.string().optional(),
});
export type FinishObligation = z.infer<typeof FINISH_OBLIGATION_SCHEMA>;

export interface FinishReportLadderConfig {
  /** Delivery attempts to the owner before the report goes up a rung. */
  maxOwnerAttempts: number;
  /** Wait between attempts to the owner, and the orchestrator rung's whole budget. */
  retryIntervalMs: number;
  /** How long a stopped child may sit owing a report before the sweep reports for it. */
  parkedGraceMs: number;
}

/** Above the report body's own limit, so the body still truncates and says how much it cut. */
const FINISH_REPORT_MESSAGE_LIMIT = 8000;

export const DEFAULT_FINISH_REPORT_LADDER: FinishReportLadderConfig = {
  maxOwnerAttempts: 3,
  retryIntervalMs: 5 * 60_000,
  parkedGraceMs: 2 * 60_000,
};

export function isUnresolved(obligation: FinishObligation): boolean {
  return obligation.state === "pending" || obligation.state === "owed";
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Arm (or re-arm) the report owed to `ownerAgentId`, replacing whatever that owner had before. */
export function armObligation(
  obligations: readonly FinishObligation[],
  input: {
    ownerAgentId: string;
    requireParentOwnership?: boolean;
    inheritedFrom?: string;
    nowMs: number;
  },
): { obligations: FinishObligation[]; armed: FinishObligation } {
  const previous = obligations.find((entry) => entry.ownerAgentId === input.ownerAgentId);
  const armed: FinishObligation = {
    ownerAgentId: input.ownerAgentId,
    generation: (previous?.generation ?? 0) + 1,
    armedAt: iso(input.nowMs),
    state: "pending",
    ...(input.requireParentOwnership ? { requireParentOwnership: true } : {}),
    ...(input.inheritedFrom ? { inheritedFrom: input.inheritedFrom } : {}),
  };
  return {
    obligations: [
      ...obligations.filter((entry) => entry.ownerAgentId !== input.ownerAgentId),
      armed,
    ],
    armed,
  };
}

/** The child reached an outcome. Null when this generation was superseded or already settled. */
export function recordOutcome(
  obligation: FinishObligation,
  input: {
    generation: number;
    reason: FinishOutcomeReason;
    nowMs: number;
    message?: string | null;
  },
): FinishObligation | null {
  if (obligation.state !== "pending" || obligation.generation !== input.generation) {
    return null;
  }
  const { parkedSince: _parkedSince, ...rest } = obligation;
  return {
    ...rest,
    state: "owed",
    outcome: {
      reason: input.reason,
      at: iso(input.nowMs),
      ...(input.message ? { message: input.message.slice(0, FINISH_REPORT_MESSAGE_LIMIT) } : {}),
    },
    rung: "owner",
    rungSince: iso(input.nowMs),
    attempts: 0,
    nextAttemptAt: iso(input.nowMs),
  };
}

/** What is known about an agent at the moment a step is planned. */
export interface AgentPresence {
  exists: boolean;
  archived: boolean;
  /** Null when the agent is not loaded in this daemon — a closed record. */
  lifecycle: AgentLifecycleStatus | null;
  lastError?: string | null;
  hasPendingPermission?: boolean;
}

/**
 * How a report may reach an agent, decided from its lifecycle before anything is sent.
 *
 * A report is sent with `activeTurnBehavior: "steer"`, which only steers when a turn is active:
 * on an idle agent it starts a new turn. That is what a report wants — the owner has to act on
 * it — but it has to be a decision, not a side effect, so every delivery goes through here.
 *
 * - `steer`: running; the report joins the active turn.
 * - `wake`: idle, closed, or not loaded; the report starts a turn (loading the agent if needed).
 * - `wait`: initializing, or failed on an account cap that account failover is about to move —
 *   a turn started now would fail or race the move. Retried next sweep, bounded by the rung's
 *   deadline.
 * - `unreachable`: archived or gone. Nothing sent to it would ever be read.
 */
export type DeliveryGate = "steer" | "wake" | "wait" | "unreachable";

export function gateDelivery(target: AgentPresence): DeliveryGate {
  if (!target.exists || target.archived) return "unreachable";
  switch (target.lifecycle) {
    case "running":
      return "steer";
    case "initializing":
      return "wait";
    case "error":
      return isLimitShapedError(target.lastError) ? "wait" : "wake";
    default:
      return "wake";
  }
}

export interface ObligationContext {
  nowMs: number;
  child: AgentPresence & { parentAgentId: string | null };
  /**
   * Who receives the owner's report: the owner, or — when account failover retired the owner by
   * importing its conversation into a new agent — the successor carrying it on.
   */
  owner: AgentPresence & { agentId: string };
  /** The nearest live agent above the owner, when there is one. */
  orchestrator: { agentId: string; presence: AgentPresence } | null;
  config: FinishReportLadderConfig;
}

export type ObligationStep =
  | { kind: "none" }
  | { kind: "park" }
  | { kind: "unpark" }
  | { kind: "settle"; reason: FinishOutcomeReason }
  | { kind: "release"; resolution: string }
  | {
      kind: "deliver";
      rung: "owner" | "orchestrator";
      targetAgentId: string;
      gate: "steer" | "wake";
    }
  | { kind: "escalate"; to: "orchestrator" | "operator"; why: string }
  | { kind: "push" };

/** Why a report owed by a stopped child is being sent by the sweep instead of its watcher. */
function parkedOutcome(child: AgentPresence): FinishOutcomeReason {
  if (child.lifecycle === "idle") return "finished";
  if (child.lifecycle === "error") return "errored";
  return "stopped before reporting";
}

function rungDeadlineMs(obligation: FinishObligation, config: FinishReportLadderConfig): number {
  const since = parseMs(obligation.rungSince) ?? parseMs(obligation.outcome?.at) ?? 0;
  const budget =
    obligation.rung === "orchestrator"
      ? config.retryIntervalMs
      : config.retryIntervalMs * config.maxOwnerAttempts;
  return since + budget;
}

function planPending(obligation: FinishObligation, ctx: ObligationContext): ObligationStep {
  const { child } = ctx;
  if (child.archived) {
    // Archived while nobody watched it (after a restart, say). Say so, as a live watcher would.
    return { kind: "settle", reason: "was closed" };
  }
  const working =
    child.lifecycle === "running" ||
    child.lifecycle === "initializing" ||
    child.hasPendingPermission === true;
  if (working) {
    return obligation.parkedSince ? { kind: "unpark" } : { kind: "none" };
  }
  const parkedSinceMs = parseMs(obligation.parkedSince);
  if (parkedSinceMs === null) return { kind: "park" };
  if (ctx.nowMs - parkedSinceMs < ctx.config.parkedGraceMs) return { kind: "none" };
  return { kind: "settle", reason: parkedOutcome(child) };
}

function planOwnerRung(obligation: FinishObligation, ctx: ObligationContext): ObligationStep {
  const gate = gateDelivery(ctx.owner);
  if (gate === "unreachable") {
    // Unreachable at the owner rung means the owner was archived or deleted: whoever did that
    // ended the tree, and the child keeps its result on its own record.
    return { kind: "release", resolution: "its owner was archived before it could be told" };
  }
  const nextAttemptMs = parseMs(obligation.nextAttemptAt) ?? 0;
  if (ctx.nowMs < nextAttemptMs) return { kind: "none" };
  if (gate === "wait") {
    return ctx.nowMs >= rungDeadlineMs(obligation, ctx.config)
      ? { kind: "escalate", to: "orchestrator", why: "its owner never became reachable" }
      : { kind: "none" };
  }
  return { kind: "deliver", rung: "owner", targetAgentId: ctx.owner.agentId, gate };
}

function planOrchestratorRung(
  obligation: FinishObligation,
  ctx: ObligationContext,
): ObligationStep {
  const orchestrator = ctx.orchestrator;
  if (!orchestrator) {
    return { kind: "escalate", to: "operator", why: "no live agent above its owner" };
  }
  const gate = gateDelivery(orchestrator.presence);
  if (gate === "unreachable") {
    return { kind: "escalate", to: "operator", why: "the orchestrator is unreachable" };
  }
  if (gate === "wait") {
    return ctx.nowMs >= rungDeadlineMs(obligation, ctx.config)
      ? { kind: "escalate", to: "operator", why: "the orchestrator never became reachable" }
      : { kind: "none" };
  }
  return { kind: "deliver", rung: "orchestrator", targetAgentId: orchestrator.agentId, gate };
}

/** The one thing to do next for this obligation. Terminal obligations need nothing. */
export function planObligationStep(
  obligation: FinishObligation,
  ctx: ObligationContext,
): ObligationStep {
  if (!isUnresolved(obligation)) return { kind: "none" };
  if (!ctx.child.exists) {
    return { kind: "release", resolution: "the agent no longer exists" };
  }
  if (obligation.requireParentOwnership && ctx.child.parentAgentId !== obligation.ownerAgentId) {
    return { kind: "release", resolution: "it was detached from its parent" };
  }
  if (obligation.state === "pending") return planPending(obligation, ctx);
  switch (obligation.rung ?? "owner") {
    case "owner":
      return planOwnerRung(obligation, ctx);
    case "orchestrator":
      return planOrchestratorRung(obligation, ctx);
    case "operator":
      return { kind: "push" };
  }
}

export function markParked(obligation: FinishObligation, nowMs: number): FinishObligation {
  return { ...obligation, parkedSince: iso(nowMs) };
}

export function clearParked(obligation: FinishObligation): FinishObligation {
  const { parkedSince: _parkedSince, ...rest } = obligation;
  return rest;
}

export function releaseObligation(
  obligation: FinishObligation,
  input: { nowMs: number; resolution: string },
): FinishObligation {
  return {
    ...obligation,
    state: "released",
    resolvedAt: iso(input.nowMs),
    resolution: input.resolution,
  };
}

export function escalateObligation(
  obligation: FinishObligation,
  input: { to: "orchestrator" | "operator"; why: string; nowMs: number },
): FinishObligation {
  return {
    ...obligation,
    rung: input.to,
    rungSince: iso(input.nowMs),
    nextAttemptAt: iso(input.nowMs),
    lastError: input.why,
  };
}

/** Record one delivery attempt on the owner or orchestrator rung. */
export function recordDeliveryAttempt(
  obligation: FinishObligation,
  input: {
    rung: "owner" | "orchestrator";
    targetAgentId: string;
    error: string | null;
    nowMs: number;
    config: FinishReportLadderConfig;
  },
): FinishObligation {
  const attempts = (obligation.attempts ?? 0) + 1;
  if (input.error === null) {
    const { nextAttemptAt: _nextAttemptAt, ...rest } = obligation;
    return {
      ...rest,
      attempts,
      state: input.rung === "owner" ? "delivered" : "escalated",
      resolvedAt: iso(input.nowMs),
      resolution:
        input.rung === "owner"
          ? `delivered to ${input.targetAgentId}`
          : `delivered to orchestrator ${input.targetAgentId}; the owner was unreachable`,
    };
  }
  if (input.rung === "orchestrator") {
    return escalateObligation(
      { ...obligation, attempts },
      { to: "operator", why: input.error, nowMs: input.nowMs },
    );
  }
  if (attempts >= input.config.maxOwnerAttempts) {
    return escalateObligation(
      { ...obligation, attempts },
      { to: "orchestrator", why: input.error, nowMs: input.nowMs },
    );
  }
  return {
    ...obligation,
    attempts,
    lastError: input.error,
    nextAttemptAt: iso(input.nowMs + input.config.retryIntervalMs),
  };
}

/** The last rung. Terminal whether or not the push itself went out; the ladder never loops. */
export function recordOperatorPush(
  obligation: FinishObligation,
  input: { nowMs: number; error: string | null },
): FinishObligation {
  const { nextAttemptAt: _nextAttemptAt, ...rest } = obligation;
  return {
    ...rest,
    state: "escalated",
    resolvedAt: iso(input.nowMs),
    resolution:
      input.error === null
        ? "pushed to the operator; no agent could be told"
        : `the operator push failed too (${input.error}); the child is flagged for attention`,
  };
}

/**
 * Whether a successor taking over this agent's work should take over its report too: the work
 * has not been reported as finished. A report already delivered as "errored" or "stopped" still
 * passes on — the successor is the one that will actually finish, and the owner is owed that.
 */
export function canPassToSuccessor(obligation: FinishObligation): boolean {
  if (obligation.transferredTo) return false;
  if (isUnresolved(obligation)) return true;
  if (obligation.state !== "delivered" && obligation.state !== "escalated") return false;
  return obligation.outcome !== undefined && obligation.outcome.reason !== "finished";
}

export function markTransferred(
  obligation: FinishObligation,
  input: { successorId: string; nowMs: number },
): FinishObligation {
  if (!isUnresolved(obligation)) {
    return { ...obligation, transferredTo: input.successorId };
  }
  return {
    ...obligation,
    state: "transferred",
    transferredTo: input.successorId,
    resolvedAt: iso(input.nowMs),
    resolution: `carried on by ${input.successorId}`,
  };
}

/**
 * The owed-report summary the wire carries (docs/finish-reports.md#what-the-panel-shows). Only
 * the two states worth an orchestrator's eye: a child that stopped while still owing its report,
 * and a report that could not be delivered. A child simply working carries nothing.
 */
export function summarizeOwedFinishReport(
  obligations: readonly FinishObligation[] | undefined,
): OwedFinishReport | undefined {
  for (const obligation of obligations ?? []) {
    if (obligation.state === "pending" && obligation.parkedSince) {
      return {
        ownerAgentId: obligation.ownerAgentId,
        state: "parked",
        since: obligation.parkedSince,
      };
    }
    const failedOnce = (obligation.attempts ?? 0) > 0 || (obligation.rung ?? "owner") !== "owner";
    if (obligation.state === "owed" && failedOnce) {
      return {
        ownerAgentId: obligation.ownerAgentId,
        state: "undelivered",
        since: obligation.outcome?.at ?? obligation.armedAt,
        attempts: obligation.attempts ?? 0,
      };
    }
  }
  return undefined;
}
