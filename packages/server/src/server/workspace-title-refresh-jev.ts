import type { Logger } from "pino";

import type { JevEgressScope, JevOutcome, JevQuestions, JevService } from "./jev/contract.js";
import { createJsonlAppender } from "./jsonl-appender.js";
import type {
  WorkspaceTitleConversation,
  WorkspaceTitleTrackerAgentSummary,
} from "./agent/agent-manager.js";
import type { ResolvedWorkspaceTitleRefreshConfig } from "./workspace-title-refresh-config.js";

/**
 * Feature 17, session title refresh (docs/jev.md). Before `WorkspaceTitleTracker` spends a
 * structured-generation call re-titling a workspace, JEV answers one question: does the current
 * name still describe what its sessions are doing now? A confident "still fits" skips the call,
 * which is the saving. A "stale" answer generates. Everything else (no key, an outage, a
 * low-confidence answer, a D7-excluded workspace) falls to a deterministic cadence, and a ceiling
 * regenerates regardless, so a wrong "still fits" cannot freeze a name.
 */

export const TITLE_REFRESH_CALL_SITE = "workspace-title.refresh";

export const TITLE_REFRESH_QUESTIONS: JevQuestions = {
  fit: {
    type: "score",
    instructions:
      "`current_title` names a workspace — one checkout or worktree. `sessions` lists the coding-agent sessions working in it now, newest first: what each was first asked, what it was asked most recently, and what it is doing. `latest_reply` is the newest session's last answer. Does `current_title` still describe the work these sessions are doing now?",
    criteria: [
      "Still describes exactly what these sessions are doing",
      "Mostly still fits; the work has drifted only a little",
      "Noticeably stale; the sessions have moved on to something the name does not mention",
      "Describes something unrelated to what is happening now",
    ],
  },
};

/** Per-message cap on what is sent to JEV; the foundation's state limit is 60 KB. */
const MESSAGE_MAX_CHARS = 1_200;

function trimMessage(text: string | null): string | null {
  if (!text) return null;
  return text.length > MESSAGE_MAX_CHARS ? `${text.slice(0, MESSAGE_MAX_CHARS)}…` : text;
}

/** One recent agent and what it was asked and said. */
export interface TitleRefreshSession {
  agent: WorkspaceTitleTrackerAgentSummary;
  conversation: WorkspaceTitleConversation;
}

/**
 * The state sent to JEV: what the work is now, taken from the conversation itself. Agent titles
 * are left out on purpose: the current name was generated from them, so asking whether it fits
 * them is circular and biased toward "fits".
 */
