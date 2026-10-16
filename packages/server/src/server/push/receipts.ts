import type pino from "pino";

import type { PushLedger } from "./ledger.js";
import type { PushReceiptVerdict } from "./push-service.js";

/** Expo asks for at least 15 minutes between sending and asking for the receipt. */
const RECEIPT_MIN_AGE_MS = 15 * 60 * 1000;
/** Expo drops receipts after 24 hours. Past that a ticket stays `sent`: unconfirmed, not failed. */
const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const RECEIPT_POLL_INTERVAL_MS = 5 * 60 * 1000;

export interface ReceiptTrackerOptions {
  logger: pino.Logger;
  ledger: PushLedger;
  fetchReceipts: (
    tickets: ReadonlyArray<{ ticketId: string; token: string }>,
  ) => Promise<Map<string, PushReceiptVerdict>>;
  now?: () => number;
}

/**
 * Turns "the provider accepted it" into "the provider says it delivered it". A push the provider
 * accepted can still fail at APNs or FCM, and only the receipt says so. Without this, a phone
 * that stopped receiving pushes looks identical to a quiet day.
 */
export class ReceiptTracker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly logger: pino.Logger;
  private readonly now: () => number;

  constructor(private readonly options: ReceiptTrackerOptions) {
    this.logger = options.logger.child({ component: "push-receipts" });
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.checkDue(), RECEIPT_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Reads receipts for every ticket old enough to have one and young enough to still exist. */
  async checkDue(): Promise<void> {
    const now = this.now();
    const due = this.options.ledger.listPendingTickets().filter(({ sentAt }) => {
      const age = now - Date.parse(sentAt);
      return age >= RECEIPT_MIN_AGE_MS && age <= RECEIPT_MAX_AGE_MS;
    });
    if (due.length === 0) return;
    try {
      const verdicts = await this.options.fetchReceipts(
        due.flatMap(({ ticket }) =>
          ticket.ticketId ? [{ ticketId: ticket.ticketId, token: ticket.token }] : [],
        ),
      );
      if (verdicts.size === 0) return;
      const changed = this.options.ledger.applyReceipts(verdicts, new Date(now).toISOString());
      for (const record of changed) {
        if (record.state === "failed") {
          this.logger.warn(
            { id: record.id, reason: record.reason, error: record.error },
            "Push receipt reported a failure",
          );
        }
      }
    } catch (error) {
      // Try again next poll; a receipt outage must not disturb anything else.
      this.logger.warn({ err: error }, "Failed to read push receipts");
    }
  }
}
