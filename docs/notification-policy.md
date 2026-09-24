# Notification policy

Every push the daemon sends goes through one gate, `NotifyPolicy` (`packages/server/src/server/notify-policy/`). Callers say how urgent a push is. The policy decides whether it interrupts, waits for a digest, or is only recorded, and the ledger records whether it reached the phone.

It exists because every push source was individually reasonable and nothing ranked them. "An account is about to cap and your leader will die" arrived looking identical to "an agent's rate briefly spiked", and a signal that fires on healthy work trains its reader to ignore the ones that matter.

## Levels

Callers pass `{ level }` as the second argument to `send`. The type is `PushSendMeta` (`notify-policy/levels.ts`); the vocabulary is in `packages/protocol/src/notify-policy/types.ts`.

| Level    | Meaning                                        | Default outcome                        |
| -------- | ---------------------------------------------- | -------------------------------------- |
| `record` | Worth having in the ledger, never worth a push | Ledger only                            |
| `notice` | Worth knowing, does not need you now           | Held, sent as one quiet digest         |
| `alert`  | Needs a person soon                            | Pushed immediately, with a sound       |
| `urgent` | Something is about to be lost                  | Pushed immediately, gets through focus |

A push with no level is a `notice` and is logged as undeclared. `push-callers.test.ts` fails when a sender in the daemon does not declare one, so the next unranked source is caught when it is written, not after a week of pushes.

**Rank by what happens if the person never reads it, after automation has had its turn.** A condition the daemon can fix is not the person's to read about. A monitor with an automatic remedy runs it and records what it did at `record`; it reports the condition to the [remediation ladder](remediation.md), which pushes only when the remedy and one bounded agent both failed or could not act, and picks that push's level from the observation. For everything with no remedy, ask what ignoring it costs: an agent's token rate spiking costs nothing, so it is a `notice`; a capped account stops every agent on it, so it is `urgent`. Ask both questions again for every new sender; "it felt important when I wrote it" is how the stream got flat.

## Two dials and one mode

Settings live in `$PASEO_HOME/notify-policy.json` (not `config.json`: the availability toggle changes all day). Defaults are `minPostLevel: notice`, `minInterruptLevel: alert`, digest every 30 minutes, available.

- `minPostLevel`: below it a notification is `log`. Raising it to `alert` turns notices off.
- `minInterruptLevel`: at or above it a notification interrupts; between the two dials it digests. Lowering it to `notice` sends notices immediately, which is how the daemon behaved before the policy.

Availability then modulates an interrupt. It never drops a notification; only the dials do.

| Mode        | Alert      | Urgent     | Notices                               |
| ----------- | ---------- | ---------- | ------------------------------------- |
| `available` | interrupt  | interrupt  | digest every `digestIntervalMinutes`  |
| `focus`     | quiet push | interrupt  | digest every 2 hours                  |
| `away`      | interrupt  | interrupt  | held until the mode ends (8 hour cap) |
| `off`       | quiet push | quiet push | held until the mode ends (8 hour cap) |

A quiet push is delivered now without a sound (`sound: null`, iOS `interruptionLevel: passive`, Android channel `quiet`). `off` is respected: even `urgent` does not make a sound, and it is still delivered and ledgered. A mode carries an optional `until`; once it passes the daemon reads `available` and sends what waited. Leaving `away` or `off` sends the digest at once.

`away` differs from `available` only in holding notices, because the phone is the only channel when away and alerts must still reach it. The OpenRig away-deferral (one interrupt at T+30) is not ported.

## Repeats

