# Token usage

How many tokens each model and each role used over the last 24 hours, 7 days or 30 days, in [cost-weighted](token-burn.md#the-unit-is-cost-weighted-tokens) or raw tokens. The daemon builds it from the Claude and Codex transcripts already on disk, so it covers every session on the machine, including ones run outside Paseo, and has 30 days of history the first day it runs.

It reads and reports. It never pushes, budgets or steers. [Usage history](usage-history.md) is the per-account window projection and per-agent spend; this is per model and role.

## What is read

`TokenUsageService` (`packages/server/src/server/token-usage/`) sweeps on its own timer and reads:

- **Claude:** `<home>/projects/**/*.jsonl` for `~/.claude`, `$CLAUDE_CONFIG_DIR`, and every `agents.providers.*.env.CLAUDE_CONFIG_DIR`. Pool homes link `projects` to one real folder; the scanner resolves real paths and reads each folder once.
- **Codex:** `<home>/sessions/**/*.jsonl` for `~/.codex`, `$CODEX_HOME`, and every provider's `CODEX_HOME`.

Only transcripts modified in the last 30 days are read. Each sweep stats them all (about 16K files and 250 ms of async I/O on a busy machine), reads only bytes appended since the last sweep up to the last complete line, and stops after 1.5 s of work, yielding to the event loop every 250 lines. The next sweep resumes at the stored offset. The first sweeps are the backfill: 30 days of transcripts (15.8K files) took 22 to 25 s of work over 15 to 17 sweeps, and no stretch between yields exceeded 40 ms. Sweeps run every 15 s while the backfill has files left and every 60 s after.

`agents.tokenUsage.enabled` (default on) is re-read from `config.json` every tick. Off means no transcript reads and the RPC reports `enabled: false`.

## Transcript facts the counting relies on

Measured on this machine's transcripts in October 2026. Re-check them when a provider's CLI changes its format.

**Claude.**

- One API response is written as several lines with the same `message.id`. In the main transcript they repeat with identical usage. In a subagent's transcript the later lines report more `output_tokens` as the response streams (78K such lines in 30 days). A response is booked once by id; a repeat adds only what it reports beyond the largest count already booked. The last 16 ids of each file are kept in the scan state so a repeat that lands after a sweep boundary is still caught.
- `message.model: "<synthetic>"` lines are placeholders with zero usage. They are skipped.
- Subagents write their own files: `<project>/<session>/subagents/agent-*.jsonl`, and for workflows `<project>/<session>/subagents/workflows/wf_*/agent-*.jsonl`. Their lines carry `isSidechain: true` and the parent's `sessionId`, so a subagent books under its session's role.
- `--resume` appends to the same file. `--fork-session` writes a new file that starts with a verbatim copy of the parent's history: same message ids, same timestamps, the new `sessionId`. A fork's first response id therefore equals its parent's, which is how the scanner recognises one; the copied prefix is skipped against the response ids the parent files hold, and the first response the parents do not hold ends the copy. Either file can be read first.
- Claude sometimes writes earlier responses again much further down the same file, with their original timestamps (seen after a resume: 682 lines in 30 days, up to 1,500 lines after the original). Every such line was more than a minute older than the newest response already in the file, and no new response ever was. A response more than five minutes older than the file's newest is treated as a copy and skipped.

**Codex.**

- Count each `token_usage_record`'s `usage`. Its `turn_token_usage` and `thread_token_usage` are running totals of the same responses.
- The model is not on the usage line. It is on `turn_context.payload.model`, and on `event_msg` `thread_settings_applied` when it changes mid-thread. The scanner carries the current model across lines and sweeps.
- `input_tokens` includes `cached_input_tokens` (and `cache_write_input_tokens`, always 0 so far): `total_tokens = input + output`. Fresh input is `input − cached − cache write`, as [token burn](token-burn.md) does.
- Each subagent writes its own rollout file. Its usage lines carry the root thread as `session_id`, so a subagent books under the root session's role. Response ids never repeat across files.

## Roles

| Role      | Rule                                                                 |
| --------- | -------------------------------------------------------------------- |
| `leader`  | The session belongs to a Paseo agent with no `paseo.parent-agent-id` |
| `worker`  | The session belongs to a Paseo agent with a `paseo.parent-agent-id`  |
| `outside` | No Paseo agent owns the session                                      |

The classifier's finer role is not persisted, so history can only be split structurally.

A session maps to an agent through the agent records (`persistence.sessionId`, `runtimeInfo.sessionId`) and a session index the daemon records from every `agent_state` event (`sessions.json`). Records keep only an agent's latest session; the index keeps the earlier ones from the day the feature shipped. When two sources name one session, the newest wins.

A session no agent claims is left unread for 10 minutes after its transcript started (birth time where the platform has one, else mtime), because a Paseo agent writes its transcript before its record names the session. After that it books as `outside` for good. Going by start time rather than mtime means an active outside session is counted while it runs.

## Storage and bounds

`$PASEO_HOME/token-usage/`:

- `state.json`: hourly buckets and the per-file scan state. One file on purpose: a crash between two separate writes would count a stretch twice or lose it.
- `sessions.json`: session id, agent id, parent agent id, last seen.

Zod-validated, `v: 1`, atomic writes at most every five minutes and on shutdown. A file that will not parse is replaced and the scan rebuilds it from the transcripts. Every axis — buckets, file entries, sessions, models per provider, recent ids per file, one line's length — is bounded; see `DEFAULT_TOKEN_USAGE_LIMITS` in `token-usage-store.ts` for the current values. The scanner's discovery window matches the store's retention (`TokenUsageService` derives one from the other), so a file's scan state is never dropped before the buckets it backs are pruned.

## The RPC

`usage.tokens.get_breakdown.request` / `.response`, gated on `server_info.features.tokenUsage`, permission `daemon.read`, controller in `session/token-usage/`, client method `getTokenUsageBreakdown({ range })`. The request names `24h`, `7d` or `30d`; the range starts on the hour, so `24h` covers 24 to 25 hours. The response has one row per provider, model and role with any usage in the range (`model` is `unknown` when a response named none), the weighted total per row, and `coverage`: whether recording is on, when it started, and the backfill's state (`pending`, `running`, `done`, `off`) with files read out of files in the window. A failed read answers with the payload's `error` and no rows.

## Checking it against the transcripts

Check the scanner's totals against an independent sum over the same transcripts, deduped globally by `message.id` (largest count per category). Run the service's `runSweep()` against a temporary `PASEO_HOME` until `complete`, never against `~/.paseo`.
