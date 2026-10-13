/**
 * The sign-in leg of the account-failover sweep (docs/account-failover.md). Each sweep it gathers
 * the evidence AccountAuthTracker judges (auth-shaped turn failures, the usage fetcher's newest
 * reading per account, the probes that finished), starts a probe for each suspect account, and
 * tells the remediation ladder which accounts are signed out. The tracker decides each account's
 * state; this decides which evidence reaches it, and when the ladder hears.
 */
import type {
  AccountAuthReadingAt,
  ProviderUsageService,
} from "../../services/quota-fetcher/service.js";
import type { RemediationObservation, RemediationSink } from "../remediation/contract.js";
import type { AccountFailoverAgentSummary } from "./agent-manager.js";
import {
  readingState,
  type AccountAuthProbeEvidence,
  type AccountAuthReading,
  type AccountAuthReadingInput,
  type AccountAuthTracker,
  type AccountAuthTurnFailureInput,
} from "./account-auth-health.js";
import type { AccountAuthProbe } from "./account-auth-probe.js";
import { failureTimeMs, isAuthShapedError } from "./account-failover-detector.js";
import type { PoolAccount } from "./account-pool-providers.js";

/** How often a suspect or signed-out account's usage is re-read past the cache: its lifetime. */
const AUTH_REREAD_INTERVAL_MS = 5 * 60_000;
/** How long a suspect reading a probe answered with a sign-in is ignored for that account. */
const PROBE_QUIETS_READING_MS = 6 * 60 * 60_000;

export interface AccountAuthSweepOptions {
  tracker: AccountAuthTracker;
  probe: AccountAuthProbe;
  providerUsage: Pick<ProviderUsageService, "getAuthReadings">;
  remediationSink: RemediationSink;
}

export interface AccountAuthSweepInput {
  /** Every pool account, enabled or not: the tracker skips the disabled ones. */
  accounts: readonly PoolAccount[];
  agents: readonly AccountFailoverAgentSummary[];
  nowMs: number;
}

export class AccountAuthSweep {
  private readonly tracker: AccountAuthTracker;
  private readonly probe: AccountAuthProbe;
  private readonly providerUsage: Pick<ProviderUsageService, "getAuthReadings">;
  private readonly remediationSink: RemediationSink;
  /** When each suspect or signed-out account's usage was last read past the cache. */
  private authRereadAtMs = new Map<string, number>();
  /** What the ladder was last told about each signed-out account. */
  private signedOutReported = new Map<string, string>();
  /**
   * Per account, each suspect reading a probe has since answered with a sign-in, and until when it
   * is ignored. Without it a Keychain item looked up under the wrong name reads as missing on every
   * usage read, and every read buys another billed probe.
   */
  private quietedReadings = new Map<string, Map<AccountAuthReading, number>>();

  constructor(options: AccountAuthSweepOptions) {
    this.tracker = options.tracker;
    this.probe = options.probe;
    this.providerUsage = options.providerUsage;
    this.remediationSink = options.remediationSink;
  }

  /** The accounts failover treats as dead for a sign-in failure. */
  signedOutProviderIds(): Set<string> {
    return new Set(this.tracker.recordsIn("signed_out").map((record) => record.providerId));
  }

  isSignedOut(providerId: string): boolean {
    return this.tracker.stateFor(providerId)?.state === "signed_out";
  }

  /**
   * Suspect and signed-out accounts due a usage read past the cache, about once per cache
   * lifetime each. A sign-in started from the app forces its own read when the login exits.
   */
  dueRereads(nowMs: number): Set<string> {
    const standing = new Set(
      [...this.tracker.recordsIn("suspect"), ...this.tracker.recordsIn("signed_out")].map(
        (record) => record.providerId,
      ),
    );
    for (const providerId of this.authRereadAtMs.keys()) {
      if (!standing.has(providerId)) this.authRereadAtMs.delete(providerId);
    }
    const due = new Set<string>();
    for (const providerId of standing) {
      const last = this.authRereadAtMs.get(providerId);
      if (last !== undefined && nowMs - last < AUTH_REREAD_INTERVAL_MS) continue;
      this.authRereadAtMs.set(providerId, nowMs);
      due.add(providerId);
    }
    return due;
  }

