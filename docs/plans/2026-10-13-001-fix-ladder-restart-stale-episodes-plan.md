---
title: Episodes From Before a Restart Close Themselves, So the Next Occurrence Pushes - Plan
type: fix
date: 2026-10-13
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Episodes From Before a Restart Close Themselves, So the Next Occurrence Pushes - Plan

## Goal Capsule

- **Objective:** after a daemon restart, an open remediation episode that no monitor confirms is closed by the ladder, so the next real occurrence of that condition opens a new episode and reaches rung 3 (the push) again. The fix is in the ladder, once, for every monitor.
- **Authority:** this plan, then `docs/remediation.md`, `docs/notification-policy.md`, `docs/coding-standards.md`, `docs/testing.md`, `CLAUDE.md`.
- **Execution profile:** one worker, serial units U1, U2, U4, then U3 (docs last), in the worktree `/Users/tylerthackray/.paseo/worktrees/3jvw4yw6/peaceful-blowfish` on branch `fix/ladder-restart-episodes`. That branch already holds a docs commit (`8fdac4c4b`); build on top of it.
- **Stop conditions:** stop and report if the fix would close an episode that has an in-flight remediation agent, or send a push or start an agent on close. Also stop if it would need a monitor to change what it reports while its condition holds, or if a test needs the real `claude` provider.
- **Tail ownership:** the worker commits locally and never pushes, opens a PR, or restarts the 6767 daemon. The leader reviews, merges and stages.

## Product Contract

### Problem

The ladder (`packages/server/src/server/remediation/ladder.ts`) keeps its episodes in `$PASEO_HOME/remediation/state.json` across restarts and never expires one. An episode closes only when an observation with `active: false` arrives for its key (`handleObservation`). Monitors keep their "was active" state in memory. An audit of every `active: false` site found that these clear only on a transition they remember:

- `cpu-saturation`, `orphan-build-daemons` and `system-memory` (`agent-resource-monitor.ts`)
- `disk-critical`, `disk-low` and `disk-falling` (`worktree-disk-monitor.ts`)
- `account-pool-exhausted` (`agent-token-burn-monitor.ts`)
- `account-failover-stranded` (`agent-account-failover-monitor.ts`)
- `stalled-agent:<id>` and `looping-agent:<id>` (`agent-stall-sweep.ts`)

After a restart, an episode whose condition cleared while the daemon was down stays open forever. The next occurrence lands in it, and rung 3 fires at most once per episode, so no push goes out. An episode for an agent that no longer exists never closes. `account-signed-out` already reconciles itself on its first sweep (`account-auth-sweep.ts`, `reconciled`), and it should keep doing so.

### Requirements

- R1. An episode that was open when the ladder first loaded its state in this process, and that no observation for its key has reached by the end of a grace window, is closed by the ladder.
- R2. Any observation for the key (active or not) confirms or closes the episode as today. An active one cancels the pending expiry and keeps the episode, which still must not push again.
- R3. The grace window comfortably exceeds the slowest monitor's sweep plus first-sweep delay:
  - the disk monitor sweeps every 10 minutes by default, and its interval is configurable;
  - the stall sweep runs every 5 minutes;
  - the work-snapshot sweep waits 5 minutes before its first sweep.

  Default to 30 minutes, overridable in `agents.remediation` config if the config already has a natural place for it. Check the disk sweeper's interval config, and if it can exceed the grace, make the grace at least twice that interval.

- R4. Kinds that report once per occurrence rather than every sweep while the condition holds are never expired this way. `token-audit` is one: each run has its own key and the job closes the previous one. Verify `work-at-risk`: if its sweep does not re-send `active: true` every sweep while its on-disk `episodeOpen` holds, exclude it too.
- R5. An expired episode with an in-flight agent is not closed until that agent ends; follow how `handleObservation` keeps such an episode. Closing sends no push and starts no agent. It is recorded in the triage log like any close, with a reason or field that marks it as expired after a restart.
- R6. One info log line per expired episode (key, kind, opened at).
- R8. Separately (U4): an interrupting push (`urgent` or `alert`) that failed in transport is retried until it is delivered or two hours have passed since it was made. A transport failure is a network error (`fetch failed`, connect timeout) or an Expo 429/5xx. A provider refusal is not retried: `DeviceNotRegistered`, an invalid token, or any other ticket-level error. Retries back off (about 1, 2, 5, 10, then every 15 minutes), survive a restart (the ledger is on disk), and update the same ledger record rather than adding entries. A push that lands late says so in its body, with the time it was first sent. Today such a push is marked `failed` and never retried. Observed 2026-10-13 17:42Z: the urgent "Claude account signed out: claude-backup" push failed on a network outage (`exp.host` connect timeout), and rung 3 fires once per episode, so Tyler never heard.
- R7. Separately (U2): `AccountAuthTracker` logs one info line when an account's state changes (provider id, from, to, summary). Today nothing is logged when an account goes `signed_out`, so a live check has to infer it from the ladder file.

### Scope boundaries

- Do not change the monitors. The monitor-side reconcile in `account-auth-sweep.ts` stays.
- No protocol, app or plugin change. U4 stays inside the daemon's push layer (`packages/server/src/server/push/`, `notify-policy/`).

## Planning Contract

### Key technical decisions

