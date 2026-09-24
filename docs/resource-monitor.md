# Resource monitor

The daemon keeps the machine responsive while agents build, and watches what they use. This doc covers both halves:

- **Before load happens:** every agent runs at low priority, and a machine-wide cap limits how many child turns run at once.
- **While it happens:** a 60-second sweep attributes memory and CPU to each agent's process tree, warns when one runs away, and reports three machine-level conditions to the [remediation ladder](remediation.md): swap pressure, orphaned build daemons and CPU saturation. Saturation has its own remedies and an incident ledger that survives a forced reboot. An opt-in reaper stops abandoned build daemons instead of only reporting them.

It's the process-tree counterpart to [docs/token-burn.md](token-burn.md), which watches provider-reported token usage.

## Agents run at low priority

The daemon starts every agent at low priority, so a build farm that saturates every core still leaves the daemon, the app and whatever you're typing into first in line for CPU. It works by scheduling class, so it holds even when the monitor is blind because `ps` has stopped answering.

- **`agentNice`:** the agent provider processes (Claude, Codex, ACP agents and the commands they run through the daemon, Pi/OMP, OpenCode's shared server), and the terminals and workspace scripts an agent starts through the MCP tools. Root and child agents start at the same nice. Under load, [the saturation rung](#the-saturation-rung) lowers the heaviest child trees further, and that is what puts roots ahead of children.
- **`backgroundNice`:** the daemon's own periodic subprocesses: the `git fetch` refresh and forge PR-status polling (`gh`, `tea`, and the other forge CLIs).
- **Normal:** the daemon itself, terminals and scripts a person opens, and git or forge work someone is waiting on, such as opening a diff.

A spawn site opts in with `priority` on `spawnProcess`/`execCommand`/`runGitCommand`, or `runWithSpawnPriority` around a call that reaches its subprocess through layers with no option to thread. Nothing is lowered by default. The daemon never lowers itself, because on macOS and Linux only root can raise a priority again.

Children inherit the priority, so lowering the provider process makes the builds and tests it runs low too:

| Platform | What `nice 10` means                                                             | Inheritance                                                               |
| -------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| macOS    | Unix nice 10                                                                     | Children inherit it                                                       |
| Linux    | Unix nice 10                                                                     | Children inherit it                                                       |
| Windows  | libuv maps 10..18 to `BELOW_NORMAL_PRIORITY_CLASS`, 19 to `IDLE`, 0..9 to normal | A child of a `BELOW_NORMAL` or `IDLE` parent starts in the parent's class |

A process already at or below the target is left alone, and a failure to set the priority (the process exited, or belongs to another user) is swallowed: an agent that starts at normal priority is better than one that does not start.

The terminal worker is a separate process that cannot read the daemon's config, so the daemon resolves the nice when an agent asks for a terminal and passes the number down. A reused workspace-script terminal keeps the priority it was created with.

Config lives under `agents.processPriority`, live-patchable. Values outside 0..19 are rejected, since the daemon only ever lowers priority. Spawn sites read the policy at spawn time; processes already running keep the priority they started with.

| Key              | Default | Meaning                                                                   |
| ---------------- | ------- | ------------------------------------------------------------------------- |
| `enabled`        | `true`  | Off leaves every process at normal priority                               |
| `agentNice`      | `10`    | Nice for agent provider processes and the terminals/scripts agents start  |
| `backgroundNice` | `10`    | Nice for the daemon's periodic `git fetch` and forge polling subprocesses |

## Child admission and resume pacing

Admission keeps child agents from starting their load all at once: a machine-wide cap on child turns running at the same time, and a shared pace for the daemon's own bulk restarts. `ChildAdmissionController` (`packages/server/src/server/agent/child-admission.ts`) and `ResumePacer` (`agent/resume-pacer.ts`) own it; config is `agents.admission`, live-patchable and read fresh on every decision.

| Key                       | Default                                   | Meaning                                                     |
| ------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `enabled`                 | `true`                                    | `false` admits everything queued and stops pacing           |
| `maxConcurrentChildTurns` | `max(2, floor(cores / 2))`, 8 on 16 cores | Child turns that may run at once                            |
| `bulkResumesPerMinute`    | `4`                                       | Bulk resumes started per minute; the burst is the same size |

A child is an agent with a `paseo.parent-agent-id` label ([agent-lifecycle.md](agent-lifecycle.md#relationships)). Everything else is a root and is never queued, held or counted.

The cap applies to new turns only, enforced once inside `AgentManager.streamAgent`, the path every new turn takes whoever sends it. Steering into a running turn, out-of-band commands such as `/goal pause`, permission answers, and a replacement of a turn the child is already running never queue: the child already holds its slot. A child past the cap waits FIFO and starts when a child turn ends (idle, error, closed, archived). Slots are counted from lifecycle state, so a turn counts whatever path started it.

A queued child shows `running` with an additive `turnQueued: { queuedAt }` on its payload. Every waiter treats it as pending: `wait_for_agent`, finish reports, the done janitor and failover all read `running`, `waitForAgentRunStart` returns rather than timing out, and the stalled-agent sweep skips it. Cancelling, closing, archiving or deleting a queued child drops it from the queue and settles it as cancelled. A second prompt to a queued child is merged into the held one and keeps its place in line: the held prompt never reached the provider, so replacing it the way a running turn is replaced would lose it. A reload (a model change, an account move) takes the held prompt out of line and puts it back at the same place on the new session, and the agent never shows an idle edge in between. A reload that fails puts it back in line on the old session, or, once the old session is closed (a failover target that is logged out or capped), keeps it in `queue.json` for the next start.

A running child whose own children are running or queued does not occupy a slot. A sub-leader that delegates waits on its workers; if waiting sub-leaders held every slot, their workers could never run.

`setHold(source, held, reason?)` holds admission for a named source, such as [the saturation rung](#the-saturation-rung). Several sources may hold at once, and admission resumes only when none does. While held, new child turns queue and queued ones stay queued; running turns and roots are untouched.

`ResumePacer` is a token bucket for the daemon's bulk restarts: account-failover resume prompts ([account-failover.md](account-failover.md#what-a-migration-does)), stalled-agent nudges ([stalled-agents.md](stalled-agents.md#the-nudge)), "stopped before reporting" deliveries after a restart ([finish-reports.md](finish-reports.md#shutdown-and-restart)), [restart recovery](restart-recovery.md#apply)'s resumes, and held turns re-admitted after a restart. A held turn is admission's alone: restart recovery leaves out a child whose turn admission holds. One resume is immediate; eleven after a failover drain start over about two minutes. Roots are released before waiting children, and a child the pacer releases still asks for an admission slot. Each path keeps its own retries and idempotency; the pacer only delays the send.

Held prompts are written to `$PASEO_HOME/admission/queue.json` on every change. Shutdown closes every agent, which would drop them, so the held set is written and the file frozen first, and shutdown waits up to 5s for that write to land. On start the daemon re-sends each held prompt through the pacer, oldest first, with `activeTurnBehavior: "steer"` so a child someone already prompted is joined rather than cancelled; each goes through admission again. An entry stays in the file until it has been re-sent, so a second restart mid-restore loses nothing. A held prompt whose agent is gone or archived is dropped with a warning. A restored prompt that queues again goes back in at its original place in line, ahead of anything queued since the restart.

`grep '"module":"child-admission"' daemon.log` shows each turn queued, admitted or dropped with the queue length; `"module":"resume-pacer"` shows each resume the pacer delayed.

## What's attributed, and how

Every 60s, `AgentResourceMonitor` (`packages/server/src/server/agent-resource-monitor.ts`) takes three samples through the `ResourceMonitorSampler` seam (`agent/process-sampler.ts`):

- **Load and free memory** from `os` (`agent/system-load.ts`). Nothing is spawned, so this works on a machine too loaded for `ps` to finish, which is when it is needed. macOS and Linux read `os.loadavg()`. Windows returns zeros there, so the load is the share of CPU time busy since the previous sweep, from `os.cpus()` deltas; the first sweep after a start has no reading.
- **The process table.** `ps -axo pid,ppid,uid,rss,pcpu,etime,cputime,command` on macOS and Linux. Windows has no `ps`: PowerShell's `Get-CimInstance Win32_Process` produces the same rows, with CPU time from `UserModeTime + KernelModeTime` and no uid.
- **System memory**: swap and available memory from `sysctl`/`vm_stat` on macOS or `/proc/meminfo` on Linux. Windows reports none.

The sampling children run at `SAMPLER_NICE`, nice 5 (`utils/process-priority.ts`), with a 45s timeout: below normal, but ahead of every agent process. At load 38 on 16 cores the old 15s timeout, with `ps` at the same nice as the builds it measured, failed every sweep and the monitor went blind exactly when the machine saturated. Windows has no class between normal and `BELOW_NORMAL`, and libuv maps 5 to normal, so there the samplers run at normal priority. A sweep still in flight is never overlapped by the next tick.

`uid` exists for [the reaper](#reaping-abandoned-build-daemons) alone: nothing may be signalled without proving it belongs to the user the daemon runs as.

`process-attribution.ts` finds each live agent's root process by the `callerAgentId=<agentId>` marker `withRuntimePaseoMcpServer` (`agent/runtime-mcp-config.ts`) writes into the Paseo MCP URL at launch, then walks `ppid` to collect every descendant. Memory and CPU are summed across the tree. CPU is the rate since the previous sweep (`process-cpu-rate.ts`: cumulative CPU seconds consumed over wall-clock elapsed), not the `%CPU` column `ps` prints. That one is a decayed lifetime average, so a process that spiked an hour ago reads high all day and a fresh runaway on a long-lived tree reads low for a long time. A pid's first sighting uses the sampled value, since for a young process the two agree.

The same sweep hands its process rows to the device cap, which counts booted simulators and emulators from them, and drives [the artifact janitor](artifact-janitor.md), which reclaims orphaned Xcode test simulator clones. Both are siblings rather than legs of this monitor: they take its `ps` rows and cadence and decide everything themselves. See [docs/device-leases.md](device-leases.md).

A process that gets reparented to pid 1 — a crashed shell, a build tool that daemonizes on purpose — falls out of every agent's tree. There's no way to attribute it to whoever launched it, so it isn't folded into any agent's usage. Gradle and Kotlin's compile daemons, .NET's compiler and build servers (`VBCSCompiler`, MSBuild node-reuse workers, the Razor server) and Metro do this by design or by habit, and they're common and heavy enough (idle Gradle daemons commonly hold hundreds of MB to low GB each; a busy `VBCSCompiler` once used 439% CPU) to get their own signal: any ppid-1 process whose command line matches the build-daemon allowlist in `agent/build-daemon-signatures.ts` is counted as an orphan build daemon, by count and total RSS. The list also keeps the bare names `GradleDaemon`, `KotlinCompileDaemon` and `VBCSCompiler` as counting markers, so a process carrying one of them still shows up (as `not-on-allowlist` to the reaper) when no exact matcher accepts its command line. Windows has no reparenting to pid 1, so this signal is macOS and Linux only.

### When the process sample fails

The load, swap and saturation checks run every sweep regardless. A failed process sample is reported as failed (`sampleProcessTable`), never as an empty machine, and the monitor keeps the last good sample:

- **Evidence uses it, marked with its age.** The system-memory observation and saturation evidence name the trees from the last good sample and say how old it is.
- **Nothing that acts on idleness, absence or a pid uses it.** The reaper, the artifact janitor, the device cap and the saturation rung's lowering skip the sweep. A stale row can prove neither that a daemon is idle nor that a simulator is unused, and it can name a pid that is gone or reused. The manual janitor run skips too.
- **Per-agent and orphan-daemon legs hold.** A tree that can't be seen would otherwise read as under threshold and re-arm an alert.
- **The reaper's idle clock restarts.** It counts wall time between sweeps that saw a daemon idle, and the daemon might have been building while nobody could look.

The sampler warns when a failure streak starts and logs `Resource monitor can sample processes again` when it ends, so a second outage hours later is as visible as the first.

## Legs and thresholds

Config lives under `agents.resourceMonitor` (`persisted-config.ts`), live-toggleable like `tokenBurnMonitor`. Four independent sustained-threshold legs (`agent/sustained-breach-detector.ts`), each firing once and re-arming after `sustainedMinutes` (default 3) consecutive sweeps back under threshold:

| Leg                      | Default threshold | Scope                                                   |
| ------------------------ | ----------------- | ------------------------------------------------------- |
| `memoryBytesPerAgent`    | 6 GiB             | per agent's process tree                                |
| `cpuPercentPerAgent`     | 400 (four cores)  | per agent's process tree, rate since the previous sweep |
| `systemSwapUsedRatio`    | 0.9               | machine-wide                                            |
| `orphanBuildDaemonBytes` | 2 GiB             | machine-wide, orphan daemons only                       |

CPU saturation is a fifth condition with its own config block; see [CPU saturation](#cpu-saturation).

An agent's memory and CPU legs are independent state machines but share one alert: the agent's live `resourceAlert` clears only once both legs are back under threshold. A sweep with a working sample and no attributable process for an agent (it hasn't launched anything, or its tree already exited) is treated as a below-threshold reading, the same path that re-arms a fired leg. A sweep with no sample at all is not.

## Actions on an agent breach

- **Push notification** (`@getpaseo/protocol/resource-monitor-notification`, mirrors `token-burn-notification.ts`): per-agent pushes report both current memory and CPU regardless of which leg fired, since a tree heavy enough to trip one is usually pushing the other too. Its level follows whether the steer below reached the agent: a running agent that was steered is a `record`, since the message already did the job; an idle or unsteerable agent stays a `notice`, since nothing acted on it. More than 3 agent breaches in one sweep collapse into a single batched push, `record` only if every agent in it was steered; each agent still gets its own live alert and, if `notifyAgent` is on, its own steered message.
- **Live `resourceAlert`** on the agent payload (`AgentSnapshotPayloadSchema`/`AgentListItemPayloadSchema`), additive-optional and deliberately not part of the closed `attentionReason` enum, the same treatment as `tokenBurnAlert`. Live-only: cleared on rewind, never persisted, and `agent-state-bucket.ts` treats it as attention-worthy alongside `tokenBurnAlert`.
- **A message into the agent's own conversation**, when `notifyAgent` is on (default true) and the agent is mid-turn: one steered system message per episode, through the same `isSystemInjectedEnvelope`/`sendPromptToAgent` path chat mentions and notify-on-finish use (`activeTurnBehavior: "steer"`, `unarchive: false`). An idle agent is never steered: that path falls back to starting a new turn, which would spend tokens on an agent nobody is driving, and an idle agent with a heavy leftover child is the most common breach. It gets the push and the live alert only.

## The machine-level conditions ride the remediation ladder

Swap pressure, orphan build daemons and CPU saturation never push directly: there is no agent to steer a fix into for any of them. Each sweep reports them to the [remediation ladder](remediation.md) through `RemediationSink.observe()`, kind and key `system-memory`, `orphan-build-daemons` and `cpu-saturation`. The ladder owns the person-facing push; this section is what the monitor hands it for the first two. Saturation's answers depend on its cause and are under [The saturation rung](#the-saturation-rung).

- **Remedy state.** Orphan daemons: `live`/`dry-run`/`disabled` follows the reaper's config. System memory has no remedy of its own. Its remedies are the reaper's pass and the artifact janitor's reclaim, both of which run inside the same sweep, so it reads `live` when the reaper is live and `none` otherwise.
- **Evidence.** Orphan daemons get one line per pid: kind, RSS, CPU rate, plus the reaper's idle and grace settings. System memory gets swap used/total and the biggest process trees in the sample by RSS (`agent/memory-consumers.ts`), each labelled with its agent's title where attribution can name one, so whoever looks doesn't have to re-run `ps`.
- **Attempts.** Each accumulates the episode's remedy activity: a reap or a dry-run "would reap" line for orphan daemons, plus the artifact janitor's reclaims for system memory. Orphan daemons also carry why the reaper spared whatever it left alone, rolled up from `build-daemon-reaper.ts`'s per-pid verdicts into counts (`busy 2, not-on-allowlist 1`).
- **Grace.** Orphan daemons get the reaper's `idleMinutes` plus two sweeps, long enough for the reaper's own wait and the sweeps that observe it before an agent gets involved. System memory gets a flat 10 minutes: ten more sweeps in which the reaper or the janitor can clear it.
- **Level.** Orphan daemons: `alert` when the reaper is live (a real remedy that still didn't clear it is worth interrupting for) and `notice` when it is disabled or in dry run (the operator opted out; rung 3 still fires, quieter). System memory is always `alert`: a machine low enough on memory to trip this leg is worth knowing about regardless of what can act on it.
- **Escalation.** Both name a `task` for the ladder's rung-2 agent, with the boundary written into the task rather than left to the agent's judgement. Orphan daemons: run `./gradlew --stop` or `dotnet build-server shutdown`, or end an idle daemon whose build is gone; never touch a daemon under a running agent's tree or a build still using CPU. System memory: stop provably leftover processes (orphaned build daemons, unleased simulators, dev servers of archived agents); never touch a running agent's process or the daemon itself.

## CPU saturation

The machine is saturated when the 1-minute load reaches `loadPerCore` × cores on macOS and Linux, or the busy share reaches `busyFraction` on Windows, for `sustainedMinutes` sweeps. It clears after as many sweeps back under. A sweep with no load reading holds an open incident rather than counting toward clearing it.

The two platforms need different thresholds. The macOS and Linux load average counts runnable tasks and tasks waiting on disk, so it can reach several times the core count, and 2× cores is the "machine is drowning" line. Windows' busy share tops out at 1 and cannot express 2×, so it compares a fraction instead.

The defaults come from the 2026-09-24 incident on a 16-core Mac: load 38 five minutes after a forced reboot, then 32 to 89 for the next quarter hour, peaking while agent trees used 1,289% CPU (the stopgap's log, `~/Library/Logs/Bozeo/cpu-guard.log`). One heavy build doesn't get there: the heaviest single processes in that log were `VBCSCompiler` at 439% and a Gradle JVM at 271%, and even a build that uses every core loads about 1× cores. So 2× for 3 minutes fires on a pile-up of builds and not on one, and the 1.5× release line sits below the threshold and above what a single build leaves behind.

| Key (`agents.resourceMonitor.saturation`) | Default                              | What it does                                                        |
| ----------------------------------------- | ------------------------------------ | ------------------------------------------------------------------- |
| `enabled`                                 | `true`                               | Detection, ledger and rung; off records none and releases admission |
| `loadPerCore`                             | 2                                    | macOS/Linux threshold, per core                                     |
| `busyFraction`                            | 0.9                                  | Windows threshold                                                   |
| `sustainedMinutes`                        | the monitor's `sustainedMinutes` (3) | Sweeps to open, and to clear                                        |
| `releaseLoadPerCore`                      | 1.5                                  | macOS/Linux: child admission is released under this                 |
| `releaseBusyFraction`                     | 0.75                                 | Windows: the same                                                   |
| `reniceTopTrees`                          | 3                                    | Child agent trees lowered per sweep; 0 lowers none                  |
| `reniceNice`                              | 15 (macOS/Linux), 19 (Windows)       | The nice they are lowered to                                        |
| `attributedGraceMinutes`                  | 30                                   | Ladder grace when the cause is known                                |
| `unattributedGraceMinutes`                | 5                                    | Ladder grace when it isn't                                          |

### Evidence and cause

Each sweep of an open incident builds evidence (`agent/saturation-evidence.ts`): the five heaviest agent trees by CPU with title, cwd, CPU%, RSS and their top three commands, and the eight heaviest processes outside any agent. It also splits the load into what the sampled CPU rates explain (summed CPU% / 100, agents and the rest separately) and the remainder, and classifies the cause against the machine's cores, not the load. Sampled CPU can never exceed the core count and saturation opens at 2× cores, so the sample never explains even half the load; comparing against the load would call every incident I/O.

- **`cpu`**: the sampled processes use at least 80% of the cores. Windows' reading is CPU time, so a fresh sample there is always `cpu`.
- **`io`**: a fresh sample shows the cores not pegged. A high load with idle cores is tasks waiting on disk: Spotlight indexing a fresh `node_modules`, installs, git, tree walks. The evidence names the likely ones it found (`mds_stores`, `mdworker`, `git`, `npm ci`, `find`, ...).
- **`unknown`**: the process sample is stale or missing, or there is no load reading, so nothing can split the load.

### The saturation rung

Rung 1 for `cpu-saturation`, run every sweep of an open incident:

- **The reaper.** It already runs every sweep on its own criteria, and saturation doesn't loosen them. Its reaps and the summary of what it spared go into the episode's attempts, as they do for `system-memory`.
- **Hold child admission.** Held when the load is at the threshold and released under `releaseLoadPerCore` × cores (`releaseBusyFraction` on Windows), so a load hovering at the threshold doesn't flap it. Released too on the clear, on `stop()`, and when the monitor or saturation is turned off. It holds for every cause: fewer new builds and installs helps I/O too. The hold goes through `holdChildAdmission` on `AgentResourceMonitorOptions`, wired in `bootstrap.ts` to [child admission](#child-admission-and-resume-pacing) and called on changes only; unwired, the rung holds nothing.
- **Lower the heaviest child agent trees.** The top `reniceTopTrees` [child](#child-admission-and-resume-pacing) trees by CPU rate that use at least one core have every pid lowered to `reniceNice`. Roots, the daemon and processes outside an agent tree are never touched. This runs only on a fresh sample with a `cpu` cause: a lower priority does nothing for tasks waiting on disk. It is re-applied every sweep so pids that join those trees later are covered, and a pid already there is skipped. Agents already run at `agentNice` 10, so on macOS and Linux 15 is a real step down; on Windows 10 to 18 are all `BELOW_NORMAL` ([the priority table](#agents-run-at-low-priority)), so the only step further is 19, `IDLE`. The daemon never raises a priority, so these processes stay lowered for their lifetime, after the incident too.

Every action is a `RemedyAttempt` the ladder records at `record`, is logged at info, and is written into [the ledger](#the-incident-ledger). The remedy state reads `live` when any remedy can act (admission wired, `reniceTopTrees` above 0, or a live reaper) and `none` otherwise.

What the ladder is told depends on who is loading the machine. Agent trees are the cause when they make up at least half the sampled CPU.

| Cause                                                  | Escalation | Grace | Level    |
| ------------------------------------------------------ | ---------- | ----- | -------- |
| `cpu`, agent trees at least half                       | none       | 30m   | `notice` |
| `cpu`, mostly other processes (Android Studio, Xcode…) | none       | 30m   | `notice` |
| `io`                                                   | none       | 30m   | `notice` |
| `unknown` (sampling failing)                           | an agent   | 5m    | `alert`  |

Agent trees are what the remedies act on. Your own apps and disk work are known causes that no agent may touch, so an agent can't help. Only a load nothing can attribute justifies sending one: its task is to find what is loading the CPU and stop only provable leftovers, never a running agent's processes, the daemon, or your own apps such as Android Studio, Xcode or a browser. The grace counts from the episode's open, so an incident that loses its cause 10 minutes in escalates on that sweep.

The stopgap `sh.bozeo.cpu-guard` LaunchAgent renices agent trees and logs load, which this rung and [low priority](#agents-run-at-low-priority) now do in the daemon. Once this branch runs in the daemon, retire it with `launchctl bootout gui/$(id -u)/sh.bozeo.cpu-guard`, then delete `~/Library/LaunchAgents/sh.bozeo.cpu-guard.plist` and its script `~/bozeo-ops/cpu-guard.mjs`.

## Reaping abandoned build daemons

Off by default. It reaps Gradle and Kotlin daemons, .NET compiler and build servers, and Metro. Turn it on under `agents.resourceMonitor.reaper`, and turn on `dryRun` first: it runs the whole selection and reports exactly what it would kill, without signalling anything.

A daemon is only reaped once every one of these holds. Each is a separate way for a process to prove somebody still cares about it, so any single one failing spares it:

- **`ppid` is 1.** It was reparented to init, so the shell, Gradle client, or agent that launched it is gone. A daemon serving a build in progress still has its launcher as a parent.
- **No live agent's tree contains it**, and its command line carries no `callerAgentId=` marker. The second check matters on its own: attribution only covers agents the daemon currently lists, so an archived agent's leftover process would otherwise look unowned.
- **Its uid matches the daemon's.** Another user's process, or a platform that can't report a uid, is never signalled. Windows rows carry none, so the reaper never signals there.
- **Its command line matches the allowlist** (`agent/build-daemon-signatures.ts`). Every matcher works on whole argv tokens and needs a second fact a search or an editor can't fake, because a substring like `GradleDaemon` also matches `grep GradleDaemon`, an editor holding the string in a path, and the reaper's own source. Anything not on the list is reported and never signalled. Add an entry only after checking a real command line.

  | Kind (label)                          | Matches                                                                                                                                               | Command line from                       |
  | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
  | `gradle` (Gradle daemon)              | main class `org.gradle.launcher.daemon.bootstrap.GradleDaemon` as a whole token, after a `java` token                                                 | a live daemon                           |
  | `kotlin` (Kotlin compile daemon)      | main class `org.jetbrains.kotlin.daemon.KotlinCompileDaemon` as a whole token, after a `java` token                                                   | a live daemon                           |
  | `vbcscompiler` (.NET compiler server) | a `.../VBCSCompiler` apphost, or `dotnet .../VBCSCompiler.dll`, followed by a `-pipename:` argument                                                   | live apphost; the dll form from the SDK |
  | `msbuild-node` (MSBuild node)         | `dotnet .../MSBuild.dll` (or `MSBuild.exe`) with both `/nodemode:<n>` and `/nodeReuse:true` — the worker, never the `dotnet build` client             | live workers                            |
  | `razor-server` (Razor build server)   | `dotnet .../rzc.dll server`                                                                                                                           | the SDK's `rzc.dll`; none was running   |
  | `metro` (Metro bundler)               | `node` running `.bin/expo` or `expo/bin/cli` with `start`, `.bin/react-native` or `react-native/cli.js` with `start`, or Metro's own CLI with `serve` | package layouts; none was running       |

  Rows not taken from a live process come from the installed SDK and package files, so the first dry run on a machine that has one running is what confirms them. A wrapper such as `cross-env ... expo start` or `npm run start` never matches: only the node process that is the bundler does. Paths are matched by basename with either separator and `.exe` names accepted, so the matchers are right if Windows reaping ever arrives, but the reaper stays POSIX-only because it needs a uid.

- **It has been idle for `idleMinutes`, observed across at least `minIdleSweeps` sweeps.** Idle means the CPU rate between sweeps (`process-cpu-rate.ts`), never `ps`'s lifetime average: a daemon that compiled hard an hour ago and has slept since reads as busy there. A pid's first sighting carries no idle evidence at all for that reason, and one busy sweep resets the clock to zero rather than pausing it. Both gates apply: the sweep count is what makes it evidence rather than one sample, and the wall-clock duration is what a stalled or restarted sweep loop can't fake. A failed process sample [restarts the clock](#when-the-process-sample-fails).

Then SIGTERM, one shared grace window (`graceMs`, default 10s; it blocks the sweep, so it stays well under the 60s interval), then SIGKILL for whatever is still running. Every kind exits on SIGTERM, so escalation is the exception. Where a tool has a clean-shutdown command, that is the manual alternative to waiting for the reaper: `./gradlew --stop` for Gradle and Kotlin, `dotnet build-server shutdown` for `VBCSCompiler`, MSBuild nodes and the Razor server together. At most `maxPerSweep` daemons go per sweep, largest first. A pid is acted on once: a daemon slow to die is still in the next `ps` snapshot, and re-running the sequence on it would double-report memory already reclaimed. A pid that comes back EPERM is warned about once and skipped from then on.

Reaping runs on its own criteria, not off `orphanBuildDaemonBytes`: an abandoned daemon sitting on 800 MB is worth reclaiming even though the machine-level alert only fires at 2 GiB. Turning the reaper off discards the idle evidence it had gathered, so turning it back on starts the wait over.

While the reaper is enabled, dry run or not, it logs `Reaper: orphaned build daemons in view` whenever a ppid-1 build daemon's verdict changes: `first-sighting`, `busy`, `idle-accumulating`, `candidate`, `not-abandoned`, or `not-on-allowlist` (a process carrying a marker that the allowlist rejects), with RSS and CPU rate. A dry run that only logs when it would kill cannot be evaluated: a week without a line looked the same whether no daemon existed, the allowlist rejected every real command line, or busy builds were spared. `Reaper: no orphaned build daemons in view` marks the set going empty.

Every reap pushes on its own at `record` level (`resource_daemons_reaped`), naming each pid, kind, RSS reclaimed and how long it had been idle, and is logged at info to `daemon.log` with the sweep count behind the decision. Cleanup that worked is worth a receipt even though nothing about it needs a person. The same reap goes into that sweep's `orphan-build-daemons` observation as an attempt, so the ladder's rung-3 push (if it gets that far) can say what already happened.

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

## The incident ledger

Saturation incidents go to `$PASEO_HOME/resource-monitor/incidents.jsonl`, one JSON record per line: when an incident opens, every five minutes while it holds, on any sweep where the rung acted, and when it clears. A record carries the event, cores, the load reading, free, available and swap memory, the process sample's freshness and age, the cause, [the evidence](#evidence-and-cause), and `actions`: what the rung did that sweep.

A saturated machine usually ends in a forced reboot, and the evidence has to outlive it. Every record is its own open, append, `fdatasync` and close, never a buffered stream. An incident with no `clear` record is one the daemon or the machine did not survive. The file rotates to `incidents.1.jsonl` at 1 MiB, keeping one previous file. A write failure is logged once per run of failures and never fails the sweep.

`paseo doctor` reads it: `resource.saturation` reports the latest incident within 7 days (see [docs/doctor.md](doctor.md)).

## Why this is a separate monitor from token burn

Token burn reads provider-reported usage per turn; it has no visibility into what a tool call spawned. A `git push` running heavy pack compression, or a Gradle daemon still resident from a build ten minutes ago, never shows up in provider token accounting — it only shows up in the process table. The two monitors share a shape (`agent/token-burn-detector.ts` and `agent/sustained-breach-detector.ts` are structurally the same state machine) but sample entirely different data. They share an enforcement shape too: this doc's reaper, token burn's [spend governor](token-burn.md#the-spend-governor), the [device cap](device-leases.md) and the [artifact janitor](artifact-janitor.md) are all opt-in, all dry-runnable, and all act only on evidence gathered across sweeps.
