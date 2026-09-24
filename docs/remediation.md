# Remediation ladder

A monitor that finds something wrong fixes it itself when it can, hands it to one bounded agent when it cannot, and tells a person only when both fail. The ladder (`packages/server/src/server/remediation/`) owns every step after detection, so no monitor on it decides on its own when to push.

## The rule

A monitor with an automatic remedy runs it and records what it did at `record` (ledger only). A person is told only when:

- no remedy exists and no agent can help;
- the remedy exists but is turned off or in dry run, so it could not act;
- the remedy ran, a remediation agent ran, and the condition persists, or the agent reported it could not fix it, or no agent could run (escalation off, the daily cap spent, no usable account).

That tells you a monitor's push level too: see "Rank by what happens" in [notification-policy.md](notification-policy.md#levels).

## The rungs

1. **Deterministic.** The monitor detects the condition and runs its remedy with no LLM. Every sweep it reports to the ladder through `RemediationSink.observe()` (`remediation/contract.ts`): whether the condition holds, what state the remedy is in, what it tried, and the evidence it found.
2. **One bounded agent.** When a `live` remedy has not cleared the condition within its grace window, or there is no remedy but the observation names an `escalation.task`, the ladder creates one agent for the key. A `disabled` or `dry-run` remedy skips this rung: the operator opted out of automation. So does an observation with no `escalation`.
3. **A person.** One push per episode, at the observation's `level` (default `alert`), `dedupeKey: remediation:<key>`. The body says what is wrong, what rung 1 tried, and how rung 2 ended. When an agent ran, the push opens it; the ladder leaves it unarchived for that.

## Episodes

The ladder keeps one episode per key (`orphan-build-daemons`, `stalled-agent:<agentId>`, `work-at-risk:<path>`). A monitor calls `observe()` every sweep; repeats are free.

- The first active observation opens the episode, recorded at `record`. The grace window runs from here: `conditions.<kind>.graceMinutes`, else the observation's `graceMs`, else 0. With grace 0, a remedy-less condition with a task escalates on its first sweep.
- The first inactive observation closes it, recorded at `record` with the attempts. An agent still running then finishes, and its report still counts: NOT_FIXED reaches rung 3 even though the condition cleared. The work-at-risk sweep relies on this.
- An agent that reports FIXED while the monitor still reports the condition gets one more grace window, then rung 3, never a second agent.
- Rung 3 fires at most once per episode.
- Starting an agent sets the key's cooldown. A new episode for the key inside it skips rung 2 and goes to rung 3 once its grace runs out.
- An episode waiting for a free agent slot (`maxConcurrent`) waits silently and retries on the next observation.

## The remediation agent

The ladder creates it through the normal create path (`createAgentCommand`, `kind: "mcp"`) as a root, background agent with no finish notification. It passes the provider only (`escalation.provider`), so the classifier decides model, thinking and account from the labels:

