import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";
import type { Logger } from "pino";

import { buildJevAuditLine, JevAudit } from "./audit.js";
import { createJevConfigReader, type JevConfigReader, type ResolvedJevConfig } from "./config.js";
import type {
  JevAnswer,
  JevCallMeta,
  JevCost,
  JevDecideInput,
  JevEgressScope,
  JevFailureReason,
  JevFeatureId,
  JevLane,
  JevOutcome,
  JevService,
  JevStatus,
  JevTransport,
  JevTransportResponse,
  JevUnavailableReason,
  JevWireRequest,
  JevWireResponse,
} from "./contract.js";
import { JevDecisionStore } from "./decisions.js";
import { JevEgressScopeChecker, type JevExclusionConfig } from "./egress-scope.js";
import { createJevKeyResolver, JEV_KEY_ENV, type CapturedJevEnvKey } from "./key.js";
import { JevLanes, type JevLaneLimits } from "./lanes.js";
import { JevLedger, nextLocalMidnight, type JevLedgerEntry } from "./ledger.js";
import {
  JevExactSecretSet,
  redactJevRequest,
  restoreAnswerKeys,
  type JevRedactionResult,
  type JevSecretValue,
} from "./redact.js";
import { createHttpJevTransport } from "./transport.js";
import {
  reportedCostUsd,
  validateJevRequest,
  validateJevResponse,
  verdictLine,
  withStateAsDataSentence,
} from "./wire.js";

/**
 * `JevService`, the one place every JEV call goes through (docs/jev.md, "The request"). `decide`
 * runs its steps in order and never rejects; every stop answers today's behaviour.
 */

export const JEV_FEATURE_LANES: Record<JevFeatureId, JevLane> = {
  spawnHint: "control",
  remediationTriage: "control",
  notificationTriage: "control",
  compactionTiming: "control",
  stallJudgment: "control",
  awayReply: "control",
  agentTools: "agentTools",
};

const JEV_FEATURES = Object.keys(JEV_FEATURE_LANES) as JevFeatureId[];

/** Bytes, not tokens: JEV's tokenizer is unknown, so 60 KB assumes about 2.5 bytes a token. */
export const JEV_MAX_STATE_BYTES = 60_000;
export const JEV_MAX_BODY_BYTES = 64_000;
const ESTIMATE_BYTES_PER_TOKEN = 2.5;
/** A sent attempt with no usage (a timeout, a 5xx) is charged pessimistically. */
const UNREPORTED_BYTES_PER_TOKEN = 2;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;
const RETRY_JITTER = 0.2;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 529]);
const KEY_REJECTED_MS = 10 * 60_000;
const SNAPSHOT_TTL_MS = 5_000;

export const JEV_OFF_NO_KEY_LOG = `jev: off, no key (add ${JEV_KEY_ENV} to ~/.config/paseo/jev.env)`;

export interface JevBudgetExhaustedEvent {
  lane: JevLane;
  topFeature: JevFeatureId | null;
  resetsAt: Date;
}

