# Account failover

When a Claude account runs out of budget, the agents running on it stop: a turn fails with the limit message and nothing moves them. `AccountFailoverMonitor` (`packages/server/src/server/agent-account-failover-monitor.ts`) puts each stuck agent's conversation on a healthy account in the pool. It moves the agent in place where it can, and imports the session into a new agent where it can't.

It does not depend on the account-pool routing plugin. The plugin routes new spawns and can be disconnected (see [plugins.md](plugins.md) for plugin reconnect behavior); this monitor reads the pool from daemon config and never calls the plugin, so stuck agents still move when the plugin is dark.

## Moving an agent to another account

A provider is an account: the Claude client's `CLAUDE_CONFIG_DIR` picks which one, and the session file lives under that account's directory. So changing an agent's provider is not a field update. Three things have to happen together:

1. **The live session closes.** A persisted thread has one writer, even between turns.
2. **The target's client re-opens the same handle.** The target reads the transcript from its own `projects/`; every account slot symlinks that to one shared directory, which is the only reason an account can read a session another account wrote. Without that symlink the resume finds nothing and opens an empty conversation.
3. **Both halves of the record change.** A later load resolves the client from `persistence.provider`, not `provider` (`persistence-hooks.ts`), so writing one and not the other silently resumes on the old account. Editing the JSON by hand does neither: the daemon holds records in memory and overwrites the file on the next write.

`AgentManager.moveAgentToProvider` does all three and keeps everything else — agent id, timeline, labels, model, thinking option, mode, parent and children. It also drops the `lastError` it moved away from: the cap belonged to the account being left, and carrying it across would read as the new account's own cap on the next sweep.

Reach it as `paseo agent update <id> --provider <providerId>`, or as the `agent.provider.move.request` RPC (gated on `server_info.features.agentProviderMove`).

### What it refuses

Every refusal names a code and a sentence you can act on. `packages/server/src/server/agent/provider-move.ts` owns the ones that need no I/O; the manager adds the rest.

| Code                    | When                                                          | What to do instead                                |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------------- |
| `agent_busy`            | A turn is in flight, or the agent is initializing or closed   | Cancel the turn or wait, then move it             |
| `incompatible_provider` | The target is a different session family (`claude` → `codex`) | Move within the family, or start a new agent      |
| `unknown_provider`      | Not registered on this host                                   | Pick one of the listed providers                  |
| `provider_disabled`     | Registered but disabled in `agents.providers`                 | Enable it first                                   |
| `provider_unavailable`  | The CLI is missing or the client reports unavailable          | Install or configure it                           |
| `same_provider`         | Already there                                                 | Nothing                                           |
| `no_session`            | No provider session to re-open                                | Send it a message first, or create a new agent    |
| `session_conflict`      | The target already holds another live agent on this session   | Archive or move that agent first                  |
| `session_unreachable`   | The target's account cannot see the transcript                | Share `projects/` between the accounts, or import |

