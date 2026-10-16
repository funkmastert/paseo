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
import type { Logger } from "pino";

import { claudeSignInCommand, lastKnownClaudeEmail } from "./providers/claude/account-auth.js";

export type AccountAuthState = "ok" | "suspect" | "signed_out";

/** The usage fetcher's read on why (if at all) an account looks unable to authenticate. */
export type AccountAuthReading =
  | "credentials_missing"
  | "rejected_unexpired"
  | "rejected_expired"
  | "rejected_forbidden"
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

export interface AccountAuthReadingInput {
  providerId: string;
  reading: AccountAuthReading;
  atMs: number;
}

export interface AccountAuthProbeEvidence {
  providerId: string;
  result: AccountAuthProbeResult;
  /** When the probe finished: the moment the CLI answered. */
  atMs: number;
}

export interface AccountAuthObserveInput {
  accounts: readonly AccountAuthAccountInput[];
  turnFailures?: readonly AccountAuthTurnFailureInput[];
  readings?: readonly AccountAuthReadingInput[];
  probes?: readonly AccountAuthProbeEvidence[];
}

export interface AccountAuthObserveResult {
  /** Providers that newly became signed_out this observation. */
  opened: AccountAuthProblemRecord[];
  /** Providers that were signed_out and are not any more. */
  closed: AccountAuthProblemRecord[];
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

/**
 * Whether `candidate` beats `best`. Anything that answers the question outranks a `suspect`
 * reading, however much newer the reading is: a forced usage read taken after a probe still only
 * says the token expired, which is the question the probe was run to answer. Among answers the
 * newest wins, and on a tie the more severe one, so a failure and a success at the same instant
 * read as a failure.
 */
function outranks(candidate: Candidate, best: Candidate): boolean {
  const candidateSuspect = candidate.state === "suspect";
  if (candidateSuspect !== (best.state === "suspect")) return !candidateSuspect;
  if (candidate.atMs !== best.atMs) return candidate.atMs > best.atMs;
  return SEVERITY[candidate.state] > SEVERITY[best.state];
}

function pickCandidate(input: {
  prevState: AccountAuthState;
  prevSince: number;
  candidates: readonly (Candidate | null)[];
}): Candidate | null {
  let best: Candidate | null = null;
  for (const candidate of input.candidates) {
    if (!candidate) continue;
    if (candidate.atMs <= input.prevSince) continue;
    if (!isAllowedTransition(input.prevState, candidate)) continue;
    if (!best || outranks(candidate, best)) best = candidate;
  }
  return best;
}

// Only a 401 on a token that has not expired is proof on its own. The rest are suspect until the
// probe answers: the CLI refreshes an expired token lazily, a Keychain item looked up under the
// wrong name reads as missing for an account that is fine, and a 403 refuses the request, not
// necessarily the session.
const FROM_READING: Record<AccountAuthReading, { state: AccountAuthState; summary: string }> = {
  credentials_missing: { state: "suspect", summary: "No credentials found for this account" },
  rejected_unexpired: {
    state: "signed_out",
    summary: "The usage API rejected a token that has not expired",
  },
  rejected_expired: { state: "suspect", summary: "The usage API rejected an expired token" },
  rejected_forbidden: { state: "suspect", summary: "The usage API refused this account's token" },
  ok: { state: "ok", summary: "A usage read succeeded" },
};

/** The state a reading puts an account in on its own. */
export function readingState(reading: AccountAuthReading): AccountAuthState {
  return FROM_READING[reading].state;
}

function candidateFromTurnFailure(
  turnFailure: AccountAuthTurnFailureInput | null,
): Candidate | null {
  if (!turnFailure) return null;
  return { state: "signed_out", atMs: turnFailure.atMs, summary: turnFailure.error };
}

function candidateFromReading(reading: AccountAuthReadingInput | null): Candidate | null {
  if (!reading) return null;
  return { ...FROM_READING[reading.reading], atMs: reading.atMs };
}

function candidateFromProbe(probe: AccountAuthProbeEvidence | null): Candidate | null {
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
  reading: AccountAuthReadingInput | null;
  probe: AccountAuthProbeEvidence | null;
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

  const picked = pickCandidate({
    prevState,
    prevSince,
    candidates: [
      candidateFromTurnFailure(evidence.turnFailure),
      candidateFromReading(evidence.reading),
      candidateFromProbe(evidence.probe),
    ],
  });
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
  private readonly logger: Logger | undefined;

  constructor(options?: { logger?: Logger }) {
    this.logger = options?.logger;
  }

  observe(input: AccountAuthObserveInput): AccountAuthObserveResult {
    const opened: AccountAuthProblemRecord[] = [];
    const closed: AccountAuthProblemRecord[] = [];
    const enabledIds = new Set(
      input.accounts.filter((account) => account.enabled).map((account) => account.providerId),
    );
    for (const providerId of this.records.keys()) {
      if (!enabledIds.has(providerId)) this.records.delete(providerId);
    }

    const turnFailures = latestByProvider(input.turnFailures);
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
        reading: readings.get(account.providerId) ?? null,
        probe: probes.get(account.providerId) ?? null,
      });

      this.records.set(account.providerId, next);
      if (prevState !== next.state) {
        this.logger?.info(
          {
            providerId: account.providerId,
            from: prevState,
            to: next.state,
            summary: next.summary,
          },
          "Account auth: state changed",
        );
      }
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

  /** The records standing in `state`. */
  recordsIn(state: "ok"): AccountAuthOkRecord[];
  recordsIn(state: AccountAuthProblemRecord["state"]): AccountAuthProblemRecord[];
  recordsIn(state: AccountAuthState): AccountAuthRecord[] {
    return [...this.records.values()].filter((record) => record.state === state);
  }
}
