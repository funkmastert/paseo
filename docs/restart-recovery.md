# Restart recovery

A daemon stop closes every agent, and nothing used to restart one that was mid-turn. It sat closed until someone opened it, and the [done janitor](done-janitor.md) archived it three days later. Restart recovery finds those agents on the next boot and resumes them, leaders first. The code is in `packages/server/src/server/agent/restart-recovery/`. It ports OpenRig's restore check and crash-cart restore (plan items OR-C1, OR-C4, OR-H2) without the tmux parts.

## The run marker

Each agent record carries an optional `runMarker: { startedAt, endedAt?, endedBy? }`. `RunMarkerTracker` writes it from `AgentManager.emitState`. It opens a marker at the edge into `running` and settles it at the edge out, with `endedBy` set to the lifecycle the agent landed in. It writes once per edge, not once per state emission.

A marker with no `endedAt` is open. Two rules keep an open marker meaning "interrupted":

- **Shutdown does not settle.** After `prepareForShutdown`, closing an agent leaves its marker open. The agent did not finish; the daemon stopped it. A crash writes nothing at all. Both cases look the same on the next boot, so recovery does not need to tell them apart.
- **Only this process settles its own markers.** Loading an agent that an earlier daemon interrupted, or looking at it, does not settle its marker. A new run replaces the marker. Recovery's dismiss settles it with `endedBy: "dismissed"`.

`AgentStorage.updateRunMarker` is the only write that changes the field. Every other write carries the stored value forward, because snapshot and metadata writes rebuild the record from a copy that may not have the marker. Durable finish reports store `finishObligations` the same way, and one function, `carryOwnedFields` in `agent-storage.ts`, carries both.

## Boot

`RestartRecoveryService.capture` runs right after agent storage loads, before anything can load or prompt an agent. It reads every unarchived, non-internal record with an open marker. That list is the episode. Later plans re-read the records, so they reflect what happened after boot.

`agents.restartRecovery.mode` in `config.json` sets what happens at boot. It is read once, at startup:

| Mode             | At boot                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| `off`            | One log line. The app strip stays hidden.                                |
| `plan` (default) | Logs each interrupted agent with its readiness. The app shows the strip. |
| `resume`         | Logs the plan, then applies it.                                          |

The RPCs work in every mode. `plan` stays the default until the chaos test below has passed on Tyler's machine.

## The plan

Each entry is checked for reachability, not continuity. Nobody can prove the model will carry on exactly where it stopped, so the check does not claim it.

| Check        | Red when                                                    |
| ------------ | ----------------------------------------------------------- |
| `session`    | The record has no provider session                          |
| `workspace`  | The working directory is gone                               |
| `provider`   | The provider is unavailable                                 |
| `transcript` | `canResumeHandle` says this account cannot read the session |
| `account`    | Never. Yellow when the last error was a usage limit         |
| `live`       | The agent is already running in this daemon                 |

A probe that throws, or a provider that cannot tell (`canResumeHandle` is missing, as for Codex), gives `unknown`, not red. The rollup is `not_restorable` if any check is red, then `unknown`, then `restorable_with_caveats` for yellow, else `restorable`. Apply attempts everything except `not_restorable`.

Entry states are `pending`, `resuming`, `resumed`, `failed`, `not_attempted` and `dismissed`. An entry that ran again outside recovery, was archived, or lost its record is `not_attempted`, with the reason in `detail`.

## Apply

`depth` counts an entry's ancestors that are also in the episode, following `paseo.parent-agent-id` through idle ancestors. Apply resumes depth 0 first. Each depth waits until every agent in the depth before it has started its run, with up to four resuming at a time.

Resuming an agent is `sendPromptToAgent` with one `<paseo-system>` prompt (`envelope.ts`). The prompt names the interrupted turn and says what survived it and what did not. It tells a leader which of its children recovery is bringing back, so the leader does not relaunch them. It tells a child that its parent was resumed first. A resume that fails is recorded as `failed` with the error, and the agent stays closed. It never falls back to a fresh agent. After the waves finish, each resumed parent gets one steer that lists the mid-turn children recovery could not bring back.

`stop()` runs first in daemon shutdown. An apply stops before its next wave.

## The finish-report seam

Recovery decides who was mid-turn. [Durable finish reports](finish-reports.md) decide who is owed a wake. Recovery is captured first at boot, then the finish-report ledger. An agent must not get both a recovery prompt and a finish-report wake.

`RestartRecoveryService.isAboutToResume(agentId)` returns true while recovery has claimed an agent and not finished with it. In `resume` mode that covers the whole episode from construction until the boot apply reaches each agent. During any apply it covers the agents still queued. `FinishObligationService` takes it as `isClaimedByRestartRecovery` and leaves an obligation alone while its child or its owner is claimed: no park, no report, no wake. Once recovery resumes the child, the sweep sees it running and attaches its watcher as usual, so the leader's recovery prompt tells it the reports survived. In `plan` mode nothing is claimed, and finish reports behave as they do without recovery.

## Who owns what

One owner per case, so no agent is resumed twice:

| Case                                     | Owner                                         | How the others stay out                                                                                                                           |
| ---------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cut off mid-turn by a daemon stop        | Restart recovery                              | Finish reports and [account failover](account-failover.md) skip a claimed agent. The done janitor treats an open marker as neither dead nor done. |
| Stalled in `running` on a live daemon    | The [stalled-agent sweep](stalled-agents.md)  | A restart-cut agent is not `running` until something resumes it, so the sweep never sees it.                                                      |
| A turn that failed on a dead account     | [Account failover](account-failover.md)       | Recovery resumes on the agent's own account. If that turn hits the cap, failover takes it like any other capped turn.                             |

## Surfaces

- CLI: `paseo recover` shows the plan. `--apply [agentIds...]` resumes. `--dismiss [agentIds...]` leaves agents closed and stops offering them. `--full` shows green checks too. `--json` returns the plan.
- App: `RestartRecoveryStrip` in the sidebar, beside the device and MCP strips. It is hidden unless the host has recovery on and something is still waiting. It offers Resume all and Dismiss.
- RPCs: `agent.restart_recovery.{get_plan,apply,dismiss}.request`, gated on `server_info.features.restartRecovery`.

## The done janitor

An agent with an open marker is neither dead nor askable (`interruptedMidTurn` in `done-janitor-detector.ts`). This holds in every mode, including `off`. An interrupted agent that nobody resumes or dismisses stays unarchived. That is deliberate: this is the case that used to lose work.

## Proof

`packages/server/src/server/daemon-e2e/restart-recovery-chaos.e2e.test.ts` runs the daemon in its own process. A leader and two children are held mid-turn (the fake provider's `hold the turn open` prompt), then the process is SIGKILLed. The next daemon on the same `PASEO_HOME` must list all three through the real `paseo recover --plan`, resume the leader first through `--apply`, and settle their markers so a third daemon has nothing to recover. Two more cases cover a clean SIGTERM plus a dismiss that lasts, and `resume` mode at boot.

## Limits

- An agent that was idle with background work when the daemon stopped has no open marker. That work is gone, and recovery does not see it.
- A permission request that was waiting when the daemon stopped is not replayed. The prompt says it was dropped.
- `previousShutdown` reads `unknown`. The daemon shutdown receipt ([daemon-vitals.md](daemon-vitals.md)) exists, but `daemon-worker.ts` consumes it before the daemon is built and nothing passes it to `readPreviousShutdown` yet.
