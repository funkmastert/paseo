import type { JevAnswer, JevQuestions } from "../jev/contract.js";
import type { ResolvedAwayReplyConfig } from "./config.js";
import { AWAY_REPLY_MARKER_PREFIX, type WaitingEpisode } from "./detect.js";
import {
  parseOfferedOptions,
  parseQuestionRequest,
  type OfferedOptions,
  type QuestionRequestOptions,
} from "./options.js";
import { findExcludedAction, isReadOnlyPermission } from "./safety.js";

/**
 * JEV decides; code writes (docs/jev.md, "Feature 14: away auto-reply"). JEV cannot generate text,
 * so it only picks from closed sets, and this file maps its answers to one reply from a fixed set
 * of templates. The floors are code constants: code owns the numbers.
 */

export const NEEDS_REPLY_FLOOR = 0.6;
export const WAIT_KIND_FLOOR = 0.6;
/** Picking the option the leader itself recommended. */
export const OPTION_FLOOR_WITH_RECOMMENDATION = 0.6;
/** Picking an option when the leader recommended none. */
export const OPTION_FLOOR = 0.7;
export const READ_ONLY_FLOOR = 0.9;

const LAST_MESSAGE_CHARS = 4000;
const CONTEXT_MESSAGE_CHARS = 2000;
const PLAN_CHARS = 4000;
const REQUEST_CHARS = 1000;
const REPLY_LABEL_CHARS = 120;

export const AWAY_REPLY_GUARD =
  "Do not merge any PR, and do not take any destructive, irreversible or outward-facing action on the strength of this reply; leave those for Tyler.";

/** `[Auto-reply on Tyler's behalf — away >1h, JEV]` */
export function awayReplyMarker(thresholdMinutes: number): string {
  const minutes = Math.round(thresholdMinutes);
  const away = minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
  return `${AWAY_REPLY_MARKER_PREFIX} — away >${away}, JEV]`;
}

export interface AwayReplyContext {
  episode: WaitingEpisode;
  /** The options JEV may pick from: the leader's own. */
  offered: OfferedOptions;
  question: QuestionRequestOptions | null;
  planText: string | null;
}

export type AwayReplyContextResult =
  | { ok: true; context: AwayReplyContext }
  | { ok: false; reason: string };

export function buildAwayReplyContext(episode: WaitingEpisode): AwayReplyContextResult {
  const request = episode.request;
  switch (episode.kind) {
    case "turn-ended":
      return {
        ok: true,
        context: {
          episode,
          offered: parseOfferedOptions(episode.lastMessage),
          question: null,
          planText: null,
        },
      };
    case "question": {
      const question = parseQuestionRequest(request?.input);
      if (!question) return { ok: false, reason: "unsupported-question" };
      return { ok: true, context: { episode, offered: question, question, planText: null } };
    }
    case "plan": {
      // The marker rides on the plan text Claude echoes back as "Approved Plan (edited by user)".
      // A plan request with no plan string has nowhere to carry it, so it gets no auto-reply.
      const plan = request?.input?.["plan"];
      if (typeof plan !== "string" || plan.trim().length === 0) {
        return { ok: false, reason: "plan-cannot-carry-marker" };
      }
      return {
        ok: true,
        context: {
          episode,
          offered: { options: [], recommendedId: null },
          question: null,
          planText: plan,
        },
      };
    }
    case "permission":
      return {
        ok: true,
        context: {
          episode,
          offered: { options: [], recommendedId: null },
          question: null,
          planText: null,
        },
      };
  }
}

function requestSummary(context: AwayReplyContext): string {
  const request = context.episode.request;
  if (!request) return "";
  const input = request.input ? JSON.stringify(request.input) : "";
  return `${request.name}: ${input}`.slice(0, REQUEST_CHARS);
}

/**
 * Everything the deterministic exclusion reads: the agent's whole last message (not the capped
 * copy JEV gets), the question and its options, the plan, and the tool request.
 */
