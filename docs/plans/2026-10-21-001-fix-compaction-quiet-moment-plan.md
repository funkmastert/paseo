# Leader compaction: quiet gate + carry prompts

## Problem

`AgentLeaderCompactionMonitor` starts `prepare` the instant a leader crosses
`prepareAtTokens` and goes idle — including the moment right after a turn
Tyler himself triggered, while he's still reading or about to send a
follow-up. His next message then waits behind three system turns, and
nothing tells the leader a message arrived mid-episode.

## Decision

- **Quiet gate**: don't start an episode (`prepare`, either trigger) while
  the leader's most recent _human_ prompt is younger than `quietMinutes`
  (new config, default 10), unless the context is at or over `ceilingTokens`
  (new config, default 550000) — then start now, as today. A hold is not an
  attempt: no hysteresis, no state change.
- **Carry prompts**: record the human prompts the leader got from shortly
  before `prepare` (the last one, if younger than `quietMinutes`) through to
  the start of `restore`. Quote them verbatim in the restore message and
  tell the leader to make sure each is answered first. If one was recent
  enough to carry into `prepare` itself (the ceiling-bypass case), quote it
  under the note's next-step bullet too.

## Human-prompt signal

Already exists: `AgentManager.recordHumanPrompt` / `subscribeOperatorSignals`
emits `{ kind: "human-prompt", agentId, at, clientMessageId }` only when the
session has `clientActivity` — set by heartbeats, which only the app/web/
mobile client sends (`session.ts:4074-4081`). The CLI and MCP agent-to-agent
path never set it, so they're correctly excluded without inferring from
text. This is already how `away-reply` and `attention-push-triage` tell Tyler
apart from everything else — reuse it, not a new mechanism.

It doesn't currently carry the message text, which carry-prompts needs to
quote. Add `text: string` to the `human-prompt` signal variant, threaded from
both `session.ts` call sites (`handleSendAgentMessage`, the WS
`send_agent_message_request` handler) where the raw text is already in
scope. Purely additive — no wire/protocol type, so no back-compat concern.

## Design

- `leader-compaction-planner.ts` (pure):
  - `LeaderCompactionConfig` gains `quietMs`, `ceilingTokens`.
  - `LeaderCompactionEpisode` gains `carriedPrompts: LeaderCompactionCarriedPrompt[]`
    (`{ atMs, text }`), preserved through every existing spread-based
    transition.
  - `planLeaderCompactionStep` gains an input `lastHumanPrompt: { atMs, text } | null`.
    In the `armed` case, after a trigger resolves (line or early) and before
    starting: if there's a recent human prompt and usage is under the
    ceiling, return a new `quietHold` action (state unchanged). Otherwise
    seed the new episode's `carriedPrompts` with that prompt if it's still
    "recent" (covers the ceiling-bypass case); `reportDryRun`'s action
    carries the same value so a dry run's logged prepare message matches.
- `agent-leader-compaction-monitor.ts` (I/O):
  - Subscribes to `agentManager.subscribeOperatorSignals` in its
    constructor; tracks `lastHumanPrompt` per agent, and appends to an open
    episode's `carriedPrompts` live (from `prepare` through `compact`,
    stopping once `restore` starts).
  - `formatPrepareMessage` takes an optional recent prompt and folds one
    sentence into the next-step bullet.
  - `formatRestoreMessage` quotes `episode.carriedPrompts` (capped like
    `truncateNote`) with an instruction to handle any unanswered one first;
    omitted entirely when empty.
  - New `quietHold` action: no send, a once-per-hold-period info log.

## Tests

`leader-compaction-planner.test.ts`: hold while recent, start once quiet,
start at the ceiling despite recency (and it's carried), dry run carries the
same recent prompt.

`agent-leader-compaction-monitor.test.ts`: `FakeAgents` gains
`subscribeOperatorSignals` + a `humanPrompt()` helper. Cases: gate holds and
then releases; a non-human signal doesn't gate or get carried; prompts sent
during the episode show up quoted in the restore message; no prompts ⇒ no
quote block.

## Docs

Integrate into `docs/leader-compaction.md`: a short paragraph after "The
sequence" table for the quiet gate + carry behavior, a sentence in "Never
interrupt a turn" tying the gate to the same "don't land on top of the
person" idea, a sentence in "Hysteresis" (a hold doesn't touch it, same as a
`busy` result), and two new Config rows.
