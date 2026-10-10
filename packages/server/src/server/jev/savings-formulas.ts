import type {
  JevBenefitKind,
  JevOtherBenefit,
  JevSavingsBasis,
  JevSavingsDecision,
  JevSavingsFeature,
  JevSavingsMode,
  JevSavingsUnit,
  JevSavingsValidation,
} from "./contract.js";
import { OPUS_55_INPUT_USD_PER_TOKEN, usdToOpusTokens } from "@getpaseo/protocol/jev/pricing";

/**
 * The one place facts become Opus-equivalent weighted tokens (docs/jev.md, "Formulas"). Call sites
 * report facts; the savings module prices them here, so a correction reprices every feature alike.
 * Every figure carries its basis: the formula and each input, so it can be recomputed by hand.
 */

export const JEV_SAVINGS_UNIT: JevSavingsUnit = "opus-equivalent-weighted-tokens";

/**
 * Characters per token for what a read or a tool result loads: the fleet's calibrated median for
 * tool results (p10 2.10, p90 2.62, n = 1,463). Every feature's `T` uses it, so no two features
 * count the same text differently.
 */
export const JEV_CHARS_PER_TOKEN = 2.35;

/** `T` in the formulas: the tokens `characters` of text load into an agent's context. */
export function estimateContextTokens(characters: number): number {
  if (!Number.isFinite(characters) || characters <= 0) return 0;
  return Math.round(characters / JEV_CHARS_PER_TOKEN);
}

/**
 * `R`: what one token loaded into context costs over its life, in weighted tokens. One cache write
 * at the fleet unit's 1.25, then 0.1 on each of about 125 later calls (research 03 §3, which
 * priced the write at the one-hour 2 and measured 14.1-15.0; 13.35-14.25 in this unit).
 */
export const JEV_RESIDENCY = 13.75;

/** `S(C) = 0.1 x C + 2,200`: the context re-read plus the median 440 output tokens at 5. */
export const JEV_STEP_OUTPUT_TOKENS = 2_200;
export const JEV_STEP_CONTEXT_WEIGHT = 0.1;

/**
 * The context `S(C)` assumes when a caller's is unknown: research 03 puts one extra step at about
 * 25,000 weighted tokens at the fleet's median context, which `S` reaches at 228,000.
 */
export const JEV_FLEET_MEDIAN_CONTEXT_TOKENS = 228_000;

export function extraStepTokens(contextTokens: number): number {
  return JEV_STEP_CONTEXT_WEIGHT * contextTokens + JEV_STEP_OUTPUT_TOKENS;
}

// Claude Opus 5.5's list input price lives in the protocol package, shared with the app's dashboard.
export { OPUS_55_INPUT_USD_PER_TOKEN, usdToOpusTokens };

/**
 * `w(m)`, each model's price against Claude Opus 5.5. List input prices $4, $5, $2, $2 and $1 a
 * million, output five times input for each, so one weight per model matches the fleet's
 * weighting. Any other model has no weight, and a figure that needs one is null.
 */
export const JEV_PRICE_WEIGHTS: Readonly<Record<string, number>> = {
  "claude-opus-5-5": 1,
  "claude-opus-5": 1.25,
  "claude-sonnet-5-5": 0.5,
  "claude-sonnet-5": 0.5,
  "claude-haiku-4-5": 0.25,
};

/** `claude/claude-haiku-4-5-20251001[1m]` and `us.anthropic.claude-opus-5-5-v1:0` both name a weight. */
export function normalizeSavingsModel(model: string | null | undefined): string | null {
  if (typeof model !== "string") return null;
  let id = model.trim().toLowerCase();
  if (id.length === 0) return null;
  id = id.replace(/\[1m\]$/, "");
  id = id.slice(id.lastIndexOf("/") + 1);
  id = id.replace(/^(?:[a-z]{2}\.)?anthropic\./, "");
  id = id.replace(/-v\d+:\d+$/, "");
  id = id.replace(/-\d{8}$/, "");
  return id;
}

export function priceWeight(model: string | null | undefined): number | null {
  const id = normalizeSavingsModel(model);
  return id === null ? null : (JEV_PRICE_WEIGHTS[id] ?? null);
}

/** What each feature's answer buys. Only `tokens` is summed into tokens saved. */
export const JEV_SAVINGS_BENEFIT: Readonly<Record<JevSavingsFeature, JevBenefitKind>> = {
  spawnHint: "tokens",
  remediationTriage: "tokens",
  notificationTriage: "attention",
  agentTools: "tokens",
  compactionTiming: "none",
  stallJudgment: "tokens",
  awayReply: "time",
  askJev: "none",
  // Feature 17 merged after the ledger; it counts involvements until its formula (generation
  // calls avoided) is written. See docs/jev.md, feature 17.
  titleRefresh: "none",
  readCheck: "tokens",
};