export function threadText(context: AwayReplyContext): string {
  const request = context.episode.request;
  return [
    context.episode.lastMessage,
    context.question?.question ?? "",
    ...context.offered.options.map((option) => option.label),
    ...Object.values(context.question?.descriptions ?? {}),
    context.planText ?? "",
    request?.title ?? "",
    request?.description ?? "",
    request ? `${request.name} ${request.input ? JSON.stringify(request.input) : ""}` : "",
  ].join("\n");
}

const WAITING_ON: Record<WaitingEpisode["kind"], string> = {
  "turn-ended": "the end of its turn: its last message is the newest in the thread",
  question: "an answer to the question in `question`",
  plan: "approval of the plan in `plan`",
  permission: "permission to run the tool call in `request`",
};

function optionCriteria(context: AwayReplyContext): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const option of context.offered.options) {
    const description = context.question?.descriptions[option.id];
    criteria[option.id] = description ? `${option.label} — ${description}` : option.label;
  }
  criteria["none"] =
    "None of the options is clearly the best next step, or choosing needs information the agent does not have";
  return criteria;
}

/** The state and the one question block for one episode. */
export function buildAwayReplyRequest(context: AwayReplyContext): {
  state: Record<string, unknown>;
  questions: JevQuestions;
} {
  const { episode, offered } = context;
  const state: Record<string, unknown> = { waiting_on: WAITING_ON[episode.kind] };
  const messageCap = episode.kind === "turn-ended" ? LAST_MESSAGE_CHARS : CONTEXT_MESSAGE_CHARS;
  if (episode.lastMessage.trim()) state["last_message"] = episode.lastMessage.slice(-messageCap);
  if (context.question) state["question"] = context.question.question;
  if (offered.options.length >= 2) {
    state["options"] = Object.fromEntries(
      offered.options.map((option) => [option.id, option.label]),
    );
    if (offered.recommendedId) state["recommended_option"] = offered.recommendedId;
  }
  if (context.planText) state["plan"] = context.planText.slice(0, PLAN_CHARS);
  if (episode.kind === "permission") state["request"] = requestSummary(context);

  if (episode.kind === "permission") {
    return {
      state,
      questions: {
        read_only: {
          type: "noul",
          instructions: "Is the tool call in `request` read-only or fully reversible?",
          criteria: {
            true: "It only reads files, lists or searches, or shows state, and changes nothing",
            false:
              "It writes, deletes, installs, sends, runs a program that could change state, or does anything that cannot be undone",
          },
        },
        destructive: destructiveQuestion("Would allowing the tool call in `request`"),
      },
    };
  }

  const questions: JevQuestions = {
    needs_reply: {
      type: "noul",
      instructions:
        "Does the agent that wrote `last_message` need an answer, a decision or a go-ahead from the person before it can continue?",
      criteria: {
        true: "It asks a question, offers options to choose from, asks for approval, or says it is waiting for the person",
        false:
          "It reports status or finished work, or it is waiting on something other than the person: CI, another agent, a timer",
      },
    },
    wait_kind: {
      type: "choice",
      instructions: "The agent is waiting on `waiting_on`. What does it need from the person?",
      criteria: {
        choose_option: "To pick one of the options it listed",
        approve_plan: "A go-ahead to carry on with the plan or next step it described",
        open_question:
          "Information only the person has, asked as an open question rather than a pick among listed options",
        blocked_on_person:
          "Something only the person can do: log in, provide or rotate a credential, pay, answer a permission prompt, or a physical action",
        fyi: "Nothing: it is reporting status or results",
        other: "None of these",
      },
    },
  };
  if (offered.options.length >= 2) {
    questions["option"] = {
      type: "choice",
      instructions:
        "Which of `options` is the best next step for the agent's work? `recommended_option`, when present, is the option the agent itself recommended.",
      criteria: optionCriteria(context),
    };
  }
  questions["destructive"] = destructiveQuestion("Would acting on the best answer to the agent");
  return { state, questions };
}

