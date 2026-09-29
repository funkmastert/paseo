# Done janitor

Nothing else in the daemon removes finished work. Archiving an agent does not archive its workspace, and archiving the workspace is the only thing that deletes its worktree, so every finished task leaves a sidebar row and a worktree behind: about 3 GB each once `node_modules` and build output are in it. `AgentDoneJanitor` (`packages/server/src/server/agent-done-janitor.ts`) does three things. It archives agents that are **dead** (closed or errored, untouched for days, not pinned) without asking anyone, and it finds idle **live** agents that are definitely finished, asks each one, and archives it on a strict yes. Either way it then deletes the worktree if nothing in it exists anywhere else. It archives [idle workspaces](#idle-workspaces) of every kind, the ones no agent pass reaches. Last, it removes [empty projects](#empty-projects).

The rule for dead agents is Tyler's: a dead session archives itself unless it is pinned.

Archive semantics — cascade to subagents, detach of cross-workspace and open-tab children, workspace archive as a separate lifecycle — are in [agent-lifecycle.md](agent-lifecycle.md#archive). The janitor uses the same paths a person's archive does and adds no semantics of its own.

## Turning it on

Off by default. Config lives under `agents.doneJanitor` and is live-toggleable like its siblings. Turn on `dryRun` first.

| Key                       | Default | Meaning                                                                             |
| ------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `enabled`                 | `false` | Absent or false: the sweep returns before reading anything                          |
| `dryRun`                  | `false` | Report what it would ask, archive and delete; do none of it                         |
| `quietHours`              | `72`    | How long an agent and its whole tree must be quiet before it is asked               |
| `maxQuestionsPerSweep`    | `1`     | Questions per 30-minute sweep                                                       |
| `maxArchivesPerSweep`     | `3`     | Agents archived, plus orphaned worktrees deleted, per sweep                         |
| `answerTimeoutMinutes`    | `10`    | How long to wait for the answer before cancelling the turn                          |
| `reclaimWorkspaces`       | `true`  | False keeps every worktree; finished agents are still archived                      |
| `archiveDead`             | `true`  | Archive dead, unpinned agents (below). False leaves them to the question            |
| `deadQuietHours`          | `72`    | How long a dead agent and its whole tree must be untouched                          |
| `maxDeadArchivesPerSweep` | `10`    | Dead trees archived per sweep. Worktree deletions still spend `maxArchivesPerSweep` |
| `askFinished`             | `true`  | False never asks a live agent anything; only the dead pass runs                     |
| `workspaceSweep`          | on      | The [idle-workspace sweep](#idle-workspaces) and its project rule, with their keys  |

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
(`workspace-auto-pin.ts`). Both keep the workspace at the top of the sidebar identically; they
differ only in what the janitor does with them.

A **manual** pin protects fully, as described above: the dead pass, the question, and worktree
reclamation all skip it indefinitely.

An **auto** pin protects nothing from the janitor. It exists so a workspace Tyler just started
working in doesn't look unpinned while it's active, but once that workspace would otherwise be
swept up by the janitor's ordinary quiet-and-done rules, the auto-pin does not stand in the way —
otherwise every session Tyler ever starts would pin forever and the pinned list would fill with the
same clutter the janitor exists to clear. `isProtectivePin` (`workspace-auto-pin.ts`) is the single
place this distinction is made; the dead pass, the question pass, and worktree reclamation all read
it instead of `pinnedAt` directly.

Pinning by hand always wins: it sets `pinSource` to `"manual"` regardless of what was there before,
so pinning an auto-pinned workspace upgrades it to a real pin. Unpinning clears both fields.
Auto-pinning only ever moves a workspace from unpinned to auto-pinned — it never touches a
workspace that is already pinned, by either source.

Auto-pin is human-attributable-create only: it fires for a `workspace.create.request` or a
`create_agent_request` with no `callerAgentId` (both are only reachable over a client connection —
app or CLI), never for the agent-scoped `create_workspace`/`create_agent` MCP tools, Hub
executions, schedules, heartbeats, remediation, or restart recovery, which all create through the
separate `"mcp"`-kind path. The known gap: an agent that runs the CLI with `PASEO_AGENT_ID` cleared
looks identical to a human on the wire and gets auto-pinned too — harmless, since an auto-pin is
reclaimable the same as no pin once the janitor's rules say the work is done.

Off switch: `agents.autoPinSessions` (boolean, default on, reloadable without a restart).

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

An agent that cannot be asked is left and reported as `cannot-ask`: no provider session to resume, a provider that reports itself unavailable, a usage window at 100%, a usage source in error (how a logged-out account shows), or any agent on the account with a limit-shaped error. Asking one would fail its turn and flag it, noise the janitor would have made itself.

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

Deleting a directory is the one thing the janitor cannot undo, so every deletion it makes, by any pass, meets one rule: **every file in the worktree is tracked and pushed, or in a verified backup, or under a regenerable directory.** Anything else present keeps the worktree, and the reason is logged. When in doubt, it keeps: a git command that fails, output cut off at the runner's cap, or a process list that cannot be read all keep it.

The directory checked is the directory deleted, as the same string. Every pass asks archive-by-scope which directory its archive deletes (`resolveArchiveDirectory`, `workspace-archive-service.ts`), checks that one, and hands it back as `expectedDirectory`. An archive that would delete another directory, or none, throws before it touches anything, and the workspace is kept. Both sides are canonical (`canonicalizePath`, `utils/path.ts`): the realpath, or for a path that does not exist, the realpath of its deepest existing ancestor with the rest appended. On macOS `/var/…` and `/private/var/…` are one directory and two strings, so compare only canonical paths.

Git's listing has to be the whole of what the deletion loses, so these keep the worktree too, snapshot or not:

- **A directory the delete cannot get through**: one it cannot read, or cannot write or search. Git skips a directory it cannot open without failing, and a delete that meets one stops part-way, leaving half a worktree. `readWorktreeCoverage` walks the whole tree for these, ignored directories included, without following symlinks.
- **A change git is told not to look for**: a tracked file on disk marked `--assume-unchanged` or `--skip-worktree`. Git, the scratch index and the snapshot all read an edit to it as unchanged.
- **A file stored with Git LFS** (`filter=lfs` from any attributes file, tracked or not). Git and the backup hold only its pointer; the contents are in the LFS store, and nothing the janitor can read proves the LFS server has them: `git lfs push --dry-run` and `git lfs status` compare refs, not the server's objects.

Regenerable means a directory on the path is one a build, an install or a test run recreates — `node_modules`, `dist`, `build`, `out-tsc`, `tsc-out`, `.next`, `.turbo`, `.cache`, `coverage`, `test-results`, `target`, `.gradle`, `DerivedData`, `Pods`, `.build`, `.swiftpm`, `__pycache__`, `.venv` and the rest named in `REGENERABLE_DIRS` (`agent/workspace-sweep-detector.ts`), plus `.yarn/cache` — **and it sits at the worktree root or beside a build manifest**: `package.json`, `Cargo.toml`, `build.gradle(.kts)`, `settings.gradle(.kts)`, `Package.swift`, `pyproject.toml`, `setup.py`, `go.mod`, `pom.xml` or an `*.xcodeproj`. A build tool writes its output next to its manifest; a `src/build/` or `src/.cache/` beside source is somebody's files. `.DS_Store`, `*.pyc` and `*.tsbuildinfo` count anywhere. Everything else that is ignored keeps the worktree: `.env`, `.xcode.env.local`, `google-services.json`, playtest evidence logs, `.data/`, `results/`, `src-tauri/binaries/`, and a `__pycache__/` below a package's root. Add a name to the list only for a directory whose contents are always rebuilt.

A repository nested anywhere keeps the worktree: a submodule, an untracked repository, or one inside an ignored regenerable directory, where git lists only the directory and the walk finds its `.git`. A backup holds a nested repository only as a pointer to a commit, if at all.

Ignored files come from `git status --ignored=matching --untracked-files=all`. Do not switch to `ls-files --ignored --directory`: it never looks inside an untracked directory, so a `.env` beside a new, untracked source file is in neither list, and the snapshot leaves it out as ignored.

The check runs twice:

1. **Planning, read-only, the same in a dry run and a live one.** No schedule starts agents in the worktree; no process has its cwd, its executable or a file open inside it (one `lsof` over every process the daemon's user can see; the daemon's own process is left out); and the worktree read against HEAD (`readWorktreeCoverage`) shows nothing above: no ignored path that is not regenerable, no nested repository, no directory the delete cannot get through, no hidden change, no LFS file. What differs from HEAD, and any unpushed commit, is what the snapshot will have to hold.
2. **Confirming, live only, after `du` and right before the archive.** The schedule and process checks again, then the snapshot. If it reports nothing at risk, the worktree is read against HEAD again and nothing may differ. Otherwise the backup is verified — the ref points at the snapshot, the bundle exists, is non-empty, passes `git bundle verify` and holds the snapshot, or the personal remote holds the pushed branch; a snapshot with no copy outside the repository is not a backup — and the worktree is read against the snapshot commit through a scratch index. Any file not in it keeps the worktree: one written since the plan, or one the snapshot left out for its size, for looking like a secret, or for a rule added later. The next sweep snapshots it again.

The read against the snapshot does not trust anything the snapshotter says about what it held, so its filters can change without this rule changing. A snapshot that does report files it left out (`skippedFiles`, and `possibleSecrets` once the snapshotter fills it) keeps the worktree with that reason.

A loaded agent's own CLI process counts as a process inside: its worktree stays until the agent is closed, and a daemon restart closes every agent.

## Idle workspaces

The passes above reach only Paseo-owned worktrees, and only through their agents. Everything else stayed in the sidebar until someone archived it by hand: external worktrees (`~/mobile-worktrees`, `~/bn-worktrees`), local checkouts, `directory` workspaces, dirty Paseo worktrees, and a workspace per [self-heal fixer](remediation.md#the-remediation-agent). The idle-workspace sweep archives them. `agent/workspace-sweep-detector.ts` decides; the janitor reads the facts and acts, after the orphan pass.

A workspace is archived when all of these hold:

- **Not manually pinned** ([Manual pin vs. auto-pin](#manual-pin-vs-auto-pin)), and no agent in it carries `paseo.keep`. An auto-pinned workspace is swept like an unpinned one.
- **Nothing in it is at work.** No agent is running, initializing, mid-turn, waiting on a permission, running provider subagents, or cut off by a daemon stop. No schedule or heartbeat targets one. No agent in it leads a live subagent anywhere: that is an orchestrator whose fleet is still loaded. No agent in it is a subagent whose leader, in another workspace, is loaded, at work or active within `idleHours`: a worker waits days while its leader works elsewhere and may send it more. No terminal is open and no script runs.
- **It is idle past its threshold**, measured from the newest of the record's `createdAt` and `updatedAt`, every agent's last activity and, for an archived one, when it was archived, HEAD's commit time, and the directory's own mtime. Never the git index: `git status` rewrites it. A timestamp that does not parse reads as just now, and a workspace with no signal at all is active.
- **No earlier pass archived or asked one of its agents this sweep.** Otherwise the dead pass could archive a 24h-quiet agent and this sweep delete its dirty worktree in the same run, skipping the 72 hours.

| Rule    | Which workspaces                                     | Idle after                              |
| ------- | ---------------------------------------------------- | --------------------------------------- |
| `fixer` | Every agent it ever held carries `paseo.remediation` | 10 minutes after its last fixer stopped |
| `idle`  | An unarchived agent in it, or a git checkout         | `idleHours`, 72h                        |
| `empty` | Neither                                              | `emptyIdleHours`, 24h                   |

72 hours outlasts a weekend, like the quiet period above. An idle agent does not keep its workspace past that: asking it is the question path's job, and its answer is activity that restarts the clock. A workspace with no agent and no git holds nothing but its record, and a day keeps it for someone who made it to start work tomorrow.

A fixer's workspace ignores its directory, since fixers run in the home directory, whose mtime moves all day. The ten minutes let the ladder read the finished fixer's report first; archived sooner, the ladder reads the fixer as "archived before it reported". A NOT_FIXED fixer goes with its workspace, and the push opens it from the archive. A standing self-heal workspace would group the fixers under one row, but that row stays between fixers; a workspace per fixer shows each one while it works and leaves nothing after.

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

| Key (`agents.doneJanitor.workspaceSweep`) | Default | Meaning                                                                               |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `enabled`                                 | `true`  | Runs whenever the janitor is `enabled`. False also stops the idle-project rule        |
| `dryRun`                                  | `true`  | Report only until set to `false`. The janitor's own `dryRun` makes it dry too         |
| `idleHours`                               | `72`    | The `idle` rule's threshold                                                           |
| `emptyIdleHours`                          | `24`    | The `empty` rule's threshold                                                          |
| `maxArchivesPerSweep`                     | `10`    | Workspaces archived per sweep                                                         |
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

**No active workspace for `projectGraceHours`.** Part of the idle-workspace sweep, so `workspaceSweep.enabled` and its `dryRun` govern it. The grace runs from the newest of the project's `createdAt` and `updatedAt` and each of its workspaces' `createdAt`, `updatedAt` and `archivedAt`, so it starts when the last workspace went. It keeps a project someone just opened or just emptied, and a project a daily schedule enters: each run archives its workspace and leaves the project empty for hours, never for a day. At most `maxProjectRemovalsPerSweep` go per sweep.

**No workspace at all, and a root that is gone.** This one needs no grace beyond an hour, and runs whenever the janitor is `enabled`:

- **It has no workspace at all.** A workspace record of any state carrying its `projectId` spares it, archived ones included.
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
