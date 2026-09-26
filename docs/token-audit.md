# Token audit

A weekly audit of what the Claude fleet spends before any work happens: the prefix every agent loads, and how well the prompt cache holds. Seven items, all measured, none estimated. A model is asked for one line only when something is RED or has regressed.

`paseo doctor --tokens` prints the table on demand. The daemon runs the same checks every `intervalDays`, stores the report, diffs it against the last one and decides whether anyone hears about it.

## The seven items

Each is one check in `packages/server/src/server/session/doctor/tokens/`, category `tokens`. Every row is FINDING, SEVERITY (RED, AMBER, GREEN or UNKNOWN), EVIDENCE (a number or a path) and COST. UNKNOWN means the probe could not run and never escalates.

| Item        | Measures                                                                                                                                    | RED                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `memory`    | Every CLAUDE.md, `@import` and auto-memory file loaded from each account and audited directory, plus `daemon.appendSystemPrompt`, in tokens | A file over 5k tokens or a total over 10k                                                   |
| `tools`     | MCP servers and tools per server, whether deferral is active, and any proxy or gateway variable                                             | Deferral off, `ENABLE_TOOL_SEARCH=false`, or a proxy variable set while deferral is off     |
| `model`     | Model and effort per settings layer, the flags running agents were launched with, and automatic model switching                             | `opusplan`, a fallback model, or a live governor downgrade. Measured switches are AMBER     |
| `hooks`     | PreToolUse hooks in every settings layer and installed plugin, and whether their scripts rewrite tool input                                 | none (AMBER when no hook rewrites)                                                          |
| `subagents` | Agent files in user and project agent directories, and whether each sets a model or inherits                                                | none (AMBER when one inherits and `CLAUDE_CODE_SUBAGENT_MODEL` does not cover it)           |
| `scheduled` | Paseo schedules, crontab and LaunchAgents against the cache lifetime in use, and crash-looping launchd jobs                                 | A job with 50 or more runs and a non-zero exit, or a KeepAlive job whose script is gone     |
| `cache`     | Cache read, write, input and output shares per turn, deduplicated by message id, for the newest session and a 7-day fleet aggregate         | never: no threshold was given. AMBER above 200K last-turn context or when rebuilds dominate |

## How each number is measured

