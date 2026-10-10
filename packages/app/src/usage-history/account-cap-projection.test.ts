import { describe, expect, it } from "vitest";
import type { UsageHistoryAccount } from "@getpaseo/protocol/usage-history/rpc-schemas";
import { earliestProjectedCap } from "./account-cap-projection";

function windowOf(
  windowId: string,
  projection: UsageHistoryAccount["windows"][number]["projection"],
): UsageHistoryAccount["windows"][number] {
  return {
    windowId,
    label: windowId,
    usedPct: 50,
    resetsAt: null,
    sampledAt: "2026-09-23T12:00:00.000Z",
    projection,
  };
}

const accounts: UsageHistoryAccount[] = [
  {
    providerId: "claude-personal",
    windows: [
      windowOf("five_hour", {
        status: "projected",
        samples: 12,
        spanMinutes: 55,
        ratePctPerHour: 20,
        projectedPctAtReset: 100,
        capsAt: "2026-09-23T14:00:00.000Z",
        minutesToCap: 120,
      }),
      windowOf("weekly", {
        status: "projected",
        samples: 40,
        spanMinutes: 360,
        ratePctPerHour: 2,
        projectedPctAtReset: 100,
        capsAt: "2026-09-23T13:00:00.000Z",
        minutesToCap: 60,
      }),
      windowOf("weekly_model_fable", {
        status: "unknown",
        reason: "insufficient_samples",
        samples: 1,
        spanMinutes: 0,
      }),
    ],
  },
  {
    providerId: "claude-work",
    windows: [
      windowOf("five_hour", {
        status: "projected",
        samples: 12,
        spanMinutes: 55,
        ratePctPerHour: 1,
        projectedPctAtReset: 20,
      }),
    ],
  },
];

describe("earliestProjectedCap", () => {
  it("takes the window that caps first, since that is what caps the account", () => {
    const cap = earliestProjectedCap(accounts, "claude-personal");
    expect(cap?.window.windowId).toBe("weekly");
    expect(cap?.minutesToCap).toBe(60);
  });

  it("matches the provider id case-insensitively", () => {
    expect(earliestProjectedCap(accounts, "Claude-Personal")?.minutesToCap).toBe(60);
  });

  it("is null for an account projected to reach its reset, an unknown one, or an absent one", () => {
    expect(earliestProjectedCap(accounts, "claude-work")).toBeNull();
    expect(earliestProjectedCap(accounts, "codex")).toBeNull();
  });
});
