# Token burn

The daemon tracks how much each agent spends and what it spends it against. Three consumers read the same signal: the relative badge in agent lists (`packages/app/src/utils/token-burn-tone-model.ts`), the absolute-threshold monitor that pushes notifications, and the opt-in spend governor that acts on a task budget — both in `packages/server/src/server/agent-token-burn-monitor.ts`. It's the provider-accounting counterpart to [docs/resource-monitor.md](resource-monitor.md), which watches the same agents through `ps`.

## The unit is cost-weighted tokens

Every burn delta goes through `weighTokenUsage` in `packages/server/src/server/agent/token-rate-tracker.ts`: fresh input 1, cache write 1.25, cache read 0.1, output 5 (Anthropic's list-price ratios). `recentTokenRate` and `totalTokens` on the wire are in this unit, not raw tokens.

Raw counting is what made the monitor cry wolf. A Claude agent re-reads its whole context from cache on every tool-call step, so a 300K-context agent answering a one-line question reported 1.18M "tokens" for 851 tokens of real traffic. That single turn read as 237K tokens/min for five straight minutes and tripped the rate alert on an idle agent; the 5M cumulative alert fired every couple of dozen steps on any long-lived session.

## How deltas arrive

- **Claude** records per API request while a turn runs: `message_start` carries the input side, `message_delta` the output count, and the adapter emits a daemon-internal `token_burn_delta` stream event per request. The per-turn `turnTokenDelta` on `turn_completed` is only the fallback for a run without partial messages, so a turn is never counted twice.
- **Codex** weights its per-turn `last` usage the same way, after splitting cached tokens out of its input count: Codex reports cached input as a subset of input, Anthropic reports cache reads beside it.
- **OpenCode and ACP** diff cumulative totals and have no cache breakdown, so they stay raw. Their agents do not re-read a cached context per step, so the distortion above does not apply to them.
- **OMP and Pi** report nothing; the rate leg never fires for them.

`agent-manager.ts` folds both event kinds into the same 30-second ring and lifetime total. Both are live-only: cleared on rewind, never persisted. A reload (`reloadAgentSession`, which a stale provider session or a provider move triggers) carries the counter, the alert and the governor's fired stages across to the new session; an agent that is closed and loaded again from disk, or replaced by an account-failover successor, starts from zero. Before the carry existed a reload zeroed the counter: one agent had spent 51M against a 40M budget and read 26.7M, so the governor never told it.

## Monitor legs

Config lives under `agents.tokenBurnMonitor` (`persisted-config.ts`). The rate default is 400K weighted tokens/min sustained for 3 sweeps. **The total leg ships off**; set `totalTokens` to turn it on, and it then ratchets to the next multiple.

- **Rate** is evaluated only for agents that are mid-turn. The trailing-window average stays flat for up to five minutes after the last request, so an idle agent can never be "burning"; `sustainedMinutes` alone filters nothing.
- **Total** is evaluated only for agents that are mid-turn too, for a different reason: an agent that has stopped cannot spend any more, so an alert naming what it already spent is a receipt. It is also off by default — see below.

Push copy distinguishes the two ("burning tokens fast" versus "has used a lot of tokens", `packages/protocol/src/token-burn-notification.ts`). The monitor logs nothing on a threshold breach; the push log's `Sending push notification` lines carry the title and `data.reason` of whatever went out, which is how you attribute a day's notifications to a subsystem after the fact.

### Why the total leg is off

It was 5M, flat and global, and it fired on four of one machine's agents at once — every one idle, every one legitimate, sitting between 6.4M and 9.1M after real work. That is the same argument the governor section below makes and then acts on: measured healthy agents straddle every line you could draw, so a threshold low enough to catch a runaway also catches ordinary work, and one that spares ordinary work catches nothing. A leg that fires on the normal case is noise by construction, and noise costs more than the missing alert — it is what teaches someone to swipe away the capped-account and runaway-spend notifications too.

What replaces it is the governor's `notify` stage, which compares spend against the budget the caller declared for that task. Keep `totalTokens` for a machine where a global ceiling genuinely means something (a shared host with a hard monthly cap, say); do not treat it as a runaway detector.

### Why the rate leg is a smoke alarm and not a signal

The rate default was 50,000, and it fired on ordinary agents, continuously. Measured on one machine: an Opus agent reading source files read 205K, then 181K, then 106K weighted tokens/min, and tripped the alert on its third sweep. Two finished implementation agents averaged 98K and 97K across their whole runs, and the agent that implemented this feature averaged 110K/min over 20 minutes for 2.14M total. Every one of those was healthy.

That is structural, not an outlier. A Claude agent re-reads its context from cache on every request, so the weighted rate tracks context size times request frequency. It climbs as any task progresses, and a 1M-context agent doing identical work reads roughly nine times the cache per request. **The rate is a readout of how large a context is, not of whether the work is worth doing.** 400K is about twice the measured healthy peak — quiet enough to be worth reading, still not a basis for action. The spend governor never acts on it.

## The spend governor

Off by default. Turn it on under `agents.tokenBurnMonitor.governor`, and turn on `dryRun` first: it runs the whole ladder and reports exactly what it would do, without doing any of it — not even the message to the agent, which would spend tokens on a hypothetical.

### Budgets are per agent, because nothing else separates the cases

Three agents measured on one machine: two healthy implementation agents that finished their work at 1.08M and 1.48M weighted tokens, and one that spent 1.1M discovering it had no Edit tool and then spawned helpers that also could not edit. No rate tells those apart. No single global total tells those apart either — the healthy pair straddle the runaway. What separates them is what the task was worth, and only the caller knows that.

So a caller declares it: the **`paseo.budget` label**, in weighted tokens, accepting `300000`, `300k` or `1.5M`. A label rather than a create field because labels are already on `create_agent`'s input schema, an `agent.create` plugin hook can impose or override one, `update_agent` can raise one on a live agent, and none of it costs a protocol change. Anything that isn't unambiguously a token count is read as no budget at all rather than guessed at.

An agent whose task declared no budget is **not governed**, unless `defaultBudgetTokens` is set. That is the shipped default, so turning the governor on cannot act on agents nobody has sized. Set it once dry-run has shown what your agents actually cost.

**A budget covers one agent, not a task tree.** Labels are not inherited: a child created by `create_agent` carries the labels that call gave it and no others, and every agent's spend is its own. A leader with a budget is governed on what the leader itself spends, which for an orchestrator that delegates everything stays small while its fleet spends the real money. `stopFanOut` is the stage aimed squarely at that case and it fires on the caller's own spend — the number that stays low. Budget the agents that do the work, or give the leader a budget sized to its own coordination, not to the job.

Releasing a governed agent means changing its `paseo.budget`, and the app has no label editor: that is `update_agent` from another agent, or the CLI. Worth knowing before you enable a stage that stops one.

### The ladder

Four stages, each switching independently at its own multiple of the budget. Enabling the governor enables `notify` alone: turning it on starts telling you things, never starts changing things.

| Stage        | Fires at | On by default | What it does                                                     |
| ------------ | -------- | ------------- | ---------------------------------------------------------------- |
| `notify`     | 0.75×    | yes           | Push, and a message into the agent's own conversation            |
| `downgrade`  | 1.0×     | no            | `setAgentModel` to `downgradeToModel` for the rest of the task   |
| `stopFanOut` | 1.0×     | no            | `create_agent` refuses this caller, so a runaway cannot multiply |
| `pause`      | 1.5×     | no            | Ends the turn and leaves the agent flagged for a human           |

A stage fires once per episode, not once per sweep. A **changed budget starts a fresh episode** — that is how a human releases a paused or cut-off agent: raise the label. Turning the governor off drops the carried state entirely, which releases a blocked agent too.

`pause` is the exception: it re-arms whenever the agent is started again while still over the threshold, so a turn that follows a pause is stopped too. Firing once and never again would read as protection while the agent ran on unbounded — measured at eight times its budget, with the governor watching and planning nothing. The sweep that pauses records the agent as stopped rather than as it found it, because the cancel it just planned is what stops it; otherwise a parent re-prompting its paused child inside the next 60 seconds would look like an agent that never stopped. Re-arming is not a release. Raising the label is.

`downgrade` and `pause` need a running agent. When the agent is idle they defer rather than mark themselves done, so an agent that blew its budget and went briefly quiet is still caught when it resumes. `downgrade` marks itself done without acting when there is no `downgradeToModel` or the agent is already on it, and it is skipped outright when the target is not in that agent's provider catalog. `downgradeToModel` is one global string and a fleet is not one provider: `setAgentModel` validates nothing, so a Codex agent carrying a budget label would otherwise be set to a Claude model id. A catalog that cannot be read counts as a no — an agent left on the model it already had costs money, an agent set to a model its provider never heard of costs the turn. A skip logs its reason and sends no push: a notification announcing a downgrade that did not happen is worse than silence.

An agent that jumps several thresholds between two sweeps — 60 seconds at the measured healthy rate is ~200K weighted tokens, so a small budget can go in one — gets every crossed stage in ladder order in that sweep. It is always told before it is paused.

### The agent is always told, and told enough

Silently changing an agent's model or refusing its tool calls produces exactly the confused, expensive flailing the governor exists to prevent. Every stage names the spend, the budget, and what to do differently.

Three of the four arrive as one steered `<paseo-system>` message, the same path chat mentions, notify-on-finish and the resource monitor use (`agent-prompt.ts`, `activeTurnBehavior: "steer"`), and only while the agent is mid-turn. `notify` and `stopFanOut` can fire on an idle agent, and steering an idle agent starts a fresh turn — spending tokens to tell an agent it is out of tokens, on the agent already over budget. An idle agent gets the push straight away, and for `stopFanOut` the `create_agent` refusal itself, which lands at the only moment it changes anything.

**Firing and telling are separate.** A stage that fires on an idle agent keeps its message in `undeliveredStages` and says it on the first sweep the agent is mid-turn again, carrying the spend as it reads then rather than as it read when the stage fired. Once, not every sweep after, and with no second push — the human was told at the crossing. Without this the stage that is on by default was the one that silently did nothing: an agent that crossed 0.75× between turns was marked told and never heard a word, losing the chance to wrap up early that is the entire point of `notify`. **Not** `providerOptions.appendSystemPrompt`: that is folded into the SDK options when the query is built, so using it mid-session would mean restarting the session and losing the turn being governed. It stays the right channel for a create-time restriction ([docs/plugins.md](plugins.md)), which is a different problem.

The fourth, `stopFanOut`, also arrives as the `create_agent` error itself — the most direct channel there is, delivered at the moment the agent tries. That message names the budget, the spend, that no agent was created, that this is a cap rather than a transient failure so retrying will keep failing, and the label a human would raise. An agent told only "create_agent failed" retries in a loop.

Two ordering rules carry weight:

- **A downgrade is remembered, so a migration can undo it.** The governor records the model it moved the agent off. [Account failover](account-failover.md) builds a successor that inherits the predecessor's model but starts with its spend at zero, so without that memory an agent downgraded once stayed cheap forever — the successor's fresh episode marks `downgrade` done on sight, because the agent is already on the target. The successor comes up on what the agent was on before. An in-place provider move keeps the same agent, its spend and its episode, so it keeps the downgrade too, which is right.
- **Downgrade tells the agent after the model moved**, so the notice is true when read, and says it did nothing wrong so it does not go hunting for a bug. `setAgentModel` mid-turn is safe: it reaches the SDK's `query.setModel()`, which applies from the next API request in the same turn. The request in flight finishes on the old model, the conversation is untouched, nothing restarts.
- **Pause steers first and cancels second.** The other order leaves an idle agent, and steering an idle agent starts a fresh turn (`agent-prompt.ts`'s fallback) — spending tokens to say it is out of tokens. This way the reason lands in the transcript for whoever resumes it.

Pausing works inside the closed `attentionReason` enum without adding to it. The stage sets a `tokenBurnAlert` of its own before it cancels, which `agent-state-bucket.ts` already treats as attention-worthy. Without it a paused agent is indistinguishable in the app from one that finished its turn — `cancelReason` is log-only — so the push would be the only notice, and a missed push would be a lost agent. It reports `trigger: "total"`, because the wire enum is closed and a third value would fail to parse on every shipped client; `budgetTokens`, `spentTokens` and `governorStage` ride alongside as additive-optional fields, so an old app renders the usual total copy and a new one can say it was the governor. The alert is set before the cancel rather than after: an agent whose cancel failed is still over budget and still worth a human's eye.

### Config

| Key                                      | Default         | What it does                                                  |
| ---------------------------------------- | --------------- | ------------------------------------------------------------- |
| `enabled`                                | `false`         | Nothing is governed while this is off                         |
| `dryRun`                                 | `false`         | Plan and report the whole ladder, perform none of it          |
| `defaultBudgetTokens`                    | `null`          | Budget for a task that declared none; null means not governed |
| `downgradeToModel`                       | `null`          | Where `downgrade` moves an agent; null leaves it inert        |
| `<stage>.enabled` / `<stage>.atFraction` | see table above | Per-stage switch and threshold                                |

### What it costs

A budget set too low is worse than no budget: it stops work that was going fine, and the restart costs more than the overrun would have. Dry-run for a day and read what it would have done before enabling anything past `notify`. `pause` at 1.5× is deliberately far out — it is for the runaway, not the task that took longer than expected.

## Account pressure

Off by default (`agents.tokenBurnMonitor.accountPressure`), and **report-only on purpose**. At 90% of a provider usage window it pushes once and does nothing else.

Acting here would fight two things that already own the decision. The account pool plugin routes new agents away from a hot account, so refusing a caller's `create_agent` on account pressure would block a child the plugin would have placed somewhere healthy anyway. And `AccountFailoverMonitor` already migrates agents off an account at 100% ([docs/account-failover.md](account-failover.md)). Warning before the wall is the gap neither fills.

It runs before the empty-agent-list return, like the resource monitor's machine legs: a daemon with no live agents still has accounts about to lapse. Dedup keys on the window's `resetsAt` rounded to the minute, so a window that resets warns afresh and one sitting at 94% all week does not warn again. The rounding is load-bearing: the API's `resets_at` carries microsecond noise that changes on every fetch, and keying on the raw string produced a push every five minutes. The push names the account; the daemon log line `Account pressure: usage window is over the warning threshold` carries provider, window and percentage for attributing it afterwards.

This is a threshold on one number. [Budget pacing](budget-pacing.md) reads the same rows as a rate against the clock and advises running leaders on how hard to fan out; it is the third reader of the usage windows and, like this leg, acts on none of them.
