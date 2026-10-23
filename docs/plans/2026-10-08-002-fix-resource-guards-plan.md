---
title: Resource Guards After The 10-08 Crash - Plan
type: fix
date: 2026-10-08
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Resource Guards After The 10-08 Crash - Plan

## Goal Capsule

- **Objective:** the daemon stops a disk + memory crunch from native builds before it takes the Mac down, and a running simulator can no longer hang macOS shutdown.
- **Authority:** this plan, then `docs/resource-monitor.md`, `docs/disk-pressure.md`, `docs/device-leases.md`, `docs/daemon-vitals.md`, `CLAUDE.md`.
- **Execution profile:** two workers. Worker A owns U1 and U2 (resource monitor, admission, launch gate). Worker B owns U3 and U4 (simulator teardown, `heavy.sh`).
- **Stop conditions:** stop and report if a guard would refuse or kill something Tyler started by hand, or if the gate cannot count running builds without a new privileged probe.
- **Tail ownership:** workers commit locally, never push, never restart the 6767 daemon. The leader reviews, opens the PR, merges and deploys.

---

## Product Contract

### Problem Frame

Forensics (`~/bozeo-ops/briefs/crash-2026-10-08.md`, local): for about an hour one multi-agent session ran an iOS build with UI tests on a simulator and an Android Gradle build at once. Gradle alone wrote 34 GB, free disk fell to 3.4% (32 GB), and swap reached 87%. The resource monitor held admission for swap for five minutes and then saw nothing for 90 minutes, because it never reads free disk or how fast it is falling. At the forced shutdown, CoreSimulatorService crashed while tearing down the still-booted simulator, and macOS shutdown stalled on it. After the reboot, resumed agents drove load to 122–205 before the saturation hold engaged.

### Requirements

- R1. Low free disk, or free disk falling fast, holds new child-agent turns through the same admission path swap and CPU saturation use, and releases when it recovers.
- R2. A machine-wide gate limits concurrent native builds (Gradle, Xcode/swift, Expo/React Native native runs). It defaults to one at a time, is configurable, and refuses new native builds outright while disk is critical.
- R3. On graceful daemon shutdown, and when an agent-held simulator has sat idle, the daemon shuts down simulators that agents booted, so CoreSimulatorService is never left tearing them down during OS shutdown. It never shuts down a simulator reserved for Tyler or one no agent holds.
- R4. `heavy.sh` refuses long-running servers (dev servers, daemons, watchers), and a slot can no longer be held indefinitely.
- R5. Every guard logs what it did and why, records into the existing incident ledger where one exists, and can be turned off by config.

### Scope Boundaries

- No change to what disk-guard deletes or its watermarks.
- No per-process disk-I/O accounting (no new privileged probes); the disk signal is free space and its rate of fall.
- Tyler's own simulators, emulators and builds are never refused or shut down by these guards; the gate binds agents through their hooks.

---

## Planning Contract

### Key Technical Decisions

- KTD-1. The disk signal is free space plus its slope, both from data the daemon already samples (`docs/disk-pressure.md` growth evidence and its free-space conditions), not per-process I/O. "Falling fast" defaults to 15 GB or more lost within 15 minutes. "Low" uses the existing tight/critical conditions.
- KTD-2. Disk feeds the existing child-admission hold beside the memory brake and saturation (`docs/resource-monitor.md`), with the same release hysteresis and incident-ledger records. No second admission mechanism.
- KTD-3. The native build gate follows the device cap's three-layer pattern (`docs/device-leases.md`). A process scan is the count: running Gradle builds, `xcodebuild` and `swift-frontend` trees. The PreToolUse hook every provider already has is the enforcement point, and a recognizer module decides what counts as a native build. Default `agents.buildGate.maxConcurrent: 1`, off by config, with dry run available. A refused command gets a message that tells the agent to wait and retry, and who holds the slot.
- KTD-4. The simulator valve shuts down only simulators an agent holds (by lease or process tree), never reserved or unleased ones. It runs at graceful daemon shutdown and on the sweep for a holder idle 30 minutes or more. This reverses `docs/device-leases.md`'s "never something the daemon does on its own" for agent-held simulators only; rewrite that section in place.
- KTD-5. `heavy.sh` lives outside the repo (`~/bozeo-ops/cpu-policing/heavy.sh`, with its own tests if present). It refuses commands matching long-running server shapes (`expo start`, `supervisor-entrypoint`, `--watch`, `npm run dev*`, `vite`, `next dev` and similar), and releases a slot that has been held 45 minutes or more with a logged warning.

---

## Implementation Units

### U1. Disk feeds admission (Worker A)

