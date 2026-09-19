# Device leases

A cap on how many iOS simulators and Android emulators run at once across every agent. Only the daemon sees all the agents, so only the daemon can hold the count.

Off by default. Turn it on under `agents.deviceLeases`, and turn on `dryRun` first — same discipline as the [build-daemon reaper](resource-monitor.md#reaping-abandoned-build-daemons), which it shares a sweep with.

## Why a cap at all

Several agents working on the same mobile repo each boot a device, nobody coordinates, and the machine falls over. Measured on the M3 Max this was built for, with **two** booted simulators and a build running: 0.4 GB of memory free, 20.6 of 21.5 GB of swap in use, the compressor holding 22.8 GB. Every agent was doing reasonable work. Nothing was wrong except the total.

## Three layers, three jobs

None of them is sufficient alone, and the split is the design:

| Layer                                               | What it does                         | What it cannot do                    |
| --------------------------------------------------- | ------------------------------------ | ------------------------------------ |
| **Process scan** (`agent/device-detection.ts`)      | Counts what is actually running      | Stop anything                        |
| **Checkout** (`device_checkout` / `device_checkin`) | Records intent, queues for a slot    | Stop an agent that skips it          |
| **Launch gate** (PreToolUse hook)                   | Refuses a device launch with no slot | See a device booted outside an agent |

**The process scan is the count.** Never the lease table. A lease is bookkeeping, and bookkeeping that disagrees with reality loses — a simulator Tyler booted by hand fills a slot exactly like an agent's, and a lease whose device died stops filling one. Anything displayed as "how many are running" comes from here.

**Checkout is how an agent claims intent and waits.** The cap is usually right and the work is usually right; it is just early. `device_checkout` blocks until a slot frees rather than refusing, so an agent that asks first never has to handle a failure. It also records _why_ the device is wanted, which is what the status UI shows.

**The gate is what makes checkout worth calling.** A lease an agent can skip is a convention, not a control. The gate refuses the shell command itself.

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

Free memory here means free + speculative + purgeable pages, deliberately not the file cache: macOS keeps most of RAM mapped to files, and counting that would report tens of gigabytes "available" on a machine that is swapping 20 GiB. It is a floor rather than a comfort margin, because the same design keeps free pages low on a perfectly healthy machine — 2.8 GiB right after a restart. Swap pressure is the signal that usually fires first. No signal at all (a host where memory can't be read) is never a reason to refuse.

## Enforcement

The gate is a **PreToolUse hook**, not the permission layer. The SDK is explicit about why:

> canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call (except explicit deny rules) before the callback is consulted. To gate every tool call, use a PreToolUse hook instead.

Most of Tyler's agents run in `bypassPermissions`, so a deny from `handlePermissionRequest` would never fire for them. A hook does, in every permission mode, and it resolves before `canUseTool` runs.

`agent/device-launch-commands.ts` decides what counts as a device launch: `xcrun simctl boot`, `open -a Simulator`, `xcodebuild -destination 'platform=iOS Simulator…'`, `emulator -avd <name>` / `emulator @<name>`, and `expo run:*` / `react-native run-*`. Matching is on argv tokens of the command actually being run, with quotes honoured, so `grep -rn 'simctl boot' docs/` is not a device launch. Commands that _use_ a device without booting one — `adb install`, `./gradlew installDebug`, `xcrun simctl launch` — are deliberately absent: they need a device that already exists, so gating them would refuse work that costs no slot.

What happens on a match:

- **The target is already running** (`simctl boot <udid>` for a booted device) → allowed. It costs no slot.
- **The agent already checked out** and has not used the slot → allowed. This is the good path, and the agent never sees the gate.
- **A slot is free** → allowed, and the gate takes a lease on the agent's behalf. A device booted without asking still fills a slot and still shows a holder, so the count is never quietly wrong.
- **No slot, or no headroom** → denied.

A denial that only says "no" turns into a retry loop or a workaround, so it says who holds the slots and for how long, how many are running without a lease, and what to do instead — call `device_checkout` and wait. Enforcement is Claude-only today; every other provider gets the checkout tools and the status, but nothing refuses its shell commands.

The gate fails open on every uncertainty: an unreadable hook input, a cap that throws, a `ps` that times out. A device cap that breaks tool calls is worse than one that misses a device, and the process scan catches whatever booted a sweep later.

## A lease cannot leak

Reconciliation runs every sweep against the process scan:

| Release reason   | When                                                             |
| ---------------- | ---------------------------------------------------------------- |
| `released`       | The agent called `device_checkin`                                |
| `device-stopped` | Its device is gone from the scan                                 |
| `never-started`  | It never became a device within `pendingTtlMinutes` (10)         |
| `agent-gone`     | The daemon no longer knows the agent — archived, closed, crashed |
| `expired`        | `maxLeaseHours` (12), the backstop                               |

None of that can under-count, because occupancy is the **union** of running devices and leases-without-a-device. Reclaiming a crashed agent's lease does not hide its still-running emulator; the device simply becomes unattributed and keeps its slot. That invariant is what makes aggressive reclamation safe.

Leases live in memory. After a daemon restart the count comes from the process scan alone — the truth — and leases rebuild as agents ask.

## Waiting

`device_checkout` with `wait` (the default) parks the agent until a slot frees, up to `queueTimeoutMinutes` (20). Waiters are served oldest first. A freed slot is noticed two ways: immediately on a check-in, and by re-checking every few seconds while anybody is queued — a device stopping is not something anything notifies the daemon about. A canceled turn takes its agent out of the queue.

## Status

`device_status` (any provider) and the sidebar strip both read one snapshot: how many devices are running against the cap, which agent holds each and for how long, what is still booting, who is waiting, and what the cap refused recently. A device with no lease shows its own uptime from `ps`, so "running for 2h14m" is answerable for a device nobody checked out.

The UI is a status readout, not a control panel. It renders nothing when no device is running and nobody is waiting.

## Config

Under `agents.deviceLeases` (`persisted-config.ts`), live-toggleable like its siblings.

| Key                   | Default | What it does                                        |
| --------------------- | ------- | --------------------------------------------------- |
| `enabled`             | `false` | Nothing is counted, refused or queued while off     |
| `dryRun`              | `false` | Report what would have been refused; refuse nothing |
| `totalSlots`          | derived | Devices at once, all platforms                      |
| `slotsPerPlatform`    | derived | Per platform; clamped to `totalSlots`               |
| `requireHeadroom`     | `true`  | Also refuse when memory is gone                     |
| `minAvailableBytes`   | 0.5 GiB | Free-memory floor                                   |
| `maxSwapUsedRatio`    | 0.85    | Swap ceiling                                        |
| `pendingTtlMinutes`   | 10      | How long a lease may wait for its device to appear  |
| `maxLeaseHours`       | 12      | Backstop; 0 disables                                |
| `queueTimeoutMinutes` | 20      | How long `device_checkout` waits                    |

Dry run reports through `daemon.log` and the status surface, both tagged `dryRun`:

```
Device cap would have refused a device launch
  agentId=<id> command="xcrun simctl boot" dryRun=true
```

## Why this is not part of the resource monitor

[The resource monitor](resource-monitor.md) watches usage and reacts once it is already bad: memory, CPU, swap, abandoned build daemons. This decides whether something starts at all. They share one `ps` sample and the same safety discipline — off by default, dry-runnable, fails open — but a threshold that fires after the fact cannot prevent the launch that crossed it.
