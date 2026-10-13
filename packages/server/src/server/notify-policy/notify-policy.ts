import { randomUUID } from "node:crypto";
import type pino from "pino";
import type {
  NotifyAvailabilityMode,
  NotifyPolicySettings,
  NotifyLedgerEntry,
  NotifyOutcome,
} from "@getpaseo/protocol/notify-policy/types";

import {
  PushLedger,
  stateFromTickets,
  toWireEntry,
  type LedgerRecord,
  type LedgerTicket,
} from "../push/ledger.js";
import type { PushDelivery, PushDeliveryResult, PushPayload } from "../push/push-service.js";
import { digestWindowMs, resolveAvailability, type EffectiveAvailability } from "./availability.js";
import { decideDelivery, type DeliveryDecision } from "./decide.js";
import {
  DEFAULT_NOTIFY_LEVEL,
  levelAtLeast,
  levelRank,
  type NotifyLevel,
  type PushSendMeta,
} from "./levels.js";
import type { NotifyPolicySettingsStore } from "./settings.js";

/** A repeat of the same dedupe key inside this window is counted against the first, not sent. */
export const DEDUPE_WINDOW_MS = 60 * 60 * 1000;
/** A push still unsent this long after a restart is stale; it is recorded as failed, not resent. */
const UNSENT_RESEND_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_DIGEST_LINES = 4;
const HOLDING_MODES: ReadonlySet<NotifyAvailabilityMode> = new Set(["away", "off"]);
/**
 * R8: an interrupting push (alert or urgent — never a notice or below) that failed in transport
 * keeps retrying until it is delivered or this long has passed since it was first attempted.
 */
const RETRY_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** Roughly 1, 2, 5, 10 minutes, then every 15 minutes. */
const RETRY_BACKOFF_MS = [1, 2, 5, 10, 15].map((minutes) => minutes * 60 * 1000);

export interface NotifyTransport {
  activeTokens(): string[];
  deliver(
    tokens: string[],
    payload: PushPayload,
    delivery: PushDelivery,
  ): Promise<PushDeliveryResult[]>;
}

export interface NotifyPolicyOptions {
  logger: pino.Logger;
  ledger: PushLedger;
  settings: NotifyPolicySettingsStore;
  transport: NotifyTransport;
  now?: () => number;
}

/** What `submit` would do with a push right now. `devices`: the registered tokens it would go to. */
export interface NotifyDeliveryPreview {
  outcome: NotifyOutcome;
  devices: number;
}

/**
 * Whether a push with this preview reaches a phone now: pushed at once (loud or quiet) to at least
 * one registered device. A digest may wait hours, a fold adds nothing new, and a log or a phone
 * with no token reaches nobody.
 */
export function reachesPhoneNow(preview: NotifyDeliveryPreview): boolean {
  return (preview.outcome === "interrupt" || preview.outcome === "notify") && preview.devices > 0;
}

export interface NotifyPolicyStatus {
  settings: NotifyPolicySettings;
  effectiveAvailability: EffectiveAvailability;
  heldCount: number;
  unreachedCount: number;
}

/**
 * The single gate between "something wants to tell Tyler" and his phone.
 *
 * Every push declares a level. This decides what happens to it: pushed now (loud or quiet), held
 * for a digest, or only recorded. Everything goes through the ledger first, so a notification that
 * never landed is visible instead of silent. See docs/notification-policy.md for the model.
 */
export class NotifyPolicy {
  private readonly logger: pino.Logger;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private stopped = false;
  private lastMode: NotifyAvailabilityMode | null = null;
  private readonly warnedUndeclared = new Set<string>();

  constructor(private readonly options: NotifyPolicyOptions) {
    this.logger = options.logger.child({ component: "notify-policy" });
    this.now = options.now ?? Date.now;
  }

  /** Finishes what a restart interrupted, then arms the digest timer. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.recoverUnsent();
    await this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  getStatus(): NotifyPolicyStatus {
    const settings = this.options.settings.get();
    return {
      settings,
      effectiveAvailability: resolveAvailability(settings, this.now()),
      heldCount: this.options.ledger.listHeldNotices().length,
      unreachedCount: this.options.ledger.countUnreached(),
    };
  }

  listLedger(options: { limit?: number; unreachedOnly?: boolean } = {}): NotifyLedgerEntry[] {
    return this.options.ledger.list(options).map(toWireEntry);
  }

  /** Applies a settings change and re-evaluates right away: leaving away mode sends the digest. */
  async updateSettings(patch: Partial<NotifyPolicySettings>): Promise<NotifyPolicyStatus> {
    this.noteMode();
    this.options.settings.update(patch);
    await this.tick();
    return this.getStatus();
  }

