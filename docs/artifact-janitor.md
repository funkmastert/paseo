# Artifact janitor

Stops a killed test run from leaving simulator clones on disk forever. Measured on the machine this was written for: **591 GB** in `~/Library/Developer/XCTestDevices`, with nothing booted and an empty `Devices` folder — pure residue.

Off by default. Turn it on under `agents.artifactJanitor`, and turn on `dryRun` first. It deletes files, so it holds a higher bar than the [build-daemon reaper](resource-monitor.md#reaping-abandoned-build-daemons) whose discipline it borrows: that one only ever sent a signal.

## How the clones get orphaned

`xcodebuild test` with parallel testing clones the destination simulator once per worker into a second CoreSimulator device set at `~/Library/Developer/XCTestDevices`, and deletes the clones when the run ends. Straight out of `~/Library/Logs/CoreSimulator/CoreSimulator.log`:

```
Failed to clone the device data path from …/CoreSimulator/Devices/1A9C8E3A-…/data
  to …/XCTestDevices/3B6C2CCA-…/data
Clone 3 of iPhone 16 Pro (B9B400B7-…, iOS 26.5, Creating)
```

The deletion is the run's job, and a run that is killed never does it. Agents get killed constantly here — turns cancelled, sessions dying, accounts capped mid-build — and every one of those leaves a clone.

CoreSimulator cleans up exactly one case itself: a clone that fails _during_ creation (`New device is stuck in creation state, deleting`). A clone that finished being made and was then abandoned is nobody's. The proof that nothing ever comes back for it is in the same log — the same 125 UDIDs are reported unloadable on every CoreSimulatorService start, for weeks:

```
Unable to load device.plist: …/XCTestDevices/FB071F48-…/device.plist
Failed to create device at path …/XCTestDevices/FB071F48-….
```

Those lines also mean `simctl` is not a way to find residue. A clone whose `device.plist` is unreadable is not a device as far as CoreSimulator is concerned, so it is not in `simctl --set … list devices` at all. The janitor works off the filesystem and `ps`.

## Three layers, three jobs

None is sufficient alone, and the split is the design — the same shape as the [device cap](device-leases.md):

| Layer                  | What it does                                     | What it cannot do                        |
| ---------------------- | ------------------------------------------------ | ---------------------------------------- |
| **Cleanup obligation** | Reclaims a dead run's clones within minutes      | See a run that started before the daemon |
| **Unowned sweep**      | Reclaims residue whose creator is long gone      | Act quickly — it waits 12 hours          |
| **Disk guard**         | Refuses a test launch onto a volume with no room | Reclaim anything                         |

### The cleanup obligation

When the launch gate sees a command that clones — an `xcodebuild` test action against a simulator destination (`test-run-commands.ts`) — the janitor records that the agent owes a cleanup. When that agent is gone, the obligation becomes a claim over the clones its run created, and they go without waiting out the unowned sweep's 12 hours.

**A lease is the wrong owner for this**, even though `agent-gone` is exactly the right signal. A [device lease](device-leases.md) is over a device and is released the moment the device stops — which is the event that is _supposed_ to take the clone with it, so by the time a lease ends there is nothing left for it to hold. An obligation has to outlive the device. The cap is also off by default while residue accumulates regardless. So the janitor keeps its own obligations and reads liveness from the same agent list the lease registry does.

A claim is proven by the directory's **birth time** being at or after the run started. That is only sound when the clones can be told apart, so **a dead agent's claim waits while any other agent still has an open obligation on the same set**: two runs at once interleave their clones in one directory and a birth time cannot separate them. On a quiet machine the claim proceeds; otherwise everything falls back to the unowned rules.

### The unowned sweep

Residue whose creator died weeks ago — the 591 GB case. It rides [the resource monitor's](resource-monitor.md) 60-second sweep and its `ps` sample rather than running a timer of its own, like the device cap does.

### The disk guard

The device gate already refuses a launch when memory headroom is gone; free disk is the same class of problem and fails harder, because a full volume takes down every agent rather than the one that asked. It refuses a device or test launch below `minFreeBytes`, default **20 GiB**.

That number is one parallel test run's worth of room: a four-way run clones four simulators, and the clones measured here were about 4 GB each, so ~16 GB can land on disk before a single test finishes — plus whatever DerivedData grows by. It is a floor, not a comfort margin. The machine was at 30.7 GiB free of 926 GiB the day this was written.

The guard is its own opt-in (`diskGuard.enabled`), separate from `enabled`, because refusing a launch removes nothing — and it has to work with the janitor's deletion turned off entirely.

## What it deletes, and what it does not

**Covered:** `~/Library/Developer/XCTestDevices/<UDID>` — a whole test-clone directory, and nothing else anywhere.

**Not covered, deliberately:**

- **`DerivedData`** is live build state. Deleting it costs a full rebuild of whatever it belonged to, it is keyed by project rather than by run, and a developer who comes back tomorrow still wants it. 43 GB here, and none of it provably abandoned.
- **`CoreSimulator/Devices`** holds the user's own simulators — created on purpose, with installed apps and state inside them. 50 GB here. An unused one is a decision to make in Xcode, not something to infer from an mtime.
- **`XCPGDevices`** (the playground device set) has the same shape and probably the same failure, but it has never held anything on this machine. An allowlist entry added without a verified example is how an allowlist stops being one.

Adding a set means verifying a real example first, the same rule the reaper's allowlist carries.

## How ownership is proven

A clone is removed only once every one of these holds. Each is a separate way for something to prove it still wants the directory, so any single one failing spares it for at least another sweep:

- **It is named by a canonical UDID**, directly inside the set root. `device.plist`, `.DS_Store`, a `UDID.backup`, a nested path — all outside what a removable name can be.
- **It resolves to exactly `<resolved root>/<name>`.** The root is `realpath`'d once, the entry is `realpath`'d, and the two are compared for equality. A symlink out of the tree, a `..`, a sibling root named `XCTestDevices-old`, and a root handed over unresolved all fail here. A symlink is never an entry in the first place: the scan is `lstat`-only and one level deep.
- **Nothing in the `ps` sample names its UDID.** Not "nothing is booted" — anything at all: the `xcodebuild` mid-run carries the UDIDs of the clones it made, `testmanagerd` carries the one it is driving, a `simctl` subprocess carries its argument. A false positive here costs one sweep of patience; a false negative costs somebody their simulator.
- **The device cap holds no lease on it.**
- **It has been unchanged across `minSweeps` sweeps.** A clone being written to right now has a moving mtime, and any change restarts the run from zero rather than pausing it.
- **Then either** its obligation's agent is gone, no other obligation on the set is live, and it is past `obligationGraceMinutes` — **or** nothing claims it and it has sat untouched for `minAgeHours`.

Whatever a rule cannot evaluate spares the directory: no birth time means no obligation claim, an unreadable size means it is left for a human, an mtime ahead of the clock means nothing about its age is trusted. A sweep is bounded by both `maxPerSweep` and `maxBytesPerSweep`, and every path is logged with its size and the reason behind it.

### What the dry run looks like

```
INFO  Artifact janitor would reclaim
      {
        "path": "/Users/t/Library/Developer/XCTestDevices/1C56B10C-38C1-4547-ABDA-D36412FF01CA",
        "setId": "xctest-devices",
        "sizeBytes": 4187593114,
        "ageMs": 223320000,
        "stableSweeps": 3,
        "claim": "unowned",
        "dryRun": true
      }
```

and one push, through the same path the reaper reports through:

```
Leftover test artifacts would be reclaimed
Would reclaim 3 leftover directories holding 11.7 GB (Xcode test simulator clones):
1C56B10C-… (3.9 GB, idle 62h 2m), 3B6C2CCA-… (4.1 GB, idle 40h 2m),
B9B400B7-… (3.7 GB, idle 14h 2m). Dry run — nothing was deleted.
```

Sizes come from `du`, which bills a clone for blocks it shares with the template device it was copy-on-write cloned from. Reported space is an upper bound on space actually freed — the honest direction to be wrong in for a budget whose job is to stop a sweep going too far.

## What it cannot reach

- **A booted test clone is invisible to the device cap's count.** `detectRunningDevices` matches the literal path segment `/Devices/`, and `/XCTestDevices/` does not contain it, so clones do not fill device slots. The janitor does not rely on that function — `collectDeviceIdReferences` reads the device set out of `launchd_sim`'s argv structure instead — and the count is left alone deliberately: a four-way parallel run would instantly exceed the cap and the gate would then refuse every later launch.
- **A run started before the daemon** has no obligation, so its residue waits for the unowned sweep.
- **Test runners other than `xcodebuild`** — `fastlane scan`, a wrapper script, an IDE-launched run — clone the same way but are not recognized, so they also fall to the unowned sweep. They are safe, just slow.
- **A clone that a live process still names forever** is never taken. That is the intended answer.
- **`DerivedData` and `CoreSimulator/Devices`**, per the scope above. About 93 GB on this machine that this feature will never touch.

## Config

Under `agents.artifactJanitor` (`persisted-config.ts`), live-toggleable like its siblings — turning the dry run on and reading what it would have taken must not mean restarting a daemon that is running everybody's agents.

| Key                      | Default | What it does                                                  |
| ------------------------ | ------- | ------------------------------------------------------------- |
| `enabled`                | `false` | Nothing is scanned, claimed or removed while off              |
| `dryRun`                 | `false` | Select and report every path, size and reason; delete nothing |
| `minAgeHours`            | 12      | How long unclaimed residue must sit untouched                 |
| `minSweeps`              | 3       | Sweeps that must have seen it unchanged                       |
| `obligationGraceMinutes` | 10      | How long a dead run's residue is left alone                   |
| `obligationTtlHours`     | 24      | After this, an obligation is forgotten                        |
| `maxPerSweep`            | 8       | Blast radius per sweep                                        |
| `maxBytesPerSweep`       | 100 GiB | Blast radius per sweep, in bytes                              |
| `diskGuard.enabled`      | `false` | Refuse a device or test launch with no disk left              |
| `diskGuard.dryRun`       | `false` | Report what would have been refused; refuse nothing           |
| `diskGuard.minFreeBytes` | 20 GiB  | The floor                                                     |

Turning the janitor off discards the evidence it had gathered, so turning it back on starts the wait over.
