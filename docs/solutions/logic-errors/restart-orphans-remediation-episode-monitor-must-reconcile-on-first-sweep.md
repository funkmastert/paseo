---
title: A monitor's ladder state must survive a daemon restart, or a stale episode swallows the next push
date: 2026-10-12
category: logic-errors
module: remediation-ladder
problem_type: logic_error
component: background_job
symptoms:
  - "after a daemon restart, an account that signs out again gets no push, because the ladder still holds the sign-out episode opened before the restart"
  - "the ladder's episode for a key stays open although the condition cleared while the daemon was down"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [remediation-ladder, episode, restart, notifications, monitor, account-auth]
---

# A monitor's ladder state must survive a daemon restart, or a stale episode swallows the next push

## Problem

The remediation ladder keeps its episodes on disk across a restart (`$PASEO_HOME/remediation/state.json`, see [remediation.md](../../remediation.md#state-and-restarts)). The monitors that feed it keep their state in memory, and a restart wipes it. The first version of the sign-out sweep in PR #32 closed an episode only for accounts it remembered reporting. After a restart it remembered none, so an episode opened before the restart never closed. The account's next real sign-out then landed in that stale episode, and rung 3 fires at most once per episode ([Episodes](../../remediation.md#episodes)), so no push went out.

## Symptoms

- An account signed out, the daemon restarted, the account was signed back in, then signed out again: the second sign-out pushed nothing.
- The ladder's state file shows an open `account-signed-out:<providerId>` episode for an account that is fine.

## What Didn't Work

- **Closing only what this process opened.** The sweep sent `active: false` for a key only when its in-memory `signedOutReported` map held it (`packages/server/src/server/agent/account-auth-sweep.ts`, `reportSignedOutAccounts`). A restart empties that map, while the ladder's episode survives.
- **Relying on the ladder to expire episodes.** At the time, it didn't: an episode closed only when an observation with `active: false` arrived for its key (`handleObservation`, `packages/server/src/server/remediation/ladder.ts:294`). It does now — see [State and restarts](../../remediation.md#state-and-restarts) — but this sweep's own reconcile-on-first-sweep still stands as a belt-and-braces measure, and was the only fix available before that.

## Solution

On its first report of each account in a process, the sweep tells the ladder the account's current state, whatever it remembers. A `reconciled` set (`account-auth-sweep.ts:66-72`) marks the accounts already squared. On the first sweep, every account that is not signed out gets one `active: false`:

```ts
for (const { providerId } of accounts) {
  if (this.reconciled.has(providerId)) continue;
  this.reconciled.add(providerId);
  if (standing.has(providerId)) continue;
  await this.remediationSink.observe(
    signedOutObservation({
      providerId,
      active: false,
      summary: `${providerId} is not signed out.`,
    }),
  );
}
```

`active: false` for a key with no open episode is a no-op in the ladder, so the extra observations cost nothing.

These observations must reach the ladder, not the forwarding sink's null target. `createForwardingRemediationSink` (`packages/server/src/server/remediation/contract.ts`) drops observations until bootstrap attaches the ladder. A one-time clear sent before then is lost, and the `reconciled` set never sends it again. It works today because the failover monitor's first tick runs 60 seconds after `start()` (`DEFAULT_SWEEP_INTERVAL_MS`), and `bootstrap.ts` attaches the ladder in the same startup block. If a monitor ever sweeps at once on start, it has to wait for the attach or keep retrying the clear.

Tests: `packages/server/src/server/agent/account-auth-sweep.test.ts`, "closes the episode an earlier process left open, so the next sign-out pushes again" and "tells the ladder once, on its first sweep, that every account not signed out is fine".

## Why This Works

The ladder's episode is the only memory that survives a restart. A monitor that reports only transitions it saw itself can never close an episode a previous process opened. Restating the current state once per key at startup brings the ladder back in line with reality. From then on, the usual "report while it holds, once after it clears" contract keeps it there.

## Prevention

- A monitor that keeps its "what I reported" state in memory reports every key's current state once on its first sweep after a restart, including `active: false` for keys that are fine now. [Plugging in a monitor](../../remediation.md#plugging-in-a-monitor) states this rule — now a belt-and-braces measure, since the ladder closes what nobody confirms on its own.
- **Fixed in the ladder, once, for every monitor** (see [State and restarts](../../remediation.md#state-and-restarts)): on load, the episodes open at that moment are kept as unconfirmed, with when. Any observation for a key, active or not, confirms it. One nobody confirms within a 30-minute restart grace closes with no push and no agent, from the poll tick. `token-audit` (a new key each run) and `work-at-risk` (its sweep only sends `active: true` for a fresh batch, not every sweep its open flag holds) are excluded; a new kind defaults to being expired.

## Related Issues

- [remediation.md: State and restarts](../../remediation.md#state-and-restarts)
- [A signed-out verdict needs proof](suspect-auth-evidence-must-never-overwrite-confirmed-signed-out-state.md), the other review finding from the same PR.