  /**
   * What `submit` would do with a push at this level and dedupe key now, without recording,
   * folding or sending anything. A caller that skips its own fallback because a person will be
   * told asks this first.
   */
  previewDelivery(meta: { level: NotifyLevel; dedupeKey?: string }): NotifyDeliveryPreview {
    const nowMs = this.now();
    const devices = this.options.transport.activeTokens().length;
    if (meta.dedupeKey && this.findFoldTarget(meta.dedupeKey, meta.level, nowMs)) {
      return { outcome: "suppressed", devices };
    }
    const settings = this.options.settings.get();
    const decision = decideDelivery({
      level: meta.level,
      settings,
      availability: resolveAvailability(settings, nowMs),
    });
    return { outcome: decision.outcome, devices };
  }

  async submit(payload: PushPayload, meta: PushSendMeta = {}): Promise<void> {
    const nowMs = this.now();
    const level = meta.level ?? DEFAULT_NOTIFY_LEVEL;
    const reason = typeof payload.data?.reason === "string" ? payload.data.reason : null;
    if (meta.level === undefined) this.warnUndeclared(reason ?? payload.title);

    const dedupeKey = meta.dedupeKey ?? null;
    if (dedupeKey && this.foldIfRepeat(dedupeKey, level, nowMs)) return;

    const settings = this.options.settings.get();
    const decision = decideDelivery({
      level,
      settings,
      availability: resolveAvailability(settings, nowMs),
    });
    const record = this.buildRecord(payload, { level, declared: meta.level !== undefined, reason });
    record.dedupeKey = dedupeKey;
    record.outcome = decision.outcome;
    record.state = decision.outcome === "log" ? "recorded" : "held";
    record.settledAt = decision.outcome === "log" ? record.at : null;
    this.options.ledger.append(record);
    if (decision.outcome === "digest" || decision.outcome === "log") {
      // Pushes that go out are logged in `dispatch`. These two never reach it, so this is the only
      // line saying they existed.
      this.logger.info(
        {
          level,
          outcome: decision.outcome,
          reason,
          agentId: record.agentId,
          title: payload.title,
          ...(meta.level === undefined ? { levelDeclared: false } : {}),
        },
        decision.outcome === "digest"
          ? "Notification held for a digest"
          : "Notification recorded, not pushed",
      );
    }

    if (decision.outcome === "digest") {
      this.schedule();
      return;
    }
    if (decision.outcome === "log") return;
    const retried = await this.dispatch(record, {
      quiet: decision.outcome === "notify",
      ...decisionFlags(decision),
    });
    // Only a retry needs the timer re-armed here; `tick` re-arms it after every other path.
    if (retried) this.schedule();
  }

