# ops

Tyler's fleet-keeping-alive scripts. These are a copy of the live tooling at
`~/bozeo-ops`, vendored here for durability — that directory is not a git
repository, sits on exactly one disk, and was unbacked-up until this copy
existed.

**Machine-specific.** Every script here hardcodes Tyler's paths (`/Users/tylerthackray/...`)
and assumes the fork checkout at `/Users/tylerthackray/paseo-worktrees/bozeo`. They are
not portable to another machine or checkout without editing those paths. Several
are documented stopgaps: they exist because the daemon does not yet do the
equivalent job itself, and get deleted once it does (each says so in its own
header comment).

**This copy can drift from the live one.** The running LaunchAgents load
their scripts from `~/bozeo-ops`, not from this repo, so editing a file here
does not change what is running. The simplest way to stop the drift, without
doing it here, is to symlink the `~/bozeo-ops` copies at the files in this
directory, so one edit updates both.

## Scripts

| Script | Problem it solves |
| --- | --- |
| `cpu-guard.mjs` | Renices agent-CLI process trees every 20s so agents never starve interactive use. Stopgap until the daemon lowers agent priority itself. |
| `disk-guard.mjs` | Deletes orphaned WonderlyMobileCore build caches and retires finished orchestrator worktrees when free space runs low — two disk sinks the daemon's disk rung can't see yet. |
| `failover-watch.mjs` | Moves agents off a Claude account whose usage window has hit 100% onto one that still has room. Stand-in for the daemon's account failover until flexible-placement ships. |
| `retire-merged-worktrees.mjs` | Removes the orchestrator's own worktrees once their work is on a remote, clean, and idle — reusing the done janitor's own safety check. Dry run unless `--apply`. |
| `retire-worktrees.mjs` | Archives every non-running agent whose cwd is under given worktree dirs; exits 2 if any agent there is still running, so a worktree with live work is never removed. |
| `reclaim-worktrees.mjs` | Same safety check as the done janitor, run by hand against Paseo worktrees. Dry run unless `--apply`. |
| `mobile-worktrees-report.mjs` | Read-only report of which `~/mobile-worktrees` checkouts could go without losing anything (pushed/merged, clean, idle 48h+). `--apply` runs `git worktree remove` on the safe ones; branches are kept. |
| `rehome.mjs` | Moves agents stranded on an exhausted Claude account to one that can run them, then resumes them. Waits for a mid-turn agent to finish its turn before moving it. |
| `move-when-idle.mjs` | Moves one agent to another provider once its current turn ends, since the daemon refuses to move an agent mid-turn. |
| `work-audit.mjs` | Finds every worktree/branch where work could be lost (uncommitted changes, commits on no remote, stashes) and snapshots it to `refs/backup/<date>/<slug>`. |
| `replay-classifier.mts` | Replays the agent role/model classifier over real `~/.paseo` agent records to compare old vs. fixed policy output. Read-only, throwaway by design — kept for re-runs during classifier changes. |
| `pr-backup.ts` | A point-in-time safety copy of `packages/server/src/server/agent/provider-registry.ts`, taken before a risky refactor. Historical reference, not meant to be run. |
| `cpu-policing/heavy.sh` | Wraps one heavy command (`npm ci`, a build, a typecheck, a vitest run) so at most two run machine-wide at once; waits for a free slot, reclaims a slot whose holder died. |
| `cpu-policing/common-rules.md` | Shared context for every CPU-policing workstream: why the machine saturates, what the guard already does, which docs to read first. |
| `public-web/server.mjs` | Serves the fork's static web UI at `https://bozeo.ngrok.app` and keeps the ngrok tunnel up, so Tyler can reach it from his phone. Static files only — nothing here reaches the daemon directly; the app pairs through the E2E relay. |
| `public-web/publish.sh` | Publishes a new web UI build to what `server.mjs` serves, via a two-rename swap so a visitor never sees a half-copied tree. |
| `public-web/e2e-pair.mjs` | End-to-end check of `bozeo.ngrok.app`: loads the app at phone size, pairs through the relay with a fresh offer, confirms it reaches the daemon. Throwaway browser context. |
| `public-web/sidebar-dump.mjs` | One-off Playwright script that opens a paired session and dumps the sidebar for visual verification. |

## LaunchAgents

Four services in `launch-agents/` (copies of `~/Library/LaunchAgents/sh.bozeo.*.plist`
— the real, running plists; do not touch those from this repo):

| Service | Runs | Logs |
| --- | --- | --- |
| `sh.bozeo.cpu-guard` | `cpu-guard.mjs` | `~/Library/Logs/Bozeo/cpu-guard.log` |
| `sh.bozeo.disk-guard` | `disk-guard.mjs` | `~/Library/Logs/Bozeo/disk-guard.log` |
| `sh.bozeo.failover-watch` | `failover-watch.mjs` | `~/Library/Logs/Bozeo/failover-watch.log` |
| `sh.bozeo.public-web` | `public-web/server.mjs` | `~/Library/Logs/Bozeo/public-web.log` |

Install one (loads from `~/bozeo-ops`, not this repo — copy the plist there first if it doesn't already exist):

```sh
cp ops/launch-agents/sh.bozeo.cpu-guard.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/sh.bozeo.cpu-guard.plist
```

Uninstall:

```sh
launchctl bootout gui/$(id -u)/sh.bozeo.cpu-guard
rm ~/Library/LaunchAgents/sh.bozeo.cpu-guard.plist
```

`retire-merged-worktrees.mjs`, `reclaim-worktrees.mjs`, `mobile-worktrees-report.mjs`,
`work-audit.mjs`, `move-when-idle.mjs`, `replay-classifier.mts`, and the `public-web/`
scripts other than `server.mjs` are run by hand, not as LaunchAgents.
