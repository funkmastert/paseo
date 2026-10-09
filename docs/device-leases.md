# Device leases

A cap on how many iOS simulators and Android emulators run at once across every agent. Only the daemon sees all the agents, so only the daemon can hold the count.

Off by default. Turn it on under `agents.deviceLeases`, and turn on `dryRun` first — same discipline as the [build-daemon reaper](resource-monitor.md#reaping-abandoned-build-daemons), which it shares a sweep with.

## Why a cap at all

Several agents working on the same mobile repo each boot a device, nobody coordinates, and the machine falls over. Measured on the M3 Max this was built for, with **two** booted simulators and a build running: 0.4 GB of memory free, 20.6 of 21.5 GB of swap in use, the compressor holding 22.8 GB. Every agent was doing reasonable work. Nothing was wrong except the total.

## Three layers, three jobs

None of them is sufficient alone, and the split is the design:

| Layer                                               | What it does                         | What it cannot do           |
| --------------------------------------------------- | ------------------------------------ | --------------------------- |
| **Process scan** (`agent/device-detection.ts`)      | Counts what is actually running      | Stop anything               |
| **Checkout** (`device_checkout` / `device_checkin`) | Records intent, queues for a slot    | Stop an agent that skips it |
| **Launch gate** (per provider, see below)           | Refuses a device launch with no slot | Bind every provider equally |

**The process scan is the count.** Never the lease table. A lease is bookkeeping, and bookkeeping that disagrees with reality loses — a simulator Tyler booted by hand fills a slot exactly like an agent's, and a lease whose device died stops filling one. Anything displayed as "how many are running" comes from here.

**Checkout is how an agent claims intent and waits.** The cap is usually right and the work is usually right; it is just early. `device_checkout` blocks until a slot frees rather than refusing, so an agent that asks first never has to handle a failure. It also records _why_ the device is wanted, which is what the status UI shows.

Before it allocates anything, checkout looks for a device already running that nobody holds: the one the caller names, one matched by name in the reason text (only when the match is unambiguous), or otherwise the longest-idle one. That binding is immediate — `running` with a `deviceId` set, never `starting` — so a reused device can never expire as `never-started`, and the caller learns the device's real identity and how to target it (UDID, or the AVD name plus its adb serial) back in the checkout response. A slot is allocated only when nothing suitable is running, or the caller named a device that isn't. A device [reserved for Tyler](#reservations) is never offered, named or not.

**The gate is what makes checkout worth calling.** A lease an agent can skip is a convention, not a control. The gate refuses the shell command itself — as far as the provider lets it, which is not equally far for all of them.

## Counting

A booted simulator is exactly one `launchd_sim` process, and its argv carries the UDID:

```
launchd_sim …/CoreSimulator/Devices/<UDID>/data/var/run/launchd_bootstrap.plist
```

Every other process in the device — 235 to 277 of them on a booted iPhone — is a descendant. An Android emulator is `emulator -avd <name>` and the `qemu-system-<arch>` it re-execs into; both carry `-avd`, and the launcher's tree contains the qemu process, so they count once.

This reads the `ps` sample [the resource monitor](resource-monitor.md) already takes each sweep — one scan a minute, not two — rather than shelling out to `xcrun simctl list devices booted`. It gives the same answer (verified against both) and still answers when CoreSimulator is wedged, which on a thrashing machine is exactly when you need it.

There is deliberately **no per-device memory figure**. Summing RSS across a simulator's 277 processes reads 24 GB against a real footprint of 4 GB, because RSS counts every shared page in every process that maps it. The same trap makes per-UDID attribution by `ps` look like 0.02 GB — most CoreSimulator processes don't carry the UDID at all.

`ps` is not enough to say _whose_ a device is. `launchd_sim` is reparented to pid 1 the moment CoreSimulator boots it, so no agent's process tree contains it — the same gap [orphaned build daemons](resource-monitor.md#whats-attributed-and-how) fall into. An Android emulator usually stays inside its agent's tree and can be attributed. Everything else gets its owner from a lease, or is reported as unattributed rather than guessed at.

## Where the default comes from

Derived from the machine, not hardcoded (`agent/device-slot-defaults.ts`):

```
reserve      = max(24 GiB, 40% of hw.memsize)
memorySlots  = floor((hw.memsize - reserve) / 4 GiB)
coreSlots    = floor(performanceCores / 4)     # hw.perflevel0.logicalcpu, else hw.ncpu
totalSlots   = clamp(min(memorySlots, coreSlots), 1, 6)
perPlatform  = clamp(ceil(totalSlots / 2), 1, totalSlots)
```

On the 64 GiB / 12-performance-core M3 Max: reserve 25.6 GiB, memorySlots 9, coreSlots 3 — **3 total, 2 per platform**.

The constants are measurements, not guesses:

- **4 GiB per device** is one booted iPhone 17 Pro simulator with an app running, summed by `phys_footprint` across its 277 processes (what Activity Monitor calls Memory). Not the 24 GiB its RSS adds up to. An Android emulator was not measured — booting one was off limits — and is assumed to cost the same; a stock AVD's guest RAM alone is 2 GiB.
- **The reserve floor** is what that machine actually runs before any device: Android Studio and its Gradle/Kotlin daemons at ~21 GiB, Chrome at ~9 GiB, Xcode's build services at ~2.4 GiB, plus the daemon and its agents.
- **Four cores per device, performance cores only.** A booted device is nearly free at idle — measured at 2% of one core — but boot, install and first launch each burn 1–2 cores for a minute or two, and with several agents they all happen at once. An efficiency core will not carry a simulator boot, so counting all 16 on an M3 Max would buy a slot the machine cannot serve.

Cores bind here, not memory: memory alone would allow 9. That is why a naive RAM division suggests 5 or 6 and is wrong.

## Memory headroom

A free slot is not the same as room to use it. Independently of the count, a launch is refused when swap is at or above `maxSwapUsedRatio` (0.85) or free memory is below `minAvailableBytes` (0.5 GiB). On the day this was written the machine was at 96% swap and 0.4 GB free **with a slot nominally free**, and one more device then is catastrophic.

### The guaranteed floor

Swap sits around 90% most days on the machine this cap was built for. A headroom rule with no floor refuses every device launch on a day like that, stranding mobile work before it starts — the cap exists to keep the machine usable, not to keep it idle.

So the first running (or pending) device on each platform — one iOS, one Android — is exempt from the headroom check. `isPlatformFloorUnfilled` (`device-lease-registry.ts`) asks whether occupancy for that platform is still zero; if so, `tryGrant` skips `evaluateMemoryHeadroom` entirely and only the slot cap applies. The floor still costs a slot — it is not a bypass of the count, only of the swap/free-memory gate — and 1 iOS + 1 Android always fits inside `totalSlots`/`slotsPerPlatform` at their derived minimums.

"First" means what the process scan and the lease table together already know about, not what this one grant is about to add: a platform with a device already running, held or not, or a lease still waiting to become one, is past its floor. Checkout reusing an already-running device (below) means the floor mostly matters when nothing of that platform is running at all — the case a plain headroom rule handles worst.

The floor applies wherever `tryGrant` is the path: `device_checkout`, the launch gate, and the gate's dry-run reporting (a floor launch is never recorded as a would-have-refused). The Devices section's copy says so too: "1 Android and 1 iOS always allowed; more depend on memory."

Free memory here means free + speculative + purgeable pages, deliberately not the file cache: macOS keeps most of RAM mapped to files, and counting that would report tens of gigabytes "available" on a machine that is swapping 20 GiB. It is a floor rather than a comfort margin, because the same design keeps free pages low on a perfectly healthy machine — 2.8 GiB right after a restart. Swap pressure is the signal that usually fires first. No signal at all (a host where memory can't be read) is never a reason to refuse.

## Enforcement

Every provider runs on the same machine and takes slots from the same pool. Not every provider can be stopped. `agent/device-launch-enforcement.ts` holds the tier for each one, and it is a value the daemon carries rather than something you learn from source: the UI shows it, the `device_status` tool tells the agent asking, and `device_checkout`'s own description changes to match. A cap that binds some agents and not others, silently, is worse than no cap — the well-behaved ones queue while the unguarded one takes their slots.

| Tier         | Provider                                      | Where it is refused                                              | What it misses                                                        |
| ------------ | --------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| **refuses**  | Claude                                        | PreToolUse hook on `Bash`                                        | —                                                                     |
| **refuses**  | OpenCode                                      | Bridge plugin's `tool.execute.before` on the `bash` tool         | —                                                                     |
| **asks**     | Copilot, Cursor, Kimi, Kiro, Trae, custom ACP | The terminal the daemon spawns, and the permission request first | An agent that runs a shell inside its own process, asking for neither |
| **asks**     | Codex                                         | `item/commandExecution/requestApproval`                          | **Full Access** sets the approval policy to `never`: it asks nothing  |
| **asks**     | OMP                                           | The `bash` tool approval from its extension UI                   | An OMP configured not to approve bash                                 |
| **observes** | Pi                                            | Nowhere                                                          | Everything — Pi reports tool execution, it never asks first           |
| **observes** | Anything unlisted                             | Nowhere                                                          | The default, so a new provider cannot silently claim to be enforced   |

**refuses** means the command does not run, in every mode the provider has. Claude's hook is the reference case; the rule behind it — never `canUseTool`, which `bypassPermissions` skips — is in [gating a tool call](providers.md#gating-a-tool-call). OpenCode reaches the same bar from a different direction: the Paseo bridge plugin runs inside the OpenCode server, below every OpenCode mode and permission config, and a throw from `tool.execute.before` aborts the tool call.

**asks** means the daemon only gets a say when the agent routes the command through it. When that happens the refusal is real. The ACP providers route two ways, because this daemon is the ACP _client_: it spawns the terminals the agent asks for (refusing there is refusing a process that was about to exist, and the error text reaches the agent in band), and it answers the agent's permission requests. That second gate runs **before** auto-accept — auto-accept is on by default for unattended agents, and behind it the cap would have approved every launch it exists to stop.

Neither Codex's approval response nor ACP's carries a sentence back to the model: one is a bare decision, the other an option id. Since a refusal that only says "no" turns into a retry loop or a workaround, the reason is delivered separately over the same steer path the [resource monitor](resource-monitor.md) uses, after the rejection lands (`agent/device-launch-approval.ts`).

**observes** means nothing intercepts. The device is still counted — see below — and never refused.

`agent/device-launch-commands.ts` decides what counts as a device launch, for every tier: `xcrun simctl boot`, `open -a Simulator`, `xcodebuild -destination 'platform=iOS Simulator…'`, `emulator -avd <name>` / `emulator @<name>`, and `expo run:*` / `react-native run-*` (their `--device`, `--udid`, `--simulator` or `--deviceId` value is the target). Matching is on argv tokens of the command actually being run, with quotes honoured, so `grep -rn 'simctl boot' docs/` is not a device launch. Commands that _use_ a device without booting one — `adb install`, `./gradlew installDebug`, `xcrun simctl launch` — are deliberately absent: they need a device that already exists, so gating them would refuse work that costs no slot.

The same gate carries [the native build gate](resource-monitor.md#the-native-build-gate), which runs before the device cap.

The gate refuses only a launch that boots a **new** device when the cap or headroom has no room for it. A false refusal costs more than a missed device: the agent stalls or works around the gate, while a missed device is still counted by the next scan.

A target resolves against what is running by UDID, AVD name, simulator name (from `simctl list`) or adb serial. A target that names a connected physical device is left to [the install gate](#what-the-gate-checks): no simulator boots.

What happens on a match:

- **The target is already running** (`simctl boot <udid>` for a booted device, `expo run:ios --device 'iPhone 17 Pro'` for a booted simulator of that name) → allowed, and a lease binds to it when nobody holds it and it isn't reserved, so it shows a holder.
- **The agent already holds a slot on that platform** → allowed. This is the good path, and the agent never sees the gate. It covers both the lease it checked out and has not booted yet, and the device it already booted: a rebuild loop runs `expo run:ios` over and over.
- **The launch names no device and a device of the platform is up** → allowed. A runner with no target, and `open -a Simulator`, use the device that is running; they boot nothing. The agent's lease binds to the free device it will most likely land on, and the agent is told which one and how to target it. When every running device of the platform is another agent's or reserved, the launch is still allowed and takes no slot, and the agent is warned that it will probably install onto someone else's device and told to check out its own. The gate cannot stop that: Expo and the React Native CLI pick the booted device themselves.
- **A slot is free** → allowed, and the gate takes a lease on the agent's behalf. A device booted without asking still fills a slot and still shows a holder, so the count is never quietly wrong.
- **No slot, or no headroom** → denied, with who holds the slots and for how long, how many are running without a lease, a free running device when there is one, and what to do instead — call `device_checkout` and wait. The [guaranteed floor](#the-guaranteed-floor) means this can only be a headroom refusal when a platform already has its first device.

Picking a device and leasing it happen in one serialized decision with no await in between, so two launches landing together never both get the same device.

The gate fails open on every uncertainty: an unreadable hook input, a cap that throws, a `ps` that times out, a session the bridge cannot resolve to an agent. A device cap that breaks tool calls is worse than one that misses a device, and the process scan catches whatever booted a sweep later.

### What an unenforced device costs

Nothing about the tier changes the count. Occupancy is the union of running devices and outstanding leases, so a simulator a Pi agent booted fills a slot for everyone — the next Claude agent is refused by it, and the cap holds in aggregate even where it could not hold at the launch.

A running device with no lease that sits inside a live agent's process tree is **that agent's**: checkout and the gate never hand it to anyone else, and no other agent's pending lease binds to it. After the sweep has charged it (below), the sweep leases it to that agent, so it stays held once the shell that started it exits and process attribution is gone.

What the tier changes is who knows. Such a device is **charged** to its agent: the daemon tells it, once per device, over the steer path, that it is holding a slot other agents are queueing for, that nothing has been shut down, and what to call next time. Only a mid-turn agent is told — steering an idle one would start a turn nobody asked for — and dry run tells nobody, because dry run refuses nothing and so has nothing to explain.

That message only reaches Android. `launchd_sim` is reparented to pid 1 the moment CoreSimulator boots it, so an unleased iOS simulator has no owner `ps` can name. It is not guessed at: it stays unattributed, keeps its slot, and appears in the status UI as pressure nobody is accountable for.

**An unleased device is never shut down.** A booted device may have a build running against it. Refusing a new device and killing an existing one are different features with different risks; the daemon shuts a device down on its own only in [two narrow cases](#shutdown), and only for a simulator an agent holds by lease.

## A lease cannot leak

Reconciliation runs every sweep against the process scan:

| Release reason   | When                                                             |
| ---------------- | ---------------------------------------------------------------- |
| `released`       | The agent called `device_checkin`                                |
| `device-stopped` | Its device is gone from the scan                                 |
| `never-started`  | It never became a device within `pendingTtlMinutes` (25)         |
| `agent-gone`     | The daemon no longer knows the agent — archived, closed, crashed |
| `expired`        | `maxLeaseHours` (12), the backstop                               |

The `never-started` clock runs from the last launch the gate saw, not from checkout. A cold `expo run:ios` spends its first several minutes on pods and a native build before it boots anything, and a lease that expired mid-build would hand the slot to another agent moments before the device it was holding it for appeared — putting the machine over the cap, which is the state this exists to prevent. The gate restarts that clock, so the TTL only has to cover one build rather than a whole session. It deliberately does not touch `acquiredAtMs`: that is the clock a device binds against, and moving it forward would put the device the lease is waiting for in its own past.

None of that can under-count, because occupancy is the **union** of running devices and leases-without-a-device. Reclaiming a crashed agent's lease does not hide its still-running emulator; the device simply becomes unattributed and keeps its slot. That invariant is what makes aggressive reclamation safe.

Leases live in memory. After a daemon restart the count comes from the process scan alone — the truth — and leases rebuild as agents ask.

## Waiting

`device_checkout` with `wait` (the default) parks the agent until a slot frees, up to `queueTimeoutMinutes` (20). Waiters are served oldest first. A checkout that names a running device another agent holds waits for that device and gets it when it is checked in; without `wait` it returns `unavailable`, naming the holder. It never hands back a different device instead. A named device reserved for Tyler is `unavailable` straight away. A freed slot is noticed two ways: immediately on a check-in, and by re-scanning every few seconds while anybody is queued — a device stopping is not something anything notifies the daemon about, so the drain takes its own `ps` rather than reusing the sweep's. That is the one place the cap pays for a second scan, and only while somebody is waiting. A canceled turn takes its agent out of the queue.

## Status and management

`device_status` (any provider) and the Devices section of the app both read one snapshot: how many devices are running against the cap, which agent holds each and for how long, how long each has been running, what is still booting, who is waiting, and what both gates refused recently. A simulator row carries its `simctl` name; uptime comes from `ps`, so "running for 2h14m" is answerable for a device nobody checked out.

It still renders nothing when no device is running and nobody is waiting — but it is a control panel now, not only a readout. It leads with a mode header, "Enforcing" or "Dry run — counting only, nothing is refused" (or "Off" when `enabled` is false), with an "Enforce" switch (on = enforcing) that flips `dryRun` through the same `set_daemon_config_request` path the rest of the daemon's config uses (wire field `deviceLeases`, flat — not nested under `agents`, unlike the on-disk `agents.deviceLeases` path in `persisted-config.ts`) — no dedicated RPC needed for that. A config edit doesn't otherwise make the daemon push a fresh `device_status_update` on its own, so the RPC handler calls `DeviceLeaseManager.refreshSnapshot()` whenever the patch touches `deviceLeases`; without it the switch would look stuck until the next resource-monitor sweep (up to a minute). Each device row shows its holder — an agent's title, tappable to open it — or "Free — the next agent that asks gets this", or "Reserved for you"; how long it has been held, and how long it has been running. Per-device actions: release the lease, reserve or unreserve, and shut down. A failed action shows a toast. In dry run the refusal count reads "would have been refused".

### Reservations

A device Tyler booted by hand for himself needs to be protectable — checkout and the gate reusing "whatever is running" would otherwise hand his own simulator to the next agent that asks. "Reserve for me" in the Devices section persists that (`device-reservation-store.ts`, a small JSON file under `$PASEO_HOME`, atomic-written like the other small daemon stores) so it survives a restart, unlike leases. `device.reserve.set` toggles it; checkout and the gate both exclude a reserved device from reuse, named explicitly or not — but reserving one does not evict whoever already holds it, it only stops the _next_ handover. A runner that names no device can still land on a reserved simulator when it is the only one booted (see [Enforcement](#enforcement)); the agent is warned, not stopped.

### Shutdown

An explicit human action from the Devices section: `xcrun simctl shutdown <udid>` or `adb -s <serial> emu kill`. The serial is re-resolved from `adb devices` and `emu avd name` on every shutdown, never taken from a cache: an emulator that restarted gets a new console port, and a stale serial would kill whichever emulator took the old one. `device.shutdown` refuses a device a mid-turn agent holds (by lease or by process tree) unless the request sets `confirmMidTurnHolder`, which is the UI's second confirm tap; an idle holder or no holder at all shuts down on the first. Nothing here reaps — see [why a lease does not own disk cleanup](#why-a-lease-does-not-own-disk-cleanup).

Two cases are not human-only, and they are narrow: the daemon shuts down an **iOS simulator it saw an agent boot**, never one an agent reused, never a reserved one, and never an Android emulator (`device-lease-manager.ts`'s `shutdownAgentHeldSimulatorsForDaemonShutdown` / `sweepIdleSimulators`). The reason is the 2026-10-08 crash: CoreSimulatorService crashed while tearing down a still-booted simulator during OS shutdown, and macOS's shutdown stalled on it until a hard power-cycle. A simulator the daemon already shut down never reaches that path.

- **Graceful daemon shutdown.** `stop()` starts `simctl shutdown` on each of them before agents close, lets it run beside the agent closures and the durability flushes, then waits at most what is left of the 10 s budget for it (`daemon-vitals/shutdown-budget.ts`). A wedged `simctl` is logged and left for the OS. Deploy restarts take this path too.
- **The idle sweep.** The resource-monitor sweep shuts one down once nothing has used it for `simulatorTeardown.idleMinutes`. Use is: the holder is mid-turn, the holder still has a command running (a live shell under its root, which is where an `xcodebuild test` started as a background shell lives, and any native build), or any process outside the simulator's own tree names its UDID (another agent testing on it by id, a `simctl` subprocess). Lifecycle alone is not enough: an agent waiting on a background UI-test run is idle by lifecycle for the hour the run takes. Any use, or a device the sweep has not seen before, restarts the clock.

"Saw an agent boot" is `DeviceLease.booted`: the lease was pending and bound to a device that started after it, or the device sits in the agent's process tree. A lease bound straight onto a running simulator (a reuse at checkout, a launch that names it) has no such mark, because that simulator may be one Tyler booted by hand. A simulator Tyler boots while an agent's lease is still pending can bind to that lease like any device does (see [Counting](#counting)); reserve it to protect it.

The teardown reads leases, and only the cap binds them, so it does nothing while `enabled` is off; `simulatorTeardown.enabled` turns it off on its own. Under the cap's `dryRun` it logs `Would shut down an agent-held simulator` and releases nothing. Its mode is logged as the `simulator-teardown` line of `Monitor mode`, reported off whenever the cap is off. A shutdown that fails releases nothing: the lease stays, and the device is left for the next sweep, a human, or the OS.

## Config

Under `agents.deviceLeases` (`persisted-config.ts`), live-toggleable like its siblings.

| Key                             | Default | What it does                                                                                                |
| ------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `enabled`                       | `false` | Nothing is counted, refused or queued while off                                                             |
| `dryRun`                        | `false` | Report what would have been refused; refuse nothing                                                         |
| `totalSlots`                    | derived | Devices at once, all platforms                                                                              |
| `slotsPerPlatform`              | derived | Per platform; clamped to `totalSlots`                                                                       |
| `requireHeadroom`               | `true`  | Also refuse when memory is gone                                                                             |
| `minAvailableBytes`             | 0.5 GiB | Free-memory floor                                                                                           |
| `maxSwapUsedRatio`              | 0.85    | Swap ceiling                                                                                                |
| `pendingTtlMinutes`             | 25      | How long a lease may wait for its device to appear                                                          |
| `maxLeaseHours`                 | 12      | Backstop; 0 disables                                                                                        |
| `queueTimeoutMinutes`           | 20      | How long `device_checkout` waits                                                                            |
| `simulatorTeardown.enabled`     | `true`  | Shut down agent-booted simulators at daemon stop and when idle; needs `enabled` too ([Shutdown](#shutdown)) |
| `simulatorTeardown.idleMinutes` | 30      | How long an agent-booted simulator may go unused before the sweep shuts it down                             |

A dry-run `device_checkout` that the real cap would have made wait still hands back a lease, so the agent carries on, but that lease does not fill a slot — an agent waiting in a real run holds nothing. It shows in the status readout with its holder; only the count is the real cap's. Without that, a dry run inflates its own occupancy and reports refusals the real run would never have made, on the one readout a dry run exists to be trusted on.

Dry run reports through `daemon.log` and the status surface, both tagged `dryRun`:

```
Device cap would have refused a device launch
  agentId=<id> command="xcrun simctl boot" dryRun=true
```

## Why a lease does not own disk cleanup

An `xcodebuild test` run clones simulators onto disk and deletes them when it ends; a killed run leaves them. `agent-gone` is the right signal for that, but a lease is the wrong owner — it is released the moment the device stops, which is the event that was supposed to take the clone with it. [The artifact janitor](artifact-janitor.md) keeps its own cleanup obligations and reads the same agent list this registry does. All it needs from here is `listLeasedDeviceIds`, so it never deletes a device somebody is holding.

## Physical devices

A USB Pixel, an iPhone paired over the network with no cable — leased too, but not through the cap above. A phone costs the Mac no memory, so there is no slot cap or memory-headroom check for one; the point is narrower: stop one agent's `adb install` from overwriting another agent's install on the same phone.

### Why they bypass the cap

`PhysicalDeviceLeaseManager` (`physical-device-lease-manager.ts`) is a separate manager from `DeviceLeaseManager`, not another job inside it. It shares two things with the emulator cap rather than duplicating them: the `agents.deviceLeases` enabled/dryRun toggle — one switch for the whole feature — and the reservation store, since a reservation is just a device id, physical or not.

### Detection sources

Connections change constantly, so this is live detection, not a `ps` sample. It runs only while `deviceLeases.enabled` is true, and only once the daemon is listening (`physical-device-detection.ts`): with the feature off, no daemon holds an adb child or polls devicectl. The child's pid is written to `$PASEO_HOME/adb-track-devices.pid`, and the next start kills a child a crashed worker left behind (an orphaned `adb track-devices` lives until its next write, which is the next device event).

- **Android**: a daemon-owned `adb track-devices -l` child (`AdbTrackDevicesService`). adb's host protocol frames every response with a 4-hex-character length prefix; the CLI subcommand relays that framing unmodified, one frame per connect/disconnect, each frame the full current device list rather than a diff. The child restarts with backoff if it or the adb server dies, and the phone list empties until the new child reports, which starts the grace period below. An ENOENT (adb not installed) turns detection off instead of retrying forever. A phone on USB and wireless debugging at once is one device: the mDNS serial carries the USB serial.
- **iOS**: polling `xcrun devicectl list devices --json-output <file>` (`DevicectlPollingService`) — devicectl has no watch mode. Only `reality: "physical"` entries count; simulators are the process scan's job. macOS only, and an ENOENT (Xcode command line tools missing) stops polling for good.

devicectl lists every **paired** device, reachable or not. `connectionProperties.transportType` is `wired` (USB), `localNetwork` (Wi-Fi) or `sameMachine` (simulators); a paired iPhone that can't be reached has no transport and a `tunnelState` of `unavailable`. So a device is connected when it has a `wired` or `localNetwork` transport and its tunnel is not `unavailable`. `tunnelState` is otherwise about devicectl's own tunnel session: a reachable Wi-Fi iPhone reads `disconnected` while the table says "available (paired)". It reads `connected` while something is talking to it: a one-off `devicectl device info` opened the tunnel, and it closed again within about 20 s.

A Wi-Fi iPhone without an open tunnel is **idle**. devicectl lists it for as long as it shares the Mac's network, which is most of the day and has nothing to do with whether anyone is using it. An idle phone is still a target for checkout and the install gate, but the Devices section and `device_status` leave it out unless an agent holds it or it is reserved for Tyler, and a checkout that names no device picks a phone in use before an idle one.

### The grace period

A disconnected device keeps its lease for `graceMinutes` (30) — phones get unplugged and re-paired constantly, and dropping the holder on the first missed poll would hand a mid-session device to the next agent that asks. The clock starts at the sweep that first notices the disconnect, not retroactively at the real disconnect time (nothing was watching before that sweep ran), the same way the emulator cap's `pendingTtlMinutes` works. Reconnecting inside the window keeps the same holder; past it, the lease releases as `device-disconnected`.

### What the gate checks

`gateInstall` is the enforcement point — the physical-device analog of the emulator cap's `gateLaunch`, called from the same PreToolUse hook. It refuses one thing: installing over another agent's device (or Tyler's reserved one). `device-install-commands.ts` recognizes the commands that install, uninstall, wipe or launch on a device that already exists: `adb install`/`install-multiple`/`uninstall`, `adb shell am start|start-activity`, `adb shell pm clear|install|uninstall`, gradle `install*`/`uninstall*`/`connected*AndroidTest` (with or without a `:module:` prefix), `expo run:android|ios --device`, `react-native run-android --deviceId`/`run-ios --udid|--device`, `devicectl device install|uninstall|process launch --device`, `xcodebuild test|test-without-building -destination` naming a physical id or name, `ios-deploy --bundle|--uninstall_only`, `flutter run -d`.

Never matched: anything that only reads or only builds — `adb devices`, `logcat`, `shell pm list|path`, `shell getprop`, screenshots, `am broadcast`, `am instrument`, `xcodebuild build|archive` (any destination, `generic/platform=iOS` included), `ios-deploy --detect`. `adb shell am force-stop` changes app state without installing: it is refused only on a device another agent holds, and never takes a lease.

Resolving a command's target:

- a free, unreserved device → leased to the agent on the spot, command proceeds
- held by another agent → refused (or recorded, in dry run), naming the holder
- reserved for Tyler → refused, except for the agent already holding it: reserving does not evict a holder
- untargeted, with more than one connected device of the command's platform → refused with the exact targeting fix for each device (`ANDROID_SERIAL=<serial>`, `adb -s`, `--device`, `-destination 'id=…'`, `ios-deploy --id`); `gradlew installDebug` with no `ANDROID_SERIAL` would install on all of them
- untargeted plain `adb` with more than one adb target (phones plus emulators) → allowed: adb refuses to pick one on its own, and an `ANDROID_SERIAL` exported in the agent's shell, which the gate can't see, makes it a good command
- untargeted, with exactly one connected device → that one is the target
- names a device the gate doesn't currently see connected → nothing to protect; allowed through, and the command fails on its own

`ANDROID_SERIAL`, `adb -s`, `--device`, `--deviceId`, `--udid`, and `-destination 'id=…'|'name=…'` are all recognized as targets. A target matches a device by serial or UDID, model name (adb's `Pixel_9_Pro_XL` matches "Pixel 9 Pro XL"), the name its owner gave an iPhone, or devicectl's CoreDevice identifier, case-insensitively.

### Checkout

`device_checkout` takes `kind: "physical"` (default is `"simulator"`, the emulator cap) and an optional `device` naming one (serial, UDID, name or CoreDevice identifier). Waiting works as for the emulator cap: with `wait` (the default) the agent is parked until the device, or any free one, is checked in, its holder ends, or a disconnect's grace period runs out. A named device another agent holds is reported with its holder. `device_checkin` without `kind` checks in both kinds. The response names the serial/UDID and exactly how to target it (`adb -s <serial> …` / `ANDROID_SERIAL=<serial>`, or `--device <udid>` / `-destination 'id=<udid>'`).

"Reserved for you" applies the same way it does to a simulator or emulator — checkout and the install gate both exclude a reserved device, named explicitly or not.

## Why this is not part of the resource monitor

[The resource monitor](resource-monitor.md) watches usage and reacts once it is already bad: memory, CPU, swap, abandoned build daemons. This decides whether something starts at all. They share one `ps` sample and the same safety discipline — off by default, dry-runnable, fails open — but a threshold that fires after the fact cannot prevent the launch that crossed it.
