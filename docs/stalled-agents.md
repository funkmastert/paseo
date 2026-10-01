# Stalled agents

An agent can sit in `running` for hours with nothing happening. Four agents once did that for 20 hours: their Claude account hit its weekly limit, the account was re-authed later, and nothing woke them. The turn never failed, so nothing that watches for failures saw them. `AgentStallSweep` (`packages/server/src/server/agent-stall-sweep.ts`) finds agents like these and does what a person would: save the worktree, then send one prompt telling the agent to resume.

It covers an agent stuck in `running` on a daemon that is up, and records [idle agents nothing will wake](#idle-agents-nothing-will-wake). An agent cut off by a daemon stop is restart recovery's, and a scheduled wake is the heartbeat's.

## What counts as a stall

Every five minutes the sweep looks at each non-internal agent in `running`. It is stalled when all of these hold:

- **No pending permission.** A permission is waiting on a person, and a person has already been told.
- **Not the done janitor's question.** That turn is the janitor's ([done-janitor.md](done-janitor.md)), and it has its own timeout.
- **Not queued for admission.** A child waiting for a slot shows `running` with no turn started ([resource-monitor.md](resource-monitor.md#child-admission-and-resume-pacing)).
- **No activity for `stallMinutes`.** Activity is the newest of the timestamps the agent manager already holds (timeline rows, turn start, state changes), token usage changing between sweeps, and the activity of any provider subagent still reported running. Usage is compared by the sweep itself because a usage update touches no timestamp. A running subagent counts only by its own activity: a child that hung long ago does not keep its parent looking busy.
- **An idle process tree.** The agent's process tree (found by `callerAgentId`, as in [resource-monitor.md](resource-monitor.md)) used at most `idleCpuPercent` CPU on every sweep in the window, across at least two samples.

The CPU check is there because the timeline is not enough. A tool call that runs a 40-minute build or test suite writes no timeline row until it returns, so on the timeline alone it looks exactly like a stall, and nudging it replaces the run and kills the build. The build shows up in `ps`. A tree the sweep has not sampled before carries `ps`'s lifetime-average CPU, which says nothing about now, so the first sighting counts as neither busy nor idle; after a daemon restart the sweep needs about 15 minutes before it can act. An agent with no attributable process reads as idle, the same as in the resource monitor. If `ps` returns nothing, the sweep skips that pass rather than guess.

## The nudge

When the agent's account is usable (`readProviderHealth`, the done janitor's check), the sweep:

1. Snapshots the worktree through the `WorktreeSnapshotter` ([work-snapshots.md](work-snapshots.md)): a commit under `refs/backup/` that never touches the agent's index, tree or HEAD. A failed snapshot is recorded and does not stop the nudge; the prompt says it failed.
2. Sends one resume prompt in a `<paseo-system>` envelope through `sendPromptToAgent` with `activeTurnBehavior: "interrupt"`, which replaces the stuck run. It is the one daemon prompt that interrupts on purpose: every other message steers into a turn or waits behind it, and a steer would join the dead turn or wait behind it forever. The idle process tree is also why no background workflow is lost. The send waits its turn in the daemon's shared resume pace ([resource-monitor.md](resource-monitor.md#child-admission-and-resume-pacing)), so a sweep that finds several stalls restarts them a few a minute; the sweep waits, and skips ticks while it does. The prompt says how long the daemon saw no activity, that the account is healthy, and where the snapshot is, and asks the agent to resume or to say what it is waiting on.
3. If the replace fails because the dead session refuses the cancel, it reloads the session and sends the prompt again. If that fails too, the agent cannot be nudged.

One nudge per stall episode. The episode stays open until the agent does something after the nudge; the nudge's own prompt row and turn start, in the two minutes after it, do not count.

## The judgment

With a JEV key, the sweep asks JEV once per episode, right before the nudge, what the agent's recent activity shows: progressing, looping, blocked on missing information, or waiting on a person ([Feature 10](jev.md#feature-10-stall-judgment) has the question, the floors and what is sent). Code turns the answer into one of the things the sweep already does:

- **Progressing, with a tool call still running:** one more `stallMinutes` before the nudge, once per episode. The observation carries the hold as `holdMs`, which the ladder adds to the grace, a `graceMinutes` override included, so its recheck still starts at the nudge.
- **Looping:** the nudge names the repeated step and asks for a different approach.
- **Blocked on missing information, or waiting on a person:** the nudge asks the agent to name what it lacks, or to end its turn with the question, and the observation carries `escalation.personFirst`. The ladder decides whether that sends the episode to a person instead of an agent.

A judgment never cancels, interrupts or blocks an agent. It is shadow by default, so the sweep nudges exactly as it would without JEV and records what it would have done. A capped account's handoff is never judged, and a dry-run or disabled sweep asks nothing.

## The loop watch

The time-based rule cannot see an agent that keeps running while it goes in circles. For a running agent that is not a stall candidate, code looks for a repeat in its last 12 tool calls: one tool with the same input 4 or more times, or one error text 3 or more times. Waiting on purpose does not count: `paseo wait`, `gh run watch`, `sleep`, `wait_for_agent`, reading a background shell's output (`cat …/tasks/<id>.output` included), and an orchestrator checking its agents (`paseo ls`, `get_agent_status`, `get_agent_activity`, `list_agents`). Only a repeat is sent to JEV. Two `looping` answers in a row put `looping-agent:<agentId>` on the ladder as a `notice` for the digest. After any other answer the same repeat is left alone for 30 minutes. The episode closes when the repeat stops. Nothing interrupts the agent.

Each agent gets at most 3 JEV calls an hour across the judgment and the loop watch, and the loop watch asks at most 8 agents a sweep, so a looping agent cannot spend the `control` lane's budget.

## Idle agents nothing will wake

An idle agent waits for something to start its next turn, and usually something will. Claude Code starts a turn when one of the agent's own background shells, monitors, subagents or workflows ends (`providers/claude/agent.ts`, the task notification). A running Paseo child's finish report wakes its parent. A schedule or heartbeat wakes its target. The sweep looks for the endings where nothing will, in two classes (`agent/background-wait.ts`):

- **Own work.** The final turn launched background work: a background shell (Claude answers `run_in_background` with "running in background with ID"), a monitor, a workflow, a subagent, or a Paseo agent. Nothing of it is still running, and the last message says the agent is waiting. Whatever should have woken it did not. The final turn is everything since the last user message; a turn a task notification started has none, so it counts with the turn before it. A Task card cannot say whether it ran in the background, so any subagent counts.
- **External wait.** The last message says the agent is waiting on CI, a PR, its checks, a review by Bugbot or Lore, a deploy or the merge queue, and the final turn launched nothing. A child's external wait is skipped: its parent got the child's finish report and owns what comes next.

Both classes need all of these:

- idle and quiet for 10 minutes, no pending permission, no janitor question, and a last turn that did not fail. A limit failure is [account failover](account-failover.md)'s, and a prompt row would re-date it.
- not retired by account failover (`paseo.account-failover.migrated-to`). Its successor carries the work, as in the done janitor and away-reply.
- no schedule or heartbeat targets it, its final turn set up no wakeup (`ScheduleWakeup`, `create_schedule`, `create_heartbeat`), and restart recovery is not about to resume it.
- no provider subagent runs for it. None of its Paseo children is running, waiting on a provider subagent, about to be resumed by restart recovery, or idle with a live shell under it. A child's parent label is followed through `migrated-to`, so a successor leader whose children still name the old id is covered.
- no live shell is left under its process tree. Claude runs every command in a shell that lives until the command ends: `zsh -c …`, or Git Bash on Windows. A command detached from its shell (`nohup … &`) leaves the tree and reads as ended. A shell is told by its executable's basename, which handles a quoted Windows path with spaces; on Windows the sampler's image name decides.
- an attributable tree, or a Claude-family provider. Trees are found by `callerAgentId` in a command line, and Claude's root always carries it. Codex's `app-server` and OpenCode's shared `serve` do not, so an agent on any other provider with no tree is skipped: a build running under it cannot be seen.
- a usable account. A resume on a capped account fails at once and hands failover an agent nobody needed to run.

Only the last 600 characters of the message count, and only a sentence that states the agent's own wait. These do not: a last paragraph with a question mark outside a URL or code span (`**Merge now?**` included), a wait on a person, a table row or a list item, a narrated or past-tense wait ("got stuck waiting", "was waiting"), double-quoted text, "in the background" without a first-person subject ("The sweep runs in the background"), and generic nouns (reports, results, findings, output, runs, checks).

### Record-only

The rule sends nothing. `BACKGROUND_WAIT_LIVE` in `background-wait.ts` is `false`, so every sweep takes the dry-run branch and writes a `would-resume` line, whatever `stalledAgents.dryRun` says. At the agent's next idle check after new activity, a `background-wait-outcome` line records what started its next turn (the resume, another prompt, or the agent itself), whether that turn did tool work or ended waiting again, and the minutes until it went idle. A would-resume the agent then sat on for hours is a resume it needed. One followed minutes later by a person's prompt was not. Flip the constant once a week of these lines shows a class earns it; the classes can be judged apart.

Live, each class gets one prompt in a `<paseo-system>` envelope quoting the sentence it ended on. Own work is told to check the result and continue. An external wait is told that nothing is watching it, and to check it now or set up a watcher before it ends its turn. The prompt steers rather than interrupts and is paced like a nudge. One prompt per final message, at most 3 per agent a day, from the `maxNudgesPerSweep` budget after the stalls. The caps live in memory, so a daemon restart resets them. A resume can re-trigger: an agent that answers "still waiting on X" gets another 10 minutes later, until the day's cap. The rule is code only: no JEV call, and it runs with JEV off. A disabled sweep leaves it alone.

### What a replay of the transcripts showed

A replay ran every end-of-turn message in this fleet's Claude transcripts through the matchers and the classes. Over 2026-09-23 to 09-30 (1,920 sessions, 3,524 endings), 26 endings fall into a class with 10 quiet minutes and no API error. The transcript shows what woke each, so it shows what the sweep would have seen at the 10-minute mark:

| Class         | In the class | Suppressed                                                                                                                                                      | Would resume | True positive | False positive |
| ------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------- | -------------- |
| Own work      | 20           | 20: 15 woken by their own task notification after the mark, 5 with a background shell still alive past it (a CI poll, a merge gate, a rerun loop, two watchers) | 0            | 0             | 0              |
| External wait | 6            | 5: 2 with a schedule, 2 with a shell still alive past the mark, 1 a worker whose leader merged the PR and messaged it                                           | 1            | 1             | 0              |

The one resume is a PR "waiting on CI before I merge it" with nothing watching CI; a person moved it on 16 minutes later. The same replay of the rule before the classes, over 09-22 to 09-29, resumed 8 endings, 7 of them wrongly: a schedule-driven watchdog twice, a worker waiting on its leader's review, a recommendation to a person, two handoffs waiting on an orchestrator's go, and a lead whose idle children were waiting on live shells. None is in either class now.

Own work found nothing to resume: every time, the work was still running at the mark or Claude woke the agent when it ended. Its true positives are the cases a transcript does not show: a shell killed with its process, a notification lost in a restart. The outcome lines measure it.

## The handoff to account failover

When the account is at its cap (or otherwise unusable), a nudge would fail the same way, and moving agents between accounts is [account failover](account-failover.md)'s job. Failover moves only an agent whose last turn failed with a limit-shaped `lastError`, and a turn stuck in `running` never fails. So after `deadAccountStallMinutes` with no progress the sweep cancels the turn with the `account-capped` cancel reason. That cancel leaves a limit-shaped `lastError` naming the account and a system-error timeline row. The row matters: failover dates a failure by the newest row, and without one a turn stuck for 20 hours would date its failure 20 hours back, past failover's five-hour window. Failover moves the agent on its next sweep. The sweep never moves an agent itself.

## The ladder

Every stall is reported to the remediation ladder ([remediation.md](remediation.md)) each sweep as `stalled-agent:<agentId>`, at level `alert`. After a nudge or handoff the remedy is `live` with a grace of `recheckMinutes`: if the agent is still stuck when that runs out, the ladder sends one agent to look at its process, provider logs and account and recover it without losing work. An agent the sweep could not nudge is reported with no remedy and goes to that agent at once. The sweep sends no push of its own; the ladder does. The episode closes when the agent shows activity again or leaves `running`.

## What it never does

- Act on an agent waiting on a permission, answering the done janitor, queued for admission, or with a busy process tree.
- Nudge an agent twice in one episode, or resume an idle agent twice for the same last message.
- Send an idle agent anything while `BACKGROUND_WAIT_LIVE` is `false`.
- Cancel, interrupt or hold back an agent on a JEV answer, or act on a shadow answer.
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

The judgment and the loop watch are switched under `agents.jev.stallJudgment` ([Config](jev.md#config)); their thresholds and the background-wait rule's are code constants in `agent/stall-judgment.ts` and `agent/background-wait.ts`.

`grep '"monitor":"stalled-agent-sweep"' daemon.log` shows the mode the sweep last resolved. `$PASEO_HOME/jev/stall-judgments.jsonl` holds every judgment, loop report, background-wait line and its outcome ([Feature 10](jev.md#measuring-feature-10)).
