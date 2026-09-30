import type { Logger } from "pino";

import { confidentScore } from "./jev/answers.js";
import type { JevEgressScope, JevOutcome, JevQuestions, JevService } from "./jev/contract.js";
import { createJsonlAppender } from "./jsonl-appender.js";
import type { WorkspaceTitleTrackerAgentSummary } from "./agent/agent-manager.js";
import type { ResolvedWorkspaceTitleRefreshConfig } from "./workspace-title-refresh-config.js";

/**
 * Feature 17, session title refresh (docs/jev.md). Before `WorkspaceTitleTracker` spends a
 * structured-generation call re-titling a workspace, JEV answers one question: does the current
 * name still describe what its sessions are doing now? A "still fits" answer skips the generation
 * call, which is the saving; a "stale" answer, no key, an outage, or a D7-excluded workspace all
 * fall back to the tracker's own cadence, exactly as if JEV did not exist.
 */

export const TITLE_REFRESH_CALL_SITE = "workspace-title.refresh";

export const TITLE_REFRESH_QUESTIONS: JevQuestions = {
  fit: {
    type: "score",
    instructions:
      "`current_title` names a workspace — one checkout or worktree. `sessions` lists the coding-agent sessions running in it now, newest first, with a short summary of what each is doing. Does `current_title` still describe what these sessions are doing?",
    criteria: [
      "Still describes exactly what these sessions are doing",
      "Mostly still fits; the work has drifted only a little",
      "Noticeably stale; the sessions have moved on to something the name does not mention",
      "Describes something unrelated to what is happening now",
    ],
  },
};

function describeAgentForJev(agent: WorkspaceTitleTrackerAgentSummary): string {
  const lines = [`${agent.title ?? "(untitled session)"} [${agent.lifecycle}]`];
  if (agent.lastActivitySummary) lines.push(`doing: ${agent.lastActivitySummary}`);
  return lines.join(" — ");
}

/**
 * The state sent to JEV. `PersistedWorkspaceRecord` keeps no separate "first prompt" field once a
 * title is set (`workspace-auto-name.ts` only compares against it transiently), so the current
 * title plus each session's title and latest activity — the same material the generator itself
 * reads — stands in for it.
 */
export function buildTitleRefreshState(input: {
  currentTitle: string;
  branch: string | null;
  agents: readonly WorkspaceTitleTrackerAgentSummary[];
}): { current_title: string; branch: string | null; sessions: string[] } {
  return {
    current_title: input.currentTitle,
    branch: input.branch,
    sessions: input.agents.map(describeAgentForJev),
  };
}

export function titleRefreshScope(input: {
  cwd: string;
  agents: readonly WorkspaceTitleTrackerAgentSummary[];
}): JevEgressScope {
  return { cwds: [input.cwd], agentIds: input.agents.map((agent) => agent.id) };
}

/** What the tracker does about one workspace's check, for the jsonl record and the decision note. */
export type TitleRefreshAction =
  | "anchored"
  | "no-new-activity"
  | "ceiling"
  | "jev-stale"
  | "jev-fits"
  /** D7-excluded: sent nothing to JEV, generates exactly as it would with no JEV at all. */
  | "d7-excluded"
  | "cadence"
  | "cadence-not-ready";

export interface TitleRefreshDecision {
  generate: boolean;
  action: TitleRefreshAction;
  gatedByJev: boolean;
  outcome: JevOutcome["kind"] | null;
  /** Joins the audit and the ledger. Null unless JEV actually answered. */
  callId: string | null;
  reason: string | null;
  score: number | null;
  userTurnsSinceCheck: number;
  minutesSinceLastAttempt: number | null;
}

/**
 * Per-workspace counters the tracker keeps, reset whenever a check actually looks (ceiling, a JEV
 * answer, or a cadence attempt) — not merely whenever the sweep ticks. In memory only: a restart
 * starts every workspace's counters over, the same trade every JEV feature without a persisted
 * decision store makes.
 */
export interface TitleRefreshCounters {
  userTurnsSinceCheck: number;
  lastAttemptAtMs: number | null;
}

/**
 * Decides whether to spend a title regeneration for one workspace. Never throws: any error from
 * `jev.decide` is treated as `unavailable` by the service already, so this function only branches
 * on the outcome it returns.
 */
