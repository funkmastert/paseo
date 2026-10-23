---
title: Release Devices From Idle Holders - Plan
type: fix
date: 2026-10-09
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Release Devices From Idle Holders - Plan

## Goal Capsule

- **Objective:** a device an agent has stopped using comes back on its own. Today a lease comes back only when the agent checks in, is archived or closed, the device stops or disconnects, or 12 hours pass. An agent that finishes and goes idle without `device_checkin` keeps the device all evening.
- **Authority:** this plan, then `docs/device-leases.md` ("A lease cannot leak", "Shutdown", "Config"), `docs/resource-monitor.md`, `CLAUDE.md`.
- **Execution profile:** one worker, U1–U3 in order.
- **Stop conditions:** stop and report if releasing an idle lease would let the daemon shut down a device it does not today, or if `booted` simulator teardown would lose sight of a simulator.
- **Tail ownership:** the worker commits locally; it never pushes or restarts the 6767 daemon.

---

## Product Contract

### Problem Frame

On 2026-10-09 Tyler's iPhone stayed held by a leader that installed a build at 23:23Z, finished, and went idle without checking it in. Tyler asked for a check that releases it. Archive and close already release through `agent-gone`, but only on the next reconcile (15 s for phones, up to a minute for simulators), and nothing releases a live agent that is simply done.

### Requirements

- R1. A simulator, emulator or physical-device lease is released, reason `idle`, once its holder has not used the device for `idleReleaseMinutes` (default 15; 0 turns it off).
- R2. "Used" is the definition the idle simulator sweep already uses: the holder is mid-turn, or the holder still has a live shell under its root (a background build, test run or install loop), or any process outside the device's own tree names the device id (a serial, UDID or `-s`/`--device` argument). A checkout, an install-gate or launch-gate decision for that lease also counts.
- R3. A simulator lease with `booted: true` is never idle-released: the simulator teardown valve (`simulatorTeardown.idleMinutes`) owns it, because an unleased simulator is never shut down.
- R4. Releasing never shuts anything down. A released simulator or emulator keeps its slot as an unattributed running device and becomes the next agent's on checkout.
- R5. Archiving or closing an agent reconciles both lease managers at once, so its devices free immediately rather than on the next pass.
- R6. Dry run logs `Would release an idle device lease` and releases nothing.

### Scope Boundaries

- No new UI. The Devices panel already shows holder and held-for time and has a manual Release.
- No change to `maxLeaseHours`, `never-started`, or the disconnect grace.
- Leases still live in memory only.

---

## Planning Contract

### Key Technical Decisions

- KTD-1. One idle clock per lease, `lastUsedAtMs`, set at bind and advanced whenever R2's use is seen. Each manager advances it during its own reconcile/sweep and on checkout and gate calls.
- KTD-2. Simulator and emulator leases are checked in the resource-monitor sweep, which already carries `rows` and `agentTrees` to `sweepIdleSimulators`. Reuse that function's use test (factor it out so both callers share it) rather than writing a second one.
- KTD-3. Physical leases get the same process-tree input. The resource-monitor sweep passes `rows`/`agentTrees` to the physical manager too, through a new sweep entry point. Its own 15 s `detectionChanged` reconcile keeps doing what it does. Between sweeps, the physical idle check uses the last sweep's verdict, never a fresh `ps`.
- KTD-4. The physical "names the device id" check matches the Android serial and the iOS UDID, plus the devicectl identifier, in process argv, outside the agent's own tree. That is `collectDeviceIdReferences` (`device-detection.ts`) extended to physical ids if it does not already cover them.
- KTD-5. Immediate release on archive and close: subscribe both managers to the agent manager's closed-agent event (the same event `emitClosedAgent` fires), and reconcile there. The existing `agent-gone` path then releases without waiting.
- KTD-6. Config: `agents.deviceLeases.idleReleaseMinutes`, optional, default 15, live-toggleable like its siblings. A config key, not a protocol change.

---

## Implementation Units

### U1. Idle clock and release for simulator and emulator leases

**Goal:** a non-booted simulator lease or an emulator lease whose holder is idle comes back.

**Requirements:** R1, R2, R3, R4, R6; KTD-1, KTD-2, KTD-6.

**Files:**

- `packages/server/src/server/agent/device-lease-registry.ts` (the `idle` reason, `lastUsedAtMs`)
- `packages/server/src/server/agent/device-lease-manager.ts` (shared use test, idle release in the sweep)
- `packages/server/src/server/persisted-config.ts` (`idleReleaseMinutes`)
- tests beside each

**Test scenarios:**

- An emulator lease whose holder has been idle with no shell for 15 minutes is released `idle`. The emulator keeps its slot, unattributed.
- A holder mid-turn, or with a live background shell (a Gradle build), keeps its lease past 15 minutes.
- Another process naming the device's serial keeps the lease.
- A `booted: true` simulator lease is never idle-released; the teardown still shuts it down at its own idle limit.
- A checkout or launch-gate decision resets the clock.
- `idleReleaseMinutes: 0` turns it off.
- Dry run logs and keeps the lease.

### U2. Idle release for physical-device leases

**Goal:** a phone a finished agent installed to comes back.

**Requirements:** R1, R2, R4, R6; KTD-1, KTD-3, KTD-4.

**Files:**

- `packages/server/src/server/agent/physical-device-registry.ts` (the `idle` reason in the reconciler, `lastUsedAtMs`)
- `packages/server/src/server/agent/physical-device-lease-manager.ts` (sweep entry point, the clock)
- `packages/server/src/server/agent/device-detection.ts` (physical id references, if needed)
- `packages/server/src/server/bootstrap.ts` (pass the sweep's rows and trees)
- tests beside each

**Test scenarios:**

- An install lease (`source: install`) whose holder has been idle with no shell for 15 minutes is released `idle`. This is the 2026-10-09 case. Use fake device ids such as `fake-udid-do-not-use`.
- A holder with a live background install loop keeps the lease.
- A process outside the holder's tree running `adb -s <serial>` keeps it.
- An install-gate decision resets the clock.
- A reserved device is unaffected (reservations are not leases).
- Dry run logs and keeps the lease.

### U3. Release on archive and close, and docs

**Goal:** archive and close free devices at once; the docs say so.

**Requirements:** R5; KTD-5.

**Files:**

- `packages/server/src/server/bootstrap.ts` (subscribe to closed agents)
- `docs/device-leases.md` ("A lease cannot leak" table gains `idle`; "Config" gains `idleReleaseMinutes`; integrate in place, do not append)
- a test for the subscription where bootstrap wiring is already tested, or a manager-level test that a closed-agent notification reconciles

**Test scenarios:**

- Archiving an agent that holds an emulator lease and a phone lease releases both within the same tick, reason `agent-gone`.

---

## Verification Contract

- Targeted vitest only: `nice -n 10 ~/bozeo-ops/cpu-policing/heavy.sh npx vitest run <file> --bail=1 --maxWorkers=2` from `packages/server`. Check `uptime` first. Never a full suite, never e2e, never a native build, never boot a real device.
- `npm run build:server` before diagnosing cross-package types; then `npm run typecheck`, `npm run lint -- <files>`, `npm run format:files -- <files>`.
- Never touch the live daemon on 6767 or write under `~/.paseo`.

## Definition of Done

- R1–R6 met, with tests passing and `docs/device-leases.md` updated in place.
- After deploy, a lease whose holder went idle shows `Physical device lease released ... reason: idle` or `Device slot released ... idle` in `daemon.log` about 15 minutes later.