- **Memory tokens come from `claude -p "/context"`.** It prints Claude Code's own breakdown from a local command: no model call (`duration_api_ms` and `total_cost_usd` are 0). Always pass `--no-session-persistence`; without it the run writes a transcript that the cache item then reads back as spend. The output rounds to three digits (`4k`, `8.6k`, `740`), so a count keeps its rounding step, and a value within it of a limit is AMBER. When `claude` cannot run, the rows report bytes and write tokens as UNKNOWN. Never divide bytes by four: on this fork's `appendSystemPrompt` that guess is a third short. The prompt's tokens are the difference in the `System prompt` line between a run with `--append-system-prompt` and one without.
- **Deferral is read from what agents ran with.** A transcript with deferral on carries a deferred-tools listing or ToolSearch calls. A standalone `/context` has none of an agent's launch env, so it only decides when there is no transcript.
- **Agent launch flags and env come from `ps eww`**, macOS only. Values are redacted by name (`TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `AUTH`, `COOKIE`), and a base URL is cut to scheme and host. Nothing that looks like a credential reaches a row or a report.
- **The cache lifetime in use** is the larger of `usage.cache_creation.ephemeral_1h_input_tokens` and `ephemeral_5m_input_tokens` over the window. The evidence shows both.
- **Transcripts are streamed**, never read whole: the shared projects directory is gigabytes. The check stops at its deadline and says how many files it read.
- **Windows and Linux.** `ps eww`, `launchctl` and `plutil` are macOS only, so those rows say UNKNOWN and name the platform. Windows Task Scheduler is not probed.

## The weekly job

`agents.tokenAudit` in `config.json`. The job re-reads the file on every check, so every key is live and none needs `paseo daemon reload`.

| Key                         | Default  | What it does                                                                           |
| --------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `enabled`                   | `true`   | Off, the job never runs.                                                               |
| `intervalDays`              | `7`      | The newest report's age is the schedule, so a restart neither skips nor repeats a run. |
| `keep`                      | `8`      | Reports kept under `$PASEO_HOME/token-audit/`, JSON and markdown of each.              |
| `windowDays`                | `7`      | The cache window.                                                                      |
| `cwds`                      | newest 3 | Directories to audit. Default: the cwds of the three newest sessions that still exist. |
| `maxContextRuns`            | `9`      | Cap on `claude -p /context` runs (accounts times directories).                         |
| `escalation.enabled`        | `true`   | Off, an escalating report is pushed at `notice` with no agent-written line.            |
| `escalation.budgetTokens`   | `150000` | The agent's `paseo.budget` and cancel ceiling.                                         |
| `escalation.timeoutMinutes` | `10`     | The agent's own timeout.                                                               |

The first check runs 10 minutes after the daemon starts, so a restart's burst settles first, then every 30 minutes asks whether the last report is old enough.

## When someone hears about it

The job diffs each report against the previous one (`token-audit/diff.ts`). It escalates on:

- a RED row that was not RED last time, or any RED on the first report;
- a row whose severity got worse (UNKNOWN moves are not changes);
- cache-read share or cache-write share up 5 points, median last-turn context up 20%, or total memory tokens up 20%. The two ratio rules ignore a base under 10k tokens (median context) or 2k tokens (memory).

A persistent RED escalated the week it appeared and is quiet after that. Otherwise the job records the run at `record` and nobody is pushed.

An escalating report goes to the [remediation ladder](remediation.md#advisory-episodes) as an advisory episode, key `token-audit:<report time>`, kind `token-audit`. The ladder starts one agent labelled `paseo.task-class: mechanical` (so the classifier picks the cheapest model) with `paseo.budget` at `escalation.budgetTokens`. It reads the table of non-GREEN rows and ends with one `RECOMMENDATION:` line. The ladder pushes that line at `notice`, with the report path, under the report's own title. If no agent can run, the push carries the reason instead. The next report closes the previous episode.

## Shared system-prompt cache

The `cache` item counts what agents in different worktrees fail to share. The daemon's `excludeDynamicSections` default ([config](custom-providers.md#claude-params-shared-system-prompt-cache)) removes the per-cwd part of the system prompt. Measured 2026-09-25 with the pinned SDK 0.3.246 `query()`, `claude-haiku-4-5-20251001`, the `claude_code` preset plus a per-pair nonce in `append` (so each pair starts cold), `persistSession: false`, one tiny prompt asking for the working directory, two real worktrees, session 2 launched right after session 1:

| Option | Session 2 `cache_read_input_tokens` | Session 2 `cache_creation_input_tokens` |
| ------ | ----------------------------------- | --------------------------------------- |
| off    | 18,681                              | 18,784                                  |
| on     | 22,496                              | 14,781                                  |

About 3.8K tokens per additional worktree move from write to read. The 14.8K still written comes after the system prompt (the first user message: each checkout's own `CLAUDE.md`, memory index and the moved cwd block), which the option cannot share. Both answers reported the correct directory with the option on. Re-measure after an SDK bump; the split is the bundled CLI's.

## Adding an item

Add a `TokenAuditCheck` in `session/doctor/tokens/`, register it in `TOKEN_AUDIT_CHECKS` (`tokens/index.ts`) and add its name to `TOKEN_AUDIT_ITEMS`. Give each row a stable `key` built from what the row is about, never from its numbers: the diff matches rows across weeks by it. Put a number the diff should watch in `metrics` and a rule for it in `METRIC_RULES`. The checks are not in `DOCTOR_CHECKS`: a run streams gigabytes and spawns `claude`, so plain `paseo doctor` stays quick.
