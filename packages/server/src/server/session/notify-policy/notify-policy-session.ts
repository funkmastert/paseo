import type pino from "pino";
import type { NotifyPolicySettings } from "@getpaseo/protocol/notify-policy/types";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { NotifyPolicy } from "../../notify-policy/notify-policy.js";

export interface NotifyPolicySessionOptions {
  host: { emit(msg: SessionOutboundMessage): void };
  /** A getter because the policy belongs to the push service, which the session only borrows. */
  getNotifyPolicy: () => NotifyPolicy;
  logger: pino.Logger;
}

type PolicyRequest = Extract<
  SessionInboundMessage,
  { type: "notifications.policy.get.request" | "notifications.policy.set.request" }
>;
type LedgerRequest = Extract<SessionInboundMessage, { type: "notifications.ledger.list.request" }>;

const DEFAULT_LEDGER_LIMIT = 100;

/**
 * A client's window onto the notify policy: read and change the two dials and the availability
 * mode, and read the delivery ledger. Owns the `notifications.*` RPCs.
 */
export class NotifyPolicySession {
  constructor(private readonly options: NotifyPolicySessionOptions) {}

  async handlePolicyRequest(msg: PolicyRequest): Promise<void> {
    const { host } = this.options;
    try {
      const notifyPolicy = this.options.getNotifyPolicy();
      const status =
        msg.type === "notifications.policy.set.request"
          ? await notifyPolicy.updateSettings(readPatch(msg))
          : notifyPolicy.getStatus();
      const payload = {
        requestId: msg.requestId,
        settings: status.settings,
        effectiveAvailability: status.effectiveAvailability,
        heldCount: status.heldCount,
        unreachedCount: status.unreachedCount,
      };
      host.emit(
        msg.type === "notifications.policy.set.request"
          ? { type: "notifications.policy.set.response", payload }
          : { type: "notifications.policy.get.response", payload },
      );
    } catch (error) {
      this.emitError(msg, error);
    }
  }

  handleLedgerListRequest(msg: LedgerRequest): void {
    const { host } = this.options;
    try {
      const notifyPolicy = this.options.getNotifyPolicy();
      host.emit({
        type: "notifications.ledger.list.response",
        payload: {
          requestId: msg.requestId,
          entries: notifyPolicy.listLedger({
            limit: msg.limit ?? DEFAULT_LEDGER_LIMIT,
            ...(msg.unreachedOnly ? { unreachedOnly: true } : {}),
          }),
          unreachedCount: notifyPolicy.getStatus().unreachedCount,
        },
      });
    } catch (error) {
      this.emitError(msg, error);
    }
  }

  private emitError(msg: { type: string; requestId: string }, error: unknown): void {
    this.options.logger.error(
      { err: error, requestType: msg.type },
      "Notify policy request failed",
    );
    this.options.host.emit({
      type: "rpc_error",
      payload: {
        requestId: msg.requestId,
        requestType: msg.type,
        error: error instanceof Error ? error.message : String(error),
        code: "handler_error",
      },
    });
  }
}

function readPatch(
  msg: Extract<SessionInboundMessage, { type: "notifications.policy.set.request" }>,
): Partial<NotifyPolicySettings> {
  return {
    ...(msg.minPostLevel ? { minPostLevel: msg.minPostLevel } : {}),
    ...(msg.minInterruptLevel ? { minInterruptLevel: msg.minInterruptLevel } : {}),
    ...(msg.digestIntervalMinutes ? { digestIntervalMinutes: msg.digestIntervalMinutes } : {}),
    ...(msg.availability ? { availability: msg.availability } : {}),
  };
}