A sender can pass `dedupeKey` for a situation that re-fires (one account window, one agent's failover). A second notification with the same key inside 60 minutes is counted on the first (`repeatCount`), not sent. The window runs from the first send, so a condition that persists is re-announced hourly rather than every sweep. A repeat at a higher level than the first is not folded: an escalation is news.

The ledger is on disk, so the cooldown survives a daemon restart. Monitors keep their own once-per-episode logic; the key is a backstop for the ones that lose it.

## Digests

Held notices are `state: held` in the ledger, so they survive a restart. The digest is written in one atomic commit that moves the members out of the buffer and creates the digest entry, then it is sent. A crash before the commit leaves the notices held; a crash after it resends the digest on startup (if it is under 10 minutes old; older ones are marked failed rather than sent stale). No notice is in two digests.

A digest of one is that notification, sent quietly, with its own deep link. A digest of several is titled `N notices from Paseo`, groups lines by title with a count, and opens the host.

## The ledger and receipts

`push/ledger.ts` keeps `push-ledger.json`: every notification with its level, outcome and delivery state, capped at 1000 entries and 7 days (held and unconfirmed entries are never pruned). `push/receipts.ts` reads Expo receipts 15 minutes after a send, every 5 minutes, until they expire at 24 hours.

| State       | Meaning                                                                           |
| ----------- | --------------------------------------------------------------------------------- |
| `recorded`  | Nothing was meant to be pushed (`log`)                                            |
| `held`      | In the digest buffer, or decided but not yet handed to the provider               |
| `digested`  | Rolled into a digest; the digest entry carries the delivery state                 |
| `sent`      | Provider accepted it; receipt not read yet (or expired without one)               |
| `delivered` | Provider's receipt was ok. This is admission to the device, not proof it was read |
| `failed`    | Provider refused it, in the ticket or the receipt                                 |
| `no-device` | No phone was registered                                                           |

**Unreached** is `failed` or `no-device` for anything meant to be pushed, and a notice inside a digest that failed. One device receiving a message is enough to call it `delivered`. A `DeviceNotRegistered` receipt revokes the token, as a ticket error already did. `finish_report_undelivered` (see [finish-reports.md](finish-reports.md)) is the escalation that tells the operator an agent's result reached nobody, so it is `urgent` and its own unreached state matters most.

Read it with `client.listNotificationLedger({ unreachedOnly: true })`. Settings shows the count and the latest entries.

## Sender inventory

| Sender (reason)                                  | Level                                    | Why                                                                                            |
| ------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Agent attention `permission`                     | `alert`                                  | The agent is blocked on you                                                                    |
| Agent attention `finished`, root agent           | `alert`                                  | The thing you were waiting for                                                                 |
| Agent attention `finished`, delegated child      | `notice`                                 | Reported to its parent, not to a person; a stuck report escalates separately                   |
| Terminal `finished` / `needs_input`              | `alert`                                  | Same as an agent; a terminal has no parent to report to                                        |
| `finish_report_undelivered`                      | `urgent`                                 | A child's result reached no agent and nothing else will say so                                 |
| `token_burn_account_pressure`                    | `urgent`                                 | The pool is about to cap and every agent on it stops                                           |
| `token_burn_governor` `pause`, `stopFanOut`      | `alert`                                  | An agent is stopped or blocked until someone acts                                              |
| `token_burn_governor` `notify`, `downgrade`      | `notice`                                 | News, nothing to do                                                                            |
| `token_burn_governor`, dry run                   | `record`                                 | Nothing changed                                                                                |
| `token_burn_rate`, `token_burn_total`, `_multi`  | `notice`                                 | A busy agent reads the same as a runaway ([token-burn.md](token-burn.md)); the row badge stays |
| `account_failover`, resumed                      | `notice`                                 | Automation handled it                                                                          |
| `account_failover`, could not restart            | `alert`                                  | The agent is waiting for a message from you                                                    |
| `model_divergence`                               | `notice`                                 | Costs money slowly; nothing breaks                                                             |
| `plugin_offline`                                 | `notice`                                 | Monitor already waits past a threshold; plugins restart during development                     |
| `resource_memory`, `resource_cpu`, `_multi`      | `notice`                                 | Per-agent process trees; the live alert on the row stays                                       |
| `resource_system_memory`                         | `alert`                                  | Swap pressure freezes the machine                                                              |
| `resource_orphan_daemons`                        | `notice`                                 | Leftover build daemons; the body names the fix                                                 |
| `resource_daemons_reaped`, `artifacts_reclaimed` | `record`                                 | Cleanup that worked                                                                            |
| `disk_space_critical`                            | `urgent`                                 | Writes start failing                                                                           |
| `disk_sweep_unsafe_orphan`                       | `notice`                                 | A decision, but not a timed one                                                                |
| `disk_sweep_reclaimed`                           | `record`                                 | Cleanup that worked                                                                            |
| `done_janitor`                                   | `record`, `notice` if it kept a worktree | Routine tidying, unless it left something behind                                               |
| `mcp_gateway_needs_auth`, `_multi`               | `alert`                                  | Only a person can sign in again                                                                |
| `mcp_gateway_error`                              | `notice`                                 | Often recovers on its own                                                                      |
| `daemon_event_loop_wedged`                       | `alert`                                  | Sent only after the loop recovers; agents that stalled through it may need a look              |

## What the phone gets

`PushService` sends `sound`, `priority`, `interruptionLevel` and `channelId` per outcome. Two things depend on the app build, not the daemon:

- The Android `quiet` channel is created by the app (`push-notifications/internal/subscriptions.ts`). An app that predates it gets Expo's fallback channel, so quiet pushes may still make a sound there until it updates.
- iOS `time-sensitive` breaks through Focus only when the app carries the Time Sensitive Notifications entitlement. Without it iOS treats the push as `active`.

Settings are edited through `notifications.policy.get|set.request` and read back with `notifications.ledger.list.request` (`session/notify-policy/`), gated on `server_info.features.notificationPolicy`. The app section is `screens/settings/host-notifications-section.tsx` on the host page.

## Adding a sender

First decide whether something could fix the condition. If a deterministic remedy exists, or an agent could try, the sender is a monitor on the ladder: report through `RemediationSink.observe()` every sweep, record what the remedy did at `record`, and never push about the condition yourself. The ladder owns the one push, its level (`observation.level`) and its dedupe key ([remediation.md](remediation.md#plugging-in-a-monitor)).

Otherwise pass `{ level }` (and `dedupeKey` if it can re-fire) on the `send` call, and put a test on the level if the level depends on state. If it is a monitor, keep the once-per-episode logic; the policy is not a substitute. Either way, add a row to the inventory above.

## Not built yet

Budget pacing does not read availability, so `away` does not yet tell it to speed up. There is no CLI verb for the ledger or the mode, and no sidebar quick toggle; the mode is changed in host settings. Scoped operating posture (OR-E6) is deferred: OpenRig reports its behavioural effect as unobserved.