export type JevSavingsFacts = Record<string, string | number | boolean | null>;

export interface JevSavingsPriceInput {
  feature: JevSavingsFeature;
  mode: JevSavingsMode;
  decision: JevSavingsDecision;
  /** Everything the call site and later settlements reported, merged. */
  facts: JevSavingsFacts;
  validation: JevSavingsValidation | null;
}

export interface JevSavingsPrice {
  benefit: JevBenefitKind;
  /** Null while pending, for a non-token benefit, and when a model has no price weight. */
  tokens: number | null;
  otherBenefit: JevOtherBenefit | null;
  basis: JevSavingsBasis | null;
  /** Waits on a later fact. A record whose facts say `partial` is never pending. */
  pending: boolean;
  /** The figure stands in for tokens nobody measured: a skipped agent priced at its kind's median. */
  estimated?: boolean;
}

const WEIGHT_NOTE = "w: Opus 5.5 1, Opus 5 1.25, Sonnet 0.5, Haiku 0.25";

function num(facts: JevSavingsFacts, key: string): number | null {
  const value = facts[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(facts: JevSavingsFacts, key: string): string | null {
  const value = facts[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bool(facts: JevSavingsFacts, key: string): boolean | null {
  const value = facts[key];
  return typeof value === "boolean" ? value : null;
}

function isPartial(facts: JevSavingsFacts): boolean {
  return facts["partial"] === true;
}

function round(value: number): number {
  return Math.round(value);
}

function tokensPrice(
  tokens: number | null,
  formula: string,
  inputs: JevSavingsBasis["inputs"],
  pending = false,
): JevSavingsPrice {
  return {
    benefit: "tokens",
    tokens: tokens === null ? null : round(tokens),
    otherBenefit: null,
    basis: { formula, inputs: { ...inputs, weights: WEIGHT_NOTE } },
    pending,
  };
}

/** A median standing in for an agent that never ran: shown as estimated, never as measured. */
function estimatedPrice(price: JevSavingsPrice): JevSavingsPrice {
  return price.tokens === null ? price : { ...price, estimated: true };
}

function pendingPrice(benefit: JevBenefitKind, waitingOn: string): JevSavingsPrice {
  return {
    benefit,
    tokens: null,
    otherBenefit: null,
    basis: { formula: `pending: ${waitingOn}`, inputs: {} },
    pending: true,
  };
}

/** A record whose wait ran out (7 days) or whose source restarted: priced with what it has. */
function partialPrice(benefit: JevBenefitKind, missing: string): JevSavingsPrice {
  return {
    benefit,
    tokens: null,
    otherBenefit: null,
    basis: { formula: `partial: ${missing} never arrived`, inputs: { partial: "true" } },
    pending: false,
  };
}

function noTokensPrice(benefit: JevBenefitKind, why: string): JevSavingsPrice {
  return {
    benefit,
    tokens: null,
    otherBenefit: null,
    basis: { formula: why, inputs: {} },
    pending: false,
  };
}

/** Prices one record from its facts. Pure: the same facts always give the same figure. */
export function priceSavings(input: JevSavingsPriceInput): JevSavingsPrice {
  switch (input.feature) {
    case "spawnHint":
      return priceSpawnHint(input);
    case "remediationTriage":
      return priceRemediationTriage(input);
    case "notificationTriage":
      return priceFinishTriage(input);
    case "agentTools":
      return priceAgentTools(input);
    case "stallJudgment":
      return priceStallJudgment(input);
    case "awayReply":
      return priceAwayReply(input);
    case "readCheck":
      return priceReadCheck(input);
    case "compactionTiming":
      return noTokensPrice("none", "none: it chooses when to compact, and spends for quality");
    case "askJev":
      return noTokensPrice("none", "none: a person's own question, counted as an involvement");
    case "titleRefresh":
      return noTokensPrice("none", "none yet: counted as an involvement until its formula lands");
  }
}

/**
 * Feature 2. Facts: `baseModel` (the model without JEV), `wouldModel`, `runningModel`,
 * `agentTotalTokens` (`W`, the child's weighted tokens, at its close or after 24 hours).
 * `m` is the model that ran (live) or the would-be model (shadow); an upward move is negative.
 */
function priceSpawnHint({ mode, facts }: JevSavingsPriceInput): JevSavingsPrice {
  const W = num(facts, "agentTotalTokens");
  if (W === null) {
    return isPartial(facts)
      ? partialPrice("tokens", "the child's tokens")
      : pendingPrice("tokens", "the child's close or 24 hours");
  }
  const base = str(facts, "baseModel");
  const m = mode === "live" ? str(facts, "runningModel") : str(facts, "wouldModel");
  const wBase = priceWeight(base);
  const wM = priceWeight(m);
  const inputs = {
    W,
    base,
    m,
    "w(base)": wBase,
    "w(m)": wM,
    ...(isPartial(facts) ? { partial: "true" } : {}),
  };
  const formula = "W x (w(base) - w(m))";
  if (wBase === null || wM === null)
    return tokensPrice(null, `${formula}: a model has no price weight`, inputs);
  return tokensPrice(W * (wBase - wM), formula, inputs);
}

/**
 * Feature 3a. `decision.wouldBe` is `person`, `defer` or `start-agent`. Facts: `agentTotalTokens`
 * (`A`), `agentModel`, `fixed` (from `agent-ended`), `closed`, `clearedDuringHold`, `agentRan`,
 * `minutesSinceTriage` (from `closed`), `deferMinutes` (the hold a defer would have held),
 * `medianTokens` (the median `A x w(m)` of the last 30 days' agents for the same condition kind,
 * for a live skip, whose agent never ran).
 */
function priceRemediationTriage(input: JevSavingsPriceInput): JevSavingsPrice {
  const { mode, decision, facts } = input;
  if (facts["claimedBy"] === "stallJudgment") {
    return tokensPrice(0, "0: feature 10's person-first label owns this episode's agent", {
      claimedBy: "stallJudgment",
    });
  }
  const skip = decision.wouldBe === "person" || decision.wouldBe === "defer";
  if (!skip) return tokensPrice(0, "0: the answer keeps the agent", { wouldBe: decision.wouldBe });
  if (mode === "shadow") {
    return decision.wouldBe === "defer" ? priceShadowDefer(facts) : priceShadowPerson(facts);
  }
  const median = num(facts, "medianTokens");
  const medianInputs = {
    "median(A x w(m))": median,
    kind: str(facts, "kind"),
    samples: num(facts, "medianSamples"),
  };
  if (decision.did === "person") {
    if (median === null)
      return tokensPrice(null, "median(A x w(m)): no agents of this kind in 30 days", medianInputs);
    return estimatedPrice(
      tokensPrice(
        median,
        "estimate: median(A x w(m)) of the kind's agents; the skipped agent never ran",
        medianInputs,
      ),
    );
  }
  if (decision.did === "defer") {
    if (facts["closed"] !== true) {
      return isPartial(facts)
        ? partialPrice("tokens", "the episode's close")
        : pendingPrice("tokens", "the episode's close");
    }
    if (facts["clearedDuringHold"] !== true || facts["agentRan"] === true) {
      return tokensPrice(0, "0: the condition did not clear during the hold", {
        clearedDuringHold: String(facts["clearedDuringHold"] ?? false),
      });
    }
    if (median === null)
      return tokensPrice(null, "median(A x w(m)): no agents of this kind in 30 days", medianInputs);
    return estimatedPrice(
      tokensPrice(
        median,
        "estimate: median(A x w(m)); cleared during the hold, no agent ran",
        medianInputs,
      ),
    );
  }
  return tokensPrice(0, "0: the agent started", { did: decision.did });
}

/** A shadow `person`: the agent ran, so its tokens and result are known. */
function priceShadowPerson(facts: JevSavingsFacts): JevSavingsPrice {
  const fixed = bool(facts, "fixed");
  if (fixed === null) {
    if (facts["closed"] === true && facts["agentRan"] === false) {
      return tokensPrice(0, "0: the episode closed with no agent", { closed: "true" });
    }
    return isPartial(facts)
      ? partialPrice("tokens", "the agent's end")
      : pendingPrice("tokens", "the remediation agent's end");
  }
  const A = num(facts, "agentTotalTokens");
  const model = str(facts, "agentModel");
  const w = priceWeight(model);
  const inputs = { A, m: model, "w(m)": w, fixed: String(fixed) };
  if (fixed) return tokensPrice(0, "0: the agent fixed it (contradicted)", inputs);
  if (A === null || w === null)
    return tokensPrice(null, "A x w(m): the agent's tokens or model is unknown", inputs);
  return tokensPrice(A * w, "A x w(m), would-have: the agent ended NOT FIXED", inputs);
}

/** `MAX_DEFER_MS` in `remediation/jev-triage.ts`: the hold of a record that names none. */
const DEFAULT_DEFER_MINUTES = 15;

/**
 * Whether a shadow defer would have avoided the agent. Live, a defer holds rung 2 once, 10-15
 * minutes, then starts the agent unless the condition cleared (`decideTriageAction`). So it saves
 * the agent only when the episode closed inside that hold and the agent that ran did not fix it:
 * the condition cleared by itself. Otherwise the live agent would have started and spent `A`.
 */
function priceShadowDefer(facts: JevSavingsFacts): JevSavingsPrice {
  const verdict = shadowDeferVerdict(facts);
  const A = num(facts, "agentTotalTokens");
  const model = str(facts, "agentModel");
  const w = priceWeight(model);
  const inputs = {
    A,
    m: model,
    "w(m)": w,
    hold: `${deferMinutesOf(facts)} min`,
    closedAfter: num(facts, "minutesSinceTriage"),
  };
  switch (verdict) {
    case "pending":
      return isPartial(facts)
        ? partialPrice("tokens", "the episode's close or the agent's end")
        : pendingPrice("tokens", "the episode's close and the agent's end");
    case "agent-fixed":
      return tokensPrice(0, "0: the agent fixed it, so the condition was not clearing", inputs);
    case "outlasted-hold":
      return tokensPrice(
        0,
        "0: the condition outlasted the hold; a live defer would have started the agent",
        inputs,
      );
    case "no-agent":
      return tokensPrice(0, "0: no agent ran", inputs);
    case "cleared-within-hold":
      if (A === null || w === null)
        return tokensPrice(null, "A x w(m): the agent's tokens or model is unknown", inputs);
      return tokensPrice(
        A * w,
        "A x w(m), would-have: cleared inside the hold and the agent did not fix it",
        inputs,
      );
  }
}

export type JevShadowDeferVerdict =
  | "pending"
  | "agent-fixed"
  | "outlasted-hold"
  | "no-agent"
  | "cleared-within-hold";

function deferMinutesOf(facts: JevSavingsFacts): number {
  return num(facts, "deferMinutes") ?? DEFAULT_DEFER_MINUTES;
}

/** A shadow defer's outcome from its facts; the savings hook validates it with the same answer. */
export function shadowDeferVerdict(facts: JevSavingsFacts): JevShadowDeferVerdict {
  if (bool(facts, "fixed") === true) return "agent-fixed";
  if (facts["closed"] !== true) return "pending";
  const closedAfter = num(facts, "minutesSinceTriage");
  if (closedAfter === null || closedAfter > deferMinutesOf(facts)) return "outlasted-hold";
  if (facts["agentRan"] === false) return "no-agent";
  return bool(facts, "fixed") === false ? "cleared-within-hold" : "pending";
}

/**
 * Feature 3b: attention, never tokens. A would-be (shadow) or held (live) notice is one push held
 * for the digest; a `contradicted` one, which Tyler answered within 30 minutes, held nothing.
 */
function priceFinishTriage({ mode, decision, validation }: JevSavingsPriceInput): JevSavingsPrice {
  const notice = mode === "live" ? decision.did === "notice" : decision.wouldBe === "notice";
  if (!notice) return noTokensPrice("attention", "no push held: the finish went out as an alert");
  const held = validation?.outcome === "contradicted" ? 0 : 1;
  return {
    benefit: "attention",
    tokens: null,
    otherBenefit: { unit: "pushes-held", value: held },
    basis: {
      formula:
        held === 1
          ? "1 push held for the digest"
          : "0: Tyler messaged within 30 minutes (contradicted)",
      inputs: { mode, sent: decision.did, wouldBe: decision.wouldBe },
    },
    pending: false,
  };
}

/** The file tools (features 4, 5) and `ask_jev` (6a). `ask_jev_diff_risk` (6b) may only add review. */
export const JEV_FILE_TOOLS = new Set([
  "ask_jev_file_bool",
  "ask_jev_file_choice",
  "ask_jev_file_score",
  "ask_jev_files",
  "pick_first_file",
]);

/**
 * Features 4-6. Facts: `tool`, `tAvoided` (tokens of the files or output sent to JEV),
 * `tResult` (tokens of the tool's result), `callerContextTokens` (`C`), `model`, `answered`, and
 * `regretWatch`: `none` when no path was sent, `unobserved` when the window closed with nothing
 * reporting reads. Held: `(T_avoided - T_result) x R x w(m) - S(C) x w(m)`. Regret:
 * `-(T_result x R + S(C)) x w(m)`. A saving is pending until the regret window says which, and a
 * window nothing watched gives no figure: an unwatched saving cannot be told from a regret.
 */
function priceAgentTools({ facts, validation }: JevSavingsPriceInput): JevSavingsPrice {
  const tool = str(facts, "tool");
  if (tool === "ask_jev_diff_risk")
    return noTokensPrice("none", "none: ask_jev_diff_risk may only add review");
  if (facts["answered"] === false)
    return tokensPrice(0, "0: no answer, the agent fell back to Read or Bash", { tool });
  if (validation === null) {
    const watch = str(facts, "regretWatch");
    if (watch === "none")
      return noTokensPrice("tokens", "no figure: no path was sent, so no regret can be seen");
    if (watch === "unobserved")
      return noTokensPrice("tokens", "no figure: nothing reported reads during the regret window");
    return isPartial(facts)
      ? partialPrice("tokens", "the regret window")
      : pendingPrice("tokens", "the regret window");
  }
  const tAvoided = num(facts, "tAvoided") ?? 0;
  const tResult = num(facts, "tResult") ?? 0;
  const contextKnown = num(facts, "callerContextTokens");
  const C = contextKnown ?? JEV_FLEET_MEDIAN_CONTEXT_TOKENS;
  const model = str(facts, "model");
  const w = priceWeight(model);
  const S = extraStepTokens(C);
  const inputs = {
    tool,
    T_avoided: tAvoided,
    T_result: tResult,
    R: JEV_RESIDENCY,
    C,
    ...(contextKnown === null ? { "C source": "fleet median (caller context unknown)" } : {}),
    "S(C)": S,
    m: model,
    "w(m)": w,
    ...(facts["tAvoidedSource"] ? { "T_avoided source": String(facts["tAvoidedSource"]) } : {}),
  };
  if (validation?.outcome === "regret") {
    const formula = "-(T_result x R + S(C)) x w(m): the file was read anyway";
    return w === null
      ? tokensPrice(null, `${formula}; no price weight`, inputs)
      : tokensPrice(-(tResult * JEV_RESIDENCY + S) * w, formula, inputs);
  }
  const formula = "(T_avoided - T_result) x R x w(m) - S(C) x w(m)";
  if (w === null)
    return tokensPrice(null, `${formula}: the caller's model has no price weight`, inputs);
  return tokensPrice((tAvoided - tResult) * JEV_RESIDENCY * w - S * w, formula, inputs);
}

/**
 * Feature 10. Facts: `personFirst` (the label was `blocked_missing_info` or `waiting_on_human` at
 * its floor), then from the joined remediation record: `agentRan`, `agentTotalTokens`,
 * `agentModel`, `fixed`, `personFirstSkipped` (live: the ladder sent it to a person, no agent),
 * `medianTokens`; or `reachedRung2: false` when the stall closed first.
 */
function priceStallJudgment({ mode, facts }: JevSavingsPriceInput): JevSavingsPrice {
  if (facts["personFirst"] !== true) {
    return tokensPrice(0, "0: the loop watch and the progressing hold save nothing countable", {
      activity: str(facts, "activity"),
    });
  }
  const claimedBy = str(facts, "claimedBy");
  if (claimedBy !== null) {
    return tokensPrice(0, "0: an earlier label of this episode owns its agent", { claimedBy });
  }
  if (facts["willPush"] === false) {
    return tokensPrice(0, "0: the escalation would not push, so the ladder starts the agent", {
      willPush: "false",
    });
  }
  if (facts["reachedRung2"] === false) {
    return tokensPrice(0, "0: the stall closed before the ladder's rung 2", {
      reachedRung2: "false",
    });
  }
  if (mode === "live" && facts["personFirstSkipped"] === true) {
    const median = num(facts, "medianTokens");
    const inputs = { "median(A x w(m))": median, samples: num(facts, "medianSamples") };
    if (median === null)
      return tokensPrice(null, "median(A x w(m)): no stalled-agent agents in 30 days", inputs);
    return estimatedPrice(
      tokensPrice(
        median,
        "estimate: median(A x w(m)); the ladder honoured personFirst and started no agent",
        inputs,
      ),
    );
  }
  const fixed = bool(facts, "fixed");
  if (fixed === null) {
    return isPartial(facts)
      ? partialPrice("tokens", "the joined remediation record")
      : pendingPrice("tokens", "the episode's remediation agent");
  }
  const A = num(facts, "agentTotalTokens");
  const model = str(facts, "agentModel");
  const w = priceWeight(model);
  const inputs = { A, m: model, "w(m)": w, fixed: String(fixed) };
  if (fixed) return tokensPrice(0, "0: the remediation agent fixed it", inputs);
  if (A === null || w === null)
    return tokensPrice(null, "A x w(m): the agent's tokens or model is unknown", inputs);
  return tokensPrice(
    A * w,
    `A x w(m)${mode === "shadow" ? ", would-have" : ""}: the agent ended NOT FIXED`,
    inputs,
  );
}

/**
 * Feature 14: time, never tokens. Facts: `action` (`replied`, `would-reply`, `no-reply`,
 * `not-sent`), then from the follow-up `minutesAfterDecision` and `sameChoice`. A leader's idle
 * minutes, not Tyler's.
 */
function priceAwayReply({ facts }: JevSavingsPriceInput): JevSavingsPrice {
  const action = str(facts, "action");
  if (action === "would-reply") {
    if (!("sameChoice" in facts)) {
      return isPartial(facts)
        ? partialPrice("time", "Tyler's answer")
        : pendingPrice("time", "Tyler's own answer");
    }
    const sameChoice = bool(facts, "sameChoice");
    const minutes = num(facts, "minutesAfterDecision");
    if (sameChoice === null || minutes === null) {
      return noTokensPrice("time", "unknown: Tyler's answer could not be read as an option");
    }
    return {
      benefit: "time",
      tokens: null,
      otherBenefit: { unit: "minutes", value: sameChoice ? Math.max(0, minutes) : 0 },
      basis: {
        formula: sameChoice
          ? "minutes until Tyler answered the same way, would-have"
          : "0: Tyler chose differently (contradicted)",
        inputs: { minutesAfterDecision: minutes, sameChoice: String(sameChoice) },
      },
      pending: false,
    };
  }
  if (action === "replied") {
    return noTokensPrice("time", "unknown: the job tracks no follow-up after a sent reply");
  }
  return noTokensPrice("time", "none: no reply");
}

/**
 * Feature 16. Facts: `contextTokens` (`T`), `model`, `agentContextTokens` (`C`, at a live deny).
 * `decision.wouldBe` is `would-skip`, `would-narrow` or `needed`; a live deny has `did: deny`.
 * Shadow would-skip that held, or a live deny that held: `T x R x w(m)`. Live regret: `-S(C) x w(m)`.
 * A shadow false skip: 0.
 */
function priceReadCheck({
  mode,
  decision,
  facts,
  validation,
}: JevSavingsPriceInput): JevSavingsPrice {
  const skipping = mode === "live" ? decision.did === "deny" : decision.wouldBe === "would-skip";
  if (!skipping) return tokensPrice(0, "0: the read ran", { wouldBe: decision.wouldBe });
  const T = num(facts, "contextTokens");
  const model = str(facts, "model");
  const w = priceWeight(model);
  if (validation === null || (T === null && validation.outcome !== "regret")) {
    return isPartial(facts)
      ? partialPrice("tokens", "the validation window")
      : pendingPrice("tokens", "the validation window");
  }
  const contextKnown = num(facts, "agentContextTokens");
  const C = contextKnown ?? JEV_FLEET_MEDIAN_CONTEXT_TOKENS;
  const inputs = {
    T,
    R: JEV_RESIDENCY,
    m: model,
    "w(m)": w,
    validation: validation.outcome,
    ...(facts["estimated"] === true ? { "T source": "estimated from the requested range" } : {}),
  };
  if (validation.outcome === "false-skip")
    return tokensPrice(0, "0: the agent used the file (false skip)", inputs);
  if (validation.outcome === "regret") {
    const regretInputs = { ...inputs, C, "S(C)": extraStepTokens(C) };
    return w === null
      ? tokensPrice(null, "-S(C) x w(m): no price weight", regretInputs)
      : tokensPrice(
          -extraStepTokens(C) * w,
          "-S(C) x w(m): the agent read it after the deny",
          regretInputs,
        );
  }
  if (validation.outcome === "contradicted") return tokensPrice(0, "0: contradicted", inputs);
  const formula = `T x R x w(m)${mode === "shadow" ? ", would-have" : ""}`;
  if (T === null || w === null)
    return tokensPrice(null, `${formula}: T or the model's weight is unknown`, inputs);
  return tokensPrice(T * JEV_RESIDENCY * w, formula, inputs);
}

/*
 * Evidence (docs/jev.md, "The JEV dashboard", "Evidence rules"). Fixed here before the data
 * arrives: each record adds to named counters, and each rule reads only its own counters. Code
 * reports whether the rule is met; Tyler flips the mode (D6).
 */

export interface JevEvidenceRecordView {
  feature: JevSavingsFeature;
  mode: JevSavingsMode;
  decision: JevSavingsDecision;
  facts: JevSavingsFacts;
  validation: JevSavingsValidation | null;
  price: JevSavingsPrice;
}

type CounterAdder = (key: string, value?: number) => void;
type CounterRule = (record: JevEvidenceRecordView, add: CounterAdder) => void;

const EVIDENCE_COUNTERS: Partial<Record<JevSavingsFeature, CounterRule>> = {
  spawnHint: ({ mode, price, facts }, add) => {
    if (mode !== "shadow" || price.pending) return;
    // The declared-label audit (docs/jev.md, "Auditing a declared label") measures a different
    // counterfactual, over- or under-labelling, from "this child's class was never declared", so
    // it gets its own bucket rather than inflating the unlabelled-child count the go-live rule reads.
    if (facts["declaredAudit"] === true) {
      add("declaredAuditSettled");
      add("declaredAuditSettledTokens", price.tokens ?? 0);
      return;
    }
    add("settledShadow");
    add("settledShadowTokens", price.tokens ?? 0);
  },
  remediationTriage: ({ mode, decision, validation, price }, add) => {
    if (mode !== "shadow") return;
    if (decision.wouldBe === "person") {
      add("wouldSkip");
      if (validation?.outcome === "contradicted") add("wouldSkipContradicted");
    } else if (decision.wouldBe === "defer" && !price.pending) {
      add("wouldDefer");
      if (validation?.outcome === "held") add("wouldDeferCleared");
    }
  },
  notificationTriage: ({ mode, decision, validation }, add) => {
    if (mode !== "shadow" || decision.wouldBe !== "notice" || !validation) return;
    add("noticeFollowedUp");
    if (validation.outcome === "held") add("noticeHeld");
  },
  agentTools: ({ facts, validation }, add) => {
    if (!JEV_FILE_TOOLS.has(str(facts, "tool") ?? "")) return;
    add("fileToolCalls");
    if (validation?.outcome === "regret") add("fileToolRegrets");
  },
  stallJudgment: ({ mode, facts }, add) => {
    if (mode !== "shadow" || facts["personFirst"] !== true || facts["agentRan"] !== true) return;
    const fixed = bool(facts, "fixed");
    if (fixed === null) return;
    add("personFirstAgentRan");
    if (!fixed) add("personFirstNotFixed");
  },
  awayReply: ({ facts, validation }, add) => {
    if (facts["action"] !== "would-reply" || !validation) return;
    add("followUps");
    if (validation.outcome === "held") add("sameChoice");
  },
  readCheck: ({ mode, decision, facts, validation }, add) => {
    const T = num(facts, "contextTokens");
    if (mode !== "shadow") return;
    // D12: a read of a shadow-only subtree can never be denied, so it is counted on its own and
    // never toward the rule that decides whether to switch the feature live.
    if (typeof facts["shadowOnly"] === "string") {
      add(`shadowOnlyJudged.${facts["shadowOnly"]}`);
      add("shadowOnlyJudged");
      if (decision.wouldBe === "would-skip") add("shadowOnlyWouldSkip");
      if (validation?.outcome === "false-skip") add("shadowOnlyFalseSkip");
      return;
    }
    if (decision.wouldBe !== "would-skip" || !validation) return;
    if (T === null || T < READ_CHECK_LIVE_MIN_TOKENS) return;
    add("bigWouldSkip");
    const w = priceWeight(str(facts, "model")) ?? 0;
    if (validation.outcome === "false-skip") {
      add("bigWouldSkipFalse");
      const C = num(facts, "agentContextTokens") ?? JEV_FLEET_MEDIAN_CONTEXT_TOKENS;
      add("bigWouldSkipProjected", round(-extraStepTokens(C) * w));
    } else {
      add("bigWouldSkipProjected", round(T * JEV_RESIDENCY * w));
    }
  },
};

/** The counters one record adds to its feature's day. Recomputed whenever the record changes. */
export function evidenceCounters(record: JevEvidenceRecordView): Record<string, number> {
  const counters: Record<string, number> = {};
  EVIDENCE_COUNTERS[record.feature]?.(record, (key, value = 1) => {
    if (value !== 0) counters[key] = (counters[key] ?? 0) + value;
  });
  return counters;
}

/** Feature 16's `liveMinTokens`: the reads its evidence rule counts. */
export const READ_CHECK_LIVE_MIN_TOKENS = 8_000;

export interface JevEvidence {
  rule: string;
  observed: string;
  /** Null until the rule's minimum count is reached. */
  met: boolean | null;
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;
}

/**
 * The declared-label audit's figure (docs/jev.md, "Auditing a declared label"), appended to
 * spawnHint's `observed` string beside the go-live rule, never inside it.
 */
function declaredAuditNote(auditN: number, auditSum: number): string {
  return auditN === 0
    ? ""
    : `; declared-label audit: ${auditN} settled, would-have sum ${Math.round(auditSum)}`;
}

/** Each feature's rule against its summed counters. `jevUsd` is the feature's JEV spend in range. */
export function evaluateEvidence(
  feature: JevSavingsFeature,
  counters: Readonly<Record<string, number>>,
  jevUsd: number,
): JevEvidence {
  const c = (key: string) => counters[key] ?? 0;
  switch (feature) {
    case "spawnHint": {
      const n = c("settledShadow");
      const sum = c("settledShadowTokens");
      return {
        rule: "shadow -> live: 50 settled unlabelled children, and a positive would-have sum after upward moves",
        observed: `${n} settled, would-have sum ${Math.round(sum)}${declaredAuditNote(c("declaredAuditSettled"), c("declaredAuditSettledTokens"))}`,
        met: n < 50 ? null : sum > 0,
      };
    }
    case "remediationTriage": {
      const n = c("wouldSkip");
      const wrong = c("wouldSkipContradicted");
      const defers = c("wouldDefer");
      const cleared = c("wouldDeferCleared");
      return {
        rule: "shadow -> live: 20 would-be skips to a person, at most 1 in 5 contradicted (the agent fixed it); deferrals are judged live",
        observed: `${n} would-be skips, ${wrong} contradicted (${pct(wrong, n)}); ${defers} would-be deferrals, ${cleared} cleared inside the hold`,
        met: n < 20 ? null : wrong * 5 <= n,
      };
    }
    case "notificationTriage": {
      const n = c("noticeFollowedUp");
      const held = c("noticeHeld");
      return {
        rule: "shadow -> live: 50 would-be notices with a follow-up, at least 80% held",
        observed: `${n} with a follow-up, ${pct(held, n)} held`,
        met: n < 50 ? null : held >= 0.8 * n,
      };
    }
    case "agentTools": {
      const n = c("fileToolCalls");
      const regrets = c("fileToolRegrets");
      return {
        rule: "live -> off: over half of 20+ file-tool calls end in a regret read (feature 4's rule), or the D8 report's kill rule (scripts/jev-tools-ab.ts)",
        observed: `${n} file-tool calls, ${regrets} regrets (${pct(regrets, n)})`,
        met: n < 20 ? null : regrets > 0.5 * n,
      };
    }
    case "stallJudgment": {
      const n = c("personFirstAgentRan");
      const notFixed = c("personFirstNotFixed");
      return {
        rule: "shadow -> live: 10 person-first labels whose agent ran, at least 70% of those agents ended NOT FIXED",
        observed: `${n} person-first labels with an agent, ${pct(notFixed, n)} NOT FIXED`,
        met: n < 10 ? null : notFixed >= 0.7 * n,
      };
    }
    case "awayReply": {
      const n = c("followUps");
      const same = c("sameChoice");
      return {
        rule: "dry run -> live: 20 follow-ups, sameChoice in at least 90%",
        observed: `${n} follow-ups, ${pct(same, n)} same choice`,
        met: n < 20 ? null : same >= 0.9 * n,
      };
    }
    case "readCheck": {
      const n = c("bigWouldSkip");
      const falseSkips = c("bigWouldSkipFalse");
      const net = c("bigWouldSkipProjected") - usdToOpusTokens(jevUsd);
      // D12's subtrees are judged in shadow whatever the feature's mode, so they are reported
      // beside the rule rather than inside it.
      const shadowOnly = c("shadowOnlyJudged");
      const shadowOnlyNote =
        shadowOnly === 0
          ? ""
          : `; shadow-only ${shadowOnly} judged, ${c("shadowOnlyWouldSkip")} would-skip, ${pct(c("shadowOnlyFalseSkip"), c("shadowOnlyWouldSkip"))} false`;
      return {
        rule: "shadow -> live: 200 would-skips of reads of 8,000 tokens or more, at most 30% false skips, a positive projected net",
        observed: `${n} would-skips, ${pct(falseSkips, n)} false, projected net ${Math.round(net)}${shadowOnlyNote}`,
        met: n < 200 ? null : falseSkips <= 0.3 * n && net > 0,
      };
    }
    case "compactionTiming":
      return {
        rule: "none: chooses when to compact, claims no savings",
        observed: "-",
        met: null,
      };
    case "askJev":
      return {
        rule: "none: a person's own questions, claims no savings",
        observed: "-",
        met: null,
      };
    case "titleRefresh":
      return {
        rule: "none yet: claims no savings until its formula lands",
        observed: "-",
        met: null,
      };
  }
}
