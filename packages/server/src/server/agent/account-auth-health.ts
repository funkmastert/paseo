/**
 * Standing sign-in state for each enabled pooled Claude account. Pure state, same episode shape
 * as `PoolAccountIdentityTracker` (pool-account-identity.ts): raised once when a provider first
 * goes bad, quiet while it stays bad, forgotten the moment it is not found any more so the next
 * occurrence re-arms. Unlike limit evidence (account-failover-detector.ts), sign-in evidence
 * never expires on a timer — it only clears on a newer success, so an account stays `signed_out`
 * for as long as nobody signs it in, however long that is. See docs/account-failover.md.
 *
 * Takes plain inputs from its caller (turn failures, an auth reading, probe results) and imports
 * nothing from the usage fetcher or the probe: the sweep that gathers that evidence owns deciding
 * what counts, not this tracker.
 */
import { claudeSignInCommand, lastKnownClaudeEmail } from "./providers/claude/account-auth.js";

export type AccountAuthState = "ok" | "suspect" | "signed_out";

/** The usage fetcher's read on why (if at all) an account looks unable to authenticate. */
export type AccountAuthReading =
  | "credentials_missing"
  | "rejected_unexpired"
  | "rejected_expired"
  | "ok";

export type AccountAuthProbeResult = "success" | "auth_failure" | "inconclusive";

interface AccountAuthRecordBase {
  providerId: string;
  /** When the evidence behind the current state was dated, not when this process noticed it. */
  since: number;
  summary: string;
}

export interface AccountAuthOkRecord extends AccountAuthRecordBase {
  state: "ok";
}

/** An account that may not authenticate, with who to sign in as and how. */
export interface AccountAuthProblemRecord extends AccountAuthRecordBase {
  state: "suspect" | "signed_out";
  /** The declared email, else the last login in the config dir's `.claude.json`. */
  email: string | null;
  fixCommand: string;
}

export type AccountAuthRecord = AccountAuthOkRecord | AccountAuthProblemRecord;

export type AccountAuthEpisode = AccountAuthProblemRecord;

export interface AccountAuthAccountInput {
  providerId: string;
  enabled: boolean;
  /** The directory the sign-in command targets. Null leaves the command unscoped. */
  configDir: string | null;
  expectedEmail?: string | null;
}

export interface AccountAuthTurnFailureInput {
  providerId: string;
  error: string;
  /** Dated by the agent's newest timeline row (account-failover-detector.ts's failureTimeMs). */
  atMs: number;
}

export interface AccountAuthTurnSuccessInput {
  providerId: string;
  atMs: number;
}

export interface AccountAuthReadingInput {
  providerId: string;
  reading: AccountAuthReading;
  atMs: number;
}

export interface AccountAuthProbeInput {
  providerId: string;
  result: AccountAuthProbeResult;
  atMs: number;
}

export interface AccountAuthObserveInput {
  accounts: readonly AccountAuthAccountInput[];
  turnFailures?: readonly AccountAuthTurnFailureInput[];
  turnSuccesses?: readonly AccountAuthTurnSuccessInput[];
  readings?: readonly AccountAuthReadingInput[];
  probes?: readonly AccountAuthProbeInput[];
}

export interface AccountAuthObserveResult {
  /** Providers that newly became signed_out this observation. */
  opened: AccountAuthEpisode[];
  /** Providers that were signed_out and are not any more. */
  closed: AccountAuthEpisode[];
}

function latestByProvider<T extends { providerId: string; atMs: number }>(
  items: readonly T[] | undefined,
): Map<string, T> {
  const latest = new Map<string, T>();
  for (const item of items ?? []) {
    const current = latest.get(item.providerId);
    if (!current || item.atMs > current.atMs) latest.set(item.providerId, item);
  }
  return latest;
}

interface Candidate {
  state: AccountAuthState;
  atMs: number;
  summary: string;
}

const SEVERITY: Record<AccountAuthState, number> = { signed_out: 2, suspect: 1, ok: 0 };

/** Whether moving from `prevState` to `candidate.state` is a transition the state machine allows. */
function isAllowedTransition(prevState: AccountAuthState, candidate: Candidate): boolean {
  // Any state clears to ok on fresh enough evidence.
  if (candidate.state === "ok") return true;
  // signed_out only clears via ok evidence above — weaker evidence (e.g. a later rejected_expired
  // reading) must not downgrade it back to merely suspect.
  if (prevState === "signed_out") return false;
  return true;
}

function pickCandidate(
  prevState: AccountAuthState,
  prevSince: number,
  candidates: readonly (Candidate | null)[],
): Candidate | null {
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.atMs <= prevSince) continue;
    if (!isAllowedTransition(prevState, candidate)) continue;
    if (
      !best ||
      candidate.atMs > best.atMs ||
      (candidate.atMs === best.atMs && SEVERITY[candidate.state] > SEVERITY[best.state])
    ) {
      best = candidate;
    }
  }
  return best;
}

function readingSummary(reading: AccountAuthReading): string {
  switch (reading) {
    case "credentials_missing":
      return "No credentials found for this account";
    case "rejected_unexpired":
      return "The usage API rejected a token that has not expired";
    case "rejected_expired":
      return "The usage API rejected an expired token";
    case "ok":
      return "A usage read succeeded";
  }
}

