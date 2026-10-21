# Done janitor

Nothing else in the daemon removes finished work. Archiving an agent does not archive its workspace, and archiving the workspace is the only thing that deletes its worktree, so every finished task leaves a sidebar row and a worktree behind: about 3 GB each once `node_modules` and build output are in it. `AgentDoneJanitor` (`packages/server/src/server/agent-done-janitor.ts`) does three things. It archives agents that are **dead** (closed or errored, untouched for days, not pinned) without asking anyone, and it finds idle **live** agents that are definitely finished, asks each one, and archives it on a strict yes. Either way it then deletes the worktree if nothing in it exists anywhere else. It archives [idle workspaces](#idle-workspaces) of every kind, the ones no agent pass reaches. Last, it removes [empty projects](#empty-projects).

The rule for dead agents is Tyler's: a dead session archives itself unless it is pinned.

Archive semantics — cascade to subagents, detach of cross-workspace and open-tab children, workspace archive as a separate lifecycle — are in [agent-lifecycle.md](agent-lifecycle.md#archive). The janitor uses the same paths a person's archive does and adds no semantics of its own.

## Turning it on

Off by default. Config lives under `agents.doneJanitor` and is live-toggleable like its siblings. Turn on `dryRun` first.

| Key                          | Default | Meaning                                                                                                                                 |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                    | `false` | Absent or false: the sweep returns before reading anything                                                                              |
| `dryRun`                     | `false` | Report what it would ask, archive and delete; do none of it                                                                             |
| `quietHours`                 | `72`    | How long an agent and its whole tree must be quiet before it is asked                                                                   |
| `maxQuestionsPerSweep`       | `1`     | Questions per 30-minute sweep                                                                                                           |
| `maxArchivesPerSweep`        | `3`     | Agents archived, plus orphaned worktrees deleted, per sweep                                                                             |
| `answerTimeoutMinutes`       | `10`    | How long to wait for the answer before cancelling the turn                                                                              |
| `reclaimWorkspaces`          | `true`  | False keeps every worktree; finished agents are still archived                                                                          |
| `archiveDead`                | `true`  | Archive dead, unpinned agents (below). False leaves them to the question                                                                |
| `deadQuietHours`             | `72`    | How long a dead agent and its whole tree must be untouched                                                                              |
| `maxDeadArchivesPerSweep`    | `10`    | Dead trees archived per sweep. Worktree deletions still spend `maxArchivesPerSweep`                                                     |
| `askFinished`                | `true`  | False never asks a live agent anything; only the dead pass runs                                                                         |
| `workspaceSweep`             | on      | The [idle-workspace sweep](#idle-workspaces) and its project rule, with their keys                                                      |
| `regenerableIgnoredPaths`    | `[]`    | Extra ignored paths the [deletion invariant](#the-deletion-invariant) treats as regenerable                                             |
| `backupIgnoredPaths`         | `[]`    | Ignored paths a work snapshot should also stage; see [Unbacked ignored files](#unbacked-ignored-files)                                  |
| `maxBackupIgnoredFileBytes`  | 5 MiB   | Caps a single file `backupIgnoredPaths` would otherwise stage                                                                           |
| `maxBackupIgnoredTotalBytes` | 50 MiB  | Caps every eligible file combined, across every matched entry                                                                           |
| `releaseSafeNestedRepos`     | `false` | Excuses a nested repository, and a container holding only safe ones, once its own HEAD is on a trusted remote and its own tree is clean |
| `trustedRemoteHosts`         | `[]`    | Extra hosts trusted as a nested repository's remote, beside the forge registry's own cloud hosts                                        |

`agents.*` sections are strict: a daemon built before a key existed rejects the whole config file, and every agent MCP request fails with it. [Approving the first live run](#approving-the-first-live-run) says when `workspaceSweep` may be written.

Enabling the janitor with `dryRun` on and reading the log is the whole rollout. `archiveDead` and `askFinished` are independent: `{ enabled: true, askFinished: false }` archives dead sessions and never resumes or prompts anything.

The quiet period is three days because an idle agent is not a finished one. Agents are left idle overnight and over a weekend and picked up again; Friday evening to Monday morning is about 64 hours.

## What "dead" means

The dead pass runs first each sweep and considers root agents only. A root is dead when its whole unarchived tree passes every check (`agentNotDeadReason` in `agent/done-janitor-detector.ts`):

- **No runtime holds it, or its runtime is in `error`.** "No runtime" is what the UI calls `closed`: the daemon has no live session for it, whatever its record last said. A stored `running` with no runtime and no open run marker is dead. One with an open marker was cut off by a daemon stop, and [restart recovery](restart-recovery.md) owns it until it is resumed or dismissed; the janitor neither archives nor asks it. An errored runtime that is mid-turn, waiting on a permission or running provider subagents is not.
- **Untouched for `deadQuietHours`**, measured from the newest activity timestamp the daemon holds. An unreadable timestamp is not quiet.
- **Not pinned** (below).
- **No schedule or heartbeat that is not completed targets it.**

Nothing else spares it. In particular an unread attention flag does not: a failed agent is flagged the moment it fails, so sparing flags would spare every errored agent until someone opened each one. The dry run says how many unread flags an archive will clear.

**An idle live agent is never dead.** A leader waiting on its children or on Tyler looks the same as a forgotten one from outside, and archiving it costs far more than leaving it. Only the agent can say which, and that is the question below. With `archiveDead` on, the question is asked only of live agents: a closed agent is archived or spared by the dead pass and never resumed to be asked.

**A restart does not reset the clock.** The wait runs from the agent's own newest activity, and closing an agent keeps the timestamps it had. A daemon restart closes every agent, so `closed` alone proves nothing about a session Tyler still means to come back to, yet the first sweep after boot, about 30 minutes in, archives every unpinned agent that was already quiet for `deadQuietHours` before the restart. An earlier `NOT_DONE` does not spare it either: the answer is activity, and the clock runs from it. The default of 72 hours outlasts a weekend (about 64 hours); a shorter `deadQuietHours` does not. Unarchiving an agent stamps its record, so an agent Tyler restores to read is archived again `deadQuietHours` later unless he pins it.

**The tree decides.** Archive cascades, so one live, pinned or recently touched descendant spares the whole tree, and a dead leader is never archived out from under a working child. The other direction is not handled: dead children of a live leader stay until the leader goes ([Not automated](#not-automated)).

Each archive is decided against freshly read state, so an agent someone opened between the sweep's read and its archive is left alone.

## Pinned

Two things pin, and both spare the agent from the dead pass and the question, and its worktree from reclamation — but a pinned workspace only does so when the pin is **manual** (below).

- **A pinned workspace** (`workspace.pin.set`, the sidebar pin). Every agent in it is pinned, and so is its worktree, as long as the pin is manual. This is the pin a person has a gesture for.
- **A `paseo.keep` label** on the agent, any value, `"false"` included. It pins the agent, its tree and its workspace regardless of pin source. Set it with `update_agent` (`labels: { "paseo.keep": "true" }`). No screen sets it.

A pinned tab is not a pin: that is per-client layout state the daemon cannot see. There is no agent-level pin gesture in the app; pinning a session means pinning its workspace, or labelling it.

### Manual pin vs. auto-pin

A workspace's `pinnedAt` has a `pinSource`: `"manual"` for a person's own pin gesture (or any record
written before `pinSource` existed — absent reads as manual, so nothing already pinned loses its
protection), and `"auto"` for the daemon pinning a workspace the moment Tyler starts a session in
it — a new workspace from the New Workspace flow, or a new agent tab in an existing one
(`workspace-auto-pin.ts`).

A **manual** pin lasts until someone unpins it and protects fully, as described above: the dead
pass, the question, and worktree reclamation all skip it indefinitely.

An **auto** pin lasts only while the workspace is active, and protects nothing from the janitor.
Active means an agent in the workspace (by `workspaceId`) is running, initializing, mid-turn or
waiting on a permission, or Tyler used the workspace in the last 24 hours
(`AUTO_PIN_RECENT_USE_MS`). A use is a session start, or a client heartbeat with an agent in the
workspace focused while the app is visible, dated by that client's last input.
`isWorkspaceActiveForAutoPin` is that definition; the per-agent half, `describeAgentWork`, is also
the janitor's [last look](#the-last-look). Once the workspace is finished, the daemon's
`AutoPinExpiry` sweep (at most a minute late) clears `pinnedAt` and `pinSource`. Every client then
groups the workspace as unpinned — its project, its status group, Done — and hides it with a
collapsed project, because `pinnedAt` is the only pin state any client or the janitor reads.
Expiry leaves `updatedAt` alone: it is not activity, and the janitor's quiet clock reads it.

The daemon expires the pin rather than each client computing it, so the phone, desktop, web, the
CLI and the janitor cannot disagree, and a client build older than this rule still shows it.
Uses are held in memory and mirrored, atomically and debounced, to `$PASEO_HOME/auto-pin-uses.json`.
A restart reloads that file before the first sweep, so a relaunch expires exactly what would have
expired without it — never every auto pin at once from one shared fresh window. Before this file
existed, a restart gave every auto pin the same fresh window from daemon start regardless of how
long each had actually sat unused, so a relaunch could clear a batch of pins together that had
each been idle for very different lengths of time.

Expiry never re-pins. A workspace whose agent resumes — a leader's prompt, a nudge, the janitor's
question — stays unpinned until Tyler starts a new session there. `isProtectivePin`
(`workspace-auto-pin.ts`) is the single place the janitor tells the two sources apart; the dead
pass, the question pass, and worktree reclamation all read it instead of `pinnedAt` directly, so an
auto pin that has not expired yet does not keep a finished workspace either.

Pinning by hand always wins: it sets `pinSource` to `"manual"` regardless of what was there before,
so pinning an auto-pinned workspace upgrades it to a real pin. Unpinning clears both fields.
Auto-pinning only ever moves a workspace from unpinned to auto-pinned — it never touches a
workspace that is already pinned, by either source.

Auto-pin is human-attributable-create only: it fires for a `workspace.create.request` or a
`create_agent_request` with no `callerAgentId` and no inherited `paseo.parent-agent-id` label (both
request types are only reachable over a client connection — app or CLI), never for the
agent-scoped `create_workspace`/`create_agent` MCP tools, Hub executions, schedules, heartbeats,
remediation, or restart recovery, which all create through the separate `"mcp"`-kind path. The CLI
sends `callerAgentId` from `PASEO_AGENT_ID` when it is set, on both `workspace create` and
`agent run`, so an agent running the CLI never pins the workspace it makes. The label check is the
fallback for the one gap that leaves: a `create_agent_request` whose `labels` already carry
`paseo.parent-agent-id` (set by whoever created the agent, independent of `callerAgentId`) is
agent-made even when `callerAgentId` itself is absent or cleared.

Config, both reloadable without a restart: `agents.autoPinSessions` (boolean, default on) turns
auto-pinning off; pins already set still expire. `agents.autoPinRecentUseMinutes` (default 1440,
24 hours) sets the recent-use window; the sweep runs every quarter of it, at most once a minute. A
daemon older than the key rejects the whole config file with `Unrecognized key`, which breaks new
connections, reloads and the next boot: `autoPinSessions` needs a build from c14e9ea32 on, and
`autoPinRecentUseMinutes` one with this change. Remove both before rolling back to Bozeo.prev.app.

## What "finished" means

The question path considers live root agents only when `archiveDead` is on (all roots when it is off). Archive cascades, so a root's whole unarchived tree has to pass every check, and any one failing spares the tree (`agent/done-janitor-detector.ts`):

- **Not running, initializing or in error.** A failed agent is a problem nobody has looked at yet.
- **No turn in flight, no pending permission, no queued run.**
- **No unread attention flag, `finished` included.** Archiving clears the flag, which would erase the only sign that there is a result nobody has read.
- **No live token-burn, spend-governor or resource alert.**
- **No provider subagent still running.** A Claude Task subagent or workflow runs inside the parent's process and the parent can look idle while it does.
- **No schedule or heartbeat that is not completed targets it.** Something is going to wake it.
- **Not retired by account failover.** Its successor carries the work on.
- **Quiet for `quietHours`**, measured from the newest activity timestamp the daemon holds. An agent with no readable timestamp is not quiet.
- **Not pinned** ([Pinned](#pinned)).

An agent's own `paseo.completion: "done"` label ([completion-state.md](completion-state.md)) is a strong hint the work is finished, but this list does not read it yet.

These prove the work is saved and idle. They do not prove it is finished, which is why the agent is asked.

## Asking

The question is sent inside a `<paseo-system>` envelope, so it stays out of the timeline like every system-injected prompt:

```
Automated check from the Paseo daemon, not from a person. You have been idle for 4d.
Is your task completely finished, with nothing left to do in this conversation? If you answer
DONE, you will be archived and your worktree may be deleted once its work is verified
committed and merged or pushed.
Reply with exactly one word and use no tools: DONE if finished, NOT_DONE otherwise.
If you are unsure, or are waiting on anything or anyone, reply NOT_DONE.
```

Only the whole reply, trimmed, equal to `DONE` (one trailing period allowed) counts, and only if the turn made no tool call. `Done`, `DONE, but…`, a question back, markdown, silence, a permission request and a failed turn are all "not done". The answer is read from the question's own turn: the last assistant message would credit an agent that said nothing with whatever it said last time. A permission request or a timeout cancels that turn. After a `DONE`, the tree is re-checked against fresh state before the archive, so an agent someone prompted in the meantime is left alone.

The question is a turn of its own, started only on an idle agent (`AgentManager.startQuietTurnIfIdle`, the check-and-start [leader compaction](leader-compaction.md) uses). The candidates were read at the start of the sweep, minutes earlier, so an agent someone started meanwhile is never steered into: it is reported `cannot-ask`, nothing is remembered, and a later sweep that finds it idle and still quiet asks. The turn is quiet from the moment it starts, never before: its finish raises no `finished` flag, sends no push and does not refresh the title. An error on it still flags, and so does a permission request.

The janitor cancels its own turn and no other. A message someone steers into the question's turn, or a turn that replaces it, makes it theirs: it is no longer quiet, the janitor never cancels it, and the agent is reported `cannot-ask`.

Asking costs a turn, and resuming a closed agent re-reads its whole context at cache-cold prices. So the janitor asks only agents that passed every check, one per sweep by default, most reclaimable disk first, and each at most once per quiet period: the answer is itself activity. Each consecutive "not done" doubles the wait before the next question, up to 8×. The backoff lives in memory; a restart resets it, never the quiet period.

An agent that cannot be asked is left and reported as `cannot-ask`: no provider session to resume, a provider that reports itself unavailable, a usage window at 100%, a usage source in error (how a logged-out account shows), or any agent on the account with a limit- or auth-shaped error (the latter also flagged `signedOut` for the stalled-agent sweep's benefit — see [account-failover.md](account-failover.md#when-an-account-is-dead)). Asking one would fail its turn and flag it, noise the janitor would have made itself.

## Reclaiming the worktree

Only after the agent is archived, through archive-by-scope, and only when all of these hold. Otherwise the workspace is kept and the reason reported:

- It is a `worktree` workspace marked Paseo-owned, and its directory is inside the Paseo worktrees root. A `local_checkout` or `directory` workspace is never a candidate.
- It is not pinned.
- It does not overlap its primary checkout, and no other active workspace sits at or inside it. A workspace in a directory above it does not count: a self-heal fixer's workspace in the home directory once kept every worktree.
- No unarchived agent belongs to it or runs anywhere under it. No terminal is open in it and no script runs in it.
- It passes the git gate (`done-janitor-worktree.ts`), which refuses on any git failure:
  - the directory is the root of a **linked** worktree — its git dir differs from the common dir, so a primary checkout is refused wherever it lives;
  - it is not locked with `git worktree lock`, and no merge, rebase, cherry-pick, revert or bisect is half done;
  - `git status --untracked-files=all` is empty. Ignored files are the [deletion invariant](#the-deletion-invariant)'s to judge;
  - no tracked file on disk is marked `--assume-unchanged` or `--skip-worktree`. `git status` never looks at such a file, so an edit to it reads as clean. A sparse checkout's files are marked too, but are not on disk, and do not count;
  - every commit reachable from HEAD is reachable from a remote-tracking ref or the local base branch recorded at creation. Both survive the deletion. Another local branch does not count: it may be the next worktree the janitor deletes. A squash-merged branch whose remote branch was deleted fails this check and is kept.
- The [deletion invariant](#the-deletion-invariant) holds.

Dead agents follow the same rules with one difference: nobody said the work was finished, so the git gate is the only proof, and it is enough. The gate keeps the worktree of a session that was cut off with uncommitted files, and the [work-at-risk sweep](work-snapshots.md#the-work-at-risk-sweep) decides whether that work needs anyone. Worktrees are planned after every dead tree in a sweep is archived, once each, so one shared by several dead agents is judged on what is true then. A sweep deletes at most `maxArchivesPerSweep` worktrees; the rest are picked up next sweep as orphans.

A workspace whose agents were all archived earlier — by a person, or by a sweep whose reclaim failed — is reclaimed on the same terms once it has been quiet for `quietHours`, without asking anyone. A workspace that never had an agent is never touched: it may be one someone created a minute ago.

Every worktree is [snapshotted](work-snapshots.md) twice on the way out: each worktree of a dead tree before the tree is archived, and each worktree as the last check before it is deleted. The second matters because the gate counts a commit on the local base branch as safe while the snapshot counts only remotes. A snapshot that fails keeps that worktree for the sweep, reported as `its work is at risk and could not be snapshotted: …`. A dry run takes no snapshot.

### The last look

A plan is minutes old by the time it is carried out: the snapshot and `du` take minutes, and a question earlier in the sweep can wait ten. So each deletion is decided again on state read at that moment, three times. The janitor looks right before it calls archive-by-scope, and hands archive-by-scope the same check as `recheck` (`workspace-archive-service.ts`), which runs it after resolving what it will archive and before touching anything, and again right before it deletes the directory.

- **Before the records**, it refuses, touching nothing, on: an unarchived agent in the workspace or under its directory; a live agent there that is running, initializing, mid-turn or waiting on a permission, read from the runtimes so that an archived agent running again counts; another active workspace there; an open terminal; a running script; a pin; or activity newer than the plan saw, from the workspace record or any agent's newest timestamp. The line reads `planned for deletion, but since then …`.
- **Before the directory**, the workspace and its agents have just been archived by this archive, so it refuses only on what arrived since: a process inside (the `lsof` scan), a schedule, or an agent or workspace there. The records stay archived and the directory stays, reported as `archived the workspace, but kept its directory: …`.

What remains is the time from each look's last read to the step it guards. Before the records, that is archive-by-scope stopping setup scripts and telling clients the workspace is archiving, a few milliseconds; an agent started then is archived with the workspace. Before the directory, it is the git calls inside `deletePaseoWorktree` ahead of `git worktree remove --force`; the `lsof` scan, the slowest read, runs first so the agent reads come last. The worktree's teardown commands run between the two looks, so an agent started during them keeps its directory but has had the teardown run in it. Nothing in the daemon stops an agent starting in a workspace that is being archived, so neither window closes entirely.

### The deletion invariant

Deleting a directory is the one thing the janitor cannot undo, so every deletion it makes, by any pass, meets one rule: **every file in the worktree is tracked and pushed, or in a verified backup, or under a regenerable directory, or byte-identical to the same path in the worktree's main checkout.** Anything else present keeps the worktree, and the reason is logged. When in doubt, it keeps: a git command that fails, output cut off at the runner's cap, or a process list that cannot be read all keep it.

The directory checked is the directory deleted, as the same string. Every pass asks archive-by-scope which directory its archive deletes (`resolveArchiveDirectory`, `workspace-archive-service.ts`), checks that one, and hands it back as `expectedDirectory`. An archive that would delete another directory, or none, throws before it touches anything, and the workspace is kept. Both sides are canonical (`canonicalizePath`, `utils/path.ts`): the realpath, or for a path that does not exist, the realpath of its deepest existing ancestor with the rest appended. On macOS `/var/…` and `/private/var/…` are one directory and two strings, so compare only canonical paths.

Git's listing has to be the whole of what the deletion loses, so these keep the worktree too, snapshot or not:

- **A directory the delete cannot get through**: one it cannot read, or cannot write or search. Git skips a directory it cannot open without failing, and a delete that meets one stops part-way, leaving half a worktree. `readWorktreeCoverage` walks the whole tree for these, ignored directories included, without following symlinks.
- **A change git is told not to look for**: a tracked file on disk marked `--assume-unchanged` or `--skip-worktree`. Git, the scratch index and the snapshot all read an edit to it as unchanged.
- **A file stored with Git LFS** (`filter=lfs` from any attributes file, tracked or not). Git and the backup hold only its pointer; the contents are in the LFS store, and nothing the janitor can read proves the LFS server has them: `git lfs push --dry-run` and `git lfs status` compare refs, not the server's objects.

Regenerable means a directory on the path is one a build, an install or a test run recreates — `node_modules`, `dist`, `build`, `out-tsc`, `tsc-out`, `.next`, `.astro`, `.turbo`, `.cache`, `coverage`, `test-results`, `target`, `.gradle`, `.cxx`, `.kotlin`, `DerivedData`, `Pods`, `.build`, `.swiftpm`, `__pycache__`, `.venv`, `bin`, `obj` and the rest named in `REGENERABLE_DIRS` (`agent/workspace-sweep-detector.ts`), plus `.yarn/cache` — **and it sits at the worktree root or beside a build manifest**: `package.json`, `Cargo.toml`, `build.gradle(.kts)`, `settings.gradle(.kts)`, `Package.swift`, `pyproject.toml`, `setup.py`, `go.mod`, `pom.xml`, a `*.csproj`/`*.fsproj`/`*.vbproj`/`*.sln`, or an `*.xcodeproj` (`isBuildManifest`). A build tool writes its output next to its manifest; a `src/build/` or `src/.cache/` beside source is somebody's files. `.DS_Store`, `*.pyc` and `*.tsbuildinfo` count anywhere.

A handful of per-machine config files are regenerable by name wherever they sit, with no root/manifest restriction, because a setup script, an IDE or a fetch writes them and the name is specific enough to never collide with a project's own files: `local.properties` (Android's local SDK path), `.xcode.env.local` (React Native's local Xcode env override), `google-services.json` and `GoogleService-Info.plist` (Firebase config), and `xcshareddata/` directly inside an `.xcworkspace` or `.xcodeproj` (Xcode's per-user scheme state) — `REGENERABLE_MACHINE_CONFIG_FILES` and the `xcshareddata` check in `isRegenerablePath` (`agent/workspace-sweep-detector.ts`). A repo can name more of its own with `agents.doneJanitor.regenerableIgnoredPaths` (see [Turning it on](#turning-it-on)): a generated file like a feature-flag snapshot, matched by path suffix or a simple glob. A pattern that could match a secret — `.env*`, `*.pem`, `*.p12`, or anything else `isSecretShapedPath` (`jev/secret-paths.ts`) would refuse to read — is rejected with a warning at config load and dropped, never applied; a unique `.env` always keeps the worktree. Add a name to either list only for something always regenerated with no content of its own to lose.

A name on none of these lists can still go, by a second and separate test: `readWorktreeCoverage` compares each ignored path against the same relative path in the worktree's **main checkout** — `DoneJanitorWorkspace.mainRepoRoot`, the repo root `git worktree add` branched the worktree off — and marks it `copiedFromMainCheckout` when the two are byte-identical. A file counts once its size matches and, for anything up to 1 MB (`COPY_COMPARISON_SIZE_CAP_BYTES`, `done-janitor-worktree.ts`), its full content does too; past that cap it is never compared, the same as a size mismatch. A directory counts only once every entry on both sides matches, recursively. This is how a worktree-setup script's copy of some other per-machine file, not on either by-name list, stops keeping a worktree once it is confirmed to be exactly that copy, with the original still in the main checkout. Missing from the main checkout, larger than the cap, or different in any byte keeps the worktree exactly as before this check existed: playtest evidence logs, `.data/`, `results/`, `src-tauri/binaries/` and a `.env` edited only in this worktree are never regenerable by name, and this check only excuses them when a byte-for-byte match proves they hold nothing of their own.

A repository nested anywhere keeps the worktree: a submodule, an untracked repository, or one inside an ignored regenerable directory, where git lists only the directory and the walk finds its `.git`. A backup holds a nested repository only as a pointer to a commit, if at all.

**One exception, off by default.** `agents.doneJanitor.releaseSafeNestedRepos` (boolean, default `false`) lets `checkNestedRepositorySafety` (`done-janitor-worktree.ts`) excuse a nested repository once every one of these holds, confirmed by its own git, not the outer worktree's:

- git's own discovery resolves the candidate directory as the repository's own toplevel — an invalid `.git` entry (an empty directory, a dangling gitdir file) would otherwise let discovery climb to an ancestor repository and read _its_ cleanliness as the candidate's;
- no local git config could run code as a side effect of the checks below: `git config --worktree --list --includes` is read first (local merged with any per-worktree `config.worktree` the candidate's own `extensions.worktreeConfig` points a filter or hooks path at — git itself degrades `--worktree` to plain `--local` when that extension is off, and this falls back to an explicit `--local` read too in case some git version ever makes `--worktree` a hard error instead) — reading never executes anything — and a `filter.*`, `core.hooksPath`, `core.sshCommand`, `diff.*.textconv` or `diff.external` setting anywhere in it makes the candidate unsafe, before `status` ever runs under that config. `core.fsmonitor` is the one key excused by value: git itself, and Xcode's own SwiftPM package resolution, both write `core.fsmonitor=false` routinely to turn the built-in watcher off, so a value git reads as off (`false`/`no`/`off`/`0`, or explicitly empty) passes. `true`, `yes`, `on`, `1` or a bare key starts git's built-in fsmonitor daemon, and anything else is a hook command, so both keep it. The listing is read with `-z`: without it a value's embedded newline prints as a line break, and `false\n<command>` would read as `false` while git runs the whole value. `runGitCommand` (`utils/run-git-command.ts`) also passes `-c core.fsmonitor=false` to every git call, but this check does not rely on that;
- it is not locked, has no half-done merge, rebase, cherry-pick or bisect, and no tracked file hidden with `--assume-unchanged` or `--skip-worktree` — the outer worktree's own guards (`readTreeProblem`), reused here;
- `git status` (tracked and untracked) is empty;
- every ignored path left is one `isRegenerablePath` already excuses by name — the outer worktree's own ignored-path rule, applied here instead of bypassed;
- HEAD is reachable from a **trusted** remote-tracking ref. Trust is an allowlist, not a loopback-or-own-host denylist: a remote's URL — `git remote get-url --all <name>` and `git remote get-url --push --all <name>`, which both apply `url.<base>.insteadOf`/`pushInsteadOf`, never the raw `remote.<name>.url`/`pushurl` text — is trusted only when its host exactly matches one of the forge registry's own cloud hosts (`github.com`, `gitlab.com`, `gitea.com`, `codeberg.org`, ...) or `agents.doneJanitor.trustedRemoteHosts` (strings, default `[]`, for a self-hosted forge the registry does not probe for this check). A URL git itself would read as a local path is never trusted, whatever its host looks like: with no scheme, no `:` or a `/` before the first `:` means a directory (git's `url_is_local_not_ssh`), so `/wt/node_modules/x@github.com:acme/up.git` is a bare repo on disk, not github.com. A `<helper>::` URL, or one with a backslash, whitespace or control character (where a URL parser and git's transport can disagree on the host), is untrusted too. Every other host is untrusted the same way, with no separate code enumerating loopback spellings to miss one: `localhost`, every form of `127.0.0.0/8`, `[::1]`, this machine's own hostname, a LAN address, and a forge nobody named all fail the same allowlist lookup. `remote.<name>.fetch`, when set explicitly, must map into `refs/remotes/<name>/`; left unset, git's own default already does. A remote is untrusted on its own when its own fetch refspec maps elsewhere; every remote is untrusted when some _other_ remote's fetch refspec writes into `refs/remotes/<name>/` instead — a foreign refspec would make a commit that arrived via that other remote's fetch look like this one's.
- the candidate is not the main checkout of some _other_ linked worktree: `<common dir>/worktrees/` must hold no entry but the candidate's own git dir. It is read directly, not through `git worktree list`, which names a submodule's own git dir as its main worktree (so every submodule read as having an external one) and skips an entry whose `gitdir` file was deleted. A fully pushed, clean standalone clone can still be the shared repository behind a linked worktree living somewhere else entirely, and deleting it would take that worktree's shared ref store and admin directory with it, dangling the other worktree's `.git` link and losing its index, HEAD and per-worktree state.
- when the candidate is a **genuine linked worktree whose repository survives the deletion**, none of the rest below is checked: its other branches, tags and stash live in the surviving repository, not in the directory being deleted. "Genuine" is all of: its `--git-dir` and `--git-common-dir` differ; the git-dir sits under `<common>/worktrees/`; and the common dir resolves outside both the worktree being deleted _and_ that outer worktree's own administrative directory (`<main>/.git/worktrees/<name>`, what `git worktree remove --force` plus `git worktree prune` actually delete). Everything else gets the full check below: a standalone clone; a submodule, whose own git-dir and common-dir are the _same_ directory (`<main>/.git/worktrees/<name>/modules/<submodule>`) even though that directory sits outside the worktree too, exactly like a genuine linked worktree's does; or a repository relocated with `--separate-git-dir`. For any of those, every other local branch and every other ref (`refs/backup`, `refs/notes`, `refs/original`, a custom namespace, an untrusted remote-tracking ref: `git rev-list --count --all --not <trusted refs>`, not `--branches --tags`) must also be reachable from a trusted remote, and no stash entry may exist.

A git failure, a dirty tree, an unreachable ref, a stash entry, an external linked worktree, or no trusted remote at all (short of the SwiftPM pin below) reads as unsafe — doubt keeps it, same as everywhere in this module. Reflog-only commits are an accepted loss, the same as the outer gate (`checkWorktreeDeletionSafety`): neither reads the reflog. `computeSafeNestedRepositories` runs this check for every candidate `listNestedRepositories` (`agent/workspace-sweep-detector.ts`) found, stopping at the first unsafe one — the invariant's own nested-repo check fails the whole worktree once any one candidate is not confirmed safe, so checking the rest cannot change the outcome, though it can under-report which other candidates the audit line names as safe. The check runs only once every cheaper check in `checkDeletionInvariant` has already passed (its own `category: "nested-repo"`, or an ignored-container block) — a worktree kept for an unrelated reason never pays for a single git call here — and nothing runs at all while the flag is off: `readWorktreeCoverage` skips the ignored-container filesystem walk entirely when `releaseSafeNestedRepos` is false, so its result is `[]` rather than merely unused.

**A SwiftPM checkout is a second way to be safe, used only when the remote-trust bullet above finds nothing to trust.** A SwiftPM dependency checkout (`<pkg>/.build/[index-build/]checkouts/<name>`) is a standalone clone whose `origin` is always a local path into the sibling `.build/[index-build/]repositories/` mirror, never a host the bullet above could trust, so without this every SwiftPM checkout keeps its worktree forever. `isSafeSwiftPmCheckout` (`done-janitor-worktree.ts`) excuses one once its fetch URL resolves into that sibling mirror, a `Package.swift` sits beside the `.build`, and a `Package.resolved` read from the _outer_ worktree's HEAD (not the working tree) pins its name, case-insensitively since SwiftPM lowercases identities, at exactly its HEAD with a `location` on the trusted-host allowlist: `swift package resolve` reclones from there and checks out that revision. The pin proves only HEAD, so the rest of the ref store gets the standalone-clone guards with the mirror's remote-tracking refs standing in for a trusted remote's: no commit reachable from HEAD, a local branch or any other ref that no mirror ref reaches (SwiftPM checks the pin out detached and leaves a branch someone committed on behind), no linked worktree elsewhere, no stash. Tags are left out of that sweep, since a mirror routinely carries tags on commits no branch reaches; a local tag on a local commit, or a commit pushed from the checkout into the mirror, is an accepted loss.

An ignored directory git collapses to one entry because it never looks inside it — `.claude/worktrees/`, holding one or more nested worktrees — is excused the same way, but only once a real filesystem walk (`lstat`, no symlinks followed) confirms it holds **nothing but** nested repositories: a loose file, a symlink, or an empty `.git` directory anywhere under it disqualifies the whole container, so a stray `notes.md` or a `.claude/skills/...` file beside a safe clone keeps the worktree exactly as it did before this excusal existed. In practice this mostly means standalone clones: a `.claude/worktrees/` entry is a linked worktree sharing the main repository, so its own branches, tags and stash are never the blocker, but any of that repository's own unpushed work still blocks the _outer_ worktree's own idle rules the normal way, through the main checkout itself, not through this excusal.

Ignored files come from `git status --ignored=matching --untracked-files=all`. Do not switch to `ls-files --ignored --directory`: it never looks inside an untracked directory, so a `.env` beside a new, untracked source file is in neither list, and the snapshot leaves it out as ignored.

### Unbacked ignored files

An ignored path that is neither regenerable by name nor byte-identical to the main checkout keeps the worktree forever by default — nobody backs it up, so nothing ever lets the janitor go. `agents.doneJanitor.backupIgnoredPaths` (patterns, same path-suffix-or-simple-glob syntax as `regenerableIgnoredPaths`, but a pattern here may name a directory) names ignored paths a work snapshot should capture instead of skip, so a worker log, a build cache a tool doesn't regenerate byte-for-byte, or a `.claude/skills/...` snapshot gets a real backup and the janitor can then reclaim the worktree. `agents.doneJanitor.maxBackupIgnoredFileBytes` (default 5 MiB) caps a single file; `agents.doneJanitor.maxBackupIgnoredTotalBytes` (default 50 MiB) caps every eligible file combined, across every matched entry, so a log or test-result directory with thousands of small files cannot stage an unbounded amount: entries are accepted in order while the running total stays within it, and one that would push the total over is skipped, later and smaller ones still tried. A directory is eligible only once every file under it, recursively, is within the per-file cap and does not look like a secret — checked file by file (`isSecretShapedPath` and the snapshotter's own `looksLikeSecret`), not only on the directory's own name, and also filtered through the outer worktree's own regenerable-by-name rule, so a pattern broad enough to also match `node_modules/` does not force-add its contents (`selectBackupEligibleIgnored`, `agent/backup-eligible-ignored.ts`). A pattern that could match a secret is rejected with a warning at config load — `resolveIgnoredPathPatterns` (`jev/secret-paths.ts`), shared with `regenerableIgnoredPaths`'s own resolver.

A directory pattern matches two shapes of candidate, not one: git does not always collapse a whole ignored directory to a single `ignored` entry. Once anything else under it is tracked (a `.gitignore`, a README), `git status --ignored=matching` lists each ignored file individually instead — `.worker-logs/final-compile2.log`, never `.worker-logs/` — so a plain suffix match against a trailing-slash pattern never fires for the common case. `matchesAnyBackupPattern` (`agent/backup-eligible-ignored.ts`) matches a directory pattern against the collapsed directory entry _and_ against any path git lists underneath it, anchoring the pattern to a path boundary on the left and requiring either the end of the string or a `/` right after it.

The same selection decides two things that must agree: what `checkDeletionInvariant` may treat as pending a backup while **planning** (`basis: "plan"`, before any snapshot exists — the `backupEligibleIgnored` coverage field, excused only at this basis so the sweep actually attempts the real snapshot), and the exact file list `GitWorktreeSnapshotter.snapshot()` force-adds (`git add -f --literal-pathspecs`, past `.gitignore`) into the tree it builds — never the directory name, and never trusting the walk's findings past that instant: each file is re-read right before it is staged, so one that grew past the cap or vanished between the walk and the write is dropped rather than forced in unchecked. `--literal-pathspecs` matters because an eligible name can itself look like a git pathspec glob (`run[1].log`); without it, force-adding that one file could also silently stage an unrelated, never-checked sibling. A worktree whose only at-risk content is one of these ignored paths would otherwise read `nothing-at-risk` and skip the snapshot entirely; finding at least one eligible file forces one. Once a real snapshot stages a path, it is tracked in that commit and no longer reads as ignored at all when coverage is read against it (`basis: "snapshot"`/`"head"`) — so the deletion invariant needs no special case there. A path the snapshotter leaves out for any reason — past either cap, secret-shaped, a rule added later — is not in the snapshot, reads as ignored again, and keeps the worktree until a later sweep tries again. Default `[]`: nothing is staged, and nothing about an existing deployment changes.

The deletion audit line (the `invariant` a report entry carries) names which rule excused each ignored entry instead of lumping every one under "regenerable": a byte-identical copy of the main checkout, a path backed up pending the snapshot, a container excused as holding only nested repositories, and the nested repositories themselves judged safe each get their own clause (`describeExcusedIgnored`, `agent/workspace-sweep-detector.ts`).

The check runs twice:

1. **Planning, read-only, the same in a dry run and a live one.** No schedule starts agents in the worktree; no process has its cwd, its executable or a file open inside it (one `lsof` over every process the daemon's user can see; the daemon's own process is left out, and so is one of its own direct children — a `tea`, `git` or `gh` forge poll it spawned directly, never an agent's: `isDaemonOwnChildPid`, `agent/process-attribution.ts`, checks the pid's immediate parent against the resource monitor's attributed `ps` sample rather than matching on a command name. "Directly" is one hop only — a shared long-lived service the daemon forks, like the terminal worker, is itself a direct child, but a user's terminal shell underneath it is a further hop out and is never folded into that exclusion); and the worktree read against HEAD (`readWorktreeCoverage`, given the workspace's `mainRepoRoot` to compare ignored paths against) shows nothing above: no ignored path that is neither regenerable nor a confirmed copy of the main checkout, no nested repository, no directory the delete cannot get through, no hidden change, no LFS file. What differs from HEAD, and any unpushed commit, is what the snapshot will have to hold.
2. **Confirming, live only, after `du` and right before the archive.** The schedule and process checks again, then the snapshot. If it reports nothing at risk, the worktree is read against HEAD again and nothing may differ. Otherwise the backup is verified — the ref points at the snapshot, the bundle exists, is non-empty, passes `git bundle verify` and holds the snapshot, or the personal remote holds the pushed branch; a snapshot with no copy outside the repository is not a backup — and the worktree is read against the snapshot commit through a scratch index. Any file not in it keeps the worktree: one written since the plan, or one the snapshot left out for its size, for looking like a secret, or for a rule added later. The next sweep snapshots it again.

The read against the snapshot does not trust anything the snapshotter says about what it held, so its filters can change without this rule changing. A snapshot that does report files it left out (`skippedFiles`, and `possibleSecrets` once the snapshotter fills it) keeps the worktree with that reason.

A loaded agent's own CLI process counts as a process inside: its worktree stays until the agent is closed, and a daemon restart closes every agent.

## Idle workspaces

The passes above reach only Paseo-owned worktrees, and only through their agents. Everything else stayed in the sidebar until someone archived it by hand: external worktrees (`~/mobile-worktrees`, `~/bn-worktrees`), local checkouts, `directory` workspaces, dirty Paseo worktrees, and a workspace per [self-heal fixer](remediation.md#the-remediation-agent). The idle-workspace sweep archives them. `agent/workspace-sweep-detector.ts` decides; the janitor reads the facts and acts, after the orphan pass.

### Who made it

Every workspace record carries `createdBy`, `"person"` or `"agent"`, set once at creation and never changed by inference after: a client request — `workspace.create.request` or a `create_agent_request` — with no caller agent and no inherited `paseo.parent-agent-id` label is a person's; everything else (the agent-scoped `create_workspace`/`create_agent` MCP tools, Hub, schedules, heartbeats, remediation, restart recovery) is an agent's. It is the same rule [auto-pin](#manual-pin-vs-auto-pin) already uses to decide whether to pin a session (`isHumanAttributableCreate`, `workspace-auto-pin.ts`), so `createdBy` and the auto-pin decision never disagree. A record written before this field existed is backfilled once at boot (`workspace-created-by-migration.ts`): agent only when every agent it ever held is a child (`paseo.parent-agent-id`) or a fixer (`paseo.remediation`) — one root agent that is neither makes the whole workspace person's, same-workspace subagents included, since an orchestrator's own workspace holds exactly that shape and is still the orchestrator's. A workspace with no agent record at all falls back to `isPaseoOwnedWorktree`, which means nothing once there is an agent to read instead (Tyler's own app flow creates worktrees too). Ambiguity resolves to person: inference never hides a workspace that might be his. Every client (sidebar, command palette) hides an `agent` workspace outright — no section, no count — unless Tyler pinned it himself; the done janitor reads the same field for the `agent-done` rule below. Absent — an older daemon, or a record the backfill has not reached yet — reads as `person`.

A workspace is archived when all of these hold:

- **Not manually pinned** ([Manual pin vs. auto-pin](#manual-pin-vs-auto-pin)), and no agent in it carries `paseo.keep`. An auto-pinned workspace is swept like an unpinned one.
- **Nothing in it is at work.** No agent is running, initializing, mid-turn, waiting on a permission, running provider subagents, or cut off by a daemon stop. No schedule or heartbeat targets one. No agent in it leads a live subagent anywhere: that is an orchestrator whose fleet is still loaded. No agent in it is a subagent whose leader, in another workspace, is loaded, at work or active within `idleHours`: a worker waits days while its leader works elsewhere and may send it more. No terminal is open and no script runs.
- **It is idle past its threshold**, measured from the newest of the record's `createdAt` and `updatedAt`, every agent's last activity and, for an archived one, when it was archived, HEAD's commit time, and the directory's own mtime. Never the git index: `git status` rewrites it. A timestamp that does not parse reads as just now, and a workspace with no signal at all is active.
- **No earlier pass archived or asked one of its agents this sweep.** Otherwise the dead pass could archive a 24h-quiet agent and this sweep delete its dirty worktree in the same run, skipping the 72 hours.

| Rule         | Which workspaces                                                          | Idle after                               |
| ------------ | ------------------------------------------------------------------------- | ---------------------------------------- |
| `fixer`      | Every agent it ever held carries `paseo.remediation`                      | 10 minutes after its last fixer stopped  |
| `agent-done` | `createdBy: "agent"`, not a fixer's                                       | 1 hour after its last agent was archived |
| `idle`       | A person-made workspace with an unarchived agent in it, or a git checkout | `idleHours`, 72h                         |
| `empty`      | A person-made workspace with neither                                      | `emptyIdleHours`, 24h                    |

72 hours outlasts a weekend, like the quiet period above. An idle agent does not keep its workspace past that: asking it is the question path's job, and its answer is activity that restarts the clock. A workspace with no agent and no git holds nothing but its record, and a day keeps it for someone who made it to start work tomorrow.

A fixer's workspace ignores its directory, since fixers run in the home directory, whose mtime moves all day. The ten minutes let the ladder read the finished fixer's report first; archived sooner, the ladder reads the fixer as "archived before it reported". A NOT_FIXED fixer goes with its workspace, and the push opens it from the archive. A standing self-heal workspace would group the fixers under one row, but that row stays between fixers; a workspace per fixer shows each one while it works and leaves nothing after.

`agent-done` (R6) replaces `idle`/`empty` for every `createdBy: "agent"` workspace that is not a fixer's: once every agent it ever held is archived, it waits one hour from the last one — short, because nothing in it is waiting for a person the way a workspace Tyler made might be. The directory still follows the ordinary rules below unchanged: record-only for an external worktree or a `directory` workspace, the git gate and a snapshot for a Paseo-owned one. While any agent in it is unarchived, it is not a candidate at all, whatever its directory's age.

### The directory

The archive goes through archive-by-scope, the path of a person's **Archive workspace**, which archives the workspace's agents and terminals with it. It deletes a directory only for a Paseo-owned worktree: the record says so, or an older record's path lies under the Paseo worktrees root.

The janitor checks the directory archive-by-scope deletes ([the deletion invariant](#the-deletion-invariant)) and names it on every line. For an older record without the ownership flag it is the worktree root above the record's cwd, even when that cwd is a subdirectory that no longer exists. A live run resolves it again from the fresh record right before the deletion, and keeps the workspace if the answer changed. An archive that deletes nothing goes through archive-by-scope with `keepDirectory`, which tears down and deletes no directory whatever the record says, so a record-only line can never delete one.

- **External worktrees, local checkouts and directories** keep their directory, dirty or not. Only the record is archived.
- **A Paseo-owned worktree** goes through the conflict and snapshot-failure checks and the [git gate](#reclaiming-the-worktree):
  - clean and pushed, or dirty or unpushed work a snapshot can hold: archived with its directory once the [deletion invariant](#the-deletion-invariant) holds. A worktree it keeps is not snapshotted by this pass; the [work-at-risk sweep](work-snapshots.md#the-work-at-risk-sweep) looks after its work;
  - gone: the record is archived, through the archive that keeps the directory;
  - anything else the gate refuses, a lock or a merge in progress: kept.
- With `reclaimWorkspaces` off, no Paseo-owned worktree is archived.

Each archive is decided again on freshly read state. One that deletes a directory gets [the last look](#the-last-look) as well, with one difference before the records: the workspace has to classify as idle still, since this sweep archives the idle agents in it. A sweep attempts at most `maxArchivesPerSweep`, fixers first and then the longest idle; the rest wait. An attempt spends the budget whatever the last checks decide, in a dry run and a live one alike, so a live run deletes only directories the dry run listed as `would-delete`. It may keep more: a snapshot that fails or leaves a file out, a backup that does not verify, or a file, process or agent that appeared between the plan and the delete.

A candidate kept for a reason unlikely to change within the hour — a process that is not the daemon's own, or an ignored, non-regenerable path no backup covers — is not attempted again for `keptCooldownHours` after that (R5), and spends none of the budget meanwhile: the rest of the backlog gets it instead of the same handful of permanently-stuck candidates every sweep. The cooldown lives in memory, keyed by workspace id, and a restart clears it; new activity drops the workspace out of the candidate list before the cooldown is ever read, so it is eligible again at once. Every other kept reason — dirty with no backup yet, a lock, a merge in progress, and a nested repository not judged safe (`category: "nested-repo"`, its own signal to `nestedRepositorySafetyCouldHelp`'s short-circuit above, mapped away before it ever reaches this cooldown) — may resolve on its own sooner and is reconsidered every sweep as before.

The daemon-own-process check (R4) answers `true`, `false`, or `"unknown"` (`agent/daemon-process-ownership.ts`) — `"unknown"` before the resource monitor's first attributed sample arrives, or once that sample ages past a few minutes (the resource monitor samples about once a minute; older than that means it stalled, or `resourceMonitor.enabled` is `false`, which skips the sample entirely). A process keeps the worktree the same way whether it reads `false` or `"unknown"`, but only a confident `false` earns the R5 cooldown — tagging `"unknown"` the same as `false` would let a momentary gap in the sample lock a workspace open (or shut) for up to six hours over a process the next sweep's fresh sample would have read correctly.

A once-a-minute sample cannot catch a forge poll that starts and exits between two samples — `tea pr list` routinely does — so a pid absent from every sample read as a confident `false` (not the daemon's own), not `"unknown"`: the check found a row for every OTHER pid but never this one, which looks exactly like "a stranger's process," never like doubt. `agent/daemon-forge-cli-pids.ts` closes that gap with a second, synchronous source: every `tea`/`gh`/`glab` child the forge CLI runner (`services/forge-cli-command.ts`) spawns directly — a poll and a mutating call alike — is marked live the instant it starts and cleared the instant it exits, independent of any sample. R4 checks this registry first — a pid it holds answers `true` unconditionally — and falls back to the sample-based check only once the registry no longer holds the pid.

| Key (`agents.doneJanitor.workspaceSweep`) | Default | Meaning                                                                               |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `enabled`                                 | `true`  | Runs whenever the janitor is `enabled`. False also stops the idle-project rule        |
| `dryRun`                                  | `true`  | Report only until set to `false`. The janitor's own `dryRun` makes it dry too         |
| `idleHours`                               | `72`    | The `idle` rule's threshold                                                           |
| `emptyIdleHours`                          | `24`    | The `empty` rule's threshold                                                          |
| `maxArchivesPerSweep`                     | `10`    | Workspaces archived per sweep                                                         |
| `keptCooldownHours`                       | `6`     | How long a permanently-stuck candidate is skipped before being re-attempted (R5)      |
| `projectGraceHours`                       | `24`    | How long a project with no active workspace stays ([Empty projects](#empty-projects)) |
| `maxProjectRemovalsPerSweep`              | `10`    | Projects that rule removes per sweep                                                  |

Scheduled runs need nothing more. A `new-agent` schedule archives its run's workspace when the run ends unless `archiveOnFinish` is false (`schedule/service.ts`); a run that keeps its workspace, or whose archive failed, is an ordinary idle workspace here. A schedule that is not completed and starts agents inside a worktree keeps that worktree's directory, so its next run does not start in a missing cwd.

### Approving the first live run

The sweep reports and deletes nothing until `workspaceSweep.dryRun` is `false`, set in code rather than config so the first daemon on a build cannot delete anything. The janitor's other passes keep their own `dryRun`. The first sweep runs 30 minutes after boot and logs every line once; later sweeps log only lines that changed.

1. Read what it would do:
   ```
   grep '"Done janitor (dry run)"' ~/.paseo/daemon.log | grep -E '"action":"(would-archive-workspace|would-delete|kept-idle-workspace|would-remove-project)"'
   ```
   Each `would-delete` line's `path` is the directory the archive deletes, and it carries its `rule`, its `idleFor` age and its `invariant` verdict: which files and commits the snapshot will have to back up, and which ignored paths go as regenerable. Each `would-archive-workspace` and `would-remove-project` line should name clutter.
2. Approve by setting `agents.doneJanitor.workspaceSweep.dryRun` to `false` in `$PASEO_HOME/config.json` and running `paseo reload`.
3. Watch the first live sweeps: `"msg":"Done janitor: archived an idle workspace"` lines carry `rule`, `idleFor`, `removedDirectory` and `invariant`, and `"action":"deleted"` lines carry `bytes`.

**Never write `workspaceSweep` into `config.json` while an older daemon runs.** `agents.doneJanitor` is strict, so a daemon built before the key rejects the whole file and every agent MCP request fails with it. Rolling back to an older build with the key on disk does the same: remove the key first.

## Empty projects

A project with no workspace left stays on the sidebar until someone removes it. Each sweep, after the workspaces, two rules remove one, record only, through the same two steps as a person's removal (`removeProjectRecord`: the registry, then the custom icon). Every connected session subscribes to the project registry, so each sidebar drops the project when the record goes. Neither rule touches an archived project or a remote-keyed one (`projectKey` or `projectId` starting with `remote:`), and neither looks at a remote project's root.

**No active workspace for `projectGraceHours`, and a root a person never opened.** Part of the idle-workspace sweep, so `workspaceSweep.enabled` and its `dryRun` govern it. The grace runs from the newest of the project's `createdAt` and `updatedAt` and each of its workspaces' `createdAt`, `updatedAt` and `archivedAt`, so it starts when the last workspace went. It keeps a project someone just opened or just emptied, and a project a daily schedule enters: each run archives its workspace and leaves the project empty for hours, never for a day. Once the grace passes, the root still has to be safe to remove: its directory is gone (the free `stat` probe, same as the rule below), or it is a worktree — a linked git worktree (its own `.git` is a pointer file, not a directory) or a Paseo-owned one — and every workspace the project ever had, archived ones included, was agent-made. A single person-created workspace keeps the project regardless of its root, and a root that still exists and is not a worktree is kept no matter how long it sits idle. At most `maxProjectRemovalsPerSweep` go per sweep.

**No workspace at all, and a root that is gone.** This one needs no grace beyond an hour, and runs whenever the janitor is `enabled`:

- **It has no workspace at all.** A workspace record of any state carrying its `projectId` spares it, archived ones included — so a worktree project whose one workspace is long archived never meets this rule; the grace rule above is the one that removes it.
- **Its root is gone.** `stat` fails with `ENOENT` and nothing else does. `EACCES`, `ENOTDIR` on a parent, a timeout or an empty or relative path say nothing about whether the directory exists, so they spare it. So does an absent volume: a root under `/Volumes/<name>`, `/media/<user>/<name>`, `/mnt/<name>` or a Windows drive root is only gone if that volume root exists, checked with one `stat` decided from the path (`volumeRootOf`, no mount table). An unplugged drive is reported as a `kept-project` line naming the volume. A root on the system volume needs only its own `ENOENT`.
- **It is at least an hour old**, by the newer of `createdAt` and `updatedAt`. Someone adding a project, or a worktree being created for one, has no workspace for a moment.

It removes at most 50 per sweep, outside `maxArchivesPerSweep`, and runs first; a project it reported is not reported again by the grace rule.

Both decide each removal against freshly read state: the project and its workspaces are read again immediately before the removal, and a project that changed is kept and reported as `kept-project`. The registry has no conditional remove, so a workspace created in the few milliseconds after that check still loses its project record. Adding the project again restores it; its custom name and icon do not come back.

## What you see

Each report line is logged to `daemon.log` when it changes, never every sweep. Grep for `Done janitor`. A dry run logs lines like these for dead agents. `kept-agent` appears only for an agent that looks dead (closed or errored) and was spared, with the reason:

```
{"action":"would-archive","agentId":"a1…","title":"Build the feature","workspaceId":"ws-1","reason":"dead: closed, quiet for 4d; with 1 subagent(s) by cascade; 1 unread flag(s) (finished) will be cleared","dryRun":true,"msg":"Done janitor (dry run)"}
{"action":"would-delete","workspaceId":"ws-1","path":"~/.paseo/worktrees/…/feature","reason":"every agent in it is dead or archived; clean tree and branch feature is merged or pushed","invariant":"holds: every file is tracked and pushed; ignored only regenerable (node_modules/)","dryRun":true,…}
{"action":"kept-agent","agentId":"c3…","title":"Fix the bug","reason":"its workspace is pinned","dryRun":true,…}
{"action":"kept-agent","agentId":"d4…","reason":"quiet for 14h of the 3d required","dryRun":true,…}
{"action":"kept-workspace","workspaceId":"ws-4","path":"…","reason":"it has 2 uncommitted or untracked file(s)","dryRun":true,…}
{"action":"would-remove-project","projectId":"prj_3f…","path":"~/.paseo/worktrees/…/wt4-feature","reason":"it has no workspaces and its directory no longer exists","dryRun":true,"msg":"Done janitor (dry run)"}
```

for idle workspaces and projects, where `kept-idle-workspace` appears only for one that is idle and was spared:

```
{"action":"would-archive-workspace","workspaceId":"wks_06fe…","title":"iOS: stale-deals sender","path":"~/mobile-worktrees/stale-deals-csm-ios","reason":"idle past 3d; record only, its directory stays","rule":"idle","idleFor":"12d","dryRun":true,…}
{"action":"would-archive-workspace","workspaceId":"wks_79ff…","title":"Remediate disk-falling condition","path":"~","reason":"a self-heal fixer's workspace, and every fixer in it is finished; record only, its directory stays","dryRun":true,…}
{"action":"would-delete","workspaceId":"wks_6290…","path":"~/.paseo/worktrees/…/qa-tests-silent-drop","reason":"idle past 3d; qa/silent-drop has 3 commit(s) neither merged into main nor pushed to any remote","rule":"idle","idleFor":"5d","invariant":"holds once a verified snapshot backs up 3 unpushed commit(s); ignored only regenerable (node_modules/)","dryRun":true,…}
{"action":"kept-idle-workspace","workspaceId":"wks_17e5…","path":"~/.paseo/worktrees/…/r7b-attack-visuals","reason":"224 ignored path(s) that are not regenerable and no backup holds (docs/style/assets/raw/effect-burst-arcane.png, …)","dryRun":true,…}
{"action":"kept-idle-workspace","workspaceId":"wks_a3c1…","path":"~/.paseo/worktrees/…/subterfuge-c3","reason":"a process runs inside it: bun (pid 48213) and 12 more","dryRun":true,…}
{"action":"would-remove-project","projectId":"prj_9c…","path":"~/bn-worktrees/csm-required-actions","reason":"it has had no active workspace for 3d","dryRun":true,…}
```

and for live agents:

```
{"action":"would-ask","agentId":"a1…","title":"Build the feature","workspaceId":"ws-1","reason":"every mechanical check passed; quiet for 4d","dryRun":true,"msg":"Done janitor (dry run)"}
{"action":"would-archive","agentId":"a1…","reason":"if it answers DONE (with 2 subagent(s) by cascade)","dryRun":true,…}
{"action":"would-delete","workspaceId":"ws-1","path":"~/.paseo/worktrees/…/feature","reason":"clean tree and branch feature is merged or pushed","dryRun":true,…}
{"action":"kept-workspace","workspaceId":"ws-2","path":"…","reason":"feature-2 has 3 commit(s) neither merged into main nor pushed to any remote","dryRun":true,…}
{"action":"cannot-ask","agentId":"b2…","reason":"account claude-b is at its usage cap","dryRun":true,…}
```

`not-done` lines are not logged; `tick()` returns them in its report. A live sweep that archived, deleted or removed something sends one push at level `record`, ledger only — "Archived 1 finished agent, archived 4 dead sessions, deleted 2 worktrees, freeing 5.8 GB, archived 6 idle workspaces and removed 25 empty projects. Kept …: …" — and a sweep that only checked sends nothing. A Paseo-owned worktree the idle-workspace sweep deletes counts as a deleted worktree; one whose record alone goes counts as an idle workspace. A live sweep logs `removed-project` lines with the project id, root path and reason, once each; a removal that failed or lost a race is a `kept-project` line, and `tick()` reports the count as `removedProjectCount`. A kept worktree does not raise the level: it is snapshotted, and the work-at-risk sweep's judge decides whether Tyler hears about it. `snapshotted` lines name each snapshot's ref and offsite copy.

## Not automated

- **Squash-merged branches whose remote branch is gone.** Their commits are unreachable from anything that survives, so they are kept and reported; delete them by hand after checking.
- **Ignored files outside the regenerable list.** They keep their worktree ([The deletion invariant](#the-deletion-invariant)) until someone backs them up or deletes them.
- **Worktrees that use Git LFS, hide changes with `--assume-unchanged` or `--skip-worktree`, or hold a directory the delete cannot get through.** They are kept every sweep ([The deletion invariant](#the-deletion-invariant)); clear the flag, push the LFS objects or fix the permissions, or delete the worktree by hand.
- **Windows.** There is no `lsof`, so the process check fails and the janitor deletes no worktree there. Records are still archived.
- **Background shells and `Monitor` watches inside a Claude process.** The daemon cannot see them. The quiet period and the question are the only defence: an agent waiting on one should answer `NOT_DONE`.
- **Dead subagents of a live leader.** The dead pass judges whole trees from the root, so a live idle leader keeps every dead child until it answers the question and is archived. The subagents track's **Archive finished** row clears them by hand.
- **Subagents on their own.** A subagent is archived with its root. One in another workspace, or open in a tab, is detached instead ([agent-lifecycle.md](agent-lifecycle.md#relationships)), becomes a root, and is asked on its own later.
- **Directories other than Paseo-owned worktrees.** The idle-workspace sweep archives their records; nothing deletes the directory.
- **A directory its archive kept.** When the last look refuses the delete, or the delete fails, the workspace is archived and its directory stays. No pass looks at an archived workspace, so it stays until someone deletes it.
