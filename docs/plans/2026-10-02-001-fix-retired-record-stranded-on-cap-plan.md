---
title: "fix: a message to a retired record strands on a capped account; recovered children keep error badges"
type: fix
status: active
date: 2026-10-02
---

# Fix: retired records strand on a cap, and recovered children look stuck

## Problem

On 2026-10-02 Tyler sent a message to his leader conversation while the `claude` and
`claude-personal` accounts were at 9% weekly. The turn died on `claude-backup` (100% weekly)
with "You've hit your weekly limit", and nothing moved it. Three subagents that had recovered
from the previous night's cap still showed red error badges, so the fleet looked stuck too.

### Root cause 1: retired records run on their own account and failover ignores them

1. One conversation (one Claude session) had two records: the live end on `claude`, and a
   retired record on `claude-backup` with `paseo.account-failover.migrated-to` pointing at the
   live end. The duplicate rule (`findLiveSessionHolder`, `account-failover-migration.ts`)
   retired the record Tyler was using, in favour of an older record on the same session.
2. The app knows nothing about retirement: nothing in `packages/app` reads `migrated-to`. A
   retired record looks and sends like any other, and Tyler's tab was on it.
3. `sendPromptToAgent` (`agent/agent-prompt.ts`) runs the turn on whatever record it is given,
   so it ran on the retired record's account, `claude-backup`, and failed on the cap. It also
   appended to the transcript the live end shares, which makes two writers on one transcript.
4. `planAccountFailoverSweep` (`agent/account-failover-detector.ts:256`) drops every record
   with `migrated-to` from the candidates, so the turn is never rescued and the stranded report
   never fires. Nothing else acts.

The import path's revival of a retired handle (`migrateStuckAgent` → `reactivateRevivedHandle`)
causes the same split: it changes which id is the live end. Any tab, pin or leader still holding
the old id now points at a retired record. It runs only because `moveAgentToProvider` refuses
with `session_conflict` when the target holds a retired record for the session
(`agent-manager.ts`, `assertProviderCanAdoptSession`). That check counts every unarchived
record, though the refusal table in `docs/account-failover.md` says "another live agent".

### Root cause 2: a child's error badge is never cleared by a later successful turn