function stateFromReading(reading: AccountAuthReading): AccountAuthState {
  if (reading === "rejected_expired") return "suspect";
  if (reading === "ok") return "ok";
  return "signed_out";
}

function candidateFromTurnFailure(
  turnFailure: AccountAuthTurnFailureInput | null,
  turnSuccess: AccountAuthTurnSuccessInput | null,
): Candidate | null {
  if (!turnFailure) return null;
  if (turnSuccess && turnSuccess.atMs >= turnFailure.atMs) return null;
  return { state: "signed_out", atMs: turnFailure.atMs, summary: turnFailure.error };
}

function candidateFromTurnSuccess(
  turnSuccess: AccountAuthTurnSuccessInput | null,
): Candidate | null {
  if (!turnSuccess) return null;
  return { state: "ok", atMs: turnSuccess.atMs, summary: "A turn on the account succeeded" };
}

function candidateFromReading(reading: AccountAuthReadingInput | null): Candidate | null {
  if (!reading) return null;
  return {
    state: stateFromReading(reading.reading),
    atMs: reading.atMs,
    summary: readingSummary(reading.reading),
  };
}

function candidateFromProbe(probe: AccountAuthProbeInput | null): Candidate | null {
  if (!probe || probe.result === "inconclusive") return null;
  const success = probe.result === "success";
  return {
    state: success ? "ok" : "signed_out",
    atMs: probe.atMs,
    summary: success
      ? "The sign-in probe refreshed the account"
      : "The sign-in probe failed to authenticate",
  };
}

interface NextRecordEvidence {
  account: AccountAuthAccountInput;
  prev: AccountAuthRecord | null;
  turnFailure: AccountAuthTurnFailureInput | null;
  turnSuccess: AccountAuthTurnSuccessInput | null;
  reading: AccountAuthReadingInput | null;
  probe: AccountAuthProbeInput | null;
}

const OK_SINCE_START: Candidate = { state: "ok", atMs: 0, summary: "ok" };

/** The record for one account in `candidate`'s state; a problem names who to sign in as. */
function recordFor(account: AccountAuthAccountInput, candidate: Candidate): AccountAuthRecord {
  const base = {
    providerId: account.providerId,
    since: candidate.atMs,
    summary: candidate.summary,
  };
  if (candidate.state === "ok") return { ...base, state: "ok" };
  const email =
    account.expectedEmail ?? (account.configDir ? lastKnownClaudeEmail(account.configDir) : null);
  return {
    ...base,
    state: candidate.state,
    email,
    fixCommand: claudeSignInCommand(account.configDir, email),
  };
}

function nextRecordFor(evidence: NextRecordEvidence): AccountAuthRecord {
  const { account, prev } = evidence;
  const prevState = prev?.state ?? "ok";
  const prevSince = prev?.since ?? 0;

  const picked = pickCandidate(prevState, prevSince, [
    candidateFromTurnFailure(evidence.turnFailure, evidence.turnSuccess),
    candidateFromTurnSuccess(evidence.turnSuccess),
    candidateFromReading(evidence.reading),
    candidateFromProbe(evidence.probe),
  ]);
  // A standing record is rebuilt too, so a login fixed in `.claude.json` updates its command.
  return recordFor(
    account,
    picked ??
      (prev ? { state: prev.state, atMs: prev.since, summary: prev.summary } : OK_SINCE_START),
  );
}

/**
 * Standing sign-in state, one record per enabled pooled Claude account. See the module doc for
 * the episode contract.
 */
export class AccountAuthTracker {
  private records = new Map<string, AccountAuthRecord>();

  observe(input: AccountAuthObserveInput): AccountAuthObserveResult {
    const opened: AccountAuthEpisode[] = [];
    const closed: AccountAuthEpisode[] = [];
    const enabledIds = new Set(
      input.accounts.filter((account) => account.enabled).map((account) => account.providerId),
    );
    for (const providerId of this.records.keys()) {
      if (!enabledIds.has(providerId)) this.records.delete(providerId);
    }

    const turnFailures = latestByProvider(input.turnFailures);
    const turnSuccesses = latestByProvider(input.turnSuccesses);
    const readings = latestByProvider(input.readings);
    const probes = latestByProvider(input.probes);

    for (const account of input.accounts) {
      if (!account.enabled) continue;
      const prev = this.records.get(account.providerId) ?? null;
      const prevState = prev?.state ?? "ok";

      const next = nextRecordFor({
        account,
        prev,
        turnFailure: turnFailures.get(account.providerId) ?? null,
        turnSuccess: turnSuccesses.get(account.providerId) ?? null,
        reading: readings.get(account.providerId) ?? null,
        probe: probes.get(account.providerId) ?? null,
      });

      this.records.set(account.providerId, next);
      if (prevState !== "signed_out" && next.state === "signed_out") {
        opened.push({ ...next });
      }
      if (prev?.state === "signed_out" && next.state !== "signed_out") {
        closed.push({ ...prev });
      }
    }

    return { opened, closed };
  }

  stateFor(providerId: string): AccountAuthRecord | null {
    return this.records.get(providerId) ?? null;
  }

  signedOutProviderIds(): Set<string> {
    return new Set(
      [...this.records.values()].filter((r) => r.state === "signed_out").map((r) => r.providerId),
    );
  }

  suspectProviderIds(): Set<string> {
    return new Set(
      [...this.records.values()].filter((r) => r.state === "suspect").map((r) => r.providerId),
    );
  }
}