  /**
   * Sends the digest if it is due, retries any interrupting push past its backoff, and re-arms
   * the timer. Called by the timer and on any change.
   */
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.flushing) {
      await this.flushing;
      return;
    }
    const returned = this.noteMode();
    this.flushing = this.runDueWork(returned).finally(() => {
      this.flushing = null;
    });
    await this.flushing;
    this.schedule();
  }

  private async runDueWork(returnedFromHold: boolean): Promise<void> {
    await this.flushIfDue(returnedFromHold);
    await this.runDueRetries();
  }

  /**
   * Sends the held notices if the digest is due. Coming back from a mode that held them (away,
   * off) makes it due at once: the person is here now and the reason to wait is gone.
   */
  private async flushIfDue(returnedFromHold: boolean): Promise<void> {
    const held = this.options.ledger.listHeldNotices();
    const oldest = held[0];
    if (!oldest) return;
    const settings = this.options.settings.get();
    const availability = resolveAvailability(settings, this.now());
    const waited = this.now() - Date.parse(oldest.at);
    if (!returnedFromHold && waited < digestWindowMs(settings, availability)) return;
    await this.sendDigest(held);
  }

  /** Records the mode in force and reports whether it just left a mode that holds notices. */
  private noteMode(): boolean {
    const mode = resolveAvailability(this.options.settings.get(), this.now()).mode;
    const previous = this.lastMode;
    this.lastMode = mode;
    return previous !== null && HOLDING_MODES.has(previous) && !HOLDING_MODES.has(mode);
  }

  private async sendDigest(held: LedgerRecord[]): Promise<void> {
    const digest = this.buildDigest(held);
    this.options.ledger.rollIntoDigest(
      held.map((record) => record.id),
      digest,
    );
    this.logger.info({ members: held.length, digestId: digest.id }, "Sending notification digest");
    await this.dispatch(digest, { quiet: true });
  }

  private buildDigest(held: LedgerRecord[]): LedgerRecord {
    const only = held.length === 1 ? held[0] : undefined;
    const top = held.reduce<NotifyLevel>(
      (best, record) => (levelRank(record.level) > levelRank(best) ? record.level : best),
      "notice",
    );
    const serverId = held.find((record) => record.serverId)?.serverId ?? null;
    const base = this.buildRecord(
      only
        ? { title: only.title, body: only.body, data: only.data }
        : {
            ...summarizeDigest(held),
            data: {
              ...(serverId ? { serverId } : {}),
              agentId: "",
              reason: "notify_digest",
              count: held.length,
            },
          },
      { level: top, declared: true, reason: only ? only.reason : "notify_digest" },
    );
    return {
      ...base,
      agentId: only?.agentId ?? null,
      serverId,
      workspaceId: only?.workspaceId ?? null,
      outcome: "notify",
      state: "held",
      memberIds: held.map((record) => record.id),
    };
  }

  /** Counts a repeat against the earlier notification and reports whether it was one. */
  private foldIfRepeat(key: string, level: NotifyLevel, nowMs: number): boolean {
    const prior = this.findFoldTarget(key, level, nowMs);
    if (!prior) return false;
    this.options.ledger.foldRepeat(prior.id);
    this.logger.info({ dedupeKey: key, priorId: prior.id }, "Notification suppressed as a repeat");
    return true;
  }

  /** The earlier notification a push with this key and level would be folded into, if any. */
  private findFoldTarget(key: string, level: NotifyLevel, nowMs: number): LedgerRecord | null {
    const prior = this.options.ledger.findLatestByDedupeKey(key);
    if (!prior || nowMs - Date.parse(prior.at) >= DEDUPE_WINDOW_MS) return null;
    // An escalation is news even when the situation is the same one.
    if (levelRank(level) > levelRank(prior.level)) return null;
    return prior;
  }

  /** Resolves to whether it armed a retry (R8), so a caller outside `tick` knows to re-arm the timer. */
  private async dispatch(record: LedgerRecord, delivery: PushDelivery): Promise<boolean> {
    const { ledger, transport } = this.options;
    const settledAt = () => new Date(this.now()).toISOString();
    const tokens = transport.activeTokens();
    // Log what went out, not just that something did. Every sender funnels through here, and with
    // only a token count on the line there is no way after the fact to tell which subsystem
    // produced a day's notifications, which is exactly the question asked when someone says the
    // notifications are noise.
    this.logger.info(
      {
        tokenCount: tokens.length,
        title: record.title,
        reason: record.reason,
        level: record.level,
        outcome: record.outcome,
        agentId: record.agentId,
        workspaceId: record.workspaceId,
      },
      "Sending push notification",
    );
    if (tokens.length === 0) {
      ledger.markSent(record.id, [], "no registered device", settledAt());
      return false;
    }
    const retryAttempt = record.retryCount ?? 0;
    const body = retryAttempt > 0 ? lateBody(record) : record.body;
    try {
      const results = await transport.deliver(
        tokens,
        { title: record.title, body, data: record.data },
        delivery,
      );
      const tickets = results.map(toTicket);
      const retry = this.planRetry(record, tickets);
      ledger.markSent(record.id, tickets, null, settledAt(), retry);
      return retry !== null;
    } catch (error) {
      ledger.markFailed(
        record.id,
        error instanceof Error ? error.message : String(error),
        settledAt(),
      );
      return false;
    }
  }

  /**
   * R8: the retry schedule for an interrupting push (alert or urgent) that failed in transport,
   * until it is delivered or `RETRY_MAX_AGE_MS` has passed since it was first attempted. A
   * ticket-level refusal (a `notice`, or no transport-failed ticket) is never retried. `record` is
   * the pre-send record: only its `level`, `at`, and `retryCount` are read, none of which change
   * between the send attempt and this call.
   */
  private planRetry(
    record: LedgerRecord,
    tickets: readonly LedgerTicket[],
  ): { nextRetryAt: string; retryCount: number } | null {
    if (!levelAtLeast(record.level, "alert")) return null;
    if (stateFromTickets(tickets) !== "failed") return null;
    if (!tickets.some((ticket) => ticket.transportFailure)) return null;
    const firstSentMs = Date.parse(record.at);
    const nowMs = this.now();
    if (nowMs - firstSentMs >= RETRY_MAX_AGE_MS) return null;
    const attempt = record.retryCount ?? 0;
    const delay = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]!;
    const nextRetryAt = new Date(
      Math.min(nowMs + delay, firstSentMs + RETRY_MAX_AGE_MS),
    ).toISOString();
    return { nextRetryAt, retryCount: attempt + 1 };
  }

  /**
   * Retries what is due, and gives up (no push, no agent) on anything past `RETRY_MAX_AGE_MS`.
   * Each due record is an independent push to the ledger, so the sends run concurrently instead
   * of a stalled one blocking the rest behind it.
   */
  private async runDueRetries(): Promise<void> {
    const nowMs = this.now();
    const due: LedgerRecord[] = [];
    for (const record of this.options.ledger.listPendingRetries()) {
      if (Date.parse(record.nextRetryAt!) > nowMs) continue;
      if (nowMs - Date.parse(record.at) >= RETRY_MAX_AGE_MS) {
        this.logger.warn(
          { id: record.id, level: record.level, retryCount: record.retryCount ?? 0 },
          "Push retries exhausted; giving up",
        );
        this.options.ledger.markFailed(
          record.id,
          record.error ?? "push retries exhausted",
          new Date(nowMs).toISOString(),
        );
        continue;
      }
      due.push(record);
    }
    await Promise.all(due.map((record) => this.dispatch(record, redeliveryFor(record))));
  }

  private async recoverUnsent(): Promise<void> {
    for (const record of this.options.ledger.listUnsent()) {
      if (this.now() - Date.parse(record.at) > UNSENT_RESEND_MAX_AGE_MS) {
        this.options.ledger.markFailed(
          record.id,
          "not sent: the daemon restarted first",
          new Date(this.now()).toISOString(),
        );
        continue;
      }
      await this.dispatch(record, redeliveryFor(record));
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped) return;
    const settings = this.options.settings.get();
    const nowMs = this.now();
    const availability = resolveAvailability(settings, nowMs);
    const wakes: number[] = [];
    const oldest = this.options.ledger.listHeldNotices()[0];
    if (oldest) wakes.push(Date.parse(oldest.at) + digestWindowMs(settings, availability));
    if (availability.until) wakes.push(Date.parse(availability.until));
    for (const record of this.options.ledger.listPendingRetries()) {
      wakes.push(Date.parse(record.nextRetryAt!));
    }
    if (wakes.length === 0) return;
    const delay = Math.min(Math.max(Math.min(...wakes) - nowMs, 1000), MAX_TIMER_MS);
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref?.();
  }

  private buildRecord(
    payload: PushPayload,
    meta: { level: NotifyLevel; declared: boolean; reason: string | null },
  ): LedgerRecord {
    const data = payload.data ?? {};
    return {
      id: randomUUID(),
      at: new Date(this.now()).toISOString(),
      level: meta.level,
      levelDeclared: meta.declared,
      reason: meta.reason,
      title: payload.title,
      body: payload.body,
      agentId: typeof data.agentId === "string" && data.agentId ? data.agentId : null,
      outcome: "log",
      state: "recorded",
      repeatCount: 0,
      digestId: null,
      memberIds: [],
      error: null,
      settledAt: null,
      serverId: typeof data.serverId === "string" ? data.serverId : null,
      workspaceId: typeof data.workspaceId === "string" ? data.workspaceId : null,
      data,
      dedupeKey: null,
      tickets: [],
    };
  }

  private warnUndeclared(label: string): void {
    if (this.warnedUndeclared.has(label)) return;
    this.warnedUndeclared.add(label);
    this.logger.warn(
      { label },
      "Push sent without a notify level; treating it as a notice. Declare one at the call site.",
    );
  }
}

