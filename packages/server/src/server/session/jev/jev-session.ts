import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type {
  JevAnswer,
  JevDecisionRecord,
  JevOutcome,
  JevQuestions,
  JevService,
  JevState,
} from "../../jev/contract.js";

interface JevSessionLogger {
  warn: (obj: object, msg?: string) => void;
}

export interface JevSessionOptions {
  host: { emit: (message: SessionOutboundMessage) => void };
  service: JevService;
  logger: JevSessionLogger;
}

/** The status shape reported when `service.status()` itself throws: unavailable, nothing known. */
const UNAVAILABLE_STATUS: ReturnType<JevService["status"]> = {
  available: false,
  reason: "config-unreadable",
  keyPresent: false,
  provider: "openrouter",
  model: "",
  features: {
    spawnHint: { enabled: false, shadow: true },
    remediationTriage: { enabled: false, shadow: true },
    notificationTriage: { enabled: false, shadow: true },
    agentTools: { enabled: false, shadow: false },
    compactionTiming: { enabled: false, shadow: true },
    stallJudgment: { enabled: false, shadow: true },
  },
  lanes: {
    control: {
      today: {
        calls: 0,
        answered: 0,
        failed: 0,
        unavailable: 0,
        inputTokens: 0,
        usd: 0,
        usdSource: "none",
      },
      maxUsdPerDay: 0,
      exhausted: false,
      circuit: "closed",
      resetsAt: new Date(0).toISOString(),
    },
    agentTools: {
      today: {
        calls: 0,
        answered: 0,
        failed: 0,
        unavailable: 0,
        inputTokens: 0,
        usd: 0,
        usdSource: "none",
      },
      maxUsdPerDay: 0,
      exhausted: false,
      circuit: "closed",
      resetsAt: new Date(0).toISOString(),
    },
  },
  spawnHint: { applyHard: false, applyRole: false },
  agentTools: { assignShare: 0 },
  todayByFeature: {
    spawnHint: {
      calls: 0,
      answered: 0,
      failed: 0,
      unavailable: 0,
      inputTokens: 0,
      usd: 0,
      usdSource: "none",
    },
    remediationTriage: {
      calls: 0,
      answered: 0,
      failed: 0,
      unavailable: 0,
      inputTokens: 0,
      usd: 0,
      usdSource: "none",
    },
    notificationTriage: {
      calls: 0,
      answered: 0,
      failed: 0,
      unavailable: 0,
      inputTokens: 0,
      usd: 0,
      usdSource: "none",
    },
    agentTools: {
      calls: 0,
      answered: 0,
      failed: 0,
      unavailable: 0,
      inputTokens: 0,
      usd: 0,
      usdSource: "none",
    },
    compactionTiming: {
      calls: 0,
      answered: 0,
      failed: 0,
      unavailable: 0,
      inputTokens: 0,
      usd: 0,
      usdSource: "none",
    },
    stallJudgment: {
      calls: 0,
      answered: 0,
      failed: 0,
      unavailable: 0,
      inputTokens: 0,
      usd: 0,
      usdSource: "none",
    },
  },
  last7Days: [],
};

/** `<questionId> <rendered answer>`, e.g. "task_class mechanical 0.91". Trims trailing zeros. */
function formatNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function formatAnswer(answer: JevAnswer): string {
  switch (answer.type) {
    case "noul":
      return formatNumber(answer.noul);
    case "choice":
      return `${answer.choice} ${formatNumber(answer.confidence)}`;
    case "score":
      return formatNumber(answer.score);
  }
}

/** e.g. "task_class mechanical 0.91, reasoning 0.6" for the spawn-hint's two questions. */
function formatVerdict(answers: Record<string, JevAnswer>): string {
  return Object.entries(answers)
    .map(([questionId, answer]) => `${questionId} ${formatAnswer(answer)}`)
    .join(", ");
}

/** The spawn hint's own confidence floor rides on `task_class`; anything else has none to report. */
function taskClassConfidence(answers: Record<string, JevAnswer>): number | null {
  const answer = answers.task_class;
  if (!answer) return null;
  return answer.type === "choice" || answer.type === "score" ? answer.confidence : null;
}

/** Serves `jev.decide`, `jev.status`, `jev.scope.check` and `jev.decisions.list` (docs/jev.md, "RPCs"). */
export class JevSession {
  private readonly options: JevSessionOptions;

  constructor(options: JevSessionOptions) {
    this.options = options;
  }

