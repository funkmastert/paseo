import type { JevAskResponse, JevQuestion } from "@getpaseo/protocol/jev/rpc-schemas";

/**
 * What the Ask JEV screen shows for a `jev.ask` answer (docs/jev.md, "Feature 15: Ask JEV"): the
 * answer as bars, or a plain message for every way a question is not answered.
 */

export type AskJevPayload = JevAskResponse["payload"];

export interface AskJevBar {
  key: string;
  label: string;
  /** 0 to 1. */
  fraction: number;
  chosen: boolean;
}

export interface AskJevMeta {
  /** Null when nothing was sent. */
  costLabel: string | null;
  latencyLabel: string;
  modelLabel: string | null;
  /** Set when redaction replaced values before sending. */
  redactionLabel: string | null;
  /** Whether anything left the machine. */
  sent: boolean;
}

export interface AskJevPosition {
  /** 0 to 1 along the scale. */
  fraction: number;
  lowLabel: string;
  highLabel: string;
}

export type AskJevResultView =
  | {
      kind: "answer";
      answerType: "noul" | "choice" | "score";
      headline: string;
      detail: string;
      bars: AskJevBar[];
      position: AskJevPosition | null;
      meta: AskJevMeta;
    }
  | {
      kind: "notice";
      tone: "info" | "warning" | "error";
      title: string;
      description: string;
      meta: AskJevMeta | null;
    };

export const ASK_JEV_KEY_FILE = "~/.config/paseo/jev.env";
export const ASK_JEV_KEY_VARIABLE = "PASEO_JEV_API_KEY";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function formatPercent(fraction: number): string {
  return `${Math.round(clamp01(fraction) * 100)}%`;
}

export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function costLabel(cost: AskJevPayload["cost"]): string | null {
  if (!cost) return null;
  if (cost.usd === null) return "Cost unknown";
  switch (cost.source) {
    case "fake":
      return "$0 (fake backend)";
    case "estimated":
      return `~${formatUsd(cost.usd)} (estimated)`;
    default:
      return formatUsd(cost.usd);
  }
}

function metaOf(payload: AskJevPayload): AskJevMeta {
  const sent = payload.cost !== null;
  return {
    costLabel: costLabel(payload.cost),
    latencyLabel: formatLatency(payload.elapsedMs),
    modelLabel: payload.model,
    redactionLabel:
      payload.redactions > 0
        ? `${payload.redactions} ${payload.redactions === 1 ? "value" : "values"} redacted before sending`
        : null,
    sent,
  };
}

function answerView(payload: AskJevPayload, question: JevQuestion): AskJevResultView | null {
  const answer = payload.answer;
  if (!answer || answer.type !== question.type) return null;
  const meta = metaOf(payload);
  switch (answer.type) {
    case "noul": {
      const yes = clamp01(answer.noul);
      const isYes = yes >= 0.5;
      return {
        kind: "answer",
        answerType: "noul",
        headline: isYes ? "Yes" : "No",
        detail: `${formatPercent(yes)} probability of yes`,
        bars: [
          { key: "yes", label: "Yes", fraction: yes, chosen: isYes },
          { key: "no", label: "No", fraction: 1 - yes, chosen: !isYes },
        ],
        position: null,
        meta,
      };
    }
    case "choice": {
      // The options in the order they were asked, so the bars read like the form.
      const keys = question.type === "choice" ? Object.keys(question.criteria) : [];
      const ordered = keys.length > 0 ? keys : Object.keys(answer.probabilities);
      return {
        kind: "answer",
        answerType: "choice",
        headline: answer.choice,
        detail: `${formatPercent(answer.confidence)} confidence`,
        bars: ordered.map((key) => ({
          key,
          label: key,
          fraction: clamp01(answer.probabilities[key] ?? 0),
          chosen: key === answer.choice,
        })),
        position: null,
        meta,
      };
    }
    case "score": {
      const labels = question.type === "score" ? question.criteria : Object.values(answer.legend);
      const top = Math.max(1, labels.length - 1);
      const nearest = Math.min(labels.length - 1, Math.max(0, Math.round(answer.score)));
      return {
        kind: "answer",
        answerType: "score",
        headline: answer.legend[String(nearest)] ?? labels[nearest] ?? String(nearest),
        detail: `${answer.score.toFixed(1)} on a 0–${top} scale · ${formatPercent(answer.confidence)} confidence`,
        bars: labels.map((label, index) => ({
          key: String(index),
          label,
          fraction: clamp01(answer.probabilities[String(index)] ?? 0),
          chosen: index === nearest,
        })),
        position: {
          fraction: clamp01(answer.score / top),
          lowLabel: labels[0] ?? "0",
          highLabel: labels[labels.length - 1] ?? String(top),
        },
        meta,
      };
    }
  }
}

interface NoticeCopy {
  tone: "info" | "warning" | "error";
  title: string;
  description: string;
}

const NOTHING_SENT = "Nothing was sent.";

