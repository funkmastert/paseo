# Usage history

The daemon knew how full a usage window was and nothing about how fast it was filling. A weekly window reached 100% with no warning and every agent on the account died. Usage history records the readings the daemon already sees, so it can say "at this rate `claude-personal` caps in three hours" while there is still time to act on it.

It records and projects. It never pushes, steers or acts. [Account pressure](token-burn.md#account-pressure) is the threshold alert and [budget pacing](budget-pacing.md) is the advice to leaders; both can read a projection, neither is changed by this.

## What is sampled

One call from `AgentTokenBurnMonitor`'s existing 60-second sweep (`packages/server/src/server/usage-history/usage-history-sampler.ts`). There is no poller of its own and no provider request of its own.

- **Account windows** from the cached provider usage rows the Host Usage screen already reads: `five_hour`, `weekly`, and per-model windows such as `weekly_model_fable`. A reading is stamped by the row's own `fetchedAt`, never by the sweep. The usage cache serves one snapshot for five minutes, so stamping by sweep would turn one number into five readings and invent movement between them. A row without `fetchedAt` is skipped for the same reason.
- **Per-agent spend** from the token-burn counter, in [cost-weighted tokens](token-burn.md#the-unit-is-cost-weighted-tokens). The stored series is cumulative across counter resets: an agent closed and loaded again, or a daemon restart, zeroes the live counter, and the store adds what the previous epoch reached to the new one.

Because it rides the token-burn sweep, `agents.tokenBurnMonitor.enabled: false` stops recording too. Recording is on unless `agents.tokenBurnMonitor.usageHistory.enabled` is `false`. It is on by default because a history that starts when someone turns it on has nothing to project on the day it matters.

## Storage and retention

`$PASEO_HOME/usage-history/`: `accounts.json` for every account window, `agents/{agentId}.json` for each agent's spend. Zod-validated on read, atomic writes, no migration. A file that will not parse is ignored and replaced; this is a history, not a record anyone depends on.

Every axis has a ceiling (`DEFAULT_USAGE_HISTORY_LIMITS`):

| Bound              | Value                                                         |
| ------------------ | ------------------------------------------------------------- |
| Age                | 8 days                                                        |
| Thinning           | past 24 h, no closer than 15 min                              |
| Account series     | 64, 1,500 readings each                                       |
| Agent files        | 400, oldest deleted first                                     |
| Readings per agent | 720; the older half halves in resolution before history stops |

A modelled month with three accounts, three windows each and 40 agents stays well under 2 MiB (`usage-history-store.test.ts`). The store holds changes in memory and writes at most every five minutes and on shutdown, so a crash loses at most that interval and never corrupts a file.

An agent's series only records when its total advances, and holds the line flat through a quiet stretch (one plateau point just before it moves), so a burst after an idle hour draws as a burst.

## The projection

`usage-projection.ts` is pure: the same readings and clock give the same answer. The rate is a least-squares slope over the trailing hour (six hours for `weekly*` windows), not the difference of the two ends, because `usedPct` is quantised to whole points and each reading can be five minutes old. Two endpoints carry most of that error; a fit over a dozen readings averages it out.

It says "not enough data yet" instead of inventing a rate. `status: "unknown"` names the rule that stopped it:

| `reason`               | Rule                                                           |
| ---------------------- | -------------------------------------------------------------- |
| `insufficient_samples` | Fewer than three readings in the current cycle and lookback    |
| `short_span`           | Three readings, but under 15 minutes apart end to end          |
| `no_reset_time`        | The window reports no `resetsAt`, so a cap cannot be judged    |
| `reset_passed`         | `resetsAt` is behind us; the snapshot describes the old cycle  |
| `stale`                | The newest reading is older than 15 minutes; the fetch stopped |

Three, not two, because two points always fit a line.

Windows reset, so it accounts for the reset:

- **It never extrapolates past `resetsAt`.** A cap time is reported only when it lands before the reset. Otherwise `capsAt` is absent and `projectedPctAtReset` says where the window will stand.
- **Only the current cycle is evidence.** Readings before a reset time change, or before a `usedPct` drop, belong to a different window that shared an id. `resets_at` carries sub-second noise on every fetch, so two minutes of slack separates noise from a real reset.
- **A falling number is not capacity coming back.** A negative slope reads as flat.
- **A flat window is a finding.** Readings are kept even when the number did not move, so a flat window projects `ratePctPerHour: 0` and no cap, instead of reading as "unknown".

`confidence: "low"` marks a fit that was allowed but is weak: under 30 minutes of span or under 2 points of movement. A weekly window at one point per six hours is a rate and also mostly quantisation noise; the flag says so and does not hide the number.

## Where it surfaces

One RPC, `usage.history.get.request` / `.response` (gated on `server_info.features.usageHistory`, permission `daemon.read`, controller in `session/usage-history/`). It returns every account window's latest reading and projection, and when the request names an `agentId`, that agent's spend downsampled to 96 points.

- **Agent detail:** a spend sparkline in the composer's context-meter tooltip (the same tooltip that shows the [context breakdown](context-usage.md)) (`packages/app/src/usage-history/agent-spend-sparkline.tsx`). It fetches only while the tooltip is open, and draws nothing without two points or on a daemon that predates the RPC.
- **Budget strip:** `earliestProjectedCap` (`usage-history/account-cap-projection.ts`) is the read: the tightest window is what caps an account, so the earliest cap across its windows is the account's time-to-cap. The strip's rendering is not changed here. Unknown is not treated as safe, so it reads `windows[].projection.status` when it needs the difference.

`runsOutAt` and `shortfallPct` on `ProviderUsageWindow` are still unpopulated, for the reason [budget pacing](budget-pacing.md#what-it-does-not-do) gives. Filling them would light up the Host Usage screen's at-risk state and is a client feature with its own design.

## No push

There is no notification here. The trajectory alert this enables (fire account pressure when a window is projected to cap inside N hours, not only past 90%) reads `projection.minutesToCap` and needs a level under the notification policy. Add it in the account-pressure leg, not here.
