import type pino from "pino";
import { existsSync, readFileSync } from "node:fs";
import type {
  NotifyDeliveryState,
  NotifyLedgerEntry,
} from "@getpaseo/protocol/notify-policy/types";

import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

/**
 * One push ticket the provider returned for one device. `pending` means the provider accepted the
 * message and its receipt has not been read yet; `ok` and `error` are the receipt's verdict (or
 * the ticket's, when the provider refused the message outright).
 */
export interface LedgerTicket {
  token: string;
  ticketId: string | null;
  status: "pending" | "ok" | "error";
  error: string | null;
  checkedAt: string | null;
}

/** The wire entry plus what the daemon needs to finish delivering and de-duplicating it. */
export interface LedgerRecord extends NotifyLedgerEntry {
  serverId: string | null;
  workspaceId: string | null;
  /** The payload `data`, kept so a digest or a resend can rebuild the push. */
  data: Record<string, unknown>;
  dedupeKey: string | null;
  tickets: LedgerTicket[];
}

const MAX_RECORDS = 1000;
const SETTLED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const UNREACHED_STATES: ReadonlySet<NotifyDeliveryState> = new Set(["failed", "no-device"]);

export function toWireEntry(record: LedgerRecord): NotifyLedgerEntry {
  const {
    serverId: _serverId,
    workspaceId: _workspaceId,
    data: _data,
    dedupeKey: _dedupeKey,
    tickets: _tickets,
    ...entry
  } = record;
  return entry;
}

/**
 * The delivery state a notification's tickets add up to. A message that reached any device counts
 * as delivered, so one dead phone does not mark a notification unreached while another got it.
 */
export function stateFromTickets(tickets: readonly LedgerTicket[]): NotifyDeliveryState {
  if (tickets.length === 0) return "no-device";
  if (tickets.some((ticket) => ticket.status === "ok")) return "delivered";
  if (tickets.some((ticket) => ticket.status === "pending")) return "sent";
  return "failed";
}

/**
 * The notification history: what the policy decided for each push, and whether it landed.
 *
 * It exists so "was Tyler told?" is one read. Every mutation is one method and one atomic file
 * write, so a digest cannot be half rolled up after a crash. A notification that was never sent is
 * `held`; recovery on startup finishes it (see NotifyPolicy.start).
 */
export class PushLedger {
  private records: LedgerRecord[] = [];
  private readonly logger: pino.Logger;

  constructor(
    logger: pino.Logger,
    private readonly filePath: string,
    private readonly now: () => number,
    private readonly write: typeof writePrivateFileAtomicSync = writePrivateFileAtomicSync,
  ) {
    this.logger = logger.child({ component: "push-ledger" });
    this.load();
  }

  append(record: LedgerRecord): void {
    this.commit([...this.records, record]);
  }

  get(id: string): LedgerRecord | null {
    return this.records.find((record) => record.id === id) ?? null;
  }

