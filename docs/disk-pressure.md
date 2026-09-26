# Disk pressure

Free disk fell 31 GB in about an hour on Tyler's machine and nothing said why. This is the fix: three conditions on the [remediation ladder](remediation.md), rung-1 remedies that try to fix them before anyone is told, and a growth sample that says what grew.

`worktree-disk-monitor.ts` owns all three. It ticks every 10 minutes (`diskSweeper.sweepIntervalMs`, unrelated to the conditions below) and, every tick, reads free space once via `statfs` and reports to the injected `RemediationSink`.

## The three conditions

| Condition       | Active when                                                                      | Level    | Grace  |
| --------------- | -------------------------------------------------------------------------------- | -------- | ------ |
| `disk-critical` | Free space is below the disk sweeper's `minFreeGB` (default 5)                   | `urgent` | 0      |
| `disk-low`      | Free space is below `agents.remediation.disk.lowFreeGB` (default 20)             | `alert`  | config |
| `disk-falling`  | Free space fell by `fallGB` (default 20) within `fallWindowMinutes` (default 60) | `alert`  | config |

All three can be active at once — a 3 GB-free machine is both critical and low. Each is reported through `sink.observe()` every tick while active, and once more when it clears; a condition that has never been active is never reported (nothing to say, and no point repeating a stale "still fine").

The falling check needs a short history of free-space readings. Rather than run a second, faster timer, the monitor reuses the 10-minute tick: six readings land inside any one-hour `fallWindowMinutes`, which resolves a fall to within one tick, and a faster timer would only double the `statfs` calls for no earlier detection. The reading is the peak within the window minus the current reading, not oldest-minus-current, so a brief recovery partway through the window doesn't hide a fall that happened either side of it. History is capped by age (6 hours), not count, so it survives a live-toggled sweep interval without needing resizing logic.

The disk sweeper's own master switch (`diskSweeper.enabled`) being off does not silence these conditions — a person still needs to hear "disk is critical and the sweeper that would fix it is turned off." Only the sweeper's own registry-reading pass (reclaiming worktrees, sampling workspace sizes) is skipped when it's off; free-space detection and ladder reporting run regardless. The remediation ladder's own master switch, `agents.remediation.disk.enabled` (and the `remedies` rung-1 switch it ANDs with, `resolveDiskRemediationConfig` in `remediation/config.ts`), is a separate, harder off: with it off the monitor reports nothing to the ladder at all, and the pre-existing disk sweeper keeps running exactly as before.

## Rung 1: three deterministic remedies

Run once per tick, only when at least one condition is active, in this order:

1. **The disk sweeper's own pass** — its existing worktree reclaim and the emergency recheck it already runs when free space just crossed `minFreeGB`. Always available when `diskSweeper.enabled`; there is no dry-run mode for it.
2. **The done janitor's reclaim, on demand.** Bootstrap injects a function that reads `agents.doneJanitor.enabled` itself and, if on, calls `AgentDoneJanitor`'s public `tick()`. `tick()` already guards against overlapping its own timer (`sweepInFlight`), so calling it on demand from here needs no extra guard.
3. **The artifact janitor, on demand.** Bootstrap injects a function that reads `agents.artifactJanitor.enabled` itself and, if on, samples `ps` with the shared `processSampler` and calls `TestArtifactJanitor.sweep({ rows })`. Off by default in Tyler's config, so this remedy is normally reported `skipped` with the reason, and the process sample is never taken.

Each remedy's outcome becomes a `RemedyAttempt` (`remedy`, `outcome`, `detail`), accumulated on the observation for as long as the episode stays open. The observation's `remedy` field is `live` if any of the three is live, `dry-run` if none is live but one exists only in dry run, `disabled` if none of the three can act at all.

Both on-demand functions are wired lazily (`getDoneJanitorRunner`/`getArtifactJanitorRunner` in `bootstrap.ts`): the done janitor and the process sampler are built after the disk monitor, so the monitor is handed a getter it calls at tick time, once everything exists.

## Rung 2: the escalation task

When a remedy is live but the condition outlasts its grace window, the ladder starts one `standard` agent with a task built from this observation: free space now, how much it fell and over what window, the top growers, and the remedies already tried. The agent is told to find what is consuming space, reclaim only what is provably safe (build outputs and caches — DerivedData of projects with no running agent, Gradle caches, `/private/tmp` build junk older than a day), never delete a worktree with uncommitted or unpushed work, and report.

## Rung 3: the push

One push per episode, `alert` for `disk-low`/`disk-falling` and `urgent` for `disk-critical`, only if the remedies and the agent both fail. There is no longer a direct `disk_space_critical` push — the condition goes through the ladder like everything else, so a merely-transient dip that the sweeper or the janitors clear never reaches Tyler at all.

## Growth evidence

`disk-growth-sampler.ts`'s `DiskGrowthSampler` answers "what grew, and by how much": a bounded, deterministic `du` sample of the known growth roots and their immediate children, run sequentially with a per-root timeout, at most once per `sampleIntervalMinutes` while a condition is active, plus an hourly baseline so there is always something recent to compare against even on a quiet machine. It reads and remembers; it never deletes anything.

Default roots (skipped if they don't exist):

- `~/.paseo/worktrees`, `~/mobile-worktrees`, `~/paseo-worktrees`
- `~/Library/Developer/Xcode/DerivedData`, `~/Library/Developer/CoreSimulator`, `~/Library/Developer/XCTestDevices`
- `~/.gradle`
- `/private/tmp`
- `~/Library/Caches`
- `~/.npm`

Override with `agents.remediation.disk.growthRoots`. Each root's immediate children are sized too (`du -k -d 1`, plus loose files in the root directly, since BSD `du` refuses `-a` together with `-d`), so the evidence can name the worktree or cache that actually grew, not just the root it lives under.

Samples persist to `$PASEO_HOME/disk-growth.json` (last 6), so a daemon restart keeps the baseline instead of starting the "since the last sample" comparison over. The comparison uses the newest sample at least one `fallWindowMinutes` old — not simply the last sample — so the delta covers the whole fall rather than whatever gap happened to exist between two ticks.

## What is never deleted

The growth sampler deletes nothing; it only measures. The only things this workstream's rung-1 remedies delete are what an existing janitor already deems safe under its own rules — the disk sweeper's worktree-reclaim gate ([done-janitor.md](done-janitor.md#reclaiming-the-worktree)) and the artifact janitor's ownership proof ([artifact-janitor.md](artifact-janitor.md#how-ownership-is-proven)). Rung 2's escalation agent gets the same instruction in its prompt: reclaim only build outputs and caches, never a worktree with uncommitted or unpushed work.