  /**
   * Feeds this sweep's evidence to the tracker: auth-shaped turn failures, the usage fetcher's
   * newest auth reading for every pool account (so an idle account nobody runs on is still
   * caught), and the probes that finished since the last sweep. Then starts a probe for each
   * suspect in the background and tells the ladder what changed.
   */
  async observe(input: AccountAuthSweepInput): Promise<void> {
    const { accounts, agents, nowMs } = input;
    const poolProviderIds = new Set(accounts.map((account) => account.providerId));
    const turnFailures: AccountAuthTurnFailureInput[] = agents.flatMap((agent) =>
      poolProviderIds.has(agent.provider) && isAuthShapedError(agent.lastError)
        ? [
            {
              providerId: agent.provider,
              error: agent.lastError,
              atMs: failureTimeMs(agent.lastTimelineAt, nowMs),
            },
          ]
        : [],
    );
    const probes = this.probe.takeFinished();
    const latestReadings = this.providerUsage.getAuthReadings();
    this.quietReadingsProbesAnswered({ probes, latestReadings, nowMs });
    const readings: AccountAuthReadingInput[] = [...latestReadings].flatMap(
      ([providerId, { reading, atMs }]) =>
        poolProviderIds.has(providerId) && !this.isQuieted({ providerId, reading, atMs })
          ? [{ providerId, reading, atMs }]
          : [],
    );
    this.tracker.observe({ accounts, turnFailures, readings, probes });

    // A suspect account is not dead to failover, so nothing this sweep waits for the answer.
    for (const record of this.tracker.recordsIn("suspect")) {
      const configDir = accounts.find(
        (account) => account.providerId === record.providerId,
      )?.configDir;
      if (!configDir) continue;
      const hasRunningAgent = agents.some(
        (agent) => agent.provider === record.providerId && agent.lifecycle === "running",
      );
      this.probe.start({ providerId: record.providerId, configDir, hasRunningAgent, nowMs });
    }

    await this.reportSignedOutAccounts();
  }

  /**
   * A probe that signed in answered the suspect reading standing then. That same kind of reading is
   * ignored for six hours after, so a fetcher that cannot see what the CLI sees costs one probe per
   * six hours, not one per fifteen minutes. Sign-in failures are never quieted.
   */
  private quietReadingsProbesAnswered(input: {
    probes: readonly AccountAuthProbeEvidence[];
    latestReadings: ReadonlyMap<string, AccountAuthReadingAt>;
    nowMs: number;
  }): void {
    for (const [providerId, quieted] of this.quietedReadings) {
      for (const [reading, untilMs] of quieted) {
        if (untilMs <= input.nowMs) quieted.delete(reading);
      }
      if (quieted.size === 0) this.quietedReadings.delete(providerId);
    }
    for (const probe of input.probes) {
      if (probe.result !== "success") continue;
      const latest = input.latestReadings.get(probe.providerId);
      if (!latest || readingState(latest.reading) !== "suspect") continue;
      const quieted = this.quietedReadings.get(probe.providerId) ?? new Map();
      quieted.set(latest.reading, probe.atMs + PROBE_QUIETS_READING_MS);
      this.quietedReadings.set(probe.providerId, quieted);
    }
  }

  private isQuieted(input: AccountAuthReadingInput): boolean {
    const untilMs = this.quietedReadings.get(input.providerId)?.get(input.reading);
    return untilMs !== undefined && input.atMs < untilMs;
  }

  /**
   * One urgent push per sign-out episode, naming the account, its login and the sign-in command.
   * The ladder hears about an episode when it opens and again only if what it would say changes,
   * and once more when the account stops being signed out (signed in, disabled, or removed).
   */
  private async reportSignedOutAccounts(): Promise<void> {
    const standing = new Set<string>();
    for (const record of this.tracker.recordsIn("signed_out")) {
      const { providerId } = record;
      standing.add(providerId);
      const summary =
        `${providerId} can't authenticate (${record.summary}). Sign in as ` +
        `${record.email ?? "its account"}: ${record.fixCommand}`;
      if (this.signedOutReported.get(providerId) === summary) continue;
      await this.remediationSink.observe(
        signedOutObservation({ providerId, active: true, summary }),
      );
      this.signedOutReported.set(providerId, summary);
    }
    for (const providerId of this.signedOutReported.keys()) {
      if (standing.has(providerId)) continue;
      await this.remediationSink.observe(
        signedOutObservation({
          providerId,
          active: false,
          summary: `${providerId} is no longer signed out.`,
        }),
      );
      this.signedOutReported.delete(providerId);
    }
  }
}

function signedOutObservation(input: {
  providerId: string;
  active: boolean;
  summary: string;
}): RemediationObservation {
  return {
    key: `account-signed-out:${input.providerId}`,
    kind: "account-signed-out",
    active: input.active,
    remedy: "none",
    level: "urgent",
    title: `Claude account signed out: ${input.providerId}`,
    summary: input.summary,
  };
}
