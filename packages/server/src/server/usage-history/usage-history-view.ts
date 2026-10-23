import type { UsageHistoryAccount } from "@getpaseo/protocol/usage-history/rpc-schemas";
import type { AccountWindowSeries } from "./usage-history-store.js";
import { projectWindow, type ProjectionConfig, type WindowProjection } from "./usage-projection.js";

function toWireProjection(
  projection: WindowProjection,
): UsageHistoryAccount["windows"][number]["projection"] {
  switch (projection.status) {
    case "unknown":
      return {
        status: "unknown",
        reason: projection.reason,
        samples: projection.samples,
        spanMinutes: projection.spanMinutes,
      };
    case "capped":
      return { status: "capped", samples: projection.samples, spanMinutes: projection.spanMinutes };
    case "projected":
      return {
        status: "projected",
        samples: projection.samples,
        spanMinutes: projection.spanMinutes,
        ratePctPerHour: projection.ratePctPerHour,
        projectedPctAtReset: projection.projectedPctAtReset,
        confidence: projection.confidence,
        ...(projection.capsAtMs !== null && projection.minutesToCap !== null
          ? {
              capsAt: new Date(projection.capsAtMs).toISOString(),
              minutesToCap: projection.minutesToCap,
            }
          : {}),
      };
  }
}

/**
 * Groups the stored window series by account and attaches each window's projection. A window whose
 * newest reading is a full reset cycle old is still listed: the projection says `reset_passed` or
 * `stale`, which is a more useful answer than the window vanishing.
 */
export function buildAccountUsageView(input: {
  series: readonly AccountWindowSeries[];
  nowMs: number;
  config?: Partial<ProjectionConfig>;
}): UsageHistoryAccount[] {
  const accounts = new Map<string, UsageHistoryAccount>();
  for (const series of input.series) {
    const newest = series.samples[series.samples.length - 1];
    if (!newest) continue;
    let account = accounts.get(series.providerId);
    if (!account) {
      account = { providerId: series.providerId, windows: [] };
      accounts.set(series.providerId, account);
    }
    account.windows.push({
      windowId: series.windowId,
      label: series.label,
      usedPct: newest.usedPct,
      resetsAt: newest.resetsAtMs === null ? null : new Date(newest.resetsAtMs).toISOString(),
      sampledAt: new Date(newest.atMs).toISOString(),
      projection: toWireProjection(
        projectWindow({
          windowId: series.windowId,
          samples: series.samples,
          nowMs: input.nowMs,
          config: input.config,
        }),
      ),
    });
  }
  return [...accounts.values()];
}
