---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
title: "feat: native build gate burst slots"
created: 2026-10-22
---

# feat: Native build gate burst slots

## Summary

The native build gate ([docs/resource-monitor.md](../resource-monitor.md#the-native-build-gate))
refused 36 of 71 build attempts as "at-cap" with `maxConcurrent` 2, and each refused agent sleeps
120 s before retrying. The cap exists because of 2026-10-08 (two builds, 34 GB of Gradle writes,
a forced reboot), but the machine is idle enough most of the time to carry more builds. This plan
makes the cap a hardware-derived guaranteed floor and adds a burst ceiling above it that a build
only reaches when every headroom check passes at decision time.

## Requirements

- R1. `maxConcurrent` stays the guaranteed floor. Its code default becomes hardware-derived
  (3 on a 16-core / 64 GB machine, 1 on a small one) instead of 1.
- R2. A build that would be refused at the floor is allowed up to `burst.maxConcurrent` (derived,
  5 here) when memory, CPU and disk headroom all pass. Burst fails closed on a missing, stale or
  unreadable signal; the floor's fail-open behaviour is unchanged.
- R3. A refusal says whether it was the floor or a failed headroom check, and which one. Each
  decision logs the headroom numbers and a `burst` flag.
- R4. `agents.buildGate.burst` is Zod-validated, live-patchable (deep merge, so patching one key
  keeps the rest) and can be turned off with `burst.enabled`.
- R5. A granted burst build is never stopped; later decisions just stop getting burst.
- R6. `docs/resource-monitor.md` documents the rules and the config table.

## Design

**Signals.** The resource monitor already reads system memory (available bytes, swap, macOS
pressure level) and load each sweep, and owns the memory brake, disk brake and saturation state.
It reports one `BuildGateMachineReading` per sweep, on both the `ps`-worked and `ps`-failed paths,
after the brakes ran. The gate keeps the newest, and a short history of swap-used readings.
Free disk is read at decision time, as the floor already does.

**Rules (burst only; `n` is the slots taken: running, setting up and allowed-but-unseen).**

| Check    | Passes when                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------- |
| reading  | a reading younger than 150 s, with every signal this platform reports, and free disk was read             |
| memory   | no memory-brake hold, pressure normal (macOS), available >= `perBuildMemoryGB` x (allowed-but-unseen + 1) |
| swap     | swap used grew less than 512 MiB over the last 5 min, with at least 2 min of history                      |
| cpu      | no saturation incident, load1 / cores < `maxLoadPerCore` (busy share < `maxBusyFraction` on Windows)      |
| disk     | no disk-brake hold, free >= `lowFreeGB` + `perBuildDiskGB` x (n + 1)                                      |
| settling | the reading is at least 90 s newer than the previous burst grant, so its memory ramp shows                |

macOS reports every signal; Linux has no pressure level; Windows has neither pressure nor swap, so
those two checks do not apply there. A signal the platform reports but the sample lacks fails the
check (closed).

**Defaults from hardware** (`os.cpus().length`, `os.totalmem()`):

- floor = clamp(min(floor(cores / 5), floor((GiB - 16) / 16)), 1, 4)
- ceiling = clamp(min(floor(cores / 3), floor((GiB - 16) / 8)), floor, floor + 3)

## Implementation units

1. `native-build-headroom.ts` (new): `deriveBuildGateDefaults`, `evaluateBurstHeadroom`, swap
   history helper. Pure; unit-tested first.
2. `native-build-gate.ts`: resolve config with hardware defaults, `observeMachine`, the burst path
   in `decide`, new refusal text and log fields.
3. Config: `AgentBuildGateSchema` (persisted-config.ts), the protocol's mutable schema
   (messages.ts), deep merge in `daemon-config-store.ts`.
4. `agent-resource-monitor.ts` reports the reading; `bootstrap.ts` wires it to the gate.
5. `docs/resource-monitor.md`.

## Test strategy

Gate tests with a fake clock and fake readings: floor unchanged, each headroom check refuses with
its own text and log fields, a missing/stale reading refuses burst while the floor still fails
open, the ceiling holds, burst off, settling, dry run. Headroom module tests for the formulas.
Config store test for the deep merge. Monitor test that a reading reaches the gate on both sweep
paths.
