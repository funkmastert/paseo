# Resource monitor

The daemon tracks OS-level memory and CPU per agent and warns when one runs away, alongside two machine-level checks: swap pressure and orphaned build daemons. An opt-in fourth leg reaps abandoned build daemons instead of only reporting them. It's the process-tree counterpart to [docs/token-burn.md](token-burn.md), which watches provider-reported token usage — same monitor shape, different signal.

## What's attributed, and how

Every 60s, `AgentResourceMonitor` (`packages/server/src/server/agent-resource-monitor.ts`) shells out to `ps -axo pid,ppid,uid,rss,pcpu,etime,cputime,command` and, on macOS/Linux, samples system swap. `uid` exists for the reaper alone — nothing may be signalled without proving it belongs to the user the daemon runs as. Both samples are best-effort with a 15s timeout: a host without `ps` gets one warning and no process legs, never a failing sweep, and a sweep still in flight is not overlapped by the next tick. `process-attribution.ts` finds each live agent's root process by the `callerAgentId=<agentId>` marker `withRuntimePaseoMcpServer` (`agent/runtime-mcp-config.ts`) writes into the Paseo MCP URL at launch, then walks `ppid` to collect every descendant. Memory and CPU are summed across the tree. CPU is the rate since the previous sweep (`process-cpu-rate.ts`: cumulative CPU seconds consumed over wall-clock elapsed), not the `%CPU` column `ps` prints — that one is a decayed lifetime average, so a process that spiked an hour ago reads high all day and a fresh runaway on a long-lived tree reads low for a long time. A pid's first sighting uses the `ps` value, since for a young process the two agree.

The same sweep hands its `ps` rows to the device cap, which counts booted simulators and emulators from them — one scan a minute rather than two. That cap is a sibling, not a leg of this monitor: see [docs/device-leases.md](device-leases.md).

A process that gets reparented to pid 1 — a crashed shell, a build tool that daemonizes on purpose — falls out of every agent's tree. There's no way to attribute it to whoever launched it, so it isn't folded into any agent's usage. Gradle and Kotlin's compile daemons, .NET's compiler and build servers (`VBCSCompiler`, MSBuild node-reuse workers, the Razor server) and Metro do this by design or by habit, and they're common enough (and heavy enough — idle Gradle daemons commonly hold hundreds of MB to low GB each; a busy `VBCSCompiler` once used 439% CPU) to warrant their own signal: any ppid-1 process whose command line matches the build-daemon allowlist in `agent/build-daemon-signatures.ts` is counted separately as an orphan build daemon, by count and total RSS, rather than silently dropped. The list also keeps the bare names `GradleDaemon`, `KotlinCompileDaemon` and `VBCSCompiler` as counting markers, so a process carrying one of them still shows up (as `not-on-allowlist` to the reaper) when no exact matcher accepts its command line.

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
- **Escalation.** Both name a `task` for the ladder's rung-2 agent, with the boundary written into the task itself rather than left to the agent's judgement: orphan daemons may run `./gradlew --stop` or `dotnet build-server shutdown`, or end an idle daemon whose build is gone, and must never touch a daemon under a running agent's tree or a build still using CPU; system memory may stop provably leftover processes (orphaned build daemons, unleased simulators, dev servers of archived agents) and must never touch a running agent's process or the daemon itself.

## Reaping abandoned build daemons

Off by default. It reaps Gradle and Kotlin daemons, .NET compiler and build servers, and Metro. Turn it on under `agents.resourceMonitor.reaper`, and turn on `dryRun` first: it runs the whole selection and reports exactly what it would kill, without signalling anything.

A daemon is only reaped once every one of these holds. Each is a separate way for a process to prove somebody still cares about it, so any single one failing spares it:

