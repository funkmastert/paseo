# Budget pacing

A usage window resets and does not roll over. A five-hour window that expires with half of it
unused has wasted that half permanently, and one that caps two hours early strands whatever was in
flight. `AgentBudgetPacingMonitor` (`packages/server/src/server/agent-budget-pacing-monitor.ts`)
watches each worker account's windows against the clock and tells running leaders to widen or
narrow their fan-out.

It is the advice half of the same picture [token burn](token-burn.md) owns the enforcement half of.
Nothing here cancels, downgrades, refuses or throttles anything — the [spend
governor](token-burn.md#the-spend-governor) does that, and two subsystems acting on one account
would race. This one produces sentences.

Off by default (`agents.budgetPacing`), and it needs about twenty minutes of observation after you
turn it on before it can say anything.

## The signal is a pace, in points of the window per minute

For each window: `requiredPctPerMin = remainingPct ÷ minutesToReset`. That is the pace that lands
the window exactly at its reset. Against it sits the pace the window has actually been going at,
and the ratio of the two is the whole signal.

The observed pace is the difference between two `usedPct` readings, not anything derived from token
counts. The daemon already knows what each window reads (`ProviderUsageService`, the rows the Host
Usage screen shows), and differencing that covers every charge against the account — including work
someone started outside Paseo, which a token total never sees. The per-agent weighted rate
([token burn](token-burn.md#the-unit-is-cost-weighted-tokens)) is summed per account for one
purpose only: naming who is spending the window in the message. It never paces anything.

Samples are timestamped by the snapshot's own `fetchedAt`, not by the sweep that read it. The usage
cache serves one snapshot for five minutes, so sweep time would invent movement between two reads
of one number.

Two figures come out of the gap, both in points of the window, so one repeat threshold governs
both directions:

- **Stranded** — `remainingPct − observedPace × minutesToReset`. What expires unused at this pace.
- **Overshoot** — `observedPace × minutesToReset − remainingPct`. What the account would want
  beyond what it has to reach the reset.

## Where the thresholds come from

The usage read is a five-minute cache, so a 15-minute observation span has endpoints up to five
minutes stale: up to ±33% error on the rate, falling to about ±11% over 45 minutes. **A verdict
must not be flippable by that error**, which is why the pace ratios sit a factor of 1.5 either side
of parity (0.5 and 1.5) rather than hugging it, and why 15 minutes is the shortest span that counts
as a measurement at all.

The rest are actionability and materiality gates. Each one answers a different question, so failing
any one of them is enough to stay quiet:

| Gate                       | Default | Why that number                                                                                                                                                                                                          |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `speedUp.horizonMinutes`   | 90      | Roughly three or four rounds of delegation at the measured ~20-minute subagent, so strategy still changes the outcome. Earlier, the next hour's work closes the gap.                                                     |
| `minActionableMinutes`     | 20      | A fresh subagent cannot finish inside that, so the capacity is already unrecoverable and the nudge is noise.                                                                                                             |
| `speedUp.minStrandedPct`   | 25      | A quarter of a window is the smallest loss worth interrupting a leader's turn over.                                                                                                                                      |
| `speedUp.minRemainingPct`  | 15      | Applied to **every** window on the account, not just the one being paced: the tightest window is what actually caps it, so a nearly-spent weekly vetoes the whole account.                                               |
| `slowDown.maxRemainingPct` | 60      | A burst in the first 40% of a window projects to an absurd overrun and then corrects itself when the agents that caused it finish. Waiting for the burn to be established is what keeps the leg off that false positive. |
| `slowDown.minOvershootPct` | 20      | Below that the account is close enough to its own pace that "ease off" is not worth a message.                                                                                                                           |
| `slowDown.minEarlyMinutes` | 20      | A high pace can overshoot by 20 points and still only cap four minutes early. Acting has to move the clock by something.                                                                                                 |

A window at 0 remaining, or one with no `resetsAt`, is not paced at all: there is no deadline to
divide by. Neither is a snapshot older than `staleUsageMinutes` — at three times the cache TTL it
has stopped refreshing, and stale numbers make confident projections.

A `usedPct` that falls reads as no burn rather than as a refund. Nothing should advise on the
strength of an account gaining capacity back.

## Whose window, and who gets told

**Worker accounts only.** The pool in `params.accountPool` says which accounts spend on subagents
([account failover](account-failover.md#the-pool) owns the pool itself). The leader account's own
window running dry is not a fan-out decision — it stops coordination, which is failover's problem.
An account pool with no enabled workers means this leg does nothing.

**Running leaders only.** A leader is a root agent — no `paseo.parent-agent-id` label. Subagents do
not choose the fan-out strategy, so they are never told. And the message only goes to an agent that
is mid-turn: steering an idle agent starts a fresh turn (`agent-prompt.ts`'s fallback), which would
spend an account's budget to talk about that budget. Every running leader gets the advisory, whatever
account it is itself on, because any of them can choose how much to delegate.

## When the fleet is idle

Nothing happens, and nothing is recorded. A fleet that is idle because Tyler is asleep is not
underusing anything worth a nudge — there is nobody the advice is for.

This falls out of the delivery rule rather than needing a check of its own: an advisory is marked as
said only once it reached at least one leader. So the capacity a sleeping fleet is about to lose is
mentioned on the first sweep after somebody starts working, with the numbers as they read then.

## Noise discipline

One advisory per sweep, however many windows qualify. Slowing down outranks speeding up — capping
early strands work, wasting capacity only wastes capacity — and within a direction the nearer
deadline wins. The rest are re-evaluated next sweep.

Bookkeeping is per window per direction per reset cycle, keyed on the window's `resetsAt`, so a
window that resets re-arms and one sitting behind its pace all week does not speak every minute.

**An unheeded nudge repeats exactly once.** A second identical message cannot add information, but a
gap that has grown by `repeatWorseningPct` (10 points) while the deadline came closer is a different
fact, and `repeatAfterMinutes` (20) keeps the two apart. `maxAdvisoriesPerCycle` (2) is the hard
ceiling: at most two messages per window per direction per reset, which for a five-hour window is at
most two an account per five hours in the worst case and usually none.

There is **no push notification**. The audience that can act on a pace is the leader, and the
human-facing channel for account usage already exists — token burn's [account
pressure](token-burn.md#account-pressure) leg pushes at 90%. Adding a second push would be the
notification spam this leg is otherwise careful about.

## What it says

Both messages carry the numbers and a recommendation, and end with what the numbers cannot promise.
The exact text lives in `formatBudgetPacingAdvisory`, and the tests assert it in full. A speed-up
reads:

> Worker account claude-personal has 52% of its Session window left and it resets in 34 min
> (2026-09-19T12:34:00.000Z). Over the last 22 min it has been consumed at about 0.36%/min;
> spending the rest of it before the reset would take about 1.5%/min. At the current pace roughly
> 40 points of the window expire unused […]
>
> Be more aggressive with subagents while it lasts: run in parallel what you were going to run in
> sequence […] Pass the account explicitly — provider "claude-personal/<model>" […]
>
> Both figures are estimates. The usage reading is a cached snapshot taken 3 min ago […] Treat the
> projection as a direction, not a measurement.

The uncertainty paragraph is not decoration. A leader that reads a cached snapshot and a two-point
estimate as facts over-corrects, and over-correcting on a budget is the thing being avoided.

## Config

`agents.budgetPacing` in `$PASEO_HOME/config.json`, live-toggleable like its siblings. Every field
is optional and absent means exactly today's behaviour.

| Key                     | Default | What it does                                                                    |
| ----------------------- | ------- | ------------------------------------------------------------------------------- |
| `enabled`               | `false` | Nothing is read or said while this is off                                       |
| `dryRun`                | `false` | Log the advice and its recipients, steer nobody                                 |
| `paceLookbackMinutes`   | 45      | How far back a pace is measured                                                 |
| `minObservationMinutes` | 15      | Shortest span that counts as a measurement                                      |
| `staleUsageMinutes`     | 15      | Skip the sweep when the usage snapshot is older                                 |
| `minActionableMinutes`  | 20      | Say nothing this close to a reset                                               |
| `repeatAfterMinutes`    | 20      | Cooldown before the one permitted repeat                                        |
| `repeatWorseningPct`    | 10      | Points the gap must have grown by to repeat                                     |
| `maxAdvisoriesPerCycle` | 2       | Ceiling per window per direction per reset; 0 silences the leg                  |
| `speedUp.*`             | above   | `enabled`, `horizonMinutes`, `paceRatio`, `minStrandedPct`, `minRemainingPct`   |
| `slowDown.*`            | above   | `enabled`, `paceRatio`, `maxRemainingPct`, `minOvershootPct`, `minEarlyMinutes` |

Turn `dryRun` on first. Each `Budget pacing would advise running leaders` line in `daemon.log`
carries the direction, the account, the numbers behind the decision, the leader ids, and the full
text — enough to judge a day's worth before any agent hears a word. Dry run still records what it
would have said, so it reports once rather than once a minute.

Adding the key to `config.json` while an older daemon is running will make that daemon reject the
whole file and fail every agent MCP request. Add it after the daemon that understands it is the one
running.

## What it does not do

- **No enforcement, ever.** Not even a soft one. See [the spend
  governor](token-burn.md#the-spend-governor) for the half that acts, and
  [account failover](account-failover.md) for the half that moves agents off a capped account.
- **No routing.** It names a healthier worker account in the message; it never places anything. The
  account pool plugin routes.
- **No leader-account pacing**, for the reason under [Whose window](#whose-window-and-who-gets-told).
- **`runsOutAt` and `shortfallPct` on `ProviderUsageWindow` stay unpopulated.** The projection this
  leg computes would fit those wire fields and light up the Host Usage screen's at-risk state, but
  that is a client feature with its own design, not a side effect of a monitor sweep.