  async handleDecide(
    msg: Extract<SessionInboundMessage, { type: "jev.decide.request" }>,
  ): Promise<void> {
    const { host, service } = this.options;
    const startedAt = Date.now();
    const respond = (payload: {
      callId: string;
      outcome: string;
      reason: string | null;
      answers: Record<string, JevAnswer> | null;
      model: string | null;
      elapsedMs: number;
    }) =>
      host.emit({ type: "jev.decide.response", payload: { requestId: msg.requestId, ...payload } });

    // Only feature 2's spawn hint is served over the wire (docs/jev.md, "RPCs"); every other
    // feature is daemon-internal, so a paired phone cannot spend under another feature's name.
    if (msg.feature !== "spawnHint") {
      respond({
        callId: `rejected:${msg.requestId}`,
        outcome: "failed",
        reason: "invalid-request",
        answers: null,
        model: null,
        elapsedMs: Date.now() - startedAt,
      });
      return;
    }

    try {
      const scope = msg.scope
        ? {
            cwds: [msg.scope.cwd],
            agentIds: msg.scope.parentAgentId ? [msg.scope.parentAgentId] : [],
          }
        : { cwds: [], missing: true as const };
      const outcome: JevOutcome = await service.decide({
        feature: "spawnHint",
        callSite: msg.callSite,
        state: msg.state as JevState,
        questions: msg.questions as JevQuestions,
        scope,
        subject: msg.scope?.parentAgentId ? { callerAgentId: msg.scope.parentAgentId } : undefined,
        deadlineMs: msg.deadlineMs,
      });

      if (outcome.kind === "answered" || outcome.kind === "shadow") {
        service.decisions.record({
          agentId: null,
          callId: outcome.callId,
          feature: "spawnHint",
          question: "What class of work is this create?",
          verdict: formatVerdict(outcome.answers),
          confidence: taskClassConfidence(outcome.answers),
          action: "classifier input at create",
          applied: false,
        });
        respond({
          callId: outcome.callId,
          outcome: outcome.kind,
          reason: null,
          answers: outcome.answers,
          model: outcome.meta.model,
          elapsedMs: outcome.meta.elapsedMs,
        });
        return;
      }

      if (outcome.kind === "unavailable") {
        respond({
          callId: outcome.callId,
          outcome: "unavailable",
          reason: outcome.reason,
          answers: null,
          model: null,
          elapsedMs: Date.now() - startedAt,
        });
        return;
      }

      respond({
        callId: outcome.callId,
        outcome: "failed",
        reason: outcome.reason,
        answers: null,
        model: outcome.meta?.model ?? null,
        elapsedMs: outcome.meta?.elapsedMs ?? Date.now() - startedAt,
      });
    } catch {
      // Never log the state or questions: they may carry a prompt or repository content.
      respond({
        callId: `rejected:${msg.requestId}`,
        outcome: "failed",
        reason: "invalid-request",
        answers: null,
        model: null,
        elapsedMs: Date.now() - startedAt,
      });
    }
  }

  async handleStatus(
    msg: Extract<SessionInboundMessage, { type: "jev.status.request" }>,
  ): Promise<void> {
    const { host, service, logger } = this.options;
    let status: ReturnType<JevService["status"]>;
    try {
      status = service.status();
    } catch (error) {
      logger.warn({ err: error }, "jev.status failed");
      status = UNAVAILABLE_STATUS;
    }
    host.emit({ type: "jev.status.response", payload: { requestId: msg.requestId, status } });
  }

  async handleScopeCheck(
    msg: Extract<SessionInboundMessage, { type: "jev.scope.check.request" }>,
  ): Promise<void> {
    const { host, service, logger } = this.options;
    let scope: "ok" | "excluded";
    try {
      scope = await service.checkScope({
        cwds: [msg.cwd],
        agentIds: msg.parentAgentId ? [msg.parentAgentId] : [],
      });
    } catch (error) {
      logger.warn({ err: error }, "jev.scope.check failed");
      scope = "excluded";
    }
    host.emit({ type: "jev.scope.check.response", payload: { requestId: msg.requestId, scope } });
  }

  async handleDecisionsList(
    msg: Extract<SessionInboundMessage, { type: "jev.decisions.list.request" }>,
  ): Promise<void> {
    const { host, service, logger } = this.options;
    let decisions: JevDecisionRecord[];
    try {
      decisions = service.listDecisions(msg.agentId);
    } catch (error) {
      logger.warn({ err: error, agentId: msg.agentId }, "jev.decisions.list failed");
      decisions = [];
    }
    host.emit({
      type: "jev.decisions.list.response",
      payload: { requestId: msg.requestId, agentId: msg.agentId, decisions },
    });
  }
}

/** Null when the host did not give the session a service, so callers stay flat. */
export function createJevSession(
  options: Omit<JevSessionOptions, "service"> & { service: JevService | null | undefined },
): JevSession | null {
  const { service, ...rest } = options;
  return service ? new JevSession({ ...rest, service }) : null;
}