export interface JevServiceOptions {
  paseoHome: string;
  logger: Logger;
  /** What `captureJevKeyFromEnv` took out of the daemon's environment at startup. */
  capturedKey: CapturedJevEnvKey;
  /**
   * Replaces the HTTP transport: the fake under tests and `PASEO_JEV_BACKEND=fake`. A fake needs no
   * key. Absent under Vitest, no live transport is built unless `PASEO_JEV_BACKEND=live`.
   */
  transport?: JevTransport;
  /** Own, ancestor and descendant cwds for the scope's agents; null for an unknown id. */
  resolveAgentCwds?: (agentIds: string[]) => Promise<string[] | null>;
  /** The exact values the daemon holds (`collectJevSecretValues`), without the JEV key. */
  readSecretValues?: (jevKey: string | null) => readonly JevSecretValue[];
  /** The agent's labels, for attaching its spawn hint in `listDecisions`. */
  readAgentLabels?: (agentId: string) => Readonly<Record<string, string>> | null;
  /** Checked for `VITEST` and `PASEO_JEV_BACKEND`. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  homeDir?: string;
  platform?: NodeJS.Platform;
  /** Test seams. */
  configReader?: JevConfigReader;
  scopeChecker?: Pick<JevEgressScopeChecker, "check" | "scanText">;
  redact?: typeof redactJevRequest;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

export interface JevServiceRuntime extends JevService {
  /** Loads the ledger's totals and narrows the audit files. Call once before serving. */
  start(): Promise<void>;
  /** Flushes the ledger and the audit queue. */
  stop(): Promise<void>;
  /** The push for a lane's first spent budget of the day (`jev_budget_exhausted`). */
  setBudgetNoticeSender(send: ((event: JevBudgetExhaustedEvent) => void) | null): void;
}

interface Snapshot {
  at: number;
  config: ResolvedJevConfig | null;
  key: string | null;
  secrets: JevExactSecretSet | null;
}

type StopOutcome =
  | { kind: "unavailable"; reason: JevUnavailableReason; signal?: string | null }
  | { kind: "failed"; reason: JevFailureReason };

interface SendContext {
  input: JevDecideInput;
  callId: string;
  startedAt: number;
  lane: JevLane;
  entry: JevLedgerEntry;
  config: ResolvedJevConfig;
  transport: JevTransport;
  redacted: JevRedactionResult;
  deadlineAt: number;
  limits: JevLaneLimits;
}

interface AttemptState {
  cost: JevCost | null;
  failure: JevFailureReason | null;
  response: JevWireResponse | null;
  attempts: number;
}

type AttemptStep = { kind: "done" } | { kind: "retry"; waitMs: number };

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return sleepFor(ms, undefined, { signal }).catch(() => undefined);
}

function mergeCostSource(
  a: "reported" | "estimated" | "fake",
  b: "reported" | "estimated" | "fake",
): "reported" | "estimated" | "fake" {
  if (a === b) return a;
  if (a === "fake" || b === "fake") return "fake";
  return "estimated";
}

function newLedgerEntry(
  input: JevDecideInput,
  callId: string,
  startedAt: number,
  lane: JevLane,
): JevLedgerEntry {
  const subject = input.subject ?? {};
  const ids = [subject.agentId, subject.callerAgentId, ...(input.scope?.agentIds ?? [])];
  return {
    callId,
    at: new Date(startedAt).toISOString(),
    feature: input.feature,
    lane,
    callSite: input.callSite,
    subjectAgentIds: [
      ...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0)),
    ],
    outcome: "unavailable",
    reason: null,
    exclusionSignal: null,
    model: null,
    attempts: 0,
    elapsedMs: 0,
    stateBytes: 0,
    bodyBytes: 0,
    redactions: 0,
    questionCount: Object.keys(input.questions ?? {}).length,
    inputTokens: 0,
    outputTokens: 0,
    cost: { usd: 0, source: "estimated" },
    verdicts: [],
    chargedAgentId:
      lane === "agentTools" ? (subject.callerAgentId ?? subject.agentId ?? null) : null,
  };
}

function featureConfig(
  config: ResolvedJevConfig,
  feature: JevFeatureId,
): { enabled: boolean; shadow: boolean; timeoutMs: number } {
  return config[feature];
}

function exclusionOf(config: ResolvedJevConfig): JevExclusionConfig {
  return {
    excludeCwds: config.excludeCwds,
    excludeRemotes: config.excludeRemotes,
    excludeTextMarkers: config.excludeTextMarkers,
  };
}

function laneLimits(config: ResolvedJevConfig): JevLaneLimits {
  return {
    control: config.maxConcurrent,
    agentTools: config.agentTools.maxConcurrent,
    perGroup: config.agentTools.maxConcurrentPerCall,
    requestsPerSecond: config.maxRequestsPerSecond,
  };
}

function laneCapUsd(config: ResolvedJevConfig, lane: JevLane): number {
  return lane === "control" ? config.maxUsdPerDay : config.agentTools.maxUsdPerDay;
}

