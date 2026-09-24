# Stalled agents

An agent can sit in `running` for hours with nothing happening. Four agents once did that for 20 hours: their Claude account hit its weekly limit, the account was re-authed later, and nothing woke them. The turn never failed, so nothing that watches for failures saw them. `AgentStallSweep` (`packages/server/src/server/agent-stall-sweep.ts`) finds agents like these and does what a person would: save the worktree, then send one prompt telling the agent to resume.

It covers only an agent stuck in `running` on a daemon that is up. An agent cut off by a daemon stop is restart recovery's, and a scheduled wake is the heartbeat's.

## What counts as a stall

Every five minutes the sweep looks at each non-internal agent in `running`. It is stalled when all of these hold:

- **No pending permission.** A permission is waiting on a person, and a person has already been told.
- **Not the done janitor's question.** That turn is the janitor's ([done-janitor.md](done-janitor.md)), and it has its own timeout.
- **No activity for `stallMinutes`.** Activity is the newest of the timestamps the agent manager already holds (timeline rows, turn start, state changes), token usage changing between sweeps, and the activity of any provider subagent still reported running. Usage is compared by the sweep itself because a usage update touches no timestamp. A running subagent counts only by its own activity: a child that hung long ago does not keep its parent looking busy.
- **An idle process tree.** The agent's process tree (found by `callerAgentId`, as in [resource-monitor.md](resource-monitor.md)) used at most `idleCpuPercent` CPU on every sweep in the window, across at least two samples.

The CPU check is there because the timeline is not enough. A tool call that runs a 40-minute build or test suite writes no timeline row until it returns, so on the timeline alone it looks exactly like a stall, and nudging it replaces the run and kills the build. The build shows up in `ps`. A tree the sweep has not sampled before carries `ps`'s lifetime-average CPU, which says nothing about now, so the first sighting counts as neither busy nor idle; after a daemon restart the sweep needs about 15 minutes before it can act. An agent with no attributable process reads as idle, the same as in the resource monitor. If `ps` returns nothing, the sweep skips that pass rather than guess.

## The nudge

When the agent's account is usable (`readProviderHealth`, the done janitor's check), the sweep:

1. Snapshots the worktree through the `WorktreeSnapshotter` ([work-snapshots.md](work-snapshots.md)): a commit under `refs/backup/` that never touches the agent's index, tree or HEAD. A failed snapshot is recorded and does not stop the nudge; the prompt says it failed.
2. Sends one resume prompt in a `<paseo-system>` envelope through `sendPromptToAgent`, which replaces the stuck run. The prompt says how long the daemon saw no activity, that the account is healthy, and where the snapshot is, and asks the agent to resume or to say what it is waiting on.
3. If the replace fails because the dead session refuses the cancel, it reloads the session and sends the prompt again. If that fails too, the agent cannot be nudged.

One nudge per stall episode. The episode stays open until the agent does something after the nudge; the nudge's own prompt row and turn start, in the two minutes after it, do not count.

## The handoff to account failover

When the account is at its cap (or otherwise unusable), a nudge would fail the same way, and moving agents between accounts is [account failover](account-failover.md)'s job. Failover moves only an agent whose last turn failed with a limit-shaped `lastError`, and a turn stuck in `running` never fails. So after `deadAccountStallMinutes` with no progress the sweep cancels the turn with the `account-capped` cancel reason. That cancel leaves a limit-shaped `lastError` naming the account and a system-error timeline row. The row matters: failover dates a failure by the newest row, and without one a turn stuck for 20 hours would date its failure 20 hours back, past failover's five-hour window. Failover moves the agent on its next sweep. The sweep never moves an agent itself.

## The ladder

Every stall is reported to the remediation ladder ([remediation.md](remediation.md)) each sweep as `stalled-agent:<agentId>`, at level `alert`. After a nudge or handoff the remedy is `live` with a grace of `recheckMinutes`: if the agent is still stuck when that runs out, the ladder sends one agent to look at its process, provider logs and account and recover it without losing work. An agent the sweep could not nudge is reported with no remedy and goes to that agent at once. The sweep sends no push of its own; the ladder does. The episode closes when the agent shows activity again or leaves `running`.

## What it never does

- Act on an agent waiting on a permission, answering the done janitor, or with a busy process tree.
- Nudge an agent twice in one episode.
- Move an agent to another account.
- Write to the agent's worktree, index or HEAD.
- Act when `ps` fails.

## Config

`agents.remediation.stalledAgents`, read fresh every sweep, so a `patchDaemonConfig` takes effect on the next one. Defaults live in `resolveStalledAgentSweepConfig` (`packages/server/src/server/remediation/config.ts`).

| Key                       | Default | Meaning                                                                                               |
| ------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `enabled`                 | `true`  | Off (or `remediation.remedies.enabled: false`): stalls are reported as `disabled`, nothing is touched |
| `dryRun`                  | `false` | Log what it would do; stalls are reported as `dry-run`                                                |
| `stallMinutes`            | `30`    | Quiet time before a stall on a usable account                                                         |
| `deadAccountStallMinutes` | `15`    | Quiet time before a stall on a capped account; a turn still making progress is left to end on its own |
| `recheckMinutes`          | `20`    | The ladder's grace after a nudge or handoff                                                           |
| `idleCpuPercent`          | `5`     | Process-tree CPU at or below this is idle                                                             |
| `maxNudgesPerSweep`       | `4`     | Nudges and handoffs per sweep, longest stalled first; the rest wait a sweep                           |
| `snapshot`                | `true`  | Snapshot the worktree before acting                                                                   |

`grep '"monitor":"stalled-agent-sweep"' daemon.log` shows the mode the sweep last resolved.
