import { createIntervalPoller } from "./interval-poller";
import { readMcpGatewaySnapshot, type McpGatewaySnapshot } from "./mcp-scope";
import type { PaseoConfigApi } from "./role-policy";

export interface McpGatewayCache {
  /** The last snapshot read, or undefined before any read succeeded, which the classifier treats as "scope nothing". */
  get(): McpGatewaySnapshot | undefined;
  forceRefresh(): Promise<McpGatewaySnapshot | undefined>;
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * The daemon's `mcpGateway` servers, re-read on the pool cache's interval.
 * A failed read keeps the last good snapshot. Editing `mcpGateway` needs a
 * daemon restart anyway (docs/mcp-gateway.md), so a minute of staleness
 * never disagrees with what the daemon actually brokers.
 */
export function createMcpGatewayCache(
  paseo: PaseoConfigApi,
  options: { intervalMs?: number; setIntervalFn?: typeof setInterval; clearIntervalFn?: typeof clearInterval } = {},
): McpGatewayCache {
  let current: McpGatewaySnapshot | undefined;
  const poller = createIntervalPoller({
    intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    run: async () => {
      try {
        const { config } = await paseo.config.get();
        current = readMcpGatewaySnapshot(config as Record<string, unknown>);
      } catch {
        // Keep the last good snapshot.
      }
      return current;
    },
  });
  return {
    get: () => current,
    forceRefresh: () => poller.runOnce(),
    stop: () => poller.stop(),
  };
}
