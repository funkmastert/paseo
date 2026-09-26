import type pino from "pino";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * How loudly one push should land. Loud (`interrupt`) plays a sound and shows normally; quiet
 * (`notify`) posts to the tray without one. `timeSensitive` asks iOS to break through Focus.
 */
export interface PushDelivery {
  quiet: boolean;
  timeSensitive?: boolean;
}

/** What the provider said about one device. `error` is null when the message was accepted. */
export interface PushDeliveryResult {
  token: string;
  ticketId: string | null;
  error: string | null;
}

/** A receipt the provider filed for an accepted message. */
export interface PushReceiptVerdict {
  status: "ok" | "error";
  error: string | null;
}

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  priority?: "default" | "normal" | "high";
  interruptionLevel?: "active" | "passive" | "time-sensitive";
  channelId?: string;
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

interface ExpoPushReceipt {
  status: "ok" | "error";
  message?: string;
  details?: { error?: string };
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const MAX_BATCH_SIZE = 100;
const MAX_RECEIPT_IDS = 1000;
/** The Android channel the app creates for quiet pushes (push-notifications/internal/subscriptions.ts). */
const QUIET_CHANNEL_ID = "quiet";
const REVOKING_ERRORS = new Set(["DeviceNotRegistered", "InvalidCredentials"]);

function buildMessage(
  token: string,
  payload: PushPayload,
  delivery: PushDelivery,
): ExpoPushMessage {
  const base = { to: token, title: payload.title, body: payload.body, data: payload.data };
  if (delivery.quiet) {
    return {
      ...base,
      sound: null,
      priority: "normal",
      interruptionLevel: "passive",
      channelId: QUIET_CHANNEL_ID,
    };
  }
  return {
    ...base,
    sound: "default",
    priority: "high",
    interruptionLevel: delivery.timeSensitive ? "time-sensitive" : "active",
  };
}

/**
 * Service for sending Expo push notifications.
 * Handles batching, invalid token removal, and reading back what the provider decided.
 */
export class PushService {
  private readonly logger: pino.Logger;
  private readonly revokeToken: (token: string) => void;

  constructor(logger: pino.Logger, revokeToken: (token: string) => void) {
    this.logger = logger.child({ component: "push-service" });
    this.revokeToken = revokeToken;
  }

  async sendPush(
    tokens: string[],
    payload: PushPayload,
    delivery: PushDelivery = { quiet: false },
  ): Promise<PushDeliveryResult[]> {
    if (tokens.length === 0) {
      return [];
    }

    const messages = tokens.map((token) => buildMessage(token, payload, delivery));

    // Batch tokens (max 100 per request per Expo limits)
    const batches: ExpoPushMessage[][] = [];
    for (let i = 0; i < messages.length; i += MAX_BATCH_SIZE) {
      batches.push(messages.slice(i, i + MAX_BATCH_SIZE));
    }

    const results = await Promise.all(batches.map((batch) => this.sendBatch(batch)));
    return results.flat();
  }

  private async sendBatch(messages: ExpoPushMessage[]): Promise<PushDeliveryResult[]> {
    const failAll = (error: string): PushDeliveryResult[] =>
      messages.map((message) => ({ token: message.to, ticketId: null, error }));
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(messages),
      });

      if (!response.ok) {
        this.logger.error(
          { status: response.status, statusText: response.statusText },
          "Expo push API error",
        );
        return failAll(`Expo push API returned ${response.status}`);
      }

      const result = (await response.json()) as { data: ExpoPushTicket[] };
      return this.handleTickets(messages, result.data);
    } catch (error) {
      this.logger.error({ err: error }, "Failed to send push notifications");
      return failAll(error instanceof Error ? error.message : String(error));
    }
  }

  private handleTickets(
    messages: ExpoPushMessage[],
    tickets: ExpoPushTicket[],
  ): PushDeliveryResult[] {
    return messages.map((message, i) => {
      const ticket = tickets[i];
      if (!ticket) {
        return { token: message.to, ticketId: null, error: "Expo returned no ticket" };
      }
      if (ticket.status !== "error") {
        return { token: message.to, ticketId: ticket.id ?? null, error: null };
      }
      this.logger.error(
        { token: message.to, message: ticket.message, details: ticket.details },
        "Push failed for token",
      );
      this.revokeIfDead(message.to, ticket.details?.error);
      return {
        token: message.to,
        ticketId: null,
        error: ticket.details?.error ?? ticket.message ?? "Expo rejected the message",
      };
    });
  }

  /**
   * Reads the provider's receipts for accepted messages. An id missing from the answer has no
   * receipt yet, so it is missing from the returned map too. A dead device revokes its token.
   */
  async fetchReceipts(
    tickets: ReadonlyArray<{ ticketId: string; token: string }>,
  ): Promise<Map<string, PushReceiptVerdict>> {
    const verdicts = new Map<string, PushReceiptVerdict>();
    for (let i = 0; i < tickets.length; i += MAX_RECEIPT_IDS) {
      const chunk = tickets.slice(i, i + MAX_RECEIPT_IDS);
      const response = await fetch(EXPO_RECEIPTS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ ids: chunk.map((ticket) => ticket.ticketId) }),
      });
      if (!response.ok) {
        throw new Error(`Expo receipts API returned ${response.status}`);
      }
      const result = (await response.json()) as { data?: Record<string, ExpoPushReceipt> };
      for (const ticket of chunk) {
        const receipt = result.data?.[ticket.ticketId];
        if (!receipt) continue;
        if (receipt.status === "ok") {
          verdicts.set(ticket.ticketId, { status: "ok", error: null });
          continue;
        }
        const error = receipt.details?.error ?? receipt.message ?? "Expo receipt reported an error";
        verdicts.set(ticket.ticketId, { status: "error", error });
        this.revokeIfDead(ticket.token, receipt.details?.error);
      }
    }
    return verdicts;
  }

  private revokeIfDead(token: string, error: string | undefined): void {
    if (error && REVOKING_ERRORS.has(error)) {
      this.revokeToken(token);
    }
  }
}
