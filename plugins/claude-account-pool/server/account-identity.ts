/**
 * Which provider entries are really the same Claude account.
 *
 * Two entries can point at different `CLAUDE_CONFIG_DIR`s and still be signed into one login —
 * `claude` and `claude-personal` both are today. The pool then believes it has two accounts
 * when it has one: it counts two survivors and stays quiet about the collapse, and a placement
 * that "moves" work from one to the other moves it nowhere, because they share a budget.
 *
 * The plugin has no way to ask who a provider is logged in as (the daemon does — see the fork's
 * `AgentManager.describeProviderAccount`, which reads `describeAccountAuth()`), so this uses the
 * evidence it does have: two entries on one account report the same usage windows, because they
 * ARE the same windows. Matching on used percentages alone would group any two idle accounts,
 * so a fingerprint also requires reset timestamps — a per-account rolling-window boundary, down
 * to the second, which two genuinely separate accounts do not share by accident.
 */

export interface IdentityWindowReading {
  window: string;
  usedPct?: number | null;
  resetsAt?: Date | null;
}

/**
 * Windows needed before a fingerprint is trusted. One matching (percent, reset) pair is a
 * coincidence worth having; two across different windows is not.
 */
const MIN_FINGERPRINT_WINDOWS = 2;

export interface AccountIdentity {
  /** Feed the same readings the usage poller feeds the health tracker. */
  reportUsage(providerId: string, readings: readonly IdentityWindowReading[]): void;
  /**
   * A key that is equal for two providers exactly when they look like one account. Falls back
   * to the provider id — its own group of one — whenever the evidence is too thin to group on,
   * so "unknown" always reads as "distinct" and nothing is silently merged.
   */
  accountKey(providerId: string): string;
  /** Distinct accounts among `providerIds`, collapsing entries that share one. */
  countAccounts(providerIds: Iterable<string>): number;
  /** Every provider id currently grouped with `providerId`, itself included. */
  siblings(providerId: string): string[];
}

function fingerprintOf(readings: readonly IdentityWindowReading[]): string | null {
  const parts: string[] = [];
  for (const reading of readings) {
    if (reading.usedPct === undefined || reading.usedPct === null) continue;
    if (!reading.resetsAt) continue;
    const resetMs = reading.resetsAt.getTime();
    if (!Number.isFinite(resetMs)) continue;
    parts.push(`${reading.window}=${reading.usedPct}@${resetMs}`);
  }
  if (parts.length < MIN_FINGERPRINT_WINDOWS) {
    return null;
  }
  return parts.sort().join("|");
}

export function createAccountIdentity(): AccountIdentity {
  const fingerprints = new Map<string, string>();

  function accountKey(providerId: string): string {
    const fingerprint = fingerprints.get(providerId);
    return fingerprint === undefined ? `id:${providerId}` : `fp:${fingerprint}`;
  }

  return {
    reportUsage(providerId, readings) {
      const fingerprint = fingerprintOf(readings);
      if (fingerprint === null) {
        // Readings got too thin to tell (a poll that returned nothing useful). Forget rather
        // than keep a stale grouping: an account that was merged and now cannot be proven
        // merged should go back to counting as its own, which is the cautious direction.
        fingerprints.delete(providerId);
        return;
      }
      fingerprints.set(providerId, fingerprint);
    },
    accountKey,
    countAccounts(providerIds) {
      const keys = new Set<string>();
      for (const providerId of providerIds) {
        keys.add(accountKey(providerId));
      }
      return keys.size;
    },
    siblings(providerId) {
      const key = accountKey(providerId);
      const result = [providerId];
      for (const other of fingerprints.keys()) {
        if (other !== providerId && accountKey(other) === key) {
          result.push(other);
        }
      }
      return result.sort();
    },
  };
}