`checkAndSetAttention` (`agent-manager.ts`) returns early when attention is already set ("Skip
if already requires attention"), and on running → idle it returns early for delegated agents. A
child that errored on a cap has `attentionReason: "error"`. When failover or its leader resumes
it and the turn finishes, the error stays. Nobody opens a subagent to clear it, so it shows as
errored indefinitely. A root keeps a stale error too, until someone views it.

## Fix

### F1. The record you message becomes the conversation's live end

**Superseded** by docs/plans/2026-10-01-001-feat-leader-settle-back-plan.md (branch multi-account-orchestrator-leader-settle-back), which redirects a retired record to its successor and adds an app redirect. Not implemented here.

Messaging a retired record makes it the live end. This mirrors how `sendPromptToAgent` already
unarchives an archived record it is asked to run.

- Add a helper next to the retire/revive helpers in `account-failover-migration.ts`, e.g.
  `adoptRetiredRecord({ agentManager, agentStorage, agentId })`. Call it from
  `sendPromptToAgent` before `ensureAgentLoaded`, behind a new opt-in param
  (`adoptRetired?: boolean`, default false). Only the two callers that carry a deliberate
  choice of record pass it: `Session.handleSendAgentMessage` (the app and CLI) and the MCP
  `send_agent_prompt` tool (`agent/tools/paseo-tools.ts`, a leader messaging a child by an id
  it holds). Automatic senders such as leader compaction, remediation, stall nudges and restart
  recovery must never flip a conversation's live end, so they don't opt in.
- If the target record has no `migrated-to`, do nothing.
- Find the other live records on the same session (`findLiveSessionHolder`). If any is busy
  (running, initializing, or has an in-flight run; use
  `agentManager.getAccountFailoverSummary(id)?.busy` and lifecycle), refuse. Throw an error the
  app and the MCP caller show as-is, naming the holder by title and id: "This conversation is
  running as <title> (<id>). Send your message there." Two writers at once is the case this
  must never create.
- Otherwise, un-retire the target: blank `migrated-to` (there is no label-removal API; a blank
  reads as unset) and strip the `[MOVED …]` title prefix (`stripMovedTitlePrefix`). Then retire
  every idle live holder in its favour with `retirePredecessor`, which sets `formatMovedTitle`
  and `migrated-to=<target>`. Finish reports already follow `migrated-to`, so the holder's
  children report to the adopted record.
- Log one info line naming both ids.

### F2. A retired record on the target does not block an in-place move

**Superseded** by docs/plans/2026-10-01-001-feat-leader-settle-back-plan.md (branch multi-account-orchestrator-leader-settle-back), which redirects a retired record to its successor and adds an app redirect. Not implemented here.

In `assertProviderCanAdoptSession`, a record that is retired (`getMigratedToFromLabels`) and not
running does not count as a claim. A retired record that is somehow running still counts; that
is a live writer. This makes the code match the refusal table, and it makes the rescue of an
adopted record an in-place move, so the id Tyler is looking at stays the live end. Without it,
the adopted record's rescue would hit `session_conflict`, fall back to import, and revive the
other record again: the same split, ping-ponging.

Leave the import fallback's revive path in place. It still serves a move that fails for another
reason.

### F3. A finished turn clears a stale error badge

In `checkAndSetAttention`, before the "already requires attention" early return: on a
running → idle edge that was not canceled, if `attention.attentionReason === "error"`, clear the
attention. Then let the existing logic run, so a root gets `finished` and a delegated agent gets
nothing. Persistence and emission follow from the existing `emitState` path; check that, don't
assume it.

## Tests (test-first; each must fail before the fix)

The first three bullets test F1 and F2 and are superseded with them. Only the `agent-manager.test.ts` bullet (F3) applies.

- `account-failover-migration.test.ts` or a new
  `agent/adopt-retired-record.test.ts`: a retired record with an idle live holder is adopted:
  the target's `migrated-to` is blank and its prefix stripped, and the holder carries
  `migrated-to=<target>`. With a running holder it is refused, nothing is changed, and the error
  names the holder. A record that is not retired is untouched.
- `provider-move.e2e.test.ts`: moving onto a provider whose only record for the session is
  retired succeeds in place (same id). A live holder there still refuses with `session_conflict`.
- `agent-account-failover-monitor.e2e.test.ts`: the regression end to end. A conversation with a
  live end on account A (healthy) and a retired record on account B (capped). Send to the retired
  record through `sendPromptToAgent`. The turn fails on B's cap, and the next sweep moves that
  same record in place to a healthy account and resumes it. Assert the record id is unchanged, it
  is no longer retired, and the other record is retired pointing at it.
- `agent-manager.test.ts`: a delegated agent with error attention that runs a turn to idle has no
  attention afterwards. A root in the same situation ends with `finished`.

## Docs

The `docs/account-failover.md` changes below cover F1 and F2 and are superseded with them. F3 is documented in `docs/agent-lifecycle.md` under Attention.

`docs/account-failover.md`, integrated, not appended:

- The refusal table's `session_conflict` row: a retired record on the target does not block a
  move.
- The Duplicates table's "Retired" row: moves in place, and the retired record stays retired.
- "When it falls back to importing": the routine `session_conflict` case is gone; revival happens
  only when a move fails for another reason.
- A short section on what a message to a retired record does: it becomes the live end and the
  other record is retired in its favour, refused while the other is mid-turn, and why.
- "Idempotency": "Retired. Never a candidate again" becomes "never a candidate while retired;
  a message un-retires it".

## Gates

- Run only the touched test files: `npx vitest run <file> --bail=1`. Never the whole suite. Pipe
  long output to a file. Before running a vitest file list, check that it is not empty.
- `npm run typecheck`, `npm run lint -- <files>`, `npm run format:files -- <files>`. Lint and
  format see no files under `~/.paseo`; see the worktree tooling gotchas in the leader's memory.
  If the npm scripts skip the files, report it rather than working around it.
- Heavy steps go through `~/bozeo-ops/cpu-policing/heavy.sh`. The machine's load is high.