A session family is the built-in provider whose client owns the transcript format, found by following `extends` to its root. Two accounts of `claude` share a family; `claude` and `codex` do not, and a codex client would open an empty conversation rather than fail loudly. `session_unreachable` is the same failure caught early, and only a provider that implements `canResumeHandle` can catch it — see [providers.md](providers.md#interfaces-to-implement).

## The pool

The pool is the `params.accountPool` of each Claude account entry in `agents.providers` (`{ role: "leader" | "worker", priority: <n> }`; [custom-providers.md](custom-providers.md) covers the entries themselves). A Claude account entry is the built-in `claude` entry or any entry with `extends: "claude"`. Entries without a valid `accountPool` are ignored.

A migration target is the enabled worker with the lowest `priority` number that is not dead this sweep and is not the account being left. Ties break by provider id. The leader account is never a target. It can be the account that ran dry, and when it isn't, it holds the budget the pool protects, so there is no "leader as last resort": with no eligible worker, the agent waits and is retried on the next sweep.

Failover rescues an agent after its turn fails. A new root agent should not reach that point: the composer does not default a new chat to a pooled account that is at a cap, and the account-pool plugin moves a root off one at create ([Root agents](../plugins/claude-account-pool/README.md#root-agents)).

## When an account is dead

Two independent signals, either one sufficient (`account-failover-detector.ts`):

- **Reactive.** An agent on the account has a limit-shaped `lastError`. One failure condemns the whole account, since every agent on it shares the cap. The match is loose on purpose (`isLimitShapedError`). It has to cover every cap message the CLI writes: "You've hit your monthly spend limit · … · your session limit resets 3:10pm" contains neither "hit your limit" nor "usage limit", and "You've hit your weekly limit · resets 7am" contains none of the older phrases. When a new cap message appears in a transcript, check it against the pattern. The evidence expires 5 hours after the failure, the Claude session window, so one stale error can't keep a recovered account out of rotation forever.

  `lastError` only exists if the provider reports the turn as failed. The Claude CLI reports a capped turn as a synthetic assistant message (`isApiErrorMessage`, `error: "rate_limit"`) followed by a `result` with `subtype: "success"` and `is_error: true`. `appendResultEvents` in the Claude provider turns that into `turn_failed`; before it did, a capped turn completed, the agent went idle with no error, and this monitor had nothing to read. Any provider added to the pool has to report a capped turn the same way. The e2e suite injects failures as `turn_failed` directly, so it cannot catch a provider that doesn't.

- **Proactive.** A usage window at or above 100%, read from the daemon's cached `ProviderUsageService` (the same rows the Host Usage screen shows). An account reporting `unavailable` with no windows is never dead on that basis: an account can serve traffic fine while its usage is unreadable.

A healthy usage reading does not clear a reactive signal. A monthly spend cap does not appear in the utilization windows at all.

This monitor is the only thing that acts on a usage window. Two others read the same rows and act on none of them, so nothing races this monitor for an account: the token-burn monitor's account-pressure leg warns at 90% ([docs/token-burn.md](token-burn.md#account-pressure)), and [budget pacing](budget-pacing.md) advises running leaders on how hard to fan out.

An account's evidence has to outlive the agent that produced it. If it stopped counting the moment that agent was rescued, the account would look healthy on the next sweep and the next stuck agent would be sent straight back onto it. The two paths keep it differently: an import leaves the retired predecessor behind on the capped account, still carrying its error; a move takes the failure with the agent and clears it, so the monitor records the evidence against the provider instead. Both age out on the same 5-hour clock, dated by the original failure.

Evidence is identified by the error text and the agent's timeline generation. A retry that fails with identical text appends timeline rows first, so it counts as a fresh failure rather than the old one.

A failure is dated by the agent's newest timeline row (its own error row), not by when the monitor first noticed it. Evidence lives in memory, so after a restart every loaded agent is seen for the first time; dating by the row keeps a days-old failure from reading as a fresh cap. Without that, the account would look dead for five more hours, and an abandoned agent would be migrated and told to resume the moment someone opened it. An old failure still moves its agent if usage shows the account at its cap.

## Which agents move

An agent is migrated when its own last turn failed on the cap, its account is dead, it is not running, closed, or initializing, it has a provider session, and it has not already been retired by an import. Leaders and subagents both move. An idle agent that merely lives on a dead account does not: it has nothing to resume, and becomes a candidate only if someone asks it to do something and that fails. The failed message is not lost, since the resume prompt tells the agent to answer it, but the rescue lands after a failed turn and up to one sweep later.

The sweep covers agents loaded in the daemon. After a restart, a stuck agent is picked up once something loads it (opening it in the app, or sending it a message).

## What a migration does

1. **Adopt, if already handed off.** If the agent already has a successor, the monitor only retires the predecessor (see [Idempotency](#idempotency)). Nothing is moved, imported, or sent.
2. **Move the agent onto the target account.** Same id, same conversation, same settings, same children.
3. **Send a resume prompt.** It tells the agent to answer the message that failed, and to create subagents with an explicit `"<target>/<model>"` provider — without that, the default provider or a role/model policy that pins one can place a new subagent back on the exhausted account.
4. **Push** the agent id → account.

A moved agent keeps the parent label and the id its parent holds, so nobody has to be told where it went. Its parent was already told "errored" when the cap hit, so after the resume prompt the monitor re-arms the finish report and the parent hears again when the work finishes ([finish-reports.md](finish-reports.md#successors)).

### When it falls back to importing

`session_conflict` is the case that happens in practice: the target still holds this conversation's retired handle from an earlier import, and reviving that handle is the right answer anyway. Any other refusal, or an unexpected failure part-way through a move, also falls back — the import path builds a fresh agent from the session id and works even when the moved agent is left closed.

The import path costs more, which is why it is second:

1. **Import the session** onto the target account through the same path as `paseo import`. The successor keeps the full conversation and the same Claude session id, and gets the predecessor's labels plus `handoff-from=<oldId>`.
2. **Retire the predecessor**: title `[MOVED → <newId>, out of budget] <title>` and label `paseo.account-failover.migrated-to=<newId>`. It is never archived. It may hold watchdogs, and archival is your call.
3. **Restore model, thinking option, and mode.** Import resets all three to provider defaults.
4. **Send a resume prompt** stating what actually got restored. It adds a third instruction a move does not need: the agent's existing subagents are still parented to the old id. Their finish reports follow `migrated-to` to the successor, but `list_agents` shows them under the old id.
5. **Push** old id → new id → account.
6. **Tell a running parent.** For an imported subagent, the parent gets a steered system message naming the new id, but only while the parent is running. Steering an idle agent starts a new turn nobody is driving, the same trap [resource-monitor.md](resource-monitor.md) describes. An idle parent gets no message; the successor keeps the parent label, so it shows up under the parent in `list_agents`, and you get the push.

Restoration is best-effort: a failure there is logged and does not undo the move or the import.

## An agent that moved but never restarted

The resume prompt is the only thing that makes a migration finish, and sending it proves nothing. `sendPromptToAgent` returns once the turn starts; a provider that refuses the turn reports that asynchronously, so the agent lands in `lifecycle: "error"` well after the send resolved. Wrapping the send in a `try` catches only the synchronous cases — no such agent, archived, a turn already active.

Nothing else will notice. The move clears the limit error, and a candidate needs a limit-shaped one, so a migrated agent that never restarted is invisible to the detector for good. Preserving the error instead would be worse: it is limit-shaped and the agent now sits on the target, so the next sweep would read it as evidence the _target_ is capped and condemn the account it was just rescued onto.

So the monitor watches every migration until its resume demonstrably landed. Each following sweep reads the agent's state: running or idle means it resumed and the watch ends; `error` means re-send, up to three sends including the original. A limit-shaped error ends the watch too — the target is capped as well, which is the detector's job and would otherwise race this queue.

When the attempts run out, the agent keeps its conversation and its place on the new account and is one message away from continuing, so the push says exactly that ("Agent moved but did not restart"). It carries `data.outcome: "needs_prompt"`, which is additive — an app that does not read it still gets the whole story from the body text.

## Idempotency

A move needs no bookkeeping. The agent is the same agent, so a repeat sweep finds it on a healthy account with no error and nothing to do; if it caps again later it is a new candidate and moves again.

An import mints a second agent, so it does need bookkeeping, and it lives on agent labels rather than in monitor state so it survives restarts:

| Label                                | On              | Meaning                                                                                  |
| ------------------------------------ | --------------- | ---------------------------------------------------------------------------------------- |
| `paseo.account-failover.migrated-to` | the predecessor | Retired. Never a candidate again. A blank value reads as unset.                          |
| `handoff-from`                       | the successor   | Names the predecessor. Same key the manual procedure writes with `paseo import --label`. |

Before doing anything, the monitor looks for an existing successor: a record whose `handoff-from` names the agent, or a record on the same provider session created after it. This covers a crash between import and retirement, and handoffs someone already did by hand. Without the lookup, a second import onto a different provider would create a duplicate, and one onto the same provider fails with `Provider session is already imported` — it does not return the existing agent. If that rejection fires anyway, because another import won a race, the monitor adopts the winner.

A conversation that has hopped accounts by import eventually needs to return to one it left, where its retired handle still holds the session. The monitor reuses that handle instead of importing again: it blanks `migrated-to` (there is no public label-removal API), strips the title prefix, and points `handoff-from` at the agent it came from. A successor that has handed the conversation back is not counted as a successor during the lookup. A target that holds a non-retired agent for the same session is skipped; that agent is someone else's live copy.

## Configuration

`agents.accountFailover` in `$PASEO_HOME/config.json`. Every field is optional, and the defaults work without any config change:

| Field                  | Default | Effect                                                                     |
| ---------------------- | ------- | -------------------------------------------------------------------------- |
| `enabled`              | `true`  | `false` stops all sweeps.                                                  |
| `migrateSubagents`     | `true`  | `false` moves leaders only and leaves subagents to their leader.           |
| `migrationConcurrency` | `3`     | Migrations run at once per sweep.                                          |
| `notifyParent`         | `true`  | `false` skips the steered message a running parent gets after an _import_. |

It is live-toggleable like `tokenBurnMonitor` and `resourceMonitor`: the monitor re-reads it every sweep, and it uses the same mutable/patch schema split so a patch that omits a field doesn't reset it. The sweep interval is fixed at 60 seconds.

## Known limits

- **Caps that outlast five hours.** A monthly spend cap can outlive its evidence. The account then looks healthy again, and one migration lands there, fails, and marks it dead for another five hours. So a capped worker is re-probed at most once per five hours.
- **Loaded agents only**, as described under [Which agents move](#which-agents-move).
- **The import fallback mints a second id.** Everything under [When it falls back to importing](#when-it-falls-back-to-importing) applies when it runs, including a parent that may relaunch the subagent before the sweep reaches it (leaving two copies). The successor inherits the predecessor's finish report ([finish-reports.md](finish-reports.md#successors)). If duplicates become a pattern there, set `migrateSubagents: false`.

For the shared monitor shape (unref'd timer, per-sweep config read, push payloads outside the closed `attentionReason` enum), see [resource-monitor.md](resource-monitor.md) and [token-burn.md](token-burn.md).