- **`ppid` is 1.** It was reparented to init, so the shell, Gradle client, or agent that launched it is gone. A daemon serving a build in progress still has its launcher as a parent.
- **No live agent's tree contains it**, and its command line carries no `callerAgentId=` marker. The second check matters on its own: attribution only covers agents the daemon currently lists, so an archived agent's leftover process would otherwise look unowned.
- **Its uid matches the daemon's.** Another user's process, or a platform that can't report a uid, is never signalled.
- **Its command line matches the allowlist** (`agent/build-daemon-signatures.ts`). Every matcher works on whole argv tokens and needs a second fact a search or an editor can't fake, because a substring like `GradleDaemon` also matches `grep GradleDaemon`, an editor holding the string in a path, and the reaper's own source. Anything not on the list is reported exactly as before and never signalled. Add an entry only after checking a real command line.

  | Kind (label)                          | Matches                                                                                                                                               | Command line from                       |
  | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
  | `gradle` (Gradle daemon)              | main class `org.gradle.launcher.daemon.bootstrap.GradleDaemon` as a whole token, after a `java` token                                                 | a live daemon                           |
  | `kotlin` (Kotlin compile daemon)      | main class `org.jetbrains.kotlin.daemon.KotlinCompileDaemon` as a whole token, after a `java` token                                                   | a live daemon                           |
  | `vbcscompiler` (.NET compiler server) | a `.../VBCSCompiler` apphost, or `dotnet .../VBCSCompiler.dll`, followed by a `-pipename:` argument                                                   | live apphost; the dll form from the SDK |
  | `msbuild-node` (MSBuild node)         | `dotnet .../MSBuild.dll` (or `MSBuild.exe`) with both `/nodemode:<n>` and `/nodeReuse:true` — the worker, never the `dotnet build` client             | live workers                            |
  | `razor-server` (Razor build server)   | `dotnet .../rzc.dll server`                                                                                                                           | the SDK's `rzc.dll`; none was running   |
  | `metro` (Metro bundler)               | `node` running `.bin/expo` or `expo/bin/cli` with `start`, `.bin/react-native` or `react-native/cli.js` with `start`, or Metro's own CLI with `serve` | package layouts; none was running       |

  The "derived" rows come from the installed SDK and package files rather than a process, so the first dry run on a machine that has one running is what confirms them. A wrapper such as `cross-env ... expo start` or `npm run start` never matches: only the node process that is the bundler does. Paths are matched by basename with either separator and `.exe` names accepted, so the matchers are right if Windows reaping ever arrives, but the reaper stays POSIX-only: it needs a uid to prove the process is the daemon's own.

- **It has been idle for `idleMinutes`, observed across at least `minIdleSweeps` sweeps.** Idle means the CPU rate between sweeps (`process-cpu-rate.ts`), never `ps`'s lifetime average — a daemon that compiled hard an hour ago and has slept since reads as busy there. A pid's first sighting carries no idle evidence at all for that reason, and one busy sweep resets the clock to zero rather than pausing it. Both gates apply: the sweep count is what makes it evidence rather than one sample, and the wall-clock duration is what a stalled or restarted sweep loop can't fake.

Then SIGTERM, one shared grace window (`graceMs`, default 10s — it blocks the sweep, so it stays well under the 60s interval), then SIGKILL for whatever is still running. Every kind exits on SIGTERM (Gradle and Kotlin daemons, `VBCSCompiler`, MSBuild nodes, the Razor server and Metro), so escalation is the exception. Where a tool has a clean-shutdown command, that is the manual alternative to waiting for the reaper: `./gradlew --stop` for Gradle and Kotlin, `dotnet build-server shutdown` for `VBCSCompiler`, MSBuild nodes and the Razor server together. At most `maxPerSweep` daemons go per sweep, largest first. A pid is acted on once: a daemon slow to die is still in the next `ps` snapshot, and re-running the sequence on it would double-report memory already reclaimed. A pid that comes back EPERM is warned about once and skipped from then on.

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

A killed daemon means the next build in that project starts cold, and each kind pays differently:

- **Gradle and Kotlin:** a fresh JVM, an empty daemon-side cache, and a noticeably slower first build — tens of seconds on a large Android project.
- **.NET (`VBCSCompiler`, MSBuild nodes, Razor server):** the first build afterwards starts a new compiler server and re-spawns the worker nodes, and the first compile has no warm Roslyn state. That is seconds to tens of seconds per solution, and it hurts most on a large solution with many projects.
- **Metro:** a restart re-crawls the file map and rebuilds the transform cache. A large app takes tens of seconds to a couple of minutes to serve its first bundle, and a device that was connected has to reload. Metro is the kind you are most likely to have started yourself, so it earns the same ppid-1 and idle proof as the rest and no shortcut: a Metro under a live terminal or agent is never touched.

Fifteen minutes of idle is the default because it is long enough that you have probably moved on, but a daemon you come back to after a coffee is one you will pay to restart. Raise `idleMinutes` if you bounce between builds; lower it if memory or CPU matters more than the first build after a break.

## Why this is a separate monitor from token burn

Token burn reads provider-reported usage per turn; it has no visibility into what a tool call spawned. A `git push` running heavy pack compression, or a Gradle daemon still resident from a build ten minutes ago, never shows up in provider token accounting — it only shows up in `ps`. The two monitors share a shape (`agent/token-burn-detector.ts` and `agent/sustained-breach-detector.ts` are structurally the same state machine) but sample entirely different data. They share an enforcement shape too: this doc's reaper, token burn's [spend governor](token-burn.md#the-spend-governor), the [device cap](device-leases.md) and the [artifact janitor](artifact-janitor.md) are all opt-in, all dry-runnable, and all act only on evidence gathered across sweeps.