**Goal:** low or fast-falling disk holds child turns before the crunch.

**Requirements:** R1, R5; KTD-1, KTD-2.

**Files:** the resource monitor and admission modules named in `docs/resource-monitor.md`, the disk-pressure sampler in `docs/disk-pressure.md`, `persisted-config.ts`, tests beside each; both docs updated in place.

**Approach:** a disk condition (low or falling fast) joins swap and saturation as an admission-hold reason, with hysteresis and an incident-ledger record naming free GB, the slope, and the top growth roots the sampler already knows.

**Test scenarios:**

- Free disk below the tight line holds admission; recovering above it with margin releases it.
- Free disk dropping 15 GB in 15 minutes holds, even above the tight line.
- A flat disk never holds.
- Config off holds nothing.
- The ledger records open, ongoing and clear with the disk evidence.

**Verification:** a scratch run, or a unit test over a fake sampler, shows the hold engaging at the 13:19 numbers (32 GB free, falling).

### U2. Native build gate (Worker A)

**Goal:** at most N agent native builds run at once.

**Requirements:** R2, R5; KTD-3.

**Files:** a new recognizer (beside `device-launch-commands.ts` and `device-install-commands.ts`), a build-gate module beside `device-lease-manager.ts` or inside the resource monitor, the PreToolUse hook wiring the device gate uses, `persisted-config.ts`, tests; a section in `docs/resource-monitor.md`.

**Approach:**

- Recognize native build commands: Gradle `assemble*`, `build`, `bundle*`, `install*`, `test*`, `connected*`; `xcodebuild build|test|archive`; `swift build`; `expo run:ios|android`; `react-native run-*`.
- Count running ones from the process scan.
- Refuse when the count is at the cap or disk is critical.
- Read-only commands (`gradlew tasks`, `xcodebuild -list`) never count.

**Test scenarios:**

- With one Gradle build running and a cap of 1, an agent's `./gradlew assembleDebug` is refused, and the message names the holder.
- `xcodebuild -list` passes.
- With disk critical, any native build is refused.
- At cap 2, a second build passes and a third is refused.
- Dry run records but allows.
- Config off allows all.

**Verification:** targeted tests, plus a recognizer table covering real commands from this fleet's agents.

### U3. Simulator teardown valve (Worker B)

**Goal:** no booted agent simulator outlives the daemon or a long idle.

**Requirements:** R3, R5; KTD-4.

**Files:** `packages/server/src/server/agent/device-lease-manager.ts` (or a small module beside it), `device-shutdown.ts`, daemon shutdown wiring, tests; `docs/device-leases.md` "Shutdown" rewritten in place.

**Approach:** at graceful shutdown, before agents close, `simctl shutdown` each agent-held simulator with a short per-device timeout. The sweep does the same for a holder idle 30 minutes or more. Reserved and unleased simulators are never touched. Failures are logged and never block shutdown.

**Test scenarios:**

- At shutdown, an agent-held booted simulator is shut down.
- A reserved one is not, and an unleased one is not.
- A holder idle 31 minutes gets its simulator shut down; one idle 10 minutes keeps it.
- A `simctl` timeout does not delay daemon shutdown past its budget.

**Verification:** targeted tests over the injectable shutdown runner.

### U4. heavy.sh refuses servers and expires slots (Worker B)

**Goal:** no long-running process can hold a heavy slot.

**Requirements:** R4; KTD-5.

**Files:** `~/bozeo-ops/cpu-policing/heavy.sh` and its tests if present (outside the repo, not committed to it).

**Approach:** refuse matching command shapes with exit 64 and a one-line reason; release a slot held 45 minutes or more with a warning in the slot's cmd file and stderr.

**Test scenarios:**

- `heavy.sh npx expo start --web` exits 64 without taking a slot.
- `heavy.sh npx vitest run x.test.ts` runs.
- A fake 46-minute holder is released.

**Verification:** run the script's tests, or a scripted check, with a temporary `HEAVY_LOCKDIR`.

---

## Verification Contract

- Targeted vitest only, through `~/bozeo-ops/cpu-policing/heavy.sh npx vitest run <file> --bail=1 --maxWorkers=2`, run with `nice -n 10`; never a full suite.
- Check `uptime` before any build or typecheck and wait while load1 is above 16.
- `npm run build:server` before diagnosing cross-package types; then typecheck, lint and format.
- Never touch the live daemon on 6767 or write under `~/.paseo`.

## Definition of Done

- R1–R5 met with tests; docs integrated in place; config documented.
- Deployed by the leader; the gate and disk hold visible in the daemon log on the live machine.
