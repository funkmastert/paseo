import type {
  UsageHistoryAccount,
  UsageHistoryWindow,
} from "@getpaseo/protocol/usage-history/rpc-schemas";

/**
 * The window that will cap first on one account, or null when none is projected to cap before its
 * reset. This is the read the orchestration panel's budget strip takes: the tightest window is what
 * actually caps an account, so the earliest cap across its windows is the account's time-to-cap.
 * A window whose projection is `unknown` is not counted: no data is not "safe", so callers that
 * need to distinguish the two read `windows[].projection.status` themselves.
 */
export function earliestProjectedCap(
  accounts: readonly UsageHistoryAccount[],
  providerId: string,
): { window: UsageHistoryWindow; capsAt: string; minutesToCap: number } | null {
  const account = accounts.find(
    (candidate) => candidate.providerId.toLowerCase() === providerId.toLowerCase(),
  );
  let earliest: { window: UsageHistoryWindow; capsAt: string; minutesToCap: number } | null = null;
  for (const window of account?.windows ?? []) {
    const { capsAt, minutesToCap } = window.projection;
    if (capsAt === undefined || minutesToCap === undefined) continue;
    if (!earliest || minutesToCap < earliest.minutesToCap) {
      earliest = { window, capsAt, minutesToCap };
    }
  }
  return earliest;
}