  /** The newest notification carrying this key, or null. Suppressed repeats never become records. */
  findLatestByDedupeKey(key: string): LedgerRecord | null {
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      const record = this.records[i];
      if (record && record.dedupeKey === key) return record;
    }
    return null;
  }

  /** Counts a repeat against the notification it duplicated. */
  foldRepeat(id: string): void {
    this.update(id, (record) => ({ ...record, repeatCount: record.repeatCount + 1 }));
  }

  /** Notices waiting for a digest, oldest first. */
  listHeldNotices(): LedgerRecord[] {
    return this.records.filter((record) => record.outcome === "digest" && record.state === "held");
  }

  /** Pushes the policy decided to send that never went out. Startup finishes or retires them. */
  listUnsent(): LedgerRecord[] {
    return this.records.filter(
      (record) =>
        (record.outcome === "interrupt" || record.outcome === "notify") && record.state === "held",
    );
  }

  /**
   * Rolls held notices into one digest push, atomically: the members leave the buffer and the
   * digest appears as an unsent push in the same write. A crash after this write resends the
   * digest; a crash before it leaves the notices held. Neither sends a notice twice.
   */
  rollIntoDigest(memberIds: readonly string[], digest: LedgerRecord): void {
    const members = new Set(memberIds);
    this.commit([
      ...this.records.map((record) =>
        members.has(record.id)
          ? { ...record, state: "digested" as const, digestId: digest.id }
          : record,
      ),
      digest,
    ]);
  }

  markSent(id: string, tickets: LedgerTicket[], error: string | null, settledAt: string): void {
    this.update(id, (record) => {
      const state = stateFromTickets(tickets);
      return {
        ...record,
        tickets,
        state,
        error: error ?? firstTicketError(tickets),
        settledAt: state === "sent" ? null : settledAt,
      };
    });
  }

  markFailed(id: string, error: string, settledAt: string): void {
    this.update(id, (record) => ({ ...record, state: "failed", error, settledAt }));
  }

  /** Applies receipt verdicts (keyed by ticket id) and re-derives each affected notification. */
  applyReceipts(
    verdicts: ReadonlyMap<string, { status: "ok" | "error"; error: string | null }>,
    checkedAt: string,
  ): LedgerRecord[] {
    const changed: LedgerRecord[] = [];
    const next = this.records.map((record) => {
      if (!record.tickets.some((t) => t.ticketId && verdicts.has(t.ticketId))) return record;
      const tickets = record.tickets.map((ticket) => {
        const verdict = ticket.ticketId ? verdicts.get(ticket.ticketId) : undefined;
        if (!verdict || ticket.status !== "pending") return ticket;
        return { ...ticket, status: verdict.status, error: verdict.error, checkedAt };
      });
      const state = stateFromTickets(tickets);
      const updated: LedgerRecord = {
        ...record,
        tickets,
        state,
        error: firstTicketError(tickets),
        settledAt: state === "sent" ? null : checkedAt,
      };
      changed.push(updated);
      return updated;
    });
    if (changed.length > 0) this.commit(next);
    return changed;
  }

  /** Tickets still waiting on a receipt. */
  listPendingTickets(): Array<{ recordId: string; sentAt: string; ticket: LedgerTicket }> {
    const pending: Array<{ recordId: string; sentAt: string; ticket: LedgerTicket }> = [];
    for (const record of this.records) {
      for (const ticket of record.tickets) {
        if (ticket.status === "pending" && ticket.ticketId) {
          pending.push({ recordId: record.id, sentAt: record.at, ticket });
        }
      }
    }
    return pending;
  }

  /** Most recent first. */
  list(options: { limit?: number; unreachedOnly?: boolean } = {}): LedgerRecord[] {
    const source = options.unreachedOnly ? this.listUnreached() : this.records;
    const newestFirst = source.toReversed();
    return options.limit ? newestFirst.slice(0, options.limit) : newestFirst;
  }

  /**
   * Notifications meant for the phone that never landed: refused by the provider, or nobody was
   * registered to receive them. A notice inside a digest is unreached when its digest was.
   */
  listUnreached(): LedgerRecord[] {
    const byId = new Map(this.records.map((record) => [record.id, record]));
    return this.records.filter((record) => {
      if (record.outcome === "log" || record.outcome === "suppressed") return false;
      if (record.state === "digested") {
        const digest = record.digestId ? byId.get(record.digestId) : undefined;
        return digest !== undefined && UNREACHED_STATES.has(digest.state);
      }
      return UNREACHED_STATES.has(record.state);
    });
  }

  countUnreached(): number {
    return this.listUnreached().length;
  }

  private update(id: string, change: (record: LedgerRecord) => LedgerRecord): void {
    let touched = false;
    const next = this.records.map((record) => {
      if (record.id !== id) return record;
      touched = true;
      return change(record);
    });
    if (touched) this.commit(next);
  }

  private commit(next: LedgerRecord[]): void {
    const pruned = this.prune(next);
    try {
      this.write(this.filePath, JSON.stringify({ records: pruned }) + "\n");
    } catch (error) {
      // A ledger that cannot be written must not stop a push. Keep the change in memory.
      this.logger.warn({ err: error }, "Failed to persist push ledger");
    }
    this.records = pruned;
  }

  private prune(records: LedgerRecord[]): LedgerRecord[] {
    const cutoff = this.now() - SETTLED_RETENTION_MS;
    const live = records.filter(
      (record) =>
        record.state === "held" || record.state === "sent" || Date.parse(record.at) >= cutoff,
    );
    if (live.length <= MAX_RECORDS) return live;
    // Drop the oldest settled records first; waiting ones are the point of the ledger.
    const overflow = live.length - MAX_RECORDS;
    let dropped = 0;
    return live.filter((record) => {
      if (dropped >= overflow || record.state === "held" || record.state === "sent") return true;
      dropped += 1;
      return false;
    });
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      ensurePrivateFile(this.filePath);
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as { records?: unknown };
      if (!Array.isArray(parsed.records)) return;
      this.records = parsed.records.filter(isLedgerRecord);
      this.logger.info({ total: this.records.length }, "Loaded push ledger");
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to load push ledger");
    }
  }
}

function firstTicketError(tickets: readonly LedgerTicket[]): string | null {
  if (tickets.some((ticket) => ticket.status === "ok")) return null;
  return tickets.find((ticket) => ticket.error)?.error ?? null;
}

function isLedgerRecord(value: unknown): value is LedgerRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LedgerRecord>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.at === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.state === "string" &&
    typeof candidate.outcome === "string" &&
    Array.isArray(candidate.tickets)
  );
}
