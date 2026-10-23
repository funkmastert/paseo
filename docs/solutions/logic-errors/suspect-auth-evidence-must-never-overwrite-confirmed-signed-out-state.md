---
title: A signed-out verdict needs proof, and suspect evidence must never overwrite a confirmed account-auth state
date: 2026-10-12
category: logic-errors
module: account-auth-health
problem_type: logic_error
component: authentication
symptoms:
  - "a healthy account that got a 403, or whose credentials were missing or unreadable, is marked signed_out, failover moves every agent off it, and an urgent push and a red sign-in banner go out"
  - "a probe confirms a sign-out, but a newer suspect reading picked in the same sweep wins, so the account stays suspect and nobody hears"
  - "readProviderHealth disagrees with the account-auth tracker because it never reads accountAuth"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [account-auth, signed-out, failover, precedence, suspect-evidence, probe, quota-fetcher]
---

# A signed-out verdict needs proof, and suspect evidence must never overwrite a confirmed account-auth state

## Problem

The first implementation of signed-out detection for the Claude pool accounts (PR #32, caught in its review before merge) treated evidence that only means "this request failed" as proof of a lost login. A 403, a missing credential, or a keychain read that failed for any reason declared a healthy account dead. It also let a weaker, newer reading beat a probe's confirmed verdict.

## Symptoms

- A healthy account is declared dead on a reading that only means the request failed: a 403, or a keychain read that failed for a reason other than "item not found".
- Failover treats that verdict as certain. The tracker's signed-out accounts join `deadProviderIds` with no expiry (`signedOutProviderIds`, `packages/server/src/server/agent/account-failover-detector.ts:285`), and every agent on the account moves to another one.
- The user gets the one urgent push per sign-out episode and the red app banner (`reportSignedOutAccounts`, `packages/server/src/server/agent/account-auth-sweep.ts:195`) for an account that was never signed out.
- A sign-out a probe had just confirmed never landed. In the same sweep, a newer `suspect` reading (another `rejected_expired` from a forced usage read) beat it under newest-wins, and the probe's answer was consumed and gone. The account stayed `suspect` and nobody was told.

## What Didn't Work

- **Three over-eager mappings.** The first version already treated an expired token as `suspect`, but it did not ask why the other failures happened:
  - A 403 shared the 401 path, so a 403 on an unexpired token read as `signed_out`.
  - Missing credentials (`credentials_missing`) were `signed_out`.
  - A credential read that failed outright (locked keychain, timeout, unparseable file) was swallowed to `null` and so read as missing credentials, which made it `signed_out` as well.
- **The newest evidence wins.** Picking between candidates by timestamp alone, whatever the strength of the evidence, let a newer `suspect` reading beat a probe's `auth_failure` from the same sweep. The probe had also been dated when it started, which made it look older than it was.
- **A second reader with its own rules.** `readProviderHealth` (`packages/server/src/server/agent-done-janitor.ts:2378`) had its own idea of a dead account and never consulted the tracker, so two readers of "is this account usable" could disagree.

## Solution

Classify each reading by what it can prove, map it to one of three states, and order the evidence so weaker evidence can't overwrite stronger. The reading-to-state table, the probe and its cadence are in [account-failover.md](../../account-failover.md#when-an-account-is-dead). This section is about the parts that went wrong.

**Readings say why they failed.** The quota fetcher (`packages/server/src/services/quota-fetcher/providers/claude.ts`, around lines 506-541) gives each rejection a kind:

- a 401 on an unexpired token → `rejected_unexpired`
- a 401 on an expired token → `rejected_expired`
- a 403 → `rejected_forbidden`
- no credentials while `.claude.json` still names an account → `credentials_missing`
- a store it could not read at all → no reading

`FROM_READING` in `packages/server/src/server/agent/account-auth-health.ts:152` lets only `rejected_unexpired` stand alone as `signed_out`. The other rejections are `suspect`. Why an expired token is not news: [providers.md](../../providers.md#usage-fetchers-are-read-only-on-credentials).

**A probe settles a suspect account.** `account-auth-probe.ts` runs one real `claude -p` turn on the account's config dir, and its result is dated when it finishes. `auth_failure` → `signed_out`, `success` → `ok`, and an inconclusive result gives no evidence (`candidateFromProbe`, `account-auth-health.ts:180`).

**Precedence is explicit** (`account-auth-health.ts`):

```ts
function isAllowedTransition(prevState: AccountAuthState, candidate: Candidate): boolean {
  // Any state clears to ok on fresh enough evidence.
  if (candidate.state === "ok") return true;
  // signed_out only clears via ok evidence above — weaker evidence (e.g. a later rejected_expired
  // reading) must not downgrade it back to merely suspect.
  if (prevState === "signed_out") return false;
  return true;
}

function outranks(candidate: Candidate, best: Candidate): boolean {
  const candidateSuspect = candidate.state === "suspect";
  if (candidateSuspect !== (best.state === "suspect")) return !candidateSuspect;
  if (candidate.atMs !== best.atMs) return candidate.atMs > best.atMs;
  return SEVERITY[candidate.state] > SEVERITY[best.state];
}
```

The rules this encodes:

- Any non-suspect evidence (an auth-shaped turn failure, an `ok` or `rejected_unexpired` reading, a resolved probe) outranks a suspect reading, even a newer one. Evidence older than the standing record is ignored.
- A suspect reading never demotes `signed_out`. This rule was right from the first version.
- Timestamps decide only between two pieces of evidence of the same kind.

Two more guards keep the state from flapping:

- After a probe succeeds, the sweep ignores readings of that same suspect kind for 6 hours (`PROBE_QUIETS_READING_MS`, `account-auth-sweep.ts:29`). Without that, a keychain item looked up under the wrong name reads as missing on every usage read, and the account pays for a probe every 15 minutes (`MIN_INTERVAL_MS`, `account-auth-probe.ts:50`).
- An auth-shaped turn failure that predates the current daemon process is dropped (`account-auth-sweep.ts`, the `startedAtMs` check), because the account may have been signed back in while the daemon was down.

**One verdict for every reader.** `readProviderHealth` checks `usage.accountAuth` before its own checks, so the janitor and failover agree. The account-pool plugin keeps the same rule on its side: a successful usage read, which normally heals a capped account, does not clear a durable signed-out state (`plugins/claude-account-pool/server/health.ts`, `reportUsage`) (session history).

## Why This Works

A `signed_out` verdict is expensive to act on, and acting on it is hard to undo. Failover moves every agent on the account, the remediation ladder sends an urgent push, and the app shows a red banner. Settle-back can move agents home later, but they have already restarted elsewhere with a rebuilt cache, and the push has landed. So the verdict has to rest on evidence that only a lost login produces:

- **A 401 on an unexpired token.** Nothing else explains the API refusing a token it should still accept.
- **An auth-shaped turn failure.** The CLI's own "Not logged in" or "OAuth session expired and could not be refreshed" is direct evidence.
- **A failed probe.** A live call made to answer exactly this question.

Everything else has an innocent explanation:

- **An expired access token.** The CLI refreshes it on its next turn.
- **A 403.** It refuses the request, not necessarily the session.
- **A failed keychain or file read.** That can be a lock, a timeout or a wrong lookup key, rather than an empty store.

## Prevention

- When a state change triggers costly actions (moving live work, pushing a person, a user-visible banner), classify each piece of evidence by the strongest claim it supports. Let only equal or stronger evidence change the verdict. Every reader of the state consults the same record, not its own copy of the rules.
- The tests that pin this, in `packages/server/src/server/agent/account-auth-health.test.ts`:
  - the `it.each` table that maps each reading kind to its state;
  - "gives suspect on a rejected_expired reading, stays suspect on an inconclusive probe, and signed_out on an auth-shaped probe";
  - "lets a probe's sign-in failure outrank a newer suspect reading of the same account" and "lets a probe that refreshed the account outrank a newer suspect reading": the regression tests for the flap the review caught;
  - "keeps a sign-out when a later reading only says the token expired" and "reads signed_out when a failure and an ok reading carry the same instant".
- `packages/server/src/server/agent/account-auth-sweep.test.ts`: "ignores a sign-in failure older than this process, and counts one after it".
- `FROM_READING` is an exhaustive `Record`, so a new reading kind won't compile until you map it. Map it to `suspect` unless only a lost login can produce it, and add it to the table test.

## Related Issues

- [account-failover.md: When an account is dead](../../account-failover.md#when-an-account-is-dead), which owns the reading-to-state table and the probe.
- [account-failover.md: When Tyler hears](../../account-failover.md#when-tyler-hears), for the sign-out push and the banner.
- [providers.md: Usage fetchers are read-only on credentials](../../providers.md#usage-fetchers-are-read-only-on-credentials), for why an expired token is only suspect.
- [A monitor's ladder state must survive a daemon restart](restart-orphans-remediation-episode-monitor-must-reconcile-on-first-sweep.md), the other review finding from the same PR.