function decisionFlags(decision: DeliveryDecision): Pick<PushDelivery, "timeSensitive"> {
  return decision.timeSensitive ? { timeSensitive: true } : {};
}

/**
 * Replays the delivery flags a stored record was originally sent with, for a retry or a
 * restart-recovered send that never goes through `decideDelivery` again. `timeSensitive` matches
 * `decideDelivery`: only an interrupt at the urgent level asks iOS to break through Focus.
 */
function redeliveryFor(record: LedgerRecord): PushDelivery {
  return {
    quiet: record.outcome === "notify",
    ...(record.outcome === "interrupt" && record.level === "urgent" ? { timeSensitive: true } : {}),
  };
}

function toTicket(result: PushDeliveryResult): LedgerTicket {
  let status: LedgerTicket["status"] = "ok";
  if (result.error) status = "error";
  else if (result.ticketId) status = "pending";
  return {
    token: result.token,
    ticketId: result.ticketId,
    status,
    error: result.error,
    checkedAt: null,
    transportFailure: result.transportFailure,
  };
}

/** R8: a push delivered on a retry says so, with when it was first attempted. */
function lateBody(record: LedgerRecord): string {
  return `${record.body}\n\n(sent late — first attempted ${record.at})`;
}

/** "5 notices" and up to four grouped lines, so the tray shows what piled up without opening. */
function summarizeDigest(held: LedgerRecord[]): { title: string; body: string } {
  const groups = new Map<string, number>();
  for (const record of held) {
    groups.set(record.title, (groups.get(record.title) ?? 0) + 1 + record.repeatCount);
  }
  const lines = [...groups].map(([title, count]) => (count > 1 ? `${title} (x${count})` : title));
  const shown = lines.slice(0, MAX_DIGEST_LINES);
  const rest = lines.length - shown.length;
  return {
    title: `${held.length} notices from Paseo`,
    body: [...shown, ...(rest > 0 ? [`and ${rest} more`] : [])].join("\n"),
  };
}
