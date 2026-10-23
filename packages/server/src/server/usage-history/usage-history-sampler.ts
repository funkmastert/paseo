import type { ProviderUsage } from "@getpaseo/protocol/messages";
import type { TokenBurnMonitorAgentSummary } from "../agent/agent-manager.js";
import type {
  AccountWindowSampleInput,
  AgentSpendInput,
  UsageHistoryStore,
} from "./usage-history-store.js";

export interface UsageHistorySettings {
  /** On unless this is false. Recording is passive: nothing is pushed, said or acted on. */
  enabled?: boolean;
}

interface SamplerLogger {
  warn: (obj: object, msg?: string) => void;
}

export interface UsageHistorySamplerOptions {
  store: UsageHistoryStore;
  /**
   * The cached provider usage rows the Host Usage screen and the pacing monitor read. Never
   * force-refreshed: the five-minute cache is what keeps the usage API quiet, and each row carries
   * its own `fetchedAt`, which is what a reading is timestamped by.
   */
  readProviderUsage?: () => Promise<readonly ProviderUsage[] | null>;
  readSettings: () => UsageHistorySettings | undefined;
  logger: SamplerLogger;
}

const MINUTE_MS = 60_000;

/**
 * The reset time to the minute. Anthropic's `resets_at` carries sub-second noise that changes on
 * every fetch (docs/token-burn.md, "Account pressure"); rounding keeps one cycle one value.
 */
function roundedResetMs(resetsAt: string | null | undefined): number | null {
  if (!resetsAt) return null;
  const ms = Date.parse(resetsAt);
  return Number.isFinite(ms) ? Math.round(ms / MINUTE_MS) * MINUTE_MS : null;
}

export function accountSamplesFromUsage(
  providers: readonly ProviderUsage[],
): AccountWindowSampleInput[] {
  const samples: AccountWindowSampleInput[] = [];
  for (const provider of providers) {
    // A row that is not `available` carries no readings, and one without `fetchedAt` cannot be
    // placed in time: stamping it with the sweep's clock would turn one cached snapshot into a
    // fresh reading every minute and invent movement between identical numbers.
    if (provider.status !== "available" || !provider.fetchedAt) continue;
    const atMs = Date.parse(provider.fetchedAt);
    if (!Number.isFinite(atMs)) continue;
    for (const window of provider.windows) {
      const usedPct = window.usedPct;
      if (typeof usedPct !== "number" || !Number.isFinite(usedPct)) continue;
      samples.push({
        providerId: provider.providerId,
        windowId: window.id,
        label: window.label,
        atMs,
        usedPct,
        resetsAtMs: roundedResetMs(window.resetsAt),
      });
    }
  }
  return samples;
}

/**
 * The one sampler hunk AgentTokenBurnMonitor calls once per sweep. It rides the monitor's existing
 * 60-second loop and the usage service's existing cache, so it adds no poller and no provider
 * request of its own. A failure here is logged and swallowed: history is disposable, and a sweep
 * that also runs the spend governor must not be lost to a full disk.
 */
export class UsageHistorySampler {
  private readonly store: UsageHistoryStore;
  private readonly readProviderUsage: UsageHistorySamplerOptions["readProviderUsage"];
  private readonly readSettings: UsageHistorySamplerOptions["readSettings"];
  private readonly logger: SamplerLogger;

  constructor(options: UsageHistorySamplerOptions) {
    this.store = options.store;
    this.readProviderUsage = options.readProviderUsage;
    this.readSettings = options.readSettings;
    this.logger = options.logger;
  }

  async sample(input: {
    nowMs: number;
    agents: readonly TokenBurnMonitorAgentSummary[];
  }): Promise<void> {
    if (this.readSettings()?.enabled === false) return;
    try {
      const usage = this.readProviderUsage ? await this.readProviderUsage() : null;
      const agents: AgentSpendInput[] = input.agents
        .filter((agent) => !agent.internal)
        .map((agent) => ({ agentId: agent.id, totalTokens: agent.totalTokens ?? 0 }));
      await this.store.record({
        nowMs: input.nowMs,
        accounts: usage ? accountSamplesFromUsage(usage) : [],
        agents,
      });
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to record usage history");
    }
  }
}
