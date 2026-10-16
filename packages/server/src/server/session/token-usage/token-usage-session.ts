import type { TokenUsageRange } from "@getpaseo/protocol/token-usage/rpc-schemas";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import {
  tokenUsageRangeStartMs,
  type TokenUsageBreakdown,
} from "../../token-usage/token-usage-service.js";

interface TokenUsageSessionLogger {
  error: (obj: object, msg?: string) => void;
}

/** What the session needs from the token usage service: one read. */
export interface TokenUsageReader {
  getBreakdown: (range: TokenUsageRange) => Promise<TokenUsageBreakdown>;
}

export interface TokenUsageSessionOptions {
  host: { emit: (message: SessionOutboundMessage) => void };
  reader: TokenUsageReader;
  logger: TokenUsageSessionLogger;
  now?: () => number;
}

/**
 * Serves `usage.tokens.get_breakdown` (docs/token-usage.md): rows per provider, model and role
 * for the range, and the coverage the screen needs for its backfill and disabled states.
 * Read-only; the service's scan is the only writer.
 */
export class TokenUsageSession {
  private readonly host: TokenUsageSessionOptions["host"];
  private readonly reader: TokenUsageReader;
  private readonly logger: TokenUsageSessionLogger;
  private readonly now: () => number;

  constructor(options: TokenUsageSessionOptions) {
    this.host = options.host;
    this.reader = options.reader;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  async handleGetBreakdownRequest(
    msg: Extract<SessionInboundMessage, { type: "usage.tokens.get_breakdown.request" }>,
  ): Promise<void> {
    try {
      const breakdown = await this.reader.getBreakdown(msg.range);
      this.host.emit({
        type: "usage.tokens.get_breakdown.response",
        payload: { requestId: msg.requestId, ...breakdown },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err }, "Failed to read token usage");
      const nowMs = this.now();
      // The payload's own error field, so the screen can say why rather than spin.
      this.host.emit({
        type: "usage.tokens.get_breakdown.response",
        payload: {
          requestId: msg.requestId,
          generatedAt: new Date(nowMs).toISOString(),
          range: msg.range,
          rangeStartMs: tokenUsageRangeStartMs(msg.range, nowMs),
          rows: [],
          coverage: {
            enabled: true,
            recordingSinceMs: null,
            backfill: { state: "pending", filesDone: 0, filesTotal: 0 },
          },
          error: `Failed to read token usage: ${err.message}`,
        },
      });
    }
  }
}

/** Null when the host has no token usage service (only a test does), so callers stay flat. */
export function createTokenUsageSession(
  options: Omit<TokenUsageSessionOptions, "reader"> & { reader: TokenUsageReader | undefined },
): TokenUsageSession | null {
  const { reader, ...rest } = options;
  return reader ? new TokenUsageSession({ ...rest, reader }) : null;
}
