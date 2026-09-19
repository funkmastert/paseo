import type pino from "pino";

import { PushService, type PushPayload } from "./push-service.js";
import { PushTokenStore } from "./token-store.js";

export type { PushPayload };

const PUSH_TOKEN_LEASE_MS = 48 * 60 * 60 * 1000;

export interface PushNotifications {
  renew(token: string): void;
  revoke(token: string): void;
  send(payload: PushPayload): Promise<void>;
}

export type PushNotificationSender = Pick<PushNotifications, "send">;

export function createPushNotifications(options: {
  logger: pino.Logger;
  filePath: string;
  now?: () => number;
  deliver?: (tokens: string[], payload: PushPayload) => Promise<void>;
}): PushNotifications {
  const now = options.now ?? Date.now;
  const store = new PushTokenStore(options.logger, options.filePath, now, PUSH_TOKEN_LEASE_MS);
  const service = new PushService(options.logger, (token) => store.revokeToken(token));
  const deliver =
    options.deliver ??
    ((tokens: string[], payload: PushPayload) => service.sendPush(tokens, payload));

  return {
    renew(token) {
      store.renewToken(token);
    },
    revoke(token) {
      store.revokeToken(token);
    },
    async send(payload) {
      const tokens = store.getActiveTokens();
      // Log what went out, not just that something did. Every sender funnels through here, and
      // with only a token count on the line there is no way after the fact to tell which
      // subsystem produced a day's notifications — which is exactly the question asked when
      // someone says the notifications are noise.
      options.logger.info(
        {
          tokenCount: tokens.length,
          title: payload.title,
          reason: payload.data?.reason,
          agentId: payload.data?.agentId,
          workspaceId: payload.data?.workspaceId,
        },
        "Sending push notification",
      );
      if (tokens.length === 0) return;
      await deliver(tokens, payload);
    },
  };
}
