/**
 * Model divergence: the model an agent's responses report versus the model it was configured
 * with (docs/model-divergence.md). One comparison, no cause enumeration — a 400 that degrades a
 * model, an account that cannot serve it and a CLI that quietly picks another all look the same
 * here, and the same is true of causes nobody has met yet.
 *
 * Pure state transitions. AgentManager owns one `ModelDivergenceState` per agent, feeds it what
 * the provider reports and the intentional changes it makes itself, and the monitor reads the
 * verdict. Nothing here touches I/O, so the ways a mismatch is explained are testable as data.
 */

/**
 * How long after `setAgentModel` a response on the previous model still counts as explained.
 * `query.setModel()` applies from the next API request: the request already in flight finishes on
 * the old model (docs/token-burn.md), and its `message_start` can arrive well after the switch.
 */
export const MODEL_TRANSITION_GRACE_MS = 2 * 60_000;

/** Responses on the same wrong model before a divergence counts as persisting. */
export const DEFAULT_PERSIST_RESPONSES = 3;
/** Time between the first and latest wrong response before a divergence counts as persisting. */
export const DEFAULT_PERSIST_MS = 60_000;

// Model shorthands the Claude CLI resolves itself. What one resolves to depends on the CLI
// version and the account, so the configured string is not a model id and cannot be compared.
const CLAUDE_MODEL_ALIASES = new Set(["default", "best", "opus", "sonnet", "haiku", "opusplan"]);
// Picks Opus in plan mode and Sonnet otherwise, so a response on either is what was asked for.
const MIXED_MODEL_ALIASES = new Set(["opusplan"]);

// Claude Code writes this on frames with no inference behind them (api errors, local commands).
const PLACEHOLDER_MODEL_IDS = new Set(["<synthetic>"]);

/**
 * The form two spellings of one model share: lowercase, no context-window suffix (`[1m]` is a
 * property of the session, not a different model), no dated-snapshot suffix, and `4.8` spelled
 * `4-8`.
 *
 * Deliberately not `normalizeClaudeRuntimeModelId`: that one maps a display id onto the manifest
 * and returns null for any id the manifest lacks, so two different unknown models would compare
 * equal (and before its fallback was anchored it collapsed `claude-opus-5-5` onto
 * `claude-opus-5`). It is right for choosing a label and wrong for asking whether two ids are the
 * same model.
 */
export function canonicalModelId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!trimmed || PLACEHOLDER_MODEL_IDS.has(trimmed)) {
    return null;
  }
  return trimmed
    .replace(/\[[^\]]*\]$/, "")
    .replace(/(\d)\.(\d)/g, "$1-$2")
    .replace(/-\d{8}$/, "");
}

export type ModelReference =
  | { kind: "model"; model: string }
  | { kind: "unverifiable"; reason: string };

/**
 * What the configured model asks for, as something a response can be compared with. A concrete
 * id is its own reference. An alias is resolved by the CLI, so the init message's model — the
 * CLI's own resolution — stands in for it. That is only ever done for an alias: for a concrete
 * id the init model is the request echoed back, and using it would let a substitution vouch for
 * itself.
 */
export function resolveModelReference(input: {
  configuredModel: string | null | undefined;
  initModel?: string | null;
}): ModelReference {
  const configured = canonicalModelId(input.configuredModel);
  if (!configured) {
    return { kind: "unverifiable", reason: "no model configured" };
  }
  if (!CLAUDE_MODEL_ALIASES.has(configured)) {
    return { kind: "model", model: configured };
  }
  if (MIXED_MODEL_ALIASES.has(configured)) {
    return { kind: "unverifiable", reason: `${configured} switches models by design` };
  }
  const resolved = canonicalModelId(input.initModel);
  return resolved
    ? { kind: "model", model: resolved }
    : { kind: "unverifiable", reason: `${configured} has not resolved to a model yet` };
}

export interface ModelDivergence {
  /** The model the agent was asked for, as compared. */
  configuredModel: string;
  /** The model its responses reported, as the provider spelled it. */
  observedModel: string;
  /** When the first response on this pair arrived, epoch ms. */
  firstObservedAt: number;
  /** When the latest one did. */
  lastObservedAt: number;
  /** Consecutive responses on this pair. */
  responses: number;
}

export interface ModelDivergenceState {
  /** Latest model a response reported, as spelled. Live status for tools and tests. */
  observedModel?: string;
  observedAt?: number;
  /** Set by an intentional configured-model change; ends on the first response on the new model. */
  transition?: { fromModel: string; at: number };
  /** The unexplained mismatch standing right now, if any. */
  divergence?: ModelDivergence;
}