| Label                   | Value                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `paseo.task-class`      | the observation's `escalation.taskClass`, else `conditions.<kind>.taskClass`, else the config's |
| `paseo.budget`          | `budgetTokens` (per condition, else the config's)                                               |
| `paseo.remediation`     | the condition kind                                                                              |
| `paseo.remediation-key` | the episode key                                                                                 |
| `paseo.agent-type`      | `worker`                                                                                        |

It runs in the observation's `escalation.cwd`, else the home directory. The prompt (`remediation/escalation.ts`) carries the condition, the summary, the evidence cut at 8 KB, the attempts, the monitor's task, and these limits: stay inside the task; no pushes to shared company forges; never restart the Paseo daemon or edit `~/.paseo/config.json`; never touch another agent's worktree except as the task says; never delete uncommitted work.

The agent ends its final message with exactly one line:

```
REMEDIATION: FIXED — <what it did and how it confirmed the condition cleared>
REMEDIATION: NOT_FIXED — <what is wrong and what a person has to do>
```

The ladder reads the last non-empty line strictly. Anything else, including markdown around the line or a hyphen for the dash, is NOT_FIXED.

| How it ended                                         | What the ladder does                       |
| ---------------------------------------------------- | ------------------------------------------ |
| FIXED                                                | Archives the agent, records it at `record` |
| NOT_FIXED, or no report line                         | Rung 3, agent left unarchived              |
| No report after `timeoutMinutes`                     | Cancels the turn, rung 3                   |
| Past `budgetTokens` while running                    | Cancels the turn, rung 3                   |
| Errored, archived or removed by someone else         | Rung 3                                     |
| Could not be created, or every pooled account is out | Rung 3, no agent                           |

"No usable account" means every enabled account in the Claude account pool is dead or capped (for a provider outside the pool, the provider itself). The ladder reads that with the done janitor's `readProviderHealth`, so both agree on what dead means.

## State and restarts

`$PASEO_HOME/remediation/state.json` holds the episodes, each key's cooldown, the daily count and the in-flight agent ids, written atomically on every change. After a restart the ladder reconciles in-flight agents by id and carries on: it never re-spawns one and never forgets a cooldown. An agent the restart left unloaded is waited on until its timeout. A state file that fails to parse is logged and replaced by an empty one.

The ladder polls in-flight agents every 60 seconds on an unref'd timer and re-reads `agents.remediation` on every poll and every observation, so config changes apply without a restart. Its mode lines are `remediation-escalation` and `remediation-notify`.

## Config

`agents.remediation` in `config.json`, live via `paseo daemon reload`. The resolvers and their defaults are in `remediation/config.ts`.

| Key                                                              | Default  | What it does                                                                  |
| ---------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| `remedies.enabled`                                               | `true`   | Master switch for the self-heal sweeps (rung 1). Off, they report `disabled`. |
| `escalation.enabled`                                             | `true`   | Rung 2. Off, every condition that would get an agent goes to rung 3.          |
| `escalation.provider`                                            | `claude` | Provider the agent is created with. The classifier still picks the account.   |
| `escalation.taskClass`                                           | standard | `paseo.task-class` when neither the observation nor the condition sets one.   |
| `escalation.budgetTokens`                                        | 2000000  | `paseo.budget`, and the token count the ladder cancels at.                    |
| `escalation.cooldownMinutes`                                     | 240      | Per key, how long after an agent starts before the key may start another.     |
| `escalation.timeoutMinutes`                                      | 45       | An agent that has not reported by then is cancelled.                          |
| `escalation.maxConcurrent`                                       | 2        | Agents in flight at once, across all keys.                                    |
| `escalation.maxPerDay`                                           | 12       | Agents started per UTC day. Past it, rung 3.                                  |
| `notify.enabled`                                                 | `true`   | Rung 3. Off, rung 3 goes to the ledger at `record` and nobody is pushed.      |
| `conditions.<kind>.graceMinutes`                                 | —        | Overrides the monitor's grace window.                                         |
| `conditions.<kind>.escalate`                                     | —        | `false` skips rung 2 for this kind.                                           |
| `conditions.<kind>.notify`                                       | —        | `false` sends this kind's rung 3 to the ledger only.                          |
| `conditions.<kind>.cooldownMinutes`, `budgetTokens`, `taskClass` | —        | Per-kind overrides of the escalation values.                                  |

`stalledAgents`, `disk` and `workSnapshots` belong to their sweeps; see the condition table.

## Plugging in a monitor

Take a `RemediationSink` at construction. `bootstrap.ts` creates one forwarding sink (`createForwardingRemediationSink()`) before the monitors and attaches the ladder once the WebSocket server exists; an observation before then is dropped, and the monitor reports again next sweep. Report every sweep while the condition holds and once after it clears. Accumulate `attempts` across the episode yourself. Do not push about the condition: the ladder owns that push. Test against a fake sink that records observations.

Add a row below for a new kind, and add the kind to `RemediationConditionKind`.

## Conditions

Keyed by the observation's `key`, not its `kind`: `account-pool-exhausted` and `account-failover-stranded` share the kind `account-pool-exhausted` but are separate episodes from separate monitors.

| Key                         | Monitor                                                                                          | Remedy (rung 1)                                                                     | Escalation task (rung 2)                                                        | Rung 3 level                            |
| --------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------- |
| `orphan-build-daemons`      | [resource monitor](resource-monitor.md#the-machine-level-conditions-ride-the-remediation-ladder) | the build daemon reaper                                                             | Stop the orphaned daemons the reaper spared that are safe to stop               | `alert` live, `notice` disabled/dry-run |
| `system-memory`             | [resource monitor](resource-monitor.md#the-machine-level-conditions-ride-the-remediation-ladder) | the reaper's pass plus the artifact janitor                                         | Stop provably leftover processes holding memory                                 | `alert`                                 |
| `cpu-saturation`            | [resource monitor](resource-monitor.md#the-machine-level-conditions-ride-the-remediation-ladder) | the reaper's pass, lowering the heaviest child agent trees, holding child admission | Only when sampling fails: find what loads the CPU, stop only provable leftovers | `notice` with a cause, `alert` without  |
| `disk-critical`             | [disk pressure](disk-pressure.md#the-three-conditions)                                           | sweeper reclaim, done janitor, artifact janitor                                     | Reclaim only provably safe disk space                                           | `urgent`                                |
| `disk-low`                  | [disk pressure](disk-pressure.md#the-three-conditions)                                           | sweeper reclaim, done janitor, artifact janitor                                     | Reclaim only provably safe disk space                                           | `alert`                                 |
| `disk-falling`              | [disk pressure](disk-pressure.md#the-three-conditions)                                           | sweeper reclaim, done janitor, artifact janitor                                     | Reclaim only provably safe disk space                                           | `alert`                                 |
| `stalled-agent`             | [stalled agents](stalled-agents.md#the-ladder)                                                   | resume nudge, or handoff to account failover                                        | Recover the stuck agent without losing its work                                 | `alert`                                 |
| `work-at-risk`              | [work snapshots](work-snapshots.md#the-judge)                                                    | none (already snapshotted)                                                          | Judge whether the snapshot needs follow-up                                      | `alert`                                 |
| `account-pool-exhausted`    | [token burn](token-burn.md#when-the-pool-cannot-route-at-all)                                    | none                                                                                | none: it needs an account                                                       | `urgent`                                |
| `account-failover-stranded` | [failover](account-failover.md#when-tyler-hears)                                                 | none                                                                                | none: it needs an account                                                       | `urgent`                                |
