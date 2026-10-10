import path from "node:path";
import type pino from "pino";

import { NotifyPolicy } from "../notify-policy/notify-policy.js";
import type { PushSendMeta } from "../notify-policy/levels.js";
import { NotifyPolicySettingsStore } from "../notify-policy/settings.js";
import { PushLedger } from "./ledger.js";
import {
  PushService,
  type PushDelivery,
  type PushDeliveryResult,
  type PushPayload,
} from "./push-service.js";
import { ReceiptTracker } from "./receipts.js";
import { PushTokenStore } from "./token-store.js";

export type { PushPayload };
export type { PushSendMeta };

const PUSH_TOKEN_LEASE_MS = 48 * 60 * 60 * 1000;

export interface PushNotifications {
  renew(token: string): void;
  revoke(token: string): void;
  /**
   * Hands a notification to the notify policy. Every caller declares `meta.level`; an undeclared
   * one is treated as a notice. Resolves once the policy has decided, and once the push is
   * handed to the provider when it goes out immediately.
   */
  send(payload: PushPayload, meta?: PushSendMeta): Promise<void>;
  readonly policy: NotifyPolicy;
  /** Finishes interrupted sends, arms the digest timer, and starts reading receipts. */
  start(): Promise<void>;
  stop(): void;
}

export type PushNotificationSender = Pick<PushNotifications, "send">;

export function createPushNotifications(options: {
  logger: pino.Logger;
  filePath: string;
  now?: () => number;
  deliver?: (
    tokens: string[],
    payload: PushPayload,
    delivery: PushDelivery,
  ) => Promise<PushDeliveryResult[] | void>;
}): PushNotifications {
  const now = options.now ?? Date.now;
  const directory = path.dirname(options.filePath);
  const store = new PushTokenStore(options.logger, options.filePath, now, PUSH_TOKEN_LEASE_MS);
  const service = new PushService(options.logger, (token) => store.revokeToken(token));
  const ledger = new PushLedger(options.logger, path.join(directory, "push-ledger.json"), now);
  const settings = new NotifyPolicySettingsStore(
    options.logger,
    path.join(directory, "notify-policy.json"),
  );
  const policy = new NotifyPolicy({
    logger: options.logger,
    ledger,
    settings,
    now,
    transport: {
      activeTokens: () => store.getActiveTokens(),
      deliver: async (tokens, payload, delivery) => {
        if (!options.deliver) return service.sendPush(tokens, payload, delivery);
        const results = await options.deliver(tokens, payload, delivery);
        return Array.isArray(results)
          ? results
          : tokens.map((token) => ({ token, ticketId: null, error: null }));
      },
    },
  });
  const receipts = new ReceiptTracker({
    logger: options.logger,
    ledger,
    now,
    fetchReceipts: (tickets) => service.fetchReceipts(tickets),
  });

  return {
    policy,
    renew(token) {
      store.renewToken(token);
    },
    revoke(token) {
      store.revokeToken(token);
    },
    send(payload, meta) {
      return policy.submit(payload, meta);
    },
    async start() {
      await policy.start();
      // A test transport has no provider to ask for receipts.
      if (!options.deliver) receipts.start();
    },
    stop() {
      policy.stop();
      receipts.stop();
    },
  };
}
