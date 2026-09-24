# Daemon vitals

Three small pieces that answer "is the daemon actually running, and if not, what happened?": an event-loop wedge detector, a slow-op recorder, and a shutdown receipt. They are the ports of OR-D3, OR-D4 and OR-C11 from the [OpenRig port plan](plans/2026-09-23-001-feat-openrig-port-plan.md). Code lives in `packages/server/src/server/daemon-vitals/`.

## Config

`agents.daemonVitals` in `config.json`. Read once at boot: relaunch to change it. The detector owns a thread and a file, and starting or stopping either mid-run is not worth a live-toggle.

| Key                 | Default | What it does                                                               |
| ------------------- | ------- | -------------------------------------------------------------------------- |
| `enabled`           | `false` | Turns on the wedge detector and the slow-op recorder                       |
| `dryRun`            | `true`  | Detect, log and record; send no push. Logs `would push` instead            |
| `tickMs`            | 250     | Main-thread tick                                                           |
| `slowStallMs`       | 500     | Blocked time worth recording (a `stall`)                                   |
| `wedgeMs`           | 5000    | Blocked time that is a wedge: push after recovery, status reports `wedged` |
| `suspendMs`         | 2000    | Watchdog-thread silence that means the whole process was paused            |
| `slowOpThresholdMs` | 250     | Budget for a recorded operation                                            |
| `shutdownReceipt`   | `true`  | The one key that defaults on. See below                                    |

It logs `Monitor mode` with `monitor: "daemonVitals"` at boot like every other monitor. Run a week in dry run before setting `dryRun: false`.

## The wedge detector

A daemon can keep its pid and its port while its event loop is blocked. Then nothing running on that loop can say so: the websocket, the push sender and `/api/health` all go quiet together. Two threads cover it. The main thread ticks and classifies each late tick. A watchdog thread (`watchdog-worker.ts`, an inline `eval` worker so it resolves under tsx, the tsc build and the packaged app alike) keeps `diagnostics/daemon-vitals.json` current once a second, whether or not the main thread is answering. `paseo daemon status` reads that file straight off disk, so it can report `wedged (event loop blocked 41s; process is alive)` while the wedge is still going. It never derives "down" from a probe deadline; that is the defect OpenRig v0.5.14 admits. The push goes out on the first tick after the loop recovers, because nothing can be sent before it.

### Suspension is not a wedge

macOS suspends the whole daemon process, including while the user is active. From the main thread a suspension and a wedge look identical: a timer that fires 40 s late. A detector that reads both as a wedge false-alarms on every sleep and gets muted within a day. `stall-tracker.ts` separates them with three signals. The first two decide; the third only corroborates:

1. **The watchdog thread went quiet too.** A blocked main thread leaves the watchdog running; a suspended process stops every thread. This is the primary signal, and the only one that works when the main thread is asleep in a synchronous call (`execFileSync`, a stuck disk): that burns no CPU and looks exactly like a suspension to a CPU-time check.
2. **The monotonic clock advanced less than the wall clock.** macOS and Linux stop the monotonic clock across system sleep.
3. **Process CPU time over the gap.** A stopped process consumes none. It cannot decide, because a thread parked in a syscall also burns none. It corroborates a suspension and labels a wedge `busy` (compute) or `blocked` (waiting). It is a hint: on a loaded machine a spinning process is descheduled and reads as blocked, so do not build anything on `cause`.

Suspended time is subtracted from the gap. A wedge that straddled a sleep reports only the blocked part, and a gap that was all sleep is logged as `Daemon process was suspended; not counted as an event-loop stall` with no push. Suspensions also reset the lag histogram so a closed lid does not become a 60 s worst case.

The tests prove it against a real process, not a simulation: `event-loop.process.test.ts` forks the monitor, blocks its main thread (busy and in `Atomics.wait`) and sends `SIGSTOP`/`SIGCONT` to it. `SIGSTOP` has no Windows equivalent, so that case is skipped there and the branches are covered by the pure `stall-tracker.test.ts`.

## The slow-op recorder

`SlowOpRecorder` (`slow-ops.ts`) appends one JSON line per operation that ran past its budget to `diagnostics/slow-ops.jsonl`, rotated at 1 MiB across three files. The write happens off the call path and is fsynced, the queue is bounded, and a failed write is counted, never thrown. Sources today: every event-loop stall and wedge, and garbage collections over budget. To time a call site, wrap it with `withSlowOpSync` or `withSlowOpStage` from `slow-ops.ts`; both are no-ops while the vitals are off. Nothing in the daemon calls them yet: `agent-manager.ts` and `session.ts` are shared hot spots, so adoption is left to the units that own them. Line a wedge up with what else was slow around it by timestamp.

## The shutdown receipt

`daemon-worker.ts` writes `$PASEO_HOME/daemon-shutdown.json` on the way out: `clean`, `failed`, `timed-out` (the 10 s budget ran out; `phase` says what was running) or `crashed` (an uncaught exception or unhandled rejection). A daemon killed outright writes nothing, and that absence is the point: it is how the next start, and restart recovery, tell "it stopped when asked" from "it died". At startup the previous receipt is moved to `daemon-shutdown.previous.json` and its outcome is logged, so a stale `clean` can never describe a run that then crashed.

It defaults on, unlike everything else here. It writes one small file as the process exits and observes nothing, and its absence only means "it died" if it is written on every run, not only runs where someone opted in. Set `shutdownReceipt: false` to turn it off.

Supervisor-loss exits and a failed `createPaseoDaemon` leave no receipt. Both are abnormal, and a missing receipt reads that way.