export function buildTitleRefreshState(input: {
  currentTitle: string;
  branch: string | null;
  sessions: readonly TitleRefreshSession[];
}): {
  current_title: string;
  branch: string | null;
  sessions: {
    status: string;
    first_request: string | null;
    recent_requests: string[];
    doing: string | null;
  }[];
  latest_reply: string | null;
} {
  return {
    current_title: input.currentTitle,
    branch: input.branch,
    sessions: input.sessions.map(({ agent, conversation }) => ({
      status: agent.lifecycle,
      first_request: trimMessage(conversation.firstUserMessage),
      recent_requests: conversation.recentUserMessages
        .map((message) => trimMessage(message))
        .filter((message): message is string => message !== null),
      doing: agent.lastActivitySummary,
    })),
    latest_reply: trimMessage(input.sessions[0]?.conversation.lastAssistantMessage ?? null),
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
  | "no-new-activity"
  /** The title was cleared (the hand-back gesture): name it now rather than at the next look. */
  | "untitled"
  | "ceiling"
  | "jev-stale"
  | "jev-fits"
  | "cadence"
  | "cadence-not-ready";

export interface TitleRefreshDecision {
  generate: boolean;
  action: TitleRefreshAction;
  gatedByJev: boolean;
  outcome: JevOutcome["kind"] | null;
  /** Joins the audit and the ledger. Null unless JEV actually answered. */
  callId: string | null;
  /** Why the cadence ran instead of JEV: "excluded" (D7), "low-confidence", an outage reason. */
  reason: string | null;
  score: number | null;
  confidence: number | null;
  userTurnsSinceLook: number;
  userTurnsSinceGeneration: number;
  minutesSinceGeneration: number;
}

/**
 * Per-workspace counters the tracker keeps. In memory only: a restart starts every workspace
 * over from first sight, the same trade every JEV feature without a persisted store makes.
 */
export interface TitleRefreshCounters {
  /** New user turns since the title was last looked at (a JEV answer, the cadence, the ceiling). */
  userTurnsSinceLook: number;
  /** New user turns since a title was last generated. The cadence and the ceiling count these. */
  userTurnsSinceGeneration: number;
  /** When a title was last generated, or when the tracker first saw the workspace. */
  lastGenerationAtMs: number;
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
  sessions: readonly TitleRefreshSession[];
}): Promise<TitleRefreshDecision> {
  const { config, counters } = input;
  const base = {
    gatedByJev: false,
    outcome: null,
    callId: null,
    reason: null,
    score: null,
    confidence: null,
    userTurnsSinceLook: counters.userTurnsSinceLook,
    userTurnsSinceGeneration: counters.userTurnsSinceGeneration,
    minutesSinceGeneration: (input.nowMs - counters.lastGenerationAtMs) / 60_000,
  } satisfies Omit<TitleRefreshDecision, "generate" | "action">;

  if (counters.userTurnsSinceLook < 1) {
    return { ...base, generate: false, action: "no-new-activity" };
  }

  const ceilingReached =
    counters.userTurnsSinceGeneration >= config.ceilingUserTurns ||
    base.minutesSinceGeneration >= config.ceilingHours * 60;
  if (ceilingReached) {
    return { ...base, generate: true, action: "ceiling" };
  }

  if (!input.jev || !config.enabled) {
    return cadenceDecision(config, base);
  }

  const agents = input.sessions.map((session) => session.agent);
  const outcome = await input.jev.decide({
    feature: "titleRefresh",
    callSite: TITLE_REFRESH_CALL_SITE,
    state: buildTitleRefreshState({
      currentTitle: input.currentTitle,
      branch: input.branch,
      sessions: input.sessions,
    }),
    questions: TITLE_REFRESH_QUESTIONS,
    scope: titleRefreshScope({ cwd: input.cwd, agents }),
    deadlineMs: config.timeoutMs,
  });
  if (outcome.kind !== "answered") {
    // D7 ("excluded": nothing was sent), no key, an outage or a timeout: the cadence decides.
    const reason =
      outcome.kind === "unavailable" || outcome.kind === "failed" ? outcome.reason : null;
    return cadenceDecision(config, { ...base, outcome: outcome.kind, reason });
  }
  const answer = outcome.answers["fit"];
  if (answer?.type !== "score" || answer.confidence < config.minConfidence) {
    return cadenceDecision(config, {
      ...base,
      outcome: outcome.kind,
      callId: outcome.callId,
      reason: "low-confidence",
      confidence: answer?.type === "score" ? answer.confidence : null,
    });
  }
  const stale = answer.score >= config.staleScoreThreshold;
  return {
    ...base,
    generate: stale,
    action: stale ? "jev-stale" : "jev-fits",
    gatedByJev: true,
    outcome: outcome.kind,
    callId: outcome.callId,
    score: answer.score,
    confidence: answer.confidence,
  };
}

function cadenceDecision(
  config: ResolvedWorkspaceTitleRefreshConfig,
  base: Omit<TitleRefreshDecision, "generate" | "action">,
): TitleRefreshDecision {
  const ready =
    base.userTurnsSinceGeneration >= config.cadenceMinUserTurns &&
    base.minutesSinceGeneration >= config.cadenceMinMinutes;
  return { ...base, generate: ready, action: ready ? "cadence" : "cadence-not-ready" };
}

/** One line per look: every decision the tracker reaches, plus the untitled hand-back. */
export interface TitleRefreshCheckEvent {
  at: string;
  workspaceId: string;
  action: TitleRefreshAction;
  gatedByJev: boolean;
  outcome: JevOutcome["kind"] | null;
  callId: string | null;
  reason: string | null;
  score: number | null;
  confidence: number | null;
  staleScoreThreshold: number;
  generationCalled: boolean;
  userTurnsSinceLook: number;
  userTurnsSinceGeneration: number;
  minutesSinceGeneration: number | null;
}

const TITLE_REFRESH_FILE_MAX_BYTES = 1_000_000;

/**
 * Appends one line per look to `$PASEO_HOME/jev/title-refresh.jsonl` (0600, one rotation at
 * 1 MB) and puts a line in the JEV decision store when JEV's answer decided the look. This is how
 * "generation calls avoided" gets counted later by the savings ledger.
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
        const fits = event.action === "jev-fits";
        options.jev.decisions.record({
          agentId: context.agentId,
          callId: event.callId,
          feature: "titleRefresh",
          question: `Does "${context.currentTitle}" still describe what this session is doing?`,
          verdict: event.score === null ? "no answer" : `fit ${event.score.toFixed(1)}`,
          confidence: event.confidence,
          action: fits
            ? "kept the workspace title, skipping the regeneration"
            : "regenerated the workspace title",
          // `applied` means JEV changed what code did (contract.ts): a "fits" answer skipped the
          // call; a "stale" answer let it through, which is what would have happened anyway.
          applied: fits,
          mode: "live",
          wouldBe: "regenerate title",
        });
      }
    } catch {
      // Recording never breaks the tracker.
    }
    file.append({ v: 2, ...event, at });
  };
}
