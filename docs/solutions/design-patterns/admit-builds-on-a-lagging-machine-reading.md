---
title: Admit a build against a lagging machine reading by counting what it can't see yet
date: 2026-10-22
category: design-patterns
module: native-build-gate
problem_type: design_pattern
component: tooling
severity: medium
applies_when:
  - "a gate hands out extra slots based on the resource monitor's memory, swap, load and disk readings"
  - "the gate's own process scan sees a job start before the monitor's reading shows its resource use"
  - "a disk or memory check is tuned on a machine that is mostly idle"
tags: [build-gate, burst, reclaimable-memory, settling, disk-reserve, admission, macos]
---

# Admit a build against a lagging machine reading by counting what it can't see yet

## Context

PR #79 let the native build gate hand out burst slots above a hardware-derived floor. The slot rules, the check order and every threshold are in [docs/resource-monitor.md](../../resource-monitor.md#the-native-build-gate); this entry keeps the three decisions that look wrong until you know the failure behind them. The code is `packages/server/src/server/agent/native-build-headroom.ts`.

## Guidance

**Read reclaimable memory on macOS, not "available" and not "free".** The device cap's `availableBytes` is free + speculative + purgeable pages (`parseMacosVmStat`, `process-sampler.ts:245`). It leaves the file cache out on purpose, and on a Mac in steady use the file cache is most of the memory that isn't an app's. It read 3.6 GiB on a 64 GiB machine macOS reported as 76% free, and 4.9 GiB on one it called 70% free, which kept burst shut. `reclaimableBytes` adds file-backed pages (`parseMacosReclaimable`, `process-sampler.ts:266`), the memory the OS drops without swapping. Inactive pages stay out: they include anonymous memory that has to be compressed or swapped first. Because the figure is now generous, the macOS pressure level and swap growth carry the "machine is actually short" judgment. `availableMemoryOf` falls back to the stricter figure when `File-backed pages` is missing from `vm_stat`.

**Wait for a reading that has seen the last grant.** The gate's own `ps` counts a build the moment it starts, but the build takes a minute or two to reach its memory, and the monitor's reading can be up to 150 seconds old (`BURST_READING_MAX_AGE_MS`). Counting the build is not the same as seeing its memory: the reserve for allowed-but-unseen builds covers a grant made seconds ago, and not three floor builds that are still ramping up. So `checkSettling` compares the reading's own `takenAtMs` with the last grant plus `BURST_SETTLE_MS` (90 seconds), floor grants included. It does not compare wall-clock time. A burst ask right after a grant therefore waits for the next sweep or two, and burst climbs at most one build per 90 seconds. A grant the device cap then refuses gives its slot and its timestamp back (`native-build-gate.ts:746`).

**Scale the disk reserve with the builds taken.** `diskReserveBytes` is the low line plus `perBuildDiskBytes` × (taken + 1) (`native-build-headroom.ts:372`), where taken is every running build, runner setting up and allowance not yet seen. A build already running has not finished writing its 10 to 34 GB, so free space now overstates what is left. On 2026-10-08 an iOS build with UI tests and an Android Gradle build filled the disk together; either alone had not. The reserve applies to floor builds too (`refuseForDiskReserve`, `native-build-gate.ts:309`), not only to burst, and with `burst.enabled: false`.

## Why This Matters

Each of the three failed the same way: a check that is right about the machine as it was a minute ago admits a build on a machine that no longer looks like that. The memory reading ignored the file cache and refused everything; the unseen count and the reading's age let a fourth build stack on three that hadn't reached their memory; a per-build free-space test said yes to each build in turn until together they filled the disk.

## When to Apply

- Adding a signal or a threshold to the burst checks.
- Moving the gate to a new platform. Linux's `MemAvailable` is already a reclaimable figure and Windows's `os.freemem()` counts the standby cache, so only macOS needs the second figure.
- Changing the monitor's sweep interval. `BURST_READING_MAX_AGE_MS` is two and a half sweeps (`native-build-headroom.ts:14`), and the settling window should be rechecked against it.

## Related

- [docs/resource-monitor.md](../../resource-monitor.md#burst) for the thresholds and why they are those numbers.
- [docs/disk-pressure.md](../../disk-pressure.md) for the 2026-10-08 incident.