export async function decideTitleRefresh(input: {
  jev: Pick<JevService, "decide"> | null;
  config: ResolvedWorkspaceTitleRefreshConfig;
  counters: TitleRefreshCounters;
  nowMs: number;
  currentTitle: string;
  branch: string | null;
  cwd: string;
  agents: readonly WorkspaceTitleTrackerAgentSummary[];
}): Promise<TitleRefreshDecision> {
  const { config, counters, nowMs } = input;
  const userTurnsSinceCheck = counters.userTurnsSinceCheck;

  if (counters.lastAttemptAtMs === null) {
    // First time this workspace has ever been eligible: anchor the clock here rather than
    // judging it stale against a "since forever" elapsed time.
    return {
      generate: false,
      action: "anchored",
      gatedByJev: false,
      outcome: null,
      callId: null,
      reason: null,
      score: null,
      userTurnsSinceCheck,
      minutesSinceLastAttempt: null,
    };
  }

  const minutesSinceLastAttempt = (nowMs - counters.lastAttemptAtMs) / 60_000;

  if (userTurnsSinceCheck < 1) {
    return {
      generate: false,
      action: "no-new-activity",
      gatedByJev: false,
      outcome: null,
      callId: null,
      reason: null,
      score: null,
      userTurnsSinceCheck,
      minutesSinceLastAttempt,
    };
  }

  const ceilingReached =
    userTurnsSinceCheck >= config.ceilingUserTurns ||
    minutesSinceLastAttempt >= config.ceilingHours * 60;
  if (ceilingReached) {
    return {
      generate: true,
      action: "ceiling",
      gatedByJev: false,
      outcome: null,
      callId: null,
      reason: null,
      score: null,
      userTurnsSinceCheck,
      minutesSinceLastAttempt,
    };
  }

  if (input.jev) {
    const outcome = await input.jev.decide({
      feature: "titleRefresh",
      callSite: TITLE_REFRESH_CALL_SITE,
      state: buildTitleRefreshState({
        currentTitle: input.currentTitle,
        branch: input.branch,
        agents: input.agents,
      }),
      questions: TITLE_REFRESH_QUESTIONS,
      scope: titleRefreshScope({ cwd: input.cwd, agents: input.agents }),
      deadlineMs: config.timeoutMs,
    });
    if (outcome.kind === "answered") {
      const score = confidentScore(outcome, "fit", 0);
      const stale = score === null || score >= config.staleScoreThreshold;
      return {
        generate: stale,
        action: stale ? "jev-stale" : "jev-fits",
        gatedByJev: true,
        outcome: outcome.kind,
        callId: outcome.callId,
        reason: null,
        score,
        userTurnsSinceCheck,
        minutesSinceLastAttempt,
      };
    }
    if (outcome.kind === "unavailable" && outcome.reason === "excluded") {
      // D7: nothing was sent. Generate exactly as this workspace would with no JEV wired at
      // all — the existing fingerprint-and-interval gate the tracker already applies is the
      // only cadence a Wonderly-scoped workspace gets.
      return {
        generate: true,
        action: "d7-excluded",
        gatedByJev: false,
        outcome: outcome.kind,
        callId: null,
        reason: outcome.reason,
        score: null,
        userTurnsSinceCheck,
        minutesSinceLastAttempt,
      };
    }
    return cadenceDecision({
      config,
      userTurnsSinceCheck,
      minutesSinceLastAttempt,
      outcome: outcome.kind,
      reason: outcome.kind === "unavailable" || outcome.kind === "failed" ? outcome.reason : null,
    });
  }

  return cadenceDecision({ config, userTurnsSinceCheck, minutesSinceLastAttempt });
}

function cadenceDecision(input: {
  config: ResolvedWorkspaceTitleRefreshConfig;
  userTurnsSinceCheck: number;
  minutesSinceLastAttempt: number;
  outcome?: JevOutcome["kind"];
  reason?: string | null;
}): TitleRefreshDecision {
  const ready =
    input.userTurnsSinceCheck >= input.config.cadenceMinUserTurns &&
    input.minutesSinceLastAttempt >= input.config.cadenceMinMinutes;
  return {
    generate: ready,
    action: ready ? "cadence" : "cadence-not-ready",
    gatedByJev: false,
    outcome: input.outcome ?? null,
    callId: null,
    reason: input.reason ?? null,
    score: null,
    userTurnsSinceCheck: input.userTurnsSinceCheck,
    minutesSinceLastAttempt: input.minutesSinceLastAttempt,
  };
}

/** One line per check worth recording — every decision except `anchored` and `no-new-activity`. */
export interface TitleRefreshCheckEvent {
  at: string;
  workspaceId: string;
  action: TitleRefreshAction;
  gatedByJev: boolean;
  outcome: JevOutcome["kind"] | null;
  callId: string | null;
  reason: string | null;
  score: number | null;
  staleScoreThreshold: number;
  generationCalled: boolean;
  userTurnsSinceCheck: number;
  minutesSinceLastAttempt: number | null;
}

const TITLE_REFRESH_FILE_MAX_BYTES = 1_000_000;

/**
 * Appends one line per non-trivial check to `$PASEO_HOME/jev/title-refresh.jsonl` (0600, one
 * rotation at 1 MB) and puts a line in the JEV decision store when JEV was actually asked. This is
 * how "generation calls avoided" gets counted later by the savings ledger.
 */
export function createTitleRefreshRecorder(options: {
  jev: Pick<JevService, "decisions"> | null;
  filePath: string;
  logger: Logger;
}): (
  event: Omit<TitleRefreshCheckEvent, "at">,
  context: { agentId: string | null; currentTitle: string },
) => void {
  const { logger } = options;
  const file = createJsonlAppender({
    filePath: options.filePath,
    maxBytes: TITLE_REFRESH_FILE_MAX_BYTES,
    logger,
  });
  return (event, context) => {
    const at = new Date().toISOString();
    try {
      logger.info({ titleRefresh: { ...event, at } }, "workspace-title-refresh");
      if (options.jev && event.gatedByJev && context.agentId && event.callId) {
        options.jev.decisions.record({
          agentId: context.agentId,
          callId: event.callId,
          feature: "titleRefresh",
          question: `Does "${context.currentTitle}" still describe what this session is doing?`,
          verdict: event.score === null ? "no answer" : `fit ${event.score.toFixed(1)}`,
          confidence: null,
          action:
            event.action === "jev-stale"
              ? "workspace title regenerated"
              : "workspace title kept — JEV said it still fits",
          applied: event.action === "jev-stale",
        });
      }
    } catch {
      // Recording never breaks the tracker.
    }
    file.append({ v: 1, ...event, at });
  };
}
