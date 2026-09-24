# Account failover

When a Claude account runs out of budget, the agents running on it stop: a turn fails with the limit message and nothing moves them. `AccountFailoverMonitor` (`packages/server/src/server/agent-account-failover-monitor.ts`) puts each stuck agent's conversation on a healthy account in the pool, and moves the idle roots on that account before Tyler asks them for anything. It moves an agent in place where it can, and imports the session into a new agent where it can't.

It is rung 1 of the [remediation ladder](remediation.md) for account limits. You hear about a cap only when no account can take the work: see [When Tyler hears](#when-tyler-hears). It replaces two stopgaps in `~/bozeo-ops/`: the one-shot `rehome.mjs` and the continuous `failover-watch.mjs`, which runs as the LaunchAgent `sh.bozeo.failover-watch`. Once a daemon with this build is running, retire the watcher with `launchctl bootout gui/$(id -u)/sh.bozeo.failover-watch` and delete its plist from `~/Library/LaunchAgents/`. Leave both scripts where they are.

It moves as little as it can, and never moves anyone back. An account move is a cache rebuild: each account keeps its own prompt cache, so the agent's next turn re-reads its whole history at the full input price, about ten times a cache hit. Agents spend about 97% of their tokens re-reading cached history, and on 2026-09-24 one leader session showed 18 rebuilds over 50K tokens, the largest 599,666. So failover moves an agent only when it cannot run where it is — see [Which agents move](#which-agents-move).

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

The pool is the `params.accountPool` of each Claude account entry in `agents.providers` (`{ role: "leader" | "worker", priority: <n> }`; [custom-providers.md](custom-providers.md) covers the entries themselves). A Claude account entry is the built-in `claude` entry or any entry with `extends: "claude"`. Entries without a valid `accountPool` are ignored. A pool with workers and no leader gets the built-in `claude` entry as its leader.

## Where a rescued agent goes

A **usable** account: enabled, not the one being left, not dead this sweep, and with every usage window under 90% (`USABLE_BELOW_PCT`, `account-pool-headroom.ts`). An account at 90% is not dead, but it would cap the agent again within a turn or two, so it is never a target for a rescue or an idle move. An account whose usage cannot be read counts as usable; a failed usage poll must not strand every agent. Among equals, the one with the most budget left wins. Which role comes first depends on the agent:

- **A child** prefers a worker, and collapses onto the leader account when no worker can take it.
- **A root** prefers the leader account, and goes to the worker with the most budget when the leader account is out. A root is Tyler's own session; isolation only ever protected the leader account from children. On 2026-09-24 a root sat on an exhausted worker for hours while the leader account had nearly all its budget.

**Isolation is a preference, not a rule.** Workers come first — keeping rescued agents off the leader's account is the budget separation the pool exists for, and it stays the normal case. But when no worker can take the agent, the leader account takes it. "The leader is never a target" stranded a leader on 2026-09-15 with the leader account and the primary worker both out for the week and a backup account sitting idle. Everything on one account is worse than isolation and far better than nothing running. The account-pool plugin makes the same choice at spawn time; the two have to agree, or a migration strands a leader on an account placement is happily using for children.

Set `collapseToSharedAccount: false` to get the old strict isolation back for children, at the cost of that stranding. It does not keep a root off the leader account.

### Ranking by headroom

Within a role tier, the target is the account with the most usable budget (`account-pool-headroom.ts`), from the same `ProviderUsage` rows the sweep already reads — so "which account is deadest" and "which has the most left" can never disagree about what the usage said.

An account scores as its **tightest window**, because a window is a wall: 95% free on the session window buys nothing when the weekly window has 2% left. Each window is what is free in it now, plus what its reset gives back, discounted by how long you wait, over a one-day horizon. The discount is what puts "20% left, resets in an hour" above "30% left, resets on Friday" — the first is about to be a whole fresh window, the second is all there is until the weekend.

A provider with no usable reading is treated as full rather than worst: a usage poll that failed must not demote an account below a nearly-capped one. With no readings at all every candidate ties and the configured `priority` decides, which is the order this used before.

Role beats headroom. For a child, a leader account with more room left is still the account whose budget the pool is protecting.

### When no account is left

Nothing moves. Every remaining target would fail on the first turn, so a rescue onto one spends a move and a resume to leave the agent exactly as stuck on a different account, with its evidence scattered across two. The agent keeps its conversation and continues the moment an account recovers. This is the one account condition Tyler hears about; see [When Tyler hears](#when-tyler-hears).

The account-pool plugin handles the other half of the same state: it refuses new spawns rather than starting them on a dead account, which is what stops a leader from looping "that one failed, try another" into an instant-death fan-out.

### Two providers, one account

A pool entry is a `CLAUDE_CONFIG_DIR`, not an account. Two entries signed into the same Claude login report the same usage windows because they _are_ the same windows, so moving an agent between them buys no budget at all. So such a provider is never a target for an agent leaving its twin.

Identity comes from `AgentManager.describeProviderAccount`, which asks the provider's client which account it runs as — for Claude, the `oauthAccount.emailAddress` the CLI writes into that config dir's `.claude.json` (`providers/claude/account-auth.ts`). One file read per pool entry per sweep, so it needs no caching.

Only an equal, readable answer counts. Two `unknown`s are two shrugs, and two signed-in accounts whose label could not be read are the same: treating "cannot tell" as "the same" would suppress rescues that would have worked. The asymmetry is deliberate — a false negative costs a wasted move, a false positive costs a rescue.

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

Only an agent that cannot run where it is, because a move costs a cache rebuild (see the top of this doc). That is two cases, both on a dead account: a turn that was cut off, which is moved and resumed, and an idle root, which is moved unprompted so Tyler can reach it. Everything else stays where it is. Nothing moves an agent back once its old account recovers: not a child to a worker, not a root to the leader account. New spawns already land on the right account through the classifier, and an idle agent that never runs again would pay a rebuild for nothing.

The candidates are loaded agents on a dead account that have a provider session and have not been retired, roots and children alike (`migrateSubagents: false` leaves children to their leader). What happens depends on where the turn is:

| State                                                           | What failover does                                                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Cut off: `error` (any error), or a limit-shaped `lastError`     | Moves it and sends the resume prompt. This is the rescue below.                                                                    |
| A root between turns: `idle`                                    | Moves it in place and sends nothing (`account-failover-rehome.ts`). It has nothing to resume, and can answer Tyler's next message. |
| A child between turns: `idle`                                   | Stays until asked. A child answers its leader, and most never run again; if a message to it fails on the cap, it is rescued then.  |
| Mid-turn: `running`, `initializing`, or waiting on a permission | Waits. The daemon refuses a mid-turn move, and the turn may finish.                                                                |
| Mid-turn, but the turn is dead                                  | The [stalled-agent sweep](stalled-agents.md) cancels it and leaves a limit-shaped `lastError`, which makes it the first row.       |

Failover never interrupts a turn itself. A turn stuck in `running` with no progress for `agents.remediation.stalledAgents.deadAccountStallMinutes` (15) on a capped account is cancelled by the stalled-agent sweep with the `account-capped` reason. The error it leaves names the account and the stall and is limit-shaped, so the next sweep moves the agent and resumes it as cut off mid-turn. That is the 15-minute rule the hand-run mover used.

Only a limit-shaped error makes an account dead; an agent in error for another reason is moved only when its account is already dead. An idle move uses the same targets as a rescue and the same duplicate rule, but never imports: a refused move backs off for an hour and the agent stays put. If it is asked to do something there, it fails on the cap and the rescue takes it.

The sweep covers agents loaded in the daemon. After a restart, a stuck agent is picked up once something loads it (opening it in the app, or sending it a message).

## What a migration does

1. **Adopt or retire, if the conversation already lives elsewhere.** If the agent already has a successor, or another live record holds its session, the monitor only retires this record (see [Idempotency](#idempotency) and [Duplicates](#duplicates)). Nothing is moved, imported, or sent.
2. **Move the agent onto the target account.** Same id, same conversation, same settings, same children.
3. **Send a resume prompt.** It tells the agent to answer the message that failed, and to create subagents with an explicit `"<target>/<model>"` provider — without that, the default provider or a role/model policy that pins one can place a new subagent back on the exhausted account.
4. **Record** the agent id → account in the ledger.

A moved agent keeps the parent label and the id its parent holds, so nobody has to be told where it went. Its parent was already told "errored" when the cap hit, so after the resume prompt the monitor re-arms the finish report and the parent hears again when the work finishes ([finish-reports.md](finish-reports.md#successors)).

### When it falls back to importing

`session_conflict` from a **retired** holder is the case that happens in practice: the target still holds this conversation's retired handle from an earlier import, and reviving that handle is the right answer anyway. A **live** holder is not an import case; it makes this record a duplicate ([Duplicates](#duplicates)). Any other refusal, or an unexpected failure part-way through a move, also falls back — the import path builds a fresh agent from the session id and works even when the moved agent is left closed.

The import path costs more, which is why it is second:

1. **Import the session** onto the target account through the same path as `paseo import`. The successor keeps the full conversation and the same Claude session id, and gets the predecessor's labels plus `handoff-from=<oldId>`.
2. **Retire the predecessor**: title `[MOVED → <newId>, out of budget] <title>` and label `paseo.account-failover.migrated-to=<newId>`. It is never archived. It may hold watchdogs, and archival is your call.
3. **Restore model, thinking option, and mode.** Import resets all three to provider defaults.
4. **Send a resume prompt** stating what actually got restored. It adds a third instruction a move does not need: the agent's existing subagents are still parented to the old id. Their finish reports follow `migrated-to` to the successor, but `list_agents` shows them under the old id.
5. **Record** old id → new id → account in the ledger.
6. **Tell a running parent.** For an imported subagent, the parent gets a steered system message naming the new id, but only while the parent is running. Steering an idle agent starts a new turn nobody is driving, the same trap [resource-monitor.md](resource-monitor.md) describes. An idle parent gets no message; the successor keeps the parent label, so it shows up under the parent in `list_agents`.

Restoration is best-effort: a failure there is logged and does not undo the move or the import.

## An agent that moved but never restarted

The resume prompt is the only thing that makes a migration finish, and sending it proves nothing. `sendPromptToAgent` returns once the turn starts; a provider that refuses the turn reports that asynchronously, so the agent lands in `lifecycle: "error"` well after the send resolved. Wrapping the send in a `try` catches only the synchronous cases — no such agent, archived, a turn already active.

Nothing else will notice. The move clears the limit error, and a candidate needs a limit-shaped one, so a migrated agent that never restarted is invisible to the detector for good. Preserving the error instead would be worse: it is limit-shaped and the agent now sits on the target, so the next sweep would read it as evidence the _target_ is capped and condemn the account it was just rescued onto.

So the monitor watches every migration until its resume demonstrably landed. Each following sweep reads the agent's state: running or idle means it resumed and the watch ends; `error` means re-send, up to three sends including the original. A limit-shaped error ends the watch too — the target is capped as well, which is the detector's job and would otherwise race this queue.

When the attempts run out, the agent keeps its conversation and its place on the new account and is one message away from continuing, so an `alert` push says exactly that ("Agent moved but did not restart"). It carries `data.outcome: "needs_prompt"`, which is additive — an app that does not read it still gets the whole story from the body text.

## Idempotency

A move needs no bookkeeping. The agent is the same agent, so a repeat sweep finds it on a healthy account with no error and nothing to do; if it caps again later it is a new candidate and moves again.

An import mints a second agent, so it does need bookkeeping, and it lives on agent labels rather than in monitor state so it survives restarts:

| Label                                | On              | Meaning                                                                                  |
| ------------------------------------ | --------------- | ---------------------------------------------------------------------------------------- |
| `paseo.account-failover.migrated-to` | the predecessor | Retired. Never a candidate again. A blank value reads as unset.                          |
| `handoff-from`                       | the successor   | Names the predecessor. Same key the manual procedure writes with `paseo import --label`. |

Before doing anything, the monitor looks for an existing successor: a record whose `handoff-from` names the agent, or a record on the same provider session created after it. This covers a crash between import and retirement, and handoffs someone already did by hand. Without the lookup, a second import onto a different provider would create a duplicate, and one onto the same provider fails with `Provider session is already imported` — it does not return the existing agent. If that rejection fires anyway, because another import won a race, the monitor adopts the winner.

A conversation that has hopped accounts by import can be rescued onto an account it left, where its retired handle still holds the session. The monitor reuses that handle instead of importing again: it blanks `migrated-to` (there is no public label-removal API), strips the title prefix, and points `handoff-from` at the agent it came from. A successor that has handed the conversation back is not counted as a successor during the lookup.

### Duplicates

One conversation has one live end. The retirement label lives on the record, so a restart never retries a duplicate. When another unarchived record without `migrated-to` holds the same provider session, whichever is older, the agent being moved is a duplicate left over from an earlier handoff (`findLiveSessionHolder`). The monitor retires it the way it retires an adopted predecessor, pointing `migrated-to` at the holder, and moves, imports and sends nothing. It is done, not failed: it is never retried, it is not stranded, and nobody is told. Moving it would be refused on the holder's account (`Provider X already holds agent Y for session Z`), and moving it anywhere else would put two live agents on one transcript. The check runs before a target is picked, and again on a `session_conflict` refusal in case the holder appeared in between.

The rule, by holder:

| The target's record for this session | What it is                               | What failover does                           |
| ------------------------------------ | ---------------------------------------- | -------------------------------------------- |
| Live: unarchived, no `migrated-to`   | The conversation's live end              | Retires the agent being moved as a duplicate |
| Retired: `migrated-to` set           | The handle this conversation left behind | Import path: revives it                      |
| Archived                             | Nothing; the move does not see it        | Moves in place                               |

## When Tyler hears

Only when no account can take the work. Everything failover does by itself is the remedy working, so it goes to the ledger at `record` ([notification-policy.md](notification-policy.md#levels)):

| Event                                                      | Level    | How                                                                              |
| ---------------------------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| A rescue moved and resumed an agent, or an idle root moved | `record` | `reason: "account_failover"` payload                                             |
| A duplicate was retired                                    | —        | Log line only                                                                    |
| A moved agent never restarted after three resume sends     | `alert`  | "Agent moved but did not restart", `data.outcome: "needs_prompt"`                |
| Agents are stranded: no account can take them              | ladder   | `account-pool-exhausted` observation, key `account-failover-stranded`; see below |

The stranded case goes through the [remediation ladder](remediation.md), which owns its one push per episode. The monitor reports it every sweep while any rescue candidate has no target, with `remedy: "none"`, no escalation (an agent would need an account to run on), `level: "urgent"` (the pool cannot route at all, so nothing is left for automation to try), and evidence naming the dead accounts, the stranded agents and the earliest reset (from the capped windows' `resetsAt`, else the cap message). It reports `active: false` once, on the first sweep where nobody is stranded, which closes the episode. An idle agent with nowhere to go is not stranded: it is doing nothing, and if someone asks it to, it fails on the cap and becomes a rescue candidate.

## Configuration

`agents.accountFailover` in `$PASEO_HOME/config.json`. Every field is optional, and the defaults work without any config change:

| Field                     | Default | Effect                                                                     |
| ------------------------- | ------- | -------------------------------------------------------------------------- |
| `enabled`                 | `true`  | `false` stops all sweeps.                                                  |
| `migrateSubagents`        | `true`  | `false` moves leaders only and leaves subagents to their leader.           |
| `migrationConcurrency`    | `3`     | Migrations run at once per sweep.                                          |
| `notifyParent`            | `true`  | `false` skips the steered message a running parent gets after an _import_. |
| `collapseToSharedAccount` | `true`  | `false` bars the leader account as a target for children.                  |

`returnHome`, `returnMaxHomeUsedPct`, `returnMinIdleMinutes`, `returnCooldownMinutes`, `returnRetryBackoffMinutes` and `returnMaxUsageAgeMinutes` are accepted and ignored. They configured the return leg, which is gone; they stay in the schema so a config that sets them still loads (`COMPAT(failoverReturn)`).

It is live-toggleable like `tokenBurnMonitor` and `resourceMonitor`: the monitor re-reads it every sweep, and it uses the same mutable/patch schema split so a patch that omits a field doesn't reset it. The sweep interval is fixed at 60 seconds.

## Known limits

- **Caps that outlast five hours.** A monthly spend cap can outlive its evidence. The account then looks healthy again, and one migration lands there, fails, and marks it dead for another five hours. So a capped worker is re-probed at most once per five hours.
- **Headroom is only as fresh as the usage cache.** Ranking reads the same cached rows the dead-account check does, so a sweep can rank on numbers up to one refresh old. It costs a suboptimal target, never a dead one — the dead check and the ranking see the same rows.
- **Two entries on one Claude login look like two accounts to the headroom ranking.** They report identical windows and score identically. Target selection excludes them via `describeProviderAccount` (see [Two providers, one account](#two-providers-one-account)), through the same unavailable set as dead accounts.
- **One account label, no organisation.** Two providers are the same account only when their client reports the same email. An account with no readable label is never matched, so a pool of accounts that all report `unknown` gets no shared-account handling at all — every move is taken at face value. Matching by organisation or by the OAuth account uuid would need the quota fetcher to surface identity alongside the usage rows, which it does not today.
- **Loaded agents only**, as described under [Which agents move](#which-agents-move).
- **The import fallback mints a second id.** Everything under [When it falls back to importing](#when-it-falls-back-to-importing) applies when it runs, including a parent that may relaunch the subagent before the sweep reaches it (leaving two copies). The successor inherits the predecessor's finish report ([finish-reports.md](finish-reports.md#successors)). If duplicates become a pattern there, set `migrateSubagents: false`.

For the shared monitor shape (unref'd timer, per-sweep config read, push payloads outside the closed `attentionReason` enum), see [resource-monitor.md](resource-monitor.md) and [token-burn.md](token-burn.md).
