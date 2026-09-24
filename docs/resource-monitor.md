# Resource monitor

The daemon tracks OS-level memory and CPU per agent and warns when one runs away, alongside two machine-level checks: swap pressure and orphaned build daemons. An opt-in fourth leg reaps abandoned build daemons instead of only reporting them. It's the process-tree counterpart to [docs/token-burn.md](token-burn.md), which watches provider-reported token usage — same monitor shape, different signal.

## Agents run at low priority

The monitor below reports a runaway after the fact. This section is what keeps the machine usable while one is running: the daemon starts every agent at low priority, so a build farm that saturates every core still leaves the daemon, the app and whatever you're typing into first in line for CPU. It works by scheduling class, so it holds even when the monitor itself is blind because `ps` has stopped answering.

**Lowered** (`agents.processPriority.agentNice`): the agent provider processes (Claude, Codex, ACP agents and the commands they run through the daemon, Pi/OMP, OpenCode's shared server), and the terminals and workspace scripts an agent starts through the MCP tools. **Lowered** (`backgroundNice`): the daemon's own periodic subprocesses, meaning the `git fetch` refresh and the forge PR-status polling (`gh`, `tea`, and the other forge CLIs). **Normal**: the daemon itself, terminals and scripts a person opens, and git or forge work someone is waiting on, such as opening a diff. A spawn site opts in with `priority` on `spawnProcess`/`execCommand`/`runGitCommand`, or `runWithSpawnPriority` around a call that reaches its subprocess through layers with no option to thread; nothing is lowered by default. The daemon never lowers itself: only root can raise a priority again on macOS and Linux.

Children inherit the priority, which is why lowering the provider process is enough to make the builds and tests it runs low too:

| Platform | What `nice 10` means                                                             | Inheritance                                                               |
| -------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| macOS    | Unix nice 10                                                                     | Children inherit it                                                       |
| Linux    | Unix nice 10                                                                     | Children inherit it                                                       |
| Windows  | libuv maps 10..18 to `BELOW_NORMAL_PRIORITY_CLASS`, 19 to `IDLE`, 0..9 to normal | A child of a `BELOW_NORMAL` or `IDLE` parent starts in the parent's class |

A process already at or below the target is left alone, and a failure to set the priority (the process exited, or belongs to another user) is swallowed: an agent that starts at normal priority is better than one that does not start.

The terminal worker is a separate process that cannot read the daemon's config, so the daemon resolves the nice when an agent asks for a terminal and passes the number down. A reused workspace-script terminal keeps the priority it was created with.

Config lives under `agents.processPriority`, live-patchable. Values outside 0..19 are rejected, since the daemon only ever lowers priority. Spawn sites read the current policy at spawn time; processes already running keep the priority they started with.

| Key              | Default | Meaning                                                                   |
| ---------------- | ------- | ------------------------------------------------------------------------- |
| `enabled`        | `true`  | Off leaves every process at normal priority                               |
| `agentNice`      | `10`    | Nice for agent provider processes and the terminals/scripts agents start  |
| `backgroundNice` | `10`    | Nice for the daemon's periodic `git fetch` and forge polling subprocesses |

## What's attributed, and how

Every 60s, `AgentResourceMonitor` (`packages/server/src/server/agent-resource-monitor.ts`) shells out to `ps -axo pid,ppid,uid,rss,pcpu,etime,cputime,command` and, on macOS/Linux, samples system swap. `uid` exists for the reaper alone — nothing may be signalled without proving it belongs to the user the daemon runs as. Both samples are best-effort with a 15s timeout: a host without `ps` gets one warning and no process legs, never a failing sweep, and a sweep still in flight is not overlapped by the next tick. `process-attribution.ts` finds each live agent's root process by the `callerAgentId=<agentId>` marker `withRuntimePaseoMcpServer` (`agent/runtime-mcp-config.ts`) writes into the Paseo MCP URL at launch, then walks `ppid` to collect every descendant. Memory and CPU are summed across the tree. CPU is the rate since the previous sweep (`process-cpu-rate.ts`: cumulative CPU seconds consumed over wall-clock elapsed), not the `%CPU` column `ps` prints — that one is a decayed lifetime average, so a process that spiked an hour ago reads high all day and a fresh runaway on a long-lived tree reads low for a long time. A pid's first sighting uses the `ps` value, since for a young process the two agree.

The same sweep hands its `ps` rows to the device cap, which counts booted simulators and emulators from them — one scan a minute rather than two. That cap is a sibling, not a leg of this monitor: see [docs/device-leases.md](device-leases.md).

A process that gets reparented to pid 1 — a crashed shell, a build tool that daemonizes on purpose — falls out of every agent's tree. There's no way to attribute it to whoever launched it, so it isn't folded into any agent's usage. Gradle and Kotlin's compile daemons do this by design, and they're common enough (and heavy enough — idle Gradle daemons commonly hold hundreds of MB to low GB each) to warrant their own signal: any ppid-1 process whose command line matches a known build-daemon marker (`GradleDaemon`, `KotlinCompileDaemon`) is counted separately as an orphan build daemon, by count and total RSS, rather than silently dropped.

## Legs and thresholds

Config lives under `agents.resourceMonitor` (`persisted-config.ts`), live-toggleable like `tokenBurnMonitor`. Four independent sustained-threshold legs (`agent/sustained-breach-detector.ts`), each firing once and re-arming after `sustainedMinutes` (default 3) consecutive sweeps back under threshold:

| Leg                      | Default threshold | Scope                                                   |
| ------------------------ | ----------------- | ------------------------------------------------------- |
| `memoryBytesPerAgent`    | 6 GiB             | per agent's process tree                                |
| `cpuPercentPerAgent`     | 400 (four cores)  | per agent's process tree, rate since the previous sweep |
| `systemSwapUsedRatio`    | 0.9               | machine-wide                                            |
| `orphanBuildDaemonBytes` | 2 GiB             | machine-wide, orphan daemons only                       |

An agent's memory and CPU legs are independent state machines but share one alert: the agent's live `resourceAlert` clears only once both legs are back under threshold. A sweep with no attributable process for an agent (it hasn't launched anything, or its tree already exited) is treated as a below-threshold reading — the same path that re-arms a fired leg.

## Actions on an agent breach

- **Push notification** (`@getpaseo/protocol/resource-monitor-notification`, mirrors `token-burn-notification.ts`): per-agent pushes report both current memory and CPU regardless of which leg fired, since a tree heavy enough to trip one is usually pushing the other too. Its level follows whether the remedy below actually reached the agent: a running agent that was steered is a `record` — the message already did the job — while an idle or unsteerable agent stays a `notice`, since nothing acted on it. More than 3 agent breaches in one sweep collapse into a single batched push, `record` only if every agent in it was steered; each agent still gets its own live alert and, if `notifyAgent` is on, its own steered message.
- **Live `resourceAlert`** on the agent payload (`AgentSnapshotPayloadSchema`/`AgentListItemPayloadSchema`), additive-optional and deliberately not part of the closed `attentionReason` enum — same treatment as `tokenBurnAlert`. Live-only: cleared on rewind, never persisted, and `agent-state-bucket.ts` treats it as attention-worthy alongside `tokenBurnAlert`.
- **A message into the agent's own conversation**, when `notifyAgent` is on (default true) and the agent is mid-turn: one steered system message per episode, reusing the same `isSystemInjectedEnvelope`/`sendPromptToAgent` path chat mentions and notify-on-finish use (`activeTurnBehavior: "steer"`, `unarchive: false`) — not a new delivery mechanism. An idle agent is never steered: that path falls back to starting a new turn, which would spend tokens on an agent nobody is driving, and an idle agent with a heavy leftover child is the most common breach. It gets the push and the live alert only.

## The two machine-level conditions ride the remediation ladder

Swap pressure and orphan build daemons never push directly any more — this monitor has no agent to steer a fix into for either, so the old orphan-daemon push just named `./gradlew --stop` in the body and hoped. Instead each sweep reports both to the [remediation ladder](remediation.md) through `RemediationSink.observe()`, kind `orphan-build-daemons` (key `orphan-build-daemons`) and `system-memory` (key `system-memory`). The ladder owns the person-facing push; this section is what this monitor hands it.

- **Remedy state.** Orphan daemons: `live`/`dry-run`/`disabled` follows the reaper's own config directly. System memory has no leg of its own — its remedies are the reaper's pass and the artifact janitor's reclaim, both of which already run inside this same sweep — so it reads `live` when the reaper is live and `none` otherwise.
- **Evidence.** Orphan daemons get one line per pid: kind, RSS, CPU rate, plus the reaper's current idle/grace settings. System memory gets swap used/total and the biggest process trees in the sample by RSS (`agent/memory-consumers.ts`), each labelled with its agent's title where process-attribution can name one, so a person or an agent doesn't have to re-run `ps` to see what to look at.
- **Attempts.** Both accumulate this episode's own remedy activity: a reap or a dry-run "would reap" line for orphan daemons, plus the artifact janitor's reclaims for system memory. Orphan daemons also carry why the reaper spared whatever it left alone, rolled up from `build-daemon-reaper.ts`'s per-pid verdicts into counts (`busy 2, not-on-allowlist 1`) — the same evidence `reportReaperSightings`' log line already gathers, handed to the ladder instead of only the log.
- **Grace.** Orphan daemons get the reaper's `idleMinutes` plus two sweeps — long enough for the reaper's own wait and the sweeps that observe it to run their course before an agent gets involved. System memory gets a flat 10 minutes: the reaper and the janitor already run every sweep, so ten minutes is ten more chances for either to clear it.
- **Level.** Orphan daemons: `alert` when the reaper is live (a real remedy that still didn't clear it is worth interrupting for) and `notice` when it is disabled or in dry run (the operator opted out; rung 3 still fires, just quieter — the ranking [docs/remediation.md](remediation.md) already spells out). System memory is always `alert`: a machine low enough on memory to trip this leg is worth knowing about regardless of what can act on it.
- **Escalation.** Both name a `task` for the ladder's rung-2 agent, with the boundary written into the task itself rather than left to the agent's judgement: orphan daemons may run `./gradlew --stop` or end an idle daemon whose build is gone, and must never touch a daemon under a running agent's tree or a build still using CPU; system memory may stop provably leftover processes (orphaned build daemons, unleased simulators, dev servers of archived agents) and must never touch a running agent's process or the daemon itself.

## Reaping abandoned build daemons

Off by default. Turn it on under `agents.resourceMonitor.reaper`, and turn on `dryRun` first: it runs the whole selection and reports exactly what it would kill, without signalling anything.

A daemon is only reaped once every one of these holds. Each is a separate way for a process to prove somebody still cares about it, so any single one failing spares it:

- **`ppid` is 1.** It was reparented to init, so the shell, Gradle client, or agent that launched it is gone. A daemon serving a build in progress still has its launcher as a parent.
- **No live agent's tree contains it**, and its command line carries no `callerAgentId=` marker. The second check matters on its own: attribution only covers agents the daemon currently lists, so an archived agent's leftover process would otherwise look unowned.
- **Its uid matches the daemon's.** Another user's process, or a platform that can't report a uid, is never signalled.
- **Its command line matches the allowlist** (`agent/build-daemon-reaper.ts`): a JVM main class as a whole argv token, with a `java` token before it. `GradleDaemon` as a substring would also match `grep GradleDaemon`, an editor holding the string in a path, and the reaper's own source. The two entries — Gradle's `org.gradle.launcher.daemon.bootstrap.GradleDaemon` and Kotlin's `org.jetbrains.kotlin.daemon.KotlinCompileDaemon` — were read off a live daemon and out of `kotlin-daemon-embeddable`'s jar. Add an entry only after checking a real command line. Anything not on the list is reported exactly as before and never signalled.
- **It has been idle for `idleMinutes`, observed across at least `minIdleSweeps` sweeps.** Idle means the CPU rate between sweeps (`process-cpu-rate.ts`), never `ps`'s lifetime average — a daemon that compiled hard an hour ago and has slept since reads as busy there. A pid's first sighting carries no idle evidence at all for that reason, and one busy sweep resets the clock to zero rather than pausing it. Both gates apply: the sweep count is what makes it evidence rather than one sample, and the wall-clock duration is what a stalled or restarted sweep loop can't fake.

Then SIGTERM, one shared grace window (`graceMs`, default 10s — it blocks the sweep, so it stays well under the 60s interval), then SIGKILL for whatever is still running. Gradle and Kotlin daemons exit cleanly on SIGTERM, so escalation is the exception. At most `maxPerSweep` daemons go per sweep, largest first. A pid is acted on once: a daemon slow to die is still in the next `ps` snapshot, and re-running the sequence on it would double-report memory already reclaimed. A pid that comes back EPERM is warned about once and skipped from then on.

The same sweep also drives [the artifact janitor](artifact-janitor.md), which reclaims orphaned Xcode test simulator clones from disk. Like the device cap, it is a sibling rather than a leg: it takes this monitor's `ps` rows and its cadence and decides everything itself.

Reaping runs on its own criteria, not off `orphanBuildDaemonBytes` — an abandoned daemon sitting on 800 MB is worth reclaiming even though the machine-level alert only fires at 2 GiB. Turning the reaper off discards the idle evidence it had gathered, so turning it back on starts the wait over.

While the reaper is enabled, dry run or not, it logs `Reaper: orphaned build daemons in view` whenever a ppid-1 build daemon's verdict changes: `first-sighting`, `busy`, `idle-accumulating`, `candidate`, `not-abandoned`, or `not-on-allowlist` (a process carrying a marker that the allowlist rejects), with RSS and CPU rate. A dry run that only logs when it would kill cannot be evaluated: a week without a line looked the same whether no daemon existed, the allowlist rejected every real command line, or busy builds were spared. `Reaper: no orphaned build daemons in view` marks the set going empty.

Every reap still pushes on its own, `record`-level (`resource_daemons_reaped`) — cleanup that worked is worth a receipt even though nothing about it needs a person — naming each pid, kind, RSS reclaimed and how long it had been idle, and logged at info to `daemon.log` with the sweep count behind the decision. The same reap is also folded into that sweep's `orphan-build-daemons` observation above, as an attempt, so the ladder's rung-3 push (if it gets that far) can say what already happened.

| Key              | Default | What it does                                  |
| ---------------- | ------- | --------------------------------------------- |
| `enabled`        | `false` | Nothing is ever signalled while this is off   |
| `dryRun`         | `false` | Select and report, signal nothing             |
| `idleCpuPercent` | 2       | At or below this rate, a sweep counts as idle |
| `idleMinutes`    | 15      | Continuous idle time required                 |
| `minIdleSweeps`  | 3       | Sweeps that must have observed that idleness  |
| `maxPerSweep`    | 2       | Blast radius per sweep                        |
| `graceMs`        | 10000   | SIGTERM-to-SIGKILL wait                       |

### What it costs

Killing an idle Gradle daemon means the next build starts cold: a fresh JVM, an empty daemon-side cache, and a noticeably slower first build in that project — tens of seconds on a large Android project. That is the trade. Fifteen minutes of idle is the default because it is long enough that you have probably moved on, but a daemon you come back to after a coffee is one you will pay to restart. Raise `idleMinutes` if you bounce between builds; lower it if memory matters more than the first build after a break.

## Why this is a separate monitor from token burn

Token burn reads provider-reported usage per turn; it has no visibility into what a tool call spawned. A `git push` running heavy pack compression, or a Gradle daemon still resident from a build ten minutes ago, never shows up in provider token accounting — it only shows up in `ps`. The two monitors share a shape (`agent/token-burn-detector.ts` and `agent/sustained-breach-detector.ts` are structurally the same state machine) but sample entirely different data. They share an enforcement shape too: this doc's reaper, token burn's [spend governor](token-burn.md#the-spend-governor), the [device cap](device-leases.md) and the [artifact janitor](artifact-janitor.md) are all opt-in, all dry-runnable, and all act only on evidence gathered across sweeps.