/** Every reason the daemon can give, in words. Unknown reasons fall through to a generic line. */
const REASON_COPY: Record<string, NoticeCopy> = {
  "no-key": {
    tone: "warning",
    title: "JEV is not configured on this host",
    description: `Add ${ASK_JEV_KEY_VARIABLE}=<key> to ${ASK_JEV_KEY_FILE} on the host. The daemon reads it within a few seconds, no restart. ${NOTHING_SENT}`,
  },
  excluded: {
    tone: "warning",
    title: "Blocked by the Wonderly exclusion",
    description: `This touches Wonderly company code, which is never sent to JEV. ${NOTHING_SENT}`,
  },
  redaction: {
    tone: "error",
    title: "Redaction failed",
    description: `Secrets could not be removed safely, so the question was held back. ${NOTHING_SENT}`,
  },
  "state-too-large": {
    tone: "warning",
    title: "Context too large",
    description: `JEV takes up to 60 KB of context. Shorten it and ask again. ${NOTHING_SENT}`,
  },
  "request-too-large": {
    tone: "warning",
    title: "Question too large",
    description: `The question and its context pass 64 KB. Shorten them and ask again. ${NOTHING_SENT}`,
  },
  "invalid-request": {
    tone: "error",
    title: "JEV cannot take this question",
    description: `Check the options or the scale. ${NOTHING_SENT}`,
  },
  "daily-budget": {
    tone: "warning",
    title: "Today's Ask JEV budget is spent",
    description: `It resets at midnight on the host. ${NOTHING_SENT}`,
  },
  saturated: {
    tone: "warning",
    title: "JEV is busy",
    description: `Too many questions are waiting. Try again in a moment. ${NOTHING_SENT}`,
  },
  "circuit-open": {
    tone: "warning",
    title: "JEV is failing right now",
    description: `Recent calls failed, so the host is pausing questions for a minute. ${NOTHING_SENT}`,
  },
  "key-rejected": {
    tone: "error",
    title: "The key was rejected",
    description: `JEV refused ${ASK_JEV_KEY_VARIABLE}. Check the key in ${ASK_JEV_KEY_FILE}. The host tries again in 10 minutes.`,
  },
  disabled: {
    tone: "warning",
    title: "JEV is switched off on this host",
    description: `agents.jev.enabled is false in the host's config.json. ${NOTHING_SENT}`,
  },
  "feature-disabled": {
    tone: "warning",
    title: "Ask JEV is switched off on this host",
    description: `agents.jev.askJev.enabled is false in the host's config.json. ${NOTHING_SENT}`,
  },
  "config-unreadable": {
    tone: "error",
    title: "The host's JEV config cannot be read",
    description: `agents.jev in config.json has an error. Run paseo doctor on the host. ${NOTHING_SENT}`,
  },
  "agent-unavailable": {
    tone: "warning",
    title: "That agent is not loaded",
    description: `Its thread can only be read while the agent is loaded on the host. Open it and ask again. ${NOTHING_SENT}`,
  },
  timeout: {
    tone: "error",
    title: "JEV did not answer in time",
    description: "The question was sent and timed out. Try again.",
  },
  aborted: {
    tone: "info",
    title: "Cancelled",
    description: "The host stopped the question.",
  },
  http: {
    tone: "error",
    title: "JEV returned an error",
    description: "The question was sent and the service refused it. Try again.",
  },
  network: {
    tone: "error",
    title: "Could not reach JEV",
    description: "The host could not connect to the service. Try again.",
  },
  contract: {
    tone: "error",
    title: "JEV's answer did not fit the question",
    description: "The answer was malformed, so it was dropped.",
  },
};

export function askJevReasonCopy(reason: string | null): NoticeCopy {
  return (
    (reason ? REASON_COPY[reason] : undefined) ?? {
      tone: "error",
      title: "JEV did not answer",
      description: reason ? `The host answered "${reason}".` : "The host gave no reason.",
    }
  );
}

export function mapAskJevPayload(payload: AskJevPayload, question: JevQuestion): AskJevResultView {
  if (payload.outcome === "answered") {
    const view = answerView(payload, question);
    if (view) return view;
    return { kind: "notice", ...askJevReasonCopy("contract"), meta: metaOf(payload) };
  }
  const copy = askJevReasonCopy(payload.reason);
  return { kind: "notice", ...copy, meta: payload.cost ? metaOf(payload) : null };
}

/** The RPC itself failed: the host never replied, or the connection dropped. */
export function mapAskJevClientFailure(error: unknown): AskJevResultView {
  const message = error instanceof Error ? error.message : "";
  if (/timeout/i.test(message)) {
    return {
      kind: "notice",
      tone: "error",
      title: "The host did not reply",
      description: "No answer arrived in time. The host may still finish the question.",
      meta: null,
    };
  }
  return {
    kind: "notice",
    tone: "error",
    title: "Unable to ask the host",
    description: message || "The connection to the host failed.",
    meta: null,
  };
}
