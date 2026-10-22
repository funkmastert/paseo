# Leader compaction

A Claude agent re-reads its whole context from cache on every request ([docs/token-burn.md](token-burn.md#the-unit-is-cost-weighted-tokens)), so what a request costs grows with the context. Leaders live longest and grow largest. One measured leader ran ten days, peaked at 967K tokens of context, and spent 82% of its 310M weighted tokens while its context was above 400K. `AgentLeaderCompactionMonitor` (`packages/server/src/server/agent-leader-compaction-monitor.ts`) compacts a leader in place once its context passes a line, without losing its footing.

## Two levers

**The CLI's own auto-compact window.** Claude Code 2.1.280 compacts on its own when the context approaches the effective window, and every Opus 5.5 session gets a 1M window by default, with or without `[1m]`. `CLAUDE_CODE_AUTO_COMPACT_WINDOW=<tokens>` (100K–1M) replaces that window. The threshold is then the window minus `min(maxOutputTokens, 20K)` minus 13K, so `400000` compacts at about 367K. It takes precedence over the `autoCompactWindow` setting and over `--settings`. `claude -p --model <m> "/autocompact"` prints the effective window and where it came from. Check that output instead of trusting a setting.

It has to reach the CLI process. A create-time `env` does not survive a reload or resume, because `buildLaunchContext` runs without it on those paths. The `agent.session_open` plugin hook runs on every open, so set it there. A provider's `agents.providers.<id>.env` sets it for every agent on that account.

It is cheap and needs no daemon code. It also gives the agent nothing: the compaction lands mid-turn, from the CLI's own summary, and the agent is not told.

Nothing on this machine sets the window, so every session compacts at the default, about 967K. Over the week to 2026-10-22, all eight CLI compactions in the transcripts were delegated agents at 967–968K, and seven landed mid-turn. No leader reached it: the monitor's line is 400K. A mid-turn CLI compaction can't be warned or deferred. The way to make it rare for an agent is to compact it earlier, between turns, which is what the monitor does.

**This monitor.** Three turns on the same agent: the agent writes a restore note, `/compact` runs, the note comes back. Use it when you want the agent to write down its own state first. To run both, set the CLI window above `prepareAtTokens`, so the CLI compaction only fires as a backstop.

## The sequence

| Step      | What is sent                            | Moves on when                                                                        |
| --------- | --------------------------------------- | ------------------------------------------------------------------------------------ |
| `prepare` | A `<paseo-system>` request for a note   | The turn completes. Its final assistant text is the note, or a [deferral](#deferral) |
| `compact` | `/compact <what the summary must keep>` | The turn completes **and** the context is under the line                             |
| `restore` | What happened, why, and the note        | The turn completes. The agent is settled until usage drops back                      |

The note is the agent's final message, not a file. A reply needs no path and no permission, and the daemon reads it straight off the turn. Compaction drops the agent's earlier reasoning, and Claude Code's summarizer reads only the visible conversation. The note is what carries that reasoning across.

A completed `/compact` turn proves nothing. A refused or interrupted compaction still ends its turn. Only a context under the line counts, and anything else is a failed attempt. The figure read right after the compaction is Claude Code's `post_tokens`, which counts the summary alone. The system prompt and tools come on top: in the ad-hoc run, a 2.2K post-compaction reading was followed by a 26K request. A line far below the fixed overhead would never re-arm, so keep `prepareAtTokens` well above it.

The agent keeps its id. Parent → child finish notifications still route, and nothing needs re-parenting. Account failover's import path is different: it mints a successor ([docs/account-failover.md](account-failover.md)).

## Finish-up window

`prepare` can land while the agent is partway through a step it can't safely leave: it ended a turn with a merge, push, deploy, migration or multi-file edit half done, or while waiting on a build. Telling it to call no tools and start nothing new makes it abandon the step or resume it from memory after the restore. So `prepare` lets it finish that one step first. It has about `finishUpMinutes` and a few tool calls, starts nothing new, not even the step that obviously comes next, and writes the note as its final message. An agent that isn't partway through such a step calls no tools.

The turn is the agent's, and the monitor never shortens it. `prepareTimeoutMinutes` only bounds how long the monitor waits. At the bound it does not cancel the turn, since the agent may be finishing a deploy. It stops waiting, counts a failed try, and sends `prepare` again after `retryAfterMinutes` once the agent is idle. A note the stale turn writes after the bound is dropped. The check runs on the sweep, so the bound is accurate to a minute. `maxAttempts` timeouts in a row give up with the usual push.

## Deferral

A step that needs longer than the window, a 20-minute build for example, would otherwise be handed to the post-compaction agent as a note. The agent can instead reply to `prepare` with exactly `DEFER <minutes>: <reason>` and nothing else. The monitor waits that long and sends `prepare` again from the start. One episode is deferred at most `maxDeferMinutes` in total, and a request past that is cut to what is left.

The ceiling outranks a deferral. At or over `ceilingTokens` a request is refused, and a wait in progress ends when the context reaches the ceiling. `ceilingTokens` is capped at 900K regardless of what is configured, to keep it well under the CLI's own compaction point. A refused request is not a note. The monitor asks once more, saying deferral is closed. A reply that defers again gets one more ask, now saying to write the note now instead; only a third `DEFER` is a failed try, the same as a cancelled or timed-out step — never taken as the note.

Only an exact one-line reply counts, so a note that mentions `DEFER` is a note. A deferral is a successful turn: it uses no attempt, and the ledger keeps one row for the episode. The cost is one extra `prepare` turn per request. The cap and the ceiling stop it from becoming a way to dodge compaction.

## Quiet gate and carried prompts

A crossing does not start `prepare` the instant it is seen. If the leader's most recent human prompt — one from the app, desktop or web client, never the CLI or an agent (`AgentManager.recordHumanPrompt`, the same signal `away-reply` and `attention-push-triage.ts` use to tell a person apart from everything else) — is younger than `quietMinutes`, the episode waits for the next sweep where it isn't, so a prompt sent while the leader is reading or typing does not land it behind three system turns. At or over `ceilingTokens`, the wait is skipped and the episode starts anyway: letting the context run far past the line to protect a conversation is worse than the interruption. A hold is not an attempt: it does not touch [hysteresis](#hysteresis), and it does not use up an early verdict.

Every human prompt the leader gets from shortly before `prepare` (the last one, if the gate let it through) to the start of `restore` is kept and quoted verbatim in the restore message, with an instruction to make sure each is answered or in progress before carrying on. One that was recent enough to start the episode anyway (the ceiling case) is quoted in the `prepare` message too, under the note's next step, so the agent sees it before compaction rather than only after.

## JEV timing

JEV can move an episode's start and add a cut-point sentence to `/compact` ([Feature 9](jev.md#feature-9-compaction-timing)). A verdict changes only what an `armed` sweep plans, so [Never interrupt a turn](#never-interrupt-a-turn) still holds. An early episode that gives up sends no push: the leader is under the line, and the line starts the next episode.

## Never interrupt a turn

Every step starts through `AgentManager.startTurnIfIdle`. It returns null and does nothing unless the agent is `idle`, owns no foreground turn, autonomous turn, pending run or replacement, and has no pending permission. The check and the start happen in one synchronous stretch.

Do not reach for the two obvious send paths:

- `sendPromptToAgent` passes `replaceRunning: true`. A prompt that arrives a moment after the agent started working cancels that work.
- Its `steer` mode starts a fresh turn on an idle agent ([docs/resource-monitor.md](resource-monitor.md)). That is harmless for a message, but this monitor must also know whether a turn it sent actually ran.

A step that finds the agent busy waits for its next idle sweep, and that does not count as an attempt. A deferral waits the same way once its time is up. The [quiet gate](#quiet-gate-and-carried-prompts) is the same idea from the other side: even an idle leader is left alone while a person just sent it something, unless the ceiling says otherwise.

**Known hazard: a steer during compaction replaces the turn.** While Claude Code is compacting, the provider refuses steers (`steerActiveTurn` returns `unavailable` when `compacting`). `AgentManager.steerOrReplaceActiveTurn` then falls back to replacing the turn. A child's finish notification, a chat mention or a governor message that lands mid-compaction therefore cancels it. This monitor retries a cancelled `compact` after `retryAfterMinutes`. The CLI's own auto-compaction mid-turn has the same exposure.

## Hysteresis

After an episode ends (`done`, `gaveUp` or a dry-run report), nothing fires for that agent until its context has been seen under `prepareAtTokens`. A compaction that did not shrink the context cannot loop, and a dry run reports each crossing once. An early episode ends under that line and re-arms at once; the one-early-start-per-cycle rule keeps it from starting again. If the context shrinks under the episode's line for any other reason, the CLI's own auto-compact or someone typing `/compact`, a pending `prepare` is dropped. A pending `compact` skips to `restore`, so the note still comes back.

A quiet-gate hold is the same as a `busy` result: nothing was sent, so nothing was tried, and the agent stays armed exactly as it was.

State is in memory. After a daemon restart, a leader still over the line starts again from `prepare`. One that was compacted but not yet restored does not get its note back. The summary still carries it, because the compact instructions say to keep it.

## Opus 5.5 and preserved thinking

Opus 5.5 ties each thinking block to the exact history before it. Accounts created on or after 2026-08-31 get a 400 when replayed thinking follows an edited prefix. Claude Code's compaction keeps the last few messages verbatim after the summary, which is the "keep-tail" shape that check rejects. The CLI handles it: it can send `thinking.block_binding.prefix_mismatch_behavior` and reads `input_transformations`/`thinking_dropped` from the response. At worst the retained turns' thinking is dropped once, at the compaction boundary. Measured on 2.1.280: `/compact` on an Opus 5.5 session with thinking and a tool call went from 30K to 1.8K tokens, and the next turn answered from before the compaction correctly with no error.

## The ledger

The monitor reports every step, every dropped episode, the quiet-gate hold, the carried prompts and the deferrals to an optional `episodeObserver`, and each call is isolated: an observer that throws is logged and never stops a step. [docs/insights.md](insights.md) owns what the compaction ledger does with them.

## Config

`agents.leaderCompaction` in `$PASEO_HOME/config.json`. It is live-toggleable, like the other monitors.

| Key                     | Default     | What it does                                                                                                                            |
| ----------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`               | `false`     | Nothing is watched while this is off                                                                                                    |
| `dryRun`                | `false`     | Log each crossing and the messages it would send, send nothing                                                                          |
| `scope`                 | `"leaders"` | `"all"` includes delegated agents                                                                                                       |
| `prepareAtTokens`       | `400000`    | Context size that starts an episode, and the line hysteresis re-arms at                                                                 |
| `retryAfterMinutes`     | `30`        | Wait after a failed or cancelled step                                                                                                   |
| `maxAttempts`           | `3`         | Tries per step before giving up with one push (a leader's; a delegated agent's stays in the log)                                        |
| `quietMinutes`          | `10`        | [Quiet gate](#quiet-gate-and-carried-prompts): how long since the leader's last human prompt before an episode may start                |
| `ceilingTokens`         | `550000`    | The quiet gate's override: start anyway at or over this. Also the line past which a [deferral](#deferral) is refused                    |
| `finishUpMinutes`       | `10`        | How long `prepare` tells the agent it has to [finish a step](#finish-up-window) it is partway through. `0`: it is told to call no tools |
| `prepareTimeoutMinutes` | `30`        | How long the monitor waits for the `prepare` turn before it stops waiting. Never below `finishUpMinutes`. `0`: no bound                 |
| `maxDeferMinutes`       | `20`        | The most one episode may be [deferred](#deferral) in total. `0`: no deferral                                                            |

Only Claude-family agents are candidates, because `/compact` is a Claude Code command. Workers are out of scope by default, but not all of them are short-lived. A fix agent that keeps getting messages for hours crosses the line with dozens of idle gaps, and those are the agents the CLI compacts mid-turn. `"all"` covers them, and only a leader's give-up pushes. One that climbs from 400K to the CLI's point inside a single turn still gets the CLI compaction.

Run `dryRun` first. Its log line, `Leader compaction would start…`, carries the agent, its context size, whether it is idle right now, what triggered it (`line` or `early`), and the full prepare message.
