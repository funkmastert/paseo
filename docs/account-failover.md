# Account failover

When a Claude account runs out of budget, the agents running on it stop: a turn fails with the limit message and nothing moves them. `AccountFailoverMonitor` (`packages/server/src/server/agent-account-failover-monitor.ts`) moves each stuck agent's conversation onto a healthy account in the pool. It is the daemon-side version of the manual `claude-account-handoff` procedure: import the session elsewhere, restore its settings, tell it to resume.

It does not depend on the account-pool routing plugin. The plugin routes new spawns and can be disconnected (see [plugins.md](plugins.md) for plugin reconnect behavior); this monitor reads the pool from daemon config and never calls the plugin, so stuck agents still move when the plugin is dark.

## The pool

The pool is the `params.accountPool` of each Claude account entry in `agents.providers` (`{ role: "leader" | "worker", priority: <n> }`; [custom-providers.md](custom-providers.md) covers the entries themselves). A Claude account entry is the built-in `claude` entry or any entry with `extends: "claude"`. Entries without a valid `accountPool` are ignored.

A migration target is the enabled worker with the lowest `priority` number that is not dead this sweep and is not the account being left. Ties break by provider id. The leader account is never a target. It can be the account that ran dry, and when it isn't, it holds the budget the pool protects, so there is no "leader as last resort": with no eligible worker, the agent waits and is retried on the next sweep.

## When an account is dead

Two independent signals, either one sufficient (`account-failover-detector.ts`):

- **Reactive.** An agent on the account has a limit-shaped `lastError`. One failure condemns the whole account, since every agent on it shares the cap. The match is loose on purpose and includes `spend limit` and `session limit`, because the real CLI message ("You've hit your monthly spend limit · … · your session limit resets 3:10pm") contains neither "hit your limit" nor "usage limit". The evidence expires 5 hours after the monitor first sees it, the Claude session window, so one stale error can't keep a recovered account out of rotation forever.
- **Proactive.** A usage window at or above 100%, read from the daemon's cached `ProviderUsageService` (the same rows the Host Usage screen shows). An account reporting `unavailable` with no windows is never dead on that basis: an account can serve traffic fine while its usage is unreadable.

A healthy usage reading does not clear a reactive signal. A monthly spend cap does not appear in the utilization windows at all.

A retired predecessor's error still counts as evidence until it expires. If it stopped counting at migration time, the account would look healthy on the next sweep and the next stuck agent would be sent straight back onto it.

Evidence is identified by the error text and the agent's timeline generation. A retry that fails with identical text appends timeline rows first, so it counts as a fresh failure rather than the old one. Evidence lives in memory and is rebuilt after a restart.

## Which agents move

An agent is migrated when its own last turn failed on the cap, its account is dead, it is not running, closed, or initializing, it has a provider session, and it has not already been migrated. Leaders and subagents both move. An idle agent that merely lives on a dead account does not: it has nothing to resume, and becomes a candidate only if someone asks it to do something and that fails.

The sweep covers agents loaded in the daemon. After a restart, a stuck agent is picked up once something loads it (opening it in the app, or sending it a message).

## What a migration does

1. **Adopt, if already handed off.** If the agent already has a successor, the monitor only retires the predecessor (see [Idempotency](#idempotency)). Nothing is imported or sent.
2. **Import the session** onto the target account through the same path as `paseo import`. Every account slot shares `projects/`, so the successor keeps the full conversation and the same Claude session id. The successor gets the predecessor's labels plus `handoff-from=<oldId>`.
3. **Retire the predecessor**: title `[MOVED → <newId>, out of budget] <title>` and label `paseo.account-failover.migrated-to=<newId>`. It is never archived. It may hold watchdogs, and archival is your call.
4. **Restore model, thinking option, and mode.** Import resets all three to provider defaults.
5. **Send a resume prompt** stating what actually got restored. It tells the successor to answer the message that failed, to create subagents with an explicit `"<target>/<model>"` provider, and to check subagents that are still parented to the old id. Without an explicit provider, the default provider or a role/model policy that pins one can place a new subagent on the exhausted account.
6. **Push** old id → new id → account.
7. **Tell a running parent.** For a migrated subagent, the parent gets a steered system message naming the new id, but only while the parent is running. Steering an idle agent starts a new turn nobody is driving, the same trap [resource-monitor.md](resource-monitor.md) describes. An idle parent gets no message; the successor keeps the parent label, so it shows up under the parent in `list_agents`, and you get the push.

Steps 4 and 5 are best-effort: a failure there is logged and does not undo the import.

## Idempotency

Idempotency lives on agent labels, not in monitor state, so it survives restarts:

| Label                                | On              | Meaning                                                                                  |
| ------------------------------------ | --------------- | ---------------------------------------------------------------------------------------- |
| `paseo.account-failover.migrated-to` | the predecessor | Retired. Never a candidate again. A blank value reads as unset.                          |
| `handoff-from`                       | the successor   | Names the predecessor. Same key the manual procedure writes with `paseo import --label`. |

A migration is one-shot per agent, not a re-arming alert. A retired agent stays retired. If the successor later caps on its own account, it is a new candidate and gets its own successor, so chains form without extra state.

Before importing, the monitor looks for an existing successor: a record whose `handoff-from` names the agent, or a record on the same provider session created after it. This covers a crash between import and retirement, and handoffs someone already did by hand. Without the lookup, a second import onto a different provider would create a duplicate, and one onto the same provider fails with `Provider session is already imported` — it does not return the existing agent. If that rejection fires anyway, because another import won a race, the monitor adopts the winner.

With two workers, a conversation eventually needs to return to an account it left, where its retired handle still holds the session. The monitor reuses that handle instead of importing: it blanks `migrated-to` (there is no public label-removal API), strips the title prefix, and points `handoff-from` at the agent it came from. A successor that has handed the conversation back is not counted as a successor during the lookup. A target that holds a non-retired agent for the same session is skipped; that agent is someone else's live copy.

## Configuration

`agents.accountFailover` in `$PASEO_HOME/config.json`. Every field is optional, and the defaults work without any config change:

| Field                  | Default | Effect                                                           |
| ---------------------- | ------- | ---------------------------------------------------------------- |
| `enabled`              | `true`  | `false` stops all sweeps.                                        |
| `migrateSubagents`     | `true`  | `false` moves leaders only and leaves subagents to their leader. |
| `migrationConcurrency` | `3`     | Migrations run at once per sweep.                                |
| `notifyParent`         | `true`  | `false` skips the steered message to a running parent.           |

It is live-toggleable like `tokenBurnMonitor` and `resourceMonitor`: the monitor re-reads it every sweep, and it uses the same mutable/patch schema split so a patch that omits a field doesn't reset it. The sweep interval is fixed at 60 seconds.

## Known limits

- **Parents that relaunch.** A subagent's parent gets an "errored" finish notification as soon as the subagent fails, and may relaunch it before the next sweep migrates it. That leaves two copies. The parent message says not to relaunch and to cancel one copy if it already did. If duplicates become a pattern, set `migrateSubagents: false`.
- **Caps that outlast five hours.** A monthly spend cap can outlive its reactive evidence. The account then looks healthy again, and one migration lands there, fails, and marks it dead for another five hours. So a capped worker is re-probed at most once per five hours.
- **No finish notification for the successor.** Nothing wires the successor's completion back to its parent.
- **Loaded agents only**, as described under [Which agents move](#which-agents-move).

For the shared monitor shape (unref'd timer, per-sweep config read, push payloads outside the closed `attentionReason` enum), see [resource-monitor.md](resource-monitor.md) and [token-burn.md](token-burn.md).