function usdForTokens(tokens: number, config: ResolvedJevConfig): number {
  return (tokens / 1_000_000) * config.inputUsdPerMillion;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export function createJevService(options: JevServiceOptions): JevServiceRuntime {
  const logger = options.logger.child({ module: "jev" });
  const now = options.now ?? Date.now;
  const homeDir = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const redact = options.redact ?? redactJevRequest;
  const jevDir = path.join(options.paseoHome, "jev");
  const configReader =
    options.configReader ??
    createJevConfigReader({ paseoHome: options.paseoHome, homeDir, logger });
  const keyResolver = createJevKeyResolver({
    captured: options.capturedKey,
    logger,
    platform: options.platform,
  });
  const scopeChecker =
    options.scopeChecker ??
    new JevEgressScopeChecker({
      homeDir,
      platform: options.platform ?? process.platform,
      resolveAgentCwds: options.resolveAgentCwds,
      now,
    });
  const lanes = new JevLanes({ now });
  let sendBudgetNotice: ((event: JevBudgetExhaustedEvent) => void) | null = null;
  const ledger = new JevLedger({
    filePath: path.join(jevDir, "ledger.json"),
    logger,
    now,
    onBudgetExhausted: (event) => {
      logger.warn(
        { lane: event.lane, topFeature: event.topFeature, resetsAt: event.resetsAt.toISOString() },
        "jev: daily budget spent; the lane is off until local midnight",
      );
      try {
        sendBudgetNotice?.(event);
      } catch (error) {
        logger.warn({ err: error }, "jev: budget notice failed");
      }
    },
  });
  const audit = new JevAudit({ dir: jevDir, logger, now, platform: options.platform });
  const decisions = new JevDecisionStore({
    now,
    costFor: (callId) => ledger.find(callId)?.cost.usd ?? null,
  });

  const fixedTransport = options.transport ?? null;
  const liveRefused =
    fixedTransport === null && Boolean(env["VITEST"]) && env["PASEO_JEV_BACKEND"] !== "live";
  let httpTransport: { signature: string; transport: JevTransport } | null = null;
  let snapshot: Snapshot | null = null;
  let keyRejectedUntil = 0;
  let loggedNoKey = false;
  let loggedKeyRejected = false;
  let loggedLiveRefused = false;

  function currentKey(): string | null {
    return snapshot?.key ?? null;
  }

  function transportFor(config: ResolvedJevConfig): JevTransport | null {
    if (fixedTransport) return fixedTransport;
    if (liveRefused) {
      if (!loggedLiveRefused) {
        loggedLiveRefused = true;
        logger.info("jev: live transport refused under Vitest (set PASEO_JEV_BACKEND=live)");
      }
      return null;
    }
    const signature = `${config.provider}\0${config.endpointUrl}`;
    if (httpTransport?.signature !== signature) {
      httpTransport = {
        signature,
        transport: createHttpJevTransport({
          provider: config.provider,
          endpointUrl: config.endpointUrl,
          getKey: currentKey,
        }),
      };
    }
    return httpTransport.transport;
  }

  /** Config and key through the 5-second cache. Secrets are built only when a call needs them. */
  function readSnapshot(needSecrets: boolean): Snapshot {
    const at = now();
    if (!snapshot || at - snapshot.at >= SNAPSHOT_TTL_MS) {
      const read = configReader.read();
      const config = read.ok ? read.config : null;
      const key = config ? keyResolver.resolve(config.envFile).key : null;
      snapshot = { at, config, key, secrets: null };
    }
    if (needSecrets && !snapshot.secrets) {
      const values = [
        ...(snapshot.key ? [{ kind: "exact", value: snapshot.key }] : []),
        ...(options.readSecretValues?.(snapshot.key) ?? []),
      ];
      snapshot.secrets = new JevExactSecretSet(values);
    }
    return snapshot;
  }

  /** Spent, or refused on its estimate today: either way the lane is off until local midnight. */
  function laneSpent(config: ResolvedJevConfig, lane: JevLane): boolean {
    return ledger.isExhausted(lane) || ledger.spentTodayUsd(lane) >= laneCapUsd(config, lane);
  }

  function keyPresent(snap: Snapshot): boolean {
    return fixedTransport?.provider === "fake" || snap.key !== null;
  }

  /** Step 1 of `decide`, and the whole of `isActive` and `status().reason`. */
  function gateReason(snap: Snapshot, feature: JevFeatureId | null): JevUnavailableReason | null {
    const config = snap.config;
    if (!config) return "config-unreadable";
    if (!config.enabled) return "disabled";
    if (feature && !featureConfig(config, feature).enabled) return "feature-disabled";
    if (!keyPresent(snap)) {
      if (!loggedNoKey) {
        loggedNoKey = true;
        logger.info(JEV_OFF_NO_KEY_LOG);
      }
      return "no-key";
    }
    if (!transportFor(config)) return "disabled";
    if (keyRejectedUntil > now()) return "key-rejected";
    if (feature) {
      const lane = JEV_FEATURE_LANES[feature];
      if (laneSpent(config, lane)) return "daily-budget";
      if (lanes.circuits[lane].state(now()) === "open") return "circuit-open";
    }
    return null;
  }

  function charge(
    sentBytes: number,
    response: JevWireResponse | null,
    config: ResolvedJevConfig,
  ): JevCost {
    if (fixedTransport?.provider === "fake") return { usd: 0, source: "fake" };
    const reported = response ? reportedCostUsd(response.usage) : null;
    if (reported !== null) return { usd: reported, source: "reported" };
    if (response)
      return { usd: usdForTokens(response.usage.input_tokens, config), source: "estimated" };
    return {
      usd: usdForTokens(sentBytes / UNREPORTED_BYTES_PER_TOKEN, config),
      source: "estimated",
    };
  }

  function addCost(total: JevCost | null, next: JevCost): JevCost {
    if (total === null || total.usd === null) return next;
    if (next.usd === null) return total;
    return { usd: total.usd + next.usd, source: mergeCostSource(total.source, next.source) };
  }

  async function decide(input: JevDecideInput): Promise<JevOutcome> {
    const callId = randomUUID();
    const startedAt = now();
    const lane = JEV_FEATURE_LANES[input.feature] ?? "control";
    const entry = newLedgerEntry(input, callId, startedAt, lane);
    let outcome: JevOutcome;
    try {
      outcome = await decideSteps(input, callId, startedAt, lane, entry);
    } catch (error) {
      // Nothing below is allowed to throw; this is the backstop that keeps `decide` total.
      logger.warn({ err: error, callId, feature: input.feature }, "jev: decide threw");
      outcome = { kind: "failed", callId, reason: "contract", meta: null };
    }
    entry.outcome = outcome.kind;
    entry.reason =
      outcome.kind === "unavailable" || outcome.kind === "failed" ? outcome.reason : null;
    entry.elapsedMs = now() - startedAt;
    try {
      ledger.record(entry);
      // The first charge that reaches the cap notifies once; step 1 stops the next call.
      const config = snapshot?.config;
      if (config && ledger.spentTodayUsd(lane) >= laneCapUsd(config, lane)) {
        ledger.markExhausted(lane);
      }
    } catch (error) {
      logger.warn({ err: error, callId }, "jev: ledger record failed");
    }
    logger.debug(
      {
        callId,
        feature: input.feature,
        callSite: input.callSite,
        outcome: outcome.kind,
        reason: entry.reason,
        signal: entry.exclusionSignal,
        elapsedMs: entry.elapsedMs,
      },
      "jev: decide",
    );
    return outcome;
  }

  async function decideSteps(
    input: JevDecideInput,
    callId: string,
    startedAt: number,
    lane: JevLane,
    entry: JevLedgerEntry,
  ): Promise<JevOutcome> {
    const unavailable = (reason: JevUnavailableReason): JevOutcome => ({
      kind: "unavailable",
      callId,
      reason,
    });

    // 1. Switches, key, circuit.
    const snap = readSnapshot(false);
    const gate = gateReason(snap, input.feature);
    if (gate) return unavailable(gate);
    const config = snap.config!;
    const transport = transportFor(config)!;

    // 2. Scope.
    const scopeSignal = await scopeExclusion(input.scope, config);
    if (scopeSignal) {
      entry.exclusionSignal = scopeSignal;
      return unavailable("excluded");
    }

    // 3–7. Body, request rules, redaction, the text scan, sizes.
    const prepared = prepareBody(input, config, entry);
    if (prepared.kind === "stop") {
      if (prepared.stop.kind === "unavailable") {
        entry.exclusionSignal = prepared.stop.signal ?? null;
        return unavailable(prepared.stop.reason);
      }
      return { kind: "failed", callId, reason: prepared.stop.reason, meta: null };
    }

    // 8. Spend, against an estimate.
    const refusal = spendRefusal(config, lane, entry);
    if (refusal) return unavailable(refusal);

    // 9. A lane slot, inside the deadline.
    const feature = featureConfig(config, input.feature);
    const deadlineMs = Math.max(
      0,
      Math.min(input.deadlineMs ?? feature.timeoutMs, feature.timeoutMs),
    );
    const deadlineAt = startedAt + deadlineMs;
    const limits = laneLimits(config);
    const slot = await lanes.acquireSlot(lane, {
      deadlineAt,
      group: lane === "agentTools" ? (input.callGroup ?? callId) : undefined,
      limits,
      signal: input.signal,
    });
    if (!slot.ok) {
      return slot.reason === "aborted"
        ? { kind: "failed", callId, reason: "aborted", meta: null }
        : unavailable("saturated");
    }
    try {
      return await sendWithRetries({
        input,
        callId,
        startedAt,
        lane,
        entry,
        config,
        transport,
        redacted: prepared.redacted,
        deadlineAt,
        limits,
      });
    } finally {
      slot.release();
    }
  }

  /** Step 2. The signal id when excluded; any error excludes. */
  async function scopeExclusion(
    scope: JevEgressScope | undefined,
    config: ResolvedJevConfig,
  ): Promise<string | null> {
    if (!scope) return "missing";
    try {
      const verdict = await scopeChecker.check(scope, exclusionOf(config));
      return verdict.excluded ? verdict.signal : null;
    } catch {
      return "error";
    }
  }

  /** Steps 3–7. Any exception sends nothing and audits nothing. */
  function prepareBody(
    input: JevDecideInput,
    config: ResolvedJevConfig,
    entry: JevLedgerEntry,
  ): { kind: "ok"; redacted: JevRedactionResult } | { kind: "stop"; stop: StopOutcome } {
    const questions = withStateAsDataSentence(input.questions);
    if (validateJevRequest(questions)) {
      return { kind: "stop", stop: { kind: "failed", reason: "invalid-request" } };
    }
    const request: JevWireRequest = { model: config.model, state: input.state, questions };
    let redacted: JevRedactionResult;
    try {
      redacted = redact(request, { secrets: readSnapshot(true).secrets!, homeDir });
    } catch {
      return { kind: "stop", stop: { kind: "failed", reason: "redaction" } };
    }
    try {
      // The text scan runs on the bytes that would be sent, and also on the body before
      // redaction: a marker inside a redacted value (an `@wonderly.com` email, a remote in an
      // assignment) is gone from the sent bytes but still means the state is company content.
      for (const text of [redacted.serialized, JSON.stringify(request)]) {
        const verdict = scanTextSafely(text, config);
        if (verdict)
          return {
            kind: "stop",
            stop: { kind: "unavailable", reason: "excluded", signal: verdict },
          };
      }
      entry.stateBytes = Buffer.byteLength(JSON.stringify(redacted.request.state) ?? "", "utf8");
      entry.bodyBytes = Buffer.byteLength(redacted.serialized, "utf8");
      entry.redactions = redacted.count;
    } catch {
      return { kind: "stop", stop: { kind: "failed", reason: "redaction" } };
    }
    if (entry.stateBytes > JEV_MAX_STATE_BYTES) {
      return { kind: "stop", stop: { kind: "failed", reason: "state-too-large" } };
    }
    if (entry.bodyBytes > JEV_MAX_BODY_BYTES) {
      return { kind: "stop", stop: { kind: "failed", reason: "request-too-large" } };
    }
    return { kind: "ok", redacted };
  }

  function scanTextSafely(text: string, config: ResolvedJevConfig): string | null {
    try {
      const verdict = scopeChecker.scanText(text, exclusionOf(config));
      return verdict.excluded ? verdict.signal : null;
    } catch {
      return "error";
    }
  }

  /** Step 8: refuse a call the remaining budget cannot cover. */
  function spendRefusal(
    config: ResolvedJevConfig,
    lane: JevLane,
    entry: JevLedgerEntry,
  ): "daily-budget" | "agent-budget" | null {
    const estimateUsd = usdForTokens(entry.bodyBytes / ESTIMATE_BYTES_PER_TOKEN, config);
    if (ledger.spentTodayUsd(lane) + estimateUsd > laneCapUsd(config, lane)) {
      ledger.markExhausted(lane);
      return "daily-budget";
    }
    if (lane !== "agentTools" || !entry.chargedAgentId) return null;
    const agentSpent = ledger.spentByAgentLastHourUsd(entry.chargedAgentId);
    return agentSpent + estimateUsd > config.agentTools.maxUsdPerAgentPerHour
      ? "agent-budget"
      : null;
  }

  /** Steps 9b–12: a rate token and the circuit per attempt, the send, retries, the answer. */
  async function sendWithRetries(ctx: SendContext): Promise<JevOutcome> {
    const attempt: AttemptState = { cost: null, failure: null, response: null, attempts: 0 };
    while (attempt.attempts < MAX_ATTEMPTS) {
      const pass = await passForAttempt(ctx);
      if (pass.kind === "refused") {
        if (attempt.attempts === 0) return pass.first;
        attempt.failure ??= "timeout";
        break;
      }
      const step = await attemptOnce(ctx, attempt, pass.probing);
      if (step.kind === "done") break;
      await sleep(step.waitMs, ctx.input.signal ?? new AbortController().signal);
      if (ctx.input.signal?.aborted) {
        attempt.failure = "aborted";
        break;
      }
    }
    return finishSend(ctx, attempt);
  }

  async function passForAttempt(
    ctx: SendContext,
  ): Promise<{ kind: "go"; probing: boolean } | { kind: "refused"; first: JevOutcome }> {
    const token = await lanes.takeRateToken(ctx.lane, {
      deadlineAt: ctx.deadlineAt,
      limits: ctx.limits,
      signal: ctx.input.signal,
    });
    if (!token.ok) {
      const first: JevOutcome =
        token.reason === "aborted"
          ? { kind: "failed", callId: ctx.callId, reason: "aborted", meta: null }
          : { kind: "unavailable", callId: ctx.callId, reason: "saturated" };
      return { kind: "refused", first };
    }
    const circuit = lanes.circuits[ctx.lane];
    const probing = circuit.state(now()) === "half-open";
    if (!circuit.tryPass(now())) {
      return {
        kind: "refused",
        first: { kind: "unavailable", callId: ctx.callId, reason: "circuit-open" },
      };
    }
    return { kind: "go", probing };
  }

  async function attemptOnce(
    ctx: SendContext,
    attempt: AttemptState,
    probing: boolean,
  ): Promise<AttemptStep> {
    attempt.attempts += 1;
    ctx.entry.attempts = attempt.attempts;
    const deadlineSignal = AbortSignal.timeout(Math.max(1, ctx.deadlineAt - now()));
    const signal = ctx.input.signal
      ? AbortSignal.any([ctx.input.signal, deadlineSignal])
      : deadlineSignal;
    let result: JevTransportResponse;
    try {
      result = await ctx.transport.send(ctx.redacted.request, { signal });
    } catch (error) {
      attempt.cost = addCost(attempt.cost, charge(ctx.entry.bodyBytes, null, ctx.config));
      const circuit = lanes.circuits[ctx.lane];
      if (ctx.input.signal?.aborted) {
        if (probing) circuit.recordFailure(now());
        attempt.failure = "aborted";
      } else {
        attempt.failure = deadlineSignal.aborted || isAbortError(error) ? "timeout" : "network";
        circuit.recordFailure(now());
      }
      return { kind: "done" };
    }
    if (result.status >= 200 && result.status < 300) {
      acceptResponse(ctx, attempt, result.body);
      return { kind: "done" };
    }
    return handleHttpError(ctx, attempt, result);
  }

  function acceptResponse(ctx: SendContext, attempt: AttemptState, body: unknown): void {
    const validated = validateJevResponse(body, ctx.redacted.request.questions);
    lanes.circuits[ctx.lane].recordSuccess();
    if (!validated.ok) {
      attempt.cost = addCost(attempt.cost, charge(ctx.entry.bodyBytes, null, ctx.config));
      attempt.failure = "contract";
      return;
    }
    attempt.response = validated.response;
    attempt.cost = addCost(
      attempt.cost,
      charge(ctx.entry.bodyBytes, validated.response, ctx.config),
    );
    attempt.failure = null;
  }

  function handleHttpError(
    ctx: SendContext,
    attempt: AttemptState,
    result: JevTransportResponse,
  ): AttemptStep {
    const circuit = lanes.circuits[ctx.lane];
    attempt.cost = addCost(attempt.cost, charge(ctx.entry.bodyBytes, null, ctx.config));
    attempt.failure = "http";
    if (result.status === 401 || result.status === 402) {
      circuit.recordSuccess();
      keyRejectedUntil = now() + KEY_REJECTED_MS;
      if (!loggedKeyRejected) {
        loggedKeyRejected = true;
        logger.warn(
          { httpStatus: result.status },
          `jev: ${JEV_KEY_ENV} was rejected; JEV is off for 10 minutes`,
        );
      }
      return { kind: "done" };
    }
    if (RETRYABLE_STATUSES.has(result.status)) {
      const backoff = RETRY_BASE_MS * 2 ** (attempt.attempts - 1) * (1 + random() * RETRY_JITTER);
      const waitMs = Math.max(backoff, result.retryAfterMs ?? 0);
      if (attempt.attempts < MAX_ATTEMPTS && now() + waitMs < ctx.deadlineAt) {
        return { kind: "retry", waitMs };
      }
      circuit.recordFailure(now());
      return { kind: "done" };
    }
    if (result.status >= 500) circuit.recordFailure(now());
    else circuit.recordSuccess();
    return { kind: "done" };
  }

  function finishSend(ctx: SendContext, attempt: AttemptState): JevOutcome {
    const { entry, config, callId } = ctx;
    const response = attempt.response;
    entry.cost = attempt.cost ?? { usd: 0, source: "estimated" };
    entry.model = response?.model ?? null;
    entry.inputTokens = response?.usage.input_tokens ?? 0;
    entry.outputTokens = response?.usage.output_tokens ?? 0;
    const meta: JevCallMeta = {
      model: response?.model ?? config.model,
      elapsedMs: now() - ctx.startedAt,
      attempts: attempt.attempts,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      stateBytes: entry.stateBytes,
      bodyBytes: entry.bodyBytes,
      redactions: entry.redactions,
      cost: entry.cost,
    };
    let outcome: JevOutcome;
    if (attempt.failure || !response) {
      outcome = { kind: "failed", callId, reason: attempt.failure ?? "contract", meta };
    } else {
      outcome = answeredOutcome(ctx, response, meta);
    }
    appendAudit(ctx, attempt, outcome, meta);
    return outcome;
  }

  /** Step 12: the answer, with the caller's own keys back; shadow unless the feature says live. */
  function answeredOutcome(
    ctx: SendContext,
    response: JevWireResponse,
    meta: JevCallMeta,
  ): JevOutcome {
    let answers: Record<string, JevAnswer>;
    try {
      answers = restoreAnswerKeys(response.answers, ctx.redacted.keyMap);
    } catch {
      return { kind: "failed", callId: ctx.callId, reason: "contract", meta };
    }
    ctx.entry.verdicts = Object.entries(answers).map(
      ([id, answer]) => `${id}: ${verdictLine(answer)}`,
    );
    const shadow =
      ctx.input.feature !== "agentTools" && featureConfig(ctx.config, ctx.input.feature).shadow;
    return { kind: shadow ? "shadow" : "answered", callId: ctx.callId, answers, meta };
  }

  function appendAudit(
    ctx: SendContext,
    attempt: AttemptState,
    outcome: JevOutcome,
    meta: JevCallMeta,
  ): void {
    if (attempt.attempts === 0 || outcome.kind === "unavailable") return;
    try {
      audit.append(
        buildJevAuditLine({
          lane: ctx.lane,
          request: ctx.redacted.request,
          answers: outcome.kind === "failed" ? null : outcome.answers,
          ledger: {
            callId: ctx.callId,
            at: ctx.entry.at,
            feature: ctx.entry.feature,
            callSite: ctx.entry.callSite,
            attempts: attempt.attempts,
            elapsedMs: meta.elapsedMs,
            stateBytes: meta.stateBytes,
            bodyBytes: meta.bodyBytes,
            redactions: meta.redactions,
            cost: meta.cost,
            outcome: outcome.kind,
            reason: outcome.kind === "failed" ? outcome.reason : null,
            model: meta.model,
          },
        }),
        ctx.config.audit,
      );
    } catch (error) {
      logger.warn({ err: error, callId: ctx.callId }, "jev: audit append failed");
    }
  }

  function isActive(feature: JevFeatureId): boolean {
    try {
      return gateReason(readSnapshot(false), feature) === null;
    } catch {
      return false;
    }
  }

  async function checkScope(scope: JevEgressScope): Promise<"ok" | "excluded"> {
    try {
      const config = readSnapshot(false).config;
      if (!config) return "excluded";
      const verdict = await scopeChecker.check(scope, exclusionOf(config));
      return verdict.excluded ? "excluded" : "ok";
    } catch {
      return "excluded";
    }
  }

  function status(): JevStatus {
    const snap = readSnapshot(false);
    const config = snap.config;
    const reason = gateReason(snap, null);
    const at = new Date(now());
    const resetsAt = nextLocalMidnight(at).toISOString();
    const laneStatus = (lane: JevLane) => ({
      today: ledger.laneTotalsToday(lane),
      maxUsdPerDay: config ? laneCapUsd(config, lane) : 0,
      exhausted: config ? laneSpent(config, lane) : ledger.isExhausted(lane),
      circuit: lanes.circuits[lane].state(now()),
      resetsAt,
    });
    const features = Object.fromEntries(
      JEV_FEATURES.map((feature) => {
        const own = config ? featureConfig(config, feature) : null;
        return [
          feature,
          {
            enabled: Boolean(config?.enabled && own?.enabled),
            shadow: feature === "agentTools" ? false : (own?.shadow ?? true),
          },
        ];
      }),
    ) as JevStatus["features"];
    return {
      available: reason === null,
      reason,
      keyPresent: keyPresent(snap),
      provider: fixedTransport?.provider ?? config?.provider ?? "openrouter",
      model: config?.model ?? "",
      features,
      lanes: { control: laneStatus("control"), agentTools: laneStatus("agentTools") },
      spawnHint: {
        applyHard: config?.spawnHint.applyHard ?? false,
        applyRole: config?.spawnHint.applyRole ?? false,
      },
      agentTools: { assignShare: config?.agentTools.assignShare ?? 0 },
      todayByFeature: Object.fromEntries(
        JEV_FEATURES.map((feature) => [feature, ledger.featureTotalsToday(feature)]),
      ) as JevStatus["todayByFeature"],
      last7Days: ledger.last7Days(),
    };
  }

  return {
    decide,
    isActive,
    checkScope,
    status,
    decisions,
    listDecisions: (agentId) => {
      let labels: Readonly<Record<string, string>> | null = null;
      try {
        labels = options.readAgentLabels?.(agentId) ?? null;
      } catch {
        labels = null;
      }
      return decisions.list(agentId, labels);
    },
    async start() {
      await ledger.load();
      const snap = readSnapshot(false);
      await audit.init({ retainDays: snap.config?.audit.retainDays ?? 3 });
      if (fixedTransport?.provider === "fake") logger.info("jev: fake backend");
      else if (snap.config && !keyPresent(snap)) gateReason(snap, null);
    },
    async stop() {
      await ledger.stop();
      await audit.flush();
    },
    setBudgetNoticeSender(send) {
      sendBudgetNotice = send;
    },
  };
}