export function emptyModelDivergenceState(): ModelDivergenceState {
  return {};
}

/**
 * The configured model changed on purpose: `setAgentModel`, which is what a spend-governor
 * downgrade, a user's model picker, `update_agent` and a role policy all go through. A finding
 * raised against the old model is moot, and the request already in flight is still answered by
 * it, so that model stays acceptable for a grace window.
 */
export function noteConfiguredModelChange(
  state: ModelDivergenceState,
  input: {
    fromModel: string | null | undefined;
    /** The provider's init resolution while the old model was configured; for an alias. */
    fromInitModel?: string | null;
    toModel: string | null | undefined;
    at: number;
  },
): ModelDivergenceState {
  const fromReference = resolveModelReference({
    configuredModel: input.fromModel,
    initModel: input.fromInitModel,
  });
  const from = fromReference.kind === "model" ? fromReference.model : null;
  const to = canonicalModelId(input.toModel);
  const next: ModelDivergenceState = { ...state };
  delete next.divergence;
  if (from && from !== to) {
    next.transition = { fromModel: from, at: input.at };
  } else {
    delete next.transition;
  }
  return next;
}

/**
 * The session was closed and re-opened on purpose (an account-failover move, a reload). Nothing
 * observed before it is evidence about the session that replaces it, so the finding and any
 * pending transition go. A response from the new session that disagrees with the configured
 * model is still a finding: a move changes where a model is served from, not which one was asked
 * for.
 */
export function noteSessionRestart(state: ModelDivergenceState): ModelDivergenceState {
  const next: ModelDivergenceState = { ...state };
  delete next.divergence;
  delete next.transition;
  return next;
}

export interface ModelObservationInput {
  /** The model a response reported, exactly as the provider spelled it. */
  observedModel: string;
  at: number;
  configuredModel: string | null | undefined;
  /** The provider's own resolution at session init; only consulted for an alias. */
  initModel?: string | null;
}

/**
 * Folds one response's reported model into the state. A mismatch is a finding unless the model
 * was changed on purpose a moment ago and this response is the request that was already in
 * flight. Everything else that is intentional — an alias resolving, `[1m]`, a dated snapshot —
 * is settled before comparing, by resolving the reference and canonicalizing both sides.
 */
export function recordModelObservation(
  state: ModelDivergenceState,
  input: ModelObservationInput,
): ModelDivergenceState {
  const observed = canonicalModelId(input.observedModel);
  if (!observed) {
    return state;
  }
  const next: ModelDivergenceState = {
    ...state,
    observedModel: input.observedModel.trim(),
    observedAt: input.at,
  };
  const reference = resolveModelReference({
    configuredModel: input.configuredModel,
    initModel: input.initModel,
  });
  if (reference.kind === "unverifiable") {
    delete next.divergence;
    return next;
  }
  if (observed === reference.model) {
    delete next.divergence;
    delete next.transition;
    return next;
  }
  const transition = state.transition;
  if (
    transition &&
    transition.fromModel === observed &&
    input.at - transition.at <= MODEL_TRANSITION_GRACE_MS
  ) {
    return next;
  }
  const standing = state.divergence;
  const samePair =
    standing !== undefined &&
    standing.configuredModel === reference.model &&
    canonicalModelId(standing.observedModel) === observed;
  next.divergence = samePair
    ? {
        ...standing,
        observedModel: input.observedModel.trim(),
        lastObservedAt: input.at,
        responses: standing.responses + 1,
      }
    : {
        configuredModel: reference.model,
        observedModel: input.observedModel.trim(),
        firstObservedAt: input.at,
        lastObservedAt: input.at,
        responses: 1,
      };
  return next;
}

export interface ModelDivergenceThresholds {
  persistResponses: number;
  persistMs: number;
}

/**
 * Persisting means several responses over a real stretch of time, not one stray frame. Both are
 * required: three tool calls inside a second can straddle a switch the grace window did not
 * cover, and a slow single response is still one response.
 */
export function isDivergencePersisting(
  divergence: ModelDivergence,
  thresholds: ModelDivergenceThresholds,
): boolean {
  return (
    divergence.responses >= thresholds.persistResponses &&
    divergence.lastObservedAt - divergence.firstObservedAt >= thresholds.persistMs
  );
}

/** The identity a finding is announced under: the same pair is one finding, however long it runs. */
export function divergenceKey(divergence: ModelDivergence): string {
  return `${divergence.configuredModel}->${canonicalModelId(divergence.observedModel) ?? divergence.observedModel}`;
}