function destructiveQuestion(lead: string): JevQuestions[string] {
  return {
    type: "noul",
    instructions: `${lead} merge a pull request, or take a destructive, irreversible or outward-facing action?`,
    criteria: {
      true: "Merging or approving a merge, deleting or overwriting data, force-pushing, deploying, releasing or publishing, spending money, changing credentials, restarting shared services, or sending messages to other people",
      false:
        "Only local, reversible work: reading, editing files on its own branch, running tests or builds, planning",
    },
  };
}

export type AwayReplyBody =
  | { kind: "recommendation"; optionId: string; optionLabel: string }
  | { kind: "option"; optionId: string; optionLabel: string }
  | { kind: "keep-going" };

export type AwayReplyChoice =
  | { kind: "reply"; body: AwayReplyBody }
  | { kind: "approve-permission" }
  | { kind: "none"; reason: string; raiseAttention: boolean };

export interface AwayReplyDecision {
  choice: AwayReplyChoice;
  /** One line per answer: "wait_kind choose_option 0.81". Never state. */
  verdicts: string[];
  /** The confidence behind the choice, for the decision record. */
  confidence: number | null;
}

function none(reason: string, raiseAttention = false): AwayReplyChoice {
  return { kind: "none", reason, raiseAttention };
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

export function verdictLines(answers: Record<string, JevAnswer>): string[] {
  return Object.entries(answers).map(([id, answer]) => {
    switch (answer.type) {
      case "noul":
        return `${id} ${round(answer.noul)}`;
      case "choice":
        return `${id} ${answer.choice} ${round(answer.confidence)}`;
      case "score":
        return `${id} ${round(answer.score)}`;
    }
  });
}

function noul(answers: Record<string, JevAnswer>, id: string): number | null {
  const answer = answers[id];
  return answer?.type === "noul" ? answer.noul : null;
}

function choice(
  answers: Record<string, JevAnswer>,
  id: string,
): { choice: string; confidence: number } | null {
  const answer = answers[id];
  return answer?.type === "choice"
    ? { choice: answer.choice, confidence: answer.confidence }
    : null;
}

/**
 * Answers to one reply, or none. Every path not listed as a reply is no reply, which is exactly
 * what happens today. `answers` are an `answered` outcome's, or a dry run's `shadow` answers.
 */
export function mapAwayReplyAnswers(
  context: AwayReplyContext,
  answers: Record<string, JevAnswer>,
  config: Pick<ResolvedAwayReplyConfig, "destructiveThreshold">,
): AwayReplyDecision {
  const verdicts = verdictLines(answers);
  const decide = (picked: AwayReplyChoice, confidence: number | null): AwayReplyDecision => ({
    choice: guardChoice(picked),
    verdicts,
    confidence,
  });

  const destructive = noul(answers, "destructive");
  if (destructive === null) return decide(none("malformed"), null);
  if (destructive >= config.destructiveThreshold) {
    return decide(none("destructive-intent"), round(destructive));
  }

  const { episode, offered } = context;
  if (episode.kind === "permission") {
    const readOnly = noul(answers, "read_only");
    if (readOnly === null) return decide(none("malformed"), null);
    if (readOnly < READ_ONLY_FLOOR) return decide(none("jev-not-read-only"), round(readOnly));
    if (!episode.request || !isReadOnlyPermission(episode.request)) {
      return decide(none("not-read-only"), round(readOnly));
    }
    return decide({ kind: "approve-permission" }, round(readOnly));
  }

  const needs = noul(answers, "needs_reply");
  const kind = choice(answers, "wait_kind");
  if (needs === null || kind === null) return decide(none("malformed"), null);
  if (needs < NEEDS_REPLY_FLOOR) return decide(none("no-reply-needed"), round(needs));
  if (kind.confidence < WAIT_KIND_FLOOR)
    return decide(none("low-confidence"), round(kind.confidence));
  const confidence = round(kind.confidence);

  switch (kind.choice) {
    case "blocked_on_person":
      return decide(none("blocked-on-tyler", episode.kind === "turn-ended"), confidence);
    case "fyi":
      return decide(none("fyi"), confidence);
    case "open_question":
      return decide(none("open-question"), confidence);
    case "approve_plan":
      if (episode.kind === "plan" || episode.kind === "turn-ended") {
        return decide({ kind: "reply", body: { kind: "keep-going" } }, confidence);
      }
      // A question is answered with one of its options, never with "keep going".
      return chooseOption(offered, answers, confidence, decide);
    case "choose_option":
      if (episode.kind === "plan") return decide(none("plan-is-not-a-choice"), confidence);
      return chooseOption(offered, answers, confidence, decide);
    default:
      return decide(none("other"), confidence);
  }
}

function chooseOption(
  offered: OfferedOptions,
  answers: Record<string, JevAnswer>,
  kindConfidence: number,
  decide: (picked: AwayReplyChoice, confidence: number | null) => AwayReplyDecision,
): AwayReplyDecision {
  if (offered.options.length < 2) return decide(none("no-options"), kindConfidence);
  const option = choice(answers, "option");
  if (!option || option.choice === "none") return decide(none("no-option-picked"), kindConfidence);
  return decide(pickOption(offered, option.choice, option.confidence), round(option.confidence));
}

function pickOption(
  offered: OfferedOptions,
  optionId: string,
  optionConfidence: number,
): AwayReplyChoice {
  const option = offered.options.find((entry) => entry.id === optionId);
  if (!option) return none("option-not-offered");
  if (offered.recommendedId) {
    if (optionId !== offered.recommendedId) return none("disagrees-with-recommendation");
    if (optionConfidence < OPTION_FLOOR_WITH_RECOMMENDATION) return none("low-confidence-option");
    return { kind: "reply", body: { kind: "recommendation", optionId, optionLabel: option.label } };
  }
  if (optionConfidence < OPTION_FLOOR) return none("low-confidence-option");
  return { kind: "reply", body: { kind: "option", optionId, optionLabel: option.label } };
}

/** The deterministic exclusion, again, on the option the reply is about to name. */
function guardChoice(picked: AwayReplyChoice): AwayReplyChoice {
  if (picked.kind !== "reply" || picked.body.kind === "keep-going") return picked;
  const hit = findExcludedAction(picked.body.optionLabel);
  return hit ? none(`excluded-option-${hit.category}`) : picked;
}

function replyLabel(label: string): string {
  const flat = label.replace(/\s+/g, " ").replace(/"/g, "'").trim();
  return flat.length > REPLY_LABEL_CHARS ? `${flat.slice(0, REPLY_LABEL_CHARS - 1)}…` : flat;
}

/** How a reply names an option: the leader's own id, or for a question (no ids) the label. */
function optionRef(
  body: Extract<AwayReplyBody, { optionId: string }>,
  kind: WaitingEpisode["kind"],
): string {
  const label = replyLabel(body.optionLabel);
  if (kind === "question") return `"${label}"`;
  return label ? `${body.optionId} ("${label}")` : body.optionId;
}

export function replyBodyText(body: AwayReplyBody, kind: WaitingEpisode["kind"]): string {
  switch (body.kind) {
    case "recommendation":
      return `Go with your recommendation, option ${optionRef(body, kind)}.`;
    case "option":
      return `Go with option ${optionRef(body, kind)}.`;
    case "keep-going":
      return "Keep going with the plan you described.";
  }
}

/** The whole reply: marker, one templated body, the guard. Nothing else is ever sent. */
export function formatAwayReply(
  body: AwayReplyBody,
  kind: WaitingEpisode["kind"],
  thresholdMinutes: number,
): string {
  return `${awayReplyMarker(thresholdMinutes)} ${replyBodyText(body, kind)} ${AWAY_REPLY_GUARD}`;
}
