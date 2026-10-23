import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { UsageHistoryStore } from "../../usage-history/usage-history-store.js";
import { buildAccountUsageView } from "../../usage-history/usage-history-view.js";

/**
 * Enough for a sparkline a few hundred pixels wide, and small enough that the response stays a
 * few kilobytes however long the agent has lived.
 */
const AGENT_SPARKLINE_POINTS = 96;

interface UsageHistorySessionLogger {
  error: (obj: object, msg?: string) => void;
}

export interface UsageHistorySessionOptions {
  host: { emit: (message: SessionOutboundMessage) => void };
  store: UsageHistoryStore;
  logger: UsageHistorySessionLogger;
  now?: () => number;
}

/**
 * Serves `usage.history.get`: every account window's projection, and, when the request names an
 * agent, that agent's weighted spend over its life. Read-only; the recorder is the only writer.
 */
export class UsageHistorySession {
  private readonly host: UsageHistorySessionOptions["host"];
  private readonly store: UsageHistoryStore;
  private readonly logger: UsageHistorySessionLogger;
  private readonly now: () => number;

  constructor(options: UsageHistorySessionOptions) {
    this.host = options.host;
    this.store = options.store;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  async handleGetRequest(
    msg: Extract<SessionInboundMessage, { type: "usage.history.get.request" }>,
  ): Promise<void> {
    try {
      const nowMs = this.now();
      const [series, spend] = await Promise.all([
        this.store.readAccountSeries(),
        msg.agentId ? this.store.readAgentSpend(msg.agentId, AGENT_SPARKLINE_POINTS) : null,
      ]);
      this.host.emit({
        type: "usage.history.get.response",
        payload: {
          requestId: msg.requestId,
          generatedAt: new Date(nowMs).toISOString(),
          accounts: buildAccountUsageView({ series, nowMs }),
          ...(spend
            ? {
                agent: {
                  agentId: spend.agentId,
                  totalWeightedTokens: spend.totalWeightedTokens,
                  points: spend.points.map((point) => ({
                    at: new Date(point.atMs).toISOString(),
                    weightedTokens: point.weightedTokens,
                  })),
                },
              }
            : {}),
        },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err }, "Failed to read usage history");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to read usage history: ${err.message}`,
          code: "usage_history_get_failed",
        },
      });
    }
  }
}

/** Null when the host did not give the session a store (only a test does), so callers stay flat. */
export function createUsageHistorySession(
  options: Omit<UsageHistorySessionOptions, "store"> & { store: UsageHistoryStore | undefined },
): UsageHistorySession | null {
  const { store, ...rest } = options;
  return store ? new UsageHistorySession({ ...rest, store }) : null;
}