- KTD1. Track unconfirmed keys in memory, captured on the first `loadState()` of the process: the open episodes at that moment, plus the process start time. Nothing new is persisted. A second restart inside the grace window starts the window again, which is correct, because the monitors start again too.
- KTD2. Run the expiry from the existing poll (`tick` → `pollAgents`, every 60 s), under the same `serialize` queue as observations, so it can't race `handleObservation`.
- KTD3. Exclusion is by kind, in one named set beside the kinds (for example `REPORTED_ONCE_KINDS`), with a comment saying why. A new kind defaults to being expired, which matches the documented contract: report every sweep while it holds.

### Patterns to follow

- `handleObservation`'s inactive branch: `closedAt`, `recordClosed`, `record(...)`, and the filter that keeps an episode with an agent.
- Tests: `packages/server/src/server/remediation/ladder.test.ts`. Use its fake clock and state-file setup, and drive `tick()`.

## Implementation Units

### U1. The ladder closes unconfirmed episodes after a restart

- **Goal:** R1 to R6.
- **Files:** `packages/server/src/server/remediation/ladder.ts`. `contract.ts` only if the kind set belongs there. Tests in `ladder.test.ts`. Config in `remediation/config.ts` only if R3's override is added.
- **Execution note:** test first. Write the "episode left open by an earlier process closes after the grace" test, see it fail, then implement.
- **Test scenarios:**
  - An episode in the state file with no observation closes once the grace has passed, not before. Advance the fake clock and call `tick()`.
  - The same, with an active observation inside the grace: the episode stays open, and a later active observation does not push again.
  - The same, with an inactive observation inside the grace: it closes as today, with no double close.
  - A `token-audit` episode is never expired.
  - An episode with an in-flight agent is not closed by expiry while the agent runs.
  - An episode opened in this process is never expired, however long it waits for its next observation.
  - Expiry sends no push and starts no agent: the fake push sender records nothing.
  - After expiry, a fresh active observation for the key opens a new episode that reaches rung 3.
- **Verification:** `npx vitest run src/server/remediation/ladder.test.ts` (from `packages/server`) passes, and `npm run typecheck` in `packages/server` is clean.

### U2. The account auth tracker logs its state changes

- **Goal:** R7.
- **Files:** `packages/server/src/server/agent/account-auth-health.ts` (it may need a logger option; follow how `account-auth-probe.ts` takes one) and its construction site. Tests in `account-auth-health.test.ts` only if the logger becomes a required option.
- **Verification:** `npx vitest run src/server/agent/account-auth-health.test.ts src/server/agent/account-auth-sweep.test.ts` passes, and typecheck is clean.

### U4. Retry interrupting pushes that failed in transport

- **Goal:** R8.
- **Files:**
  - `packages/server/src/server/push/push-service.ts`: tell a transport failure from a refusal. The batch `catch` and Expo's 429/5xx are transport failures; ticket errors are refusals.
  - `push/ledger.ts`: retry bookkeeping on the record (an attempt count and a next-try time), optional in the schema so an older ledger still loads.
  - `notify-policy/notify-policy.ts`: the retry timer beside `schedule()`, plus resuming retries on start, the way `recoverUnsent` resumes.
  - Tests in `notify-policy.test.ts` and `push/ledger.test.ts`, or the nearest existing files.
- **Execution note:** test first, with a fake transport that fails twice and then delivers.
- **Test scenarios:**
  - An urgent push that fails with `fetch failed` is retried on the backoff, and is `delivered` once the transport recovers. It stays one ledger record.
  - A `notice` that fails is not retried.
  - A `DeviceNotRegistered` ticket is not retried, and its token is still revoked.
  - A push older than two hours is not retried any more. It stays `failed` and still counts as unreached.
  - Retries resume after a restart from the ledger on disk.
  - A late push's body names the time it was first sent.
- **Verification:** the touched test files pass, and typecheck is clean.

### U3. Docs

- **Files:**
  - `docs/remediation.md`: the "State and restarts" section, and the "Plugging in a monitor" sentence about reporting every key after a start. That sentence is now a belt-and-braces measure, because the ladder closes what nobody confirms. Keep it short.
  - `docs/solutions/logic-errors/restart-orphans-remediation-episode-monitor-must-reconcile-on-first-sweep.md`: replace the "Open, as of this writing" bullet with what the ladder now does.
  - `docs/notification-policy.md`: the ledger and unreached section says which failed pushes are retried, for how long, and why only interrupting ones.
- **Verification:** `npm run format:files -- --ignore-path=$HOME/.cache/self-heal-briefs/empty-ignore <abs paths>` leaves no diff, and the doc voice rules in `CLAUDE.md` hold.

## Verification Contract

- Targeted tests only, never the full suite: `ladder.test.ts`, `account-auth-health.test.ts`, `account-auth-sweep.test.ts`, and U4's notify-policy and push tests (including `notify-policy.e2e.test.ts` and `push-callers.test.ts`), plus any test file that constructs `RemediationLadder` or `AccountAuthTracker` (grep for them).
- `npm run typecheck` in `packages/server`.
- Lint: `npm run lint -- -c .oxlintrc.json --no-ignore <abs paths>`.
- Format with the `format:files` command above. Commit with `LEFTHOOK=0`.

## Definition of Done

- U1 to U4 committed on `fix/ladder-restart-episodes`, each commit ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Targeted tests, typecheck and lint pass.
- The final message lists the commits, the grace value chosen and why, the excluded kinds and why (including the `work-at-risk` verdict), and the test evidence.
