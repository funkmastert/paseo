# Leader compaction

A Claude agent re-reads its whole context from cache on every request ([docs/token-burn.md](token-burn.md#the-unit-is-cost-weighted-tokens)), so what a request costs grows with the context. Leaders live longest and grow largest. One measured leader ran ten days, peaked at 967K tokens of context, and spent 82% of its 310M weighted tokens while its context was above 400K. `AgentLeaderCompactionMonitor` (`packages/server/src/server/agent-leader-compaction-monitor.ts`) compacts a leader in place once its context passes a line, without losing its footing.

## Two levers

**The CLI's own auto-compact window.** Claude Code 2.1.280 compacts on its own when the context approaches the effective window, and every Opus 5.5 session gets a 1M window by default, with or without `[1m]`. `CLAUDE_CODE_AUTO_COMPACT_WINDOW=<tokens>` (100K–1M) replaces that window. The threshold is then the window minus `min(maxOutputTokens, 20K)` minus 13K, so `400000` compacts at about 367K. It takes precedence over the `autoCompactWindow` setting and over `--settings`. `claude -p --model <m> "/autocompact"` prints the effective window and where it came from. Check that output instead of trusting a setting.

It has to reach the CLI process. A create-time `env` does not survive a reload or resume, because `buildLaunchContext` runs without it on those paths. The `agent.session_open` plugin hook runs on every open, so set it there. A provider's `agents.providers.<id>.env` sets it for every agent on that account.

It is cheap and needs no daemon code. It also gives the agent nothing: the compaction lands mid-turn, from the CLI's own summary, and the agent is not told.

**This monitor.** Three turns on the same agent: the agent writes a restore note, `/compact` runs, the note comes back. Use it when you want the agent to write down its own state first. To run both, set the CLI window above `prepareAtTokens`, so the CLI compaction only fires as a backstop.

## The sequence

| Step      | What is sent                            | Moves on when                                                   |
| --------- | --------------------------------------- | --------------------------------------------------------------- |
| `prepare` | A `<paseo-system>` request for a note   | The turn completes. Its final assistant text is the note        |
| `compact` | `/compact <what the summary must keep>` | The turn completes **and** the context is under the line        |
| `restore` | What happened, why, and the note        | The turn completes. The agent is settled until usage drops back |

The note is the agent's reply, not a file. A reply needs no path and no permission, and the daemon reads it straight off the turn. Compaction drops the agent's earlier reasoning, and Claude Code's summarizer reads only the visible conversation. The note is what carries that reasoning across.

A completed `/compact` turn proves nothing. A refused or interrupted compaction still ends its turn. Only a context under the line counts, and anything else is a failed attempt. The figure read right after the compaction is Claude Code's `post_tokens`, which counts the summary alone. The system prompt and tools come on top: in the ad-hoc run, a 2.2K post-compaction reading was followed by a 26K request. A line far below the fixed overhead would never re-arm, so keep `prepareAtTokens` well above it.

The agent keeps its id. Parent → child finish notifications still route, and nothing needs re-parenting. Account failover's import path is different: it mints a successor ([docs/account-failover.md](account-failover.md)).

## Never interrupt a turn

Every step starts through `AgentManager.startTurnIfIdle`. It returns null and does nothing unless the agent is `idle`, owns no foreground turn, autonomous turn, pending run or replacement, and has no pending permission. The check and the start happen in one synchronous stretch.

Do not reach for the two obvious send paths:

- `sendPromptToAgent` passes `replaceRunning: true`. A prompt that arrives a moment after the agent started working cancels that work.
- Its `steer` mode starts a fresh turn on an idle agent ([docs/resource-monitor.md](resource-monitor.md)). That is harmless for a message, but this monitor must also know whether a turn it sent actually ran.

A step that finds the agent busy waits for its next idle sweep, and that does not count as an attempt.

**Known hazard: a steer during compaction replaces the turn.** While Claude Code is compacting, the provider refuses steers (`steerActiveTurn` returns `unavailable` when `compacting`). `AgentManager.steerOrReplaceActiveTurn` then falls back to replacing the turn. A child's finish notification, a chat mention or a governor message that lands mid-compaction therefore cancels it. This monitor retries a cancelled `compact` after `retryAfterMinutes`. The CLI's own auto-compaction mid-turn has the same exposure.

## Hysteresis

After an episode ends (`done`, `gaveUp` or a dry-run report), nothing fires for that agent until its context has been seen under `prepareAtTokens`. A compaction that did not shrink the context cannot loop, and a dry run reports each crossing once. If the context shrinks for any other reason, the CLI's own auto-compact or someone typing `/compact`, a pending `prepare` is dropped. A pending `compact` skips to `restore`, so the note still comes back.

State is in memory. After a daemon restart, a leader still over the line starts again from `prepare`. One that was compacted but not yet restored does not get its note back. The summary still carries it, because the compact instructions say to keep it.

## Opus 5.5 and preserved thinking

Opus 5.5 ties each thinking block to the exact history before it. Accounts created on or after 2026-08-31 get a 400 when replayed thinking follows an edited prefix. Claude Code's compaction keeps the last few messages verbatim after the summary, which is the "keep-tail" shape that check rejects. The CLI handles it: it can send `thinking.block_binding.prefix_mismatch_behavior` and reads `input_transformations`/`thinking_dropped` from the response. At worst the retained turns' thinking is dropped once, at the compaction boundary. Measured on 2.1.280: `/compact` on an Opus 5.5 session with thinking and a tool call went from 30K to 1.8K tokens, and the next turn answered from before the compaction correctly with no error.

## Config

`agents.leaderCompaction` in `$PASEO_HOME/config.json`. It is live-toggleable, like the other monitors.

| Key                 | Default     | What it does                                                            |
| ------------------- | ----------- | ----------------------------------------------------------------------- |
| `enabled`           | `false`     | Nothing is watched while this is off                                    |
| `dryRun`            | `false`     | Log each crossing and the messages it would send, send nothing          |
| `scope`             | `"leaders"` | `"all"` includes delegated agents                                       |
| `prepareAtTokens`   | `400000`    | Context size that starts an episode, and the line hysteresis re-arms at |
| `retryAfterMinutes` | `30`        | Wait after a failed or cancelled step                                   |
| `maxAttempts`       | `3`         | Tries per step before giving up with one push                           |

Only Claude-family agents are candidates, because `/compact` is a Claude Code command. Workers are out of scope by default: they are short-lived, and a restart costs them little.

Run `dryRun` first. Its log line, `Leader compaction would start…`, carries the agent, its context size, whether it is idle right now, and the full prepare message.
