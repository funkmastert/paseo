# Work snapshots

An agent that dies, wedges or is archived can leave uncommitted files and unpushed commits in its worktree, and nothing else in the daemon protects them. The done janitor keeps a worktree that fails its git gate, but keeping is not saving: macOS purges `/tmp` and `/private/tmp`, a person deletes a directory, a later sweep reclaims it. A work snapshot copies that work into the repository's own refs, and offsite where that is safe, without touching the worktree.

`GitWorktreeSnapshotter` (`packages/server/src/server/agent/worktree-snapshot.ts`) takes the snapshots. Three callers share one instance: the done janitor, the work-at-risk sweep (`agent-work-snapshot-sweep.ts`), and the stalled-agent sweep before it nudges an agent ([stalled-agents.md](stalled-agents.md)).

## What is at risk

A worktree is at risk when either holds:

- `git status --porcelain --untracked-files=normal` reports anything. Ignored files do not count.
- HEAD has commits reachable from no remote-tracking ref. A repository with no remote at all has nothing anywhere else, so every commit counts.

Stashes and local branches other than HEAD are not looked at.

## How a snapshot is taken

The snapshot is a commit built through a temporary `GIT_INDEX_FILE`: read HEAD's tree into it, `add -u`, add untracked files that are not ignored, `write-tree`, `commit-tree` with HEAD as the parent. An unborn branch gets an empty index and a commit with no parent. Untracked files over `maxUntrackedFileBytes` are left out and named in the commit message and the result.

**The agent's index, HEAD, working tree and branch refs are never written.** The only writes are git objects, one ref under `refs/backup/`, and the offsite copy. Every git call runs with `--no-optional-locks`, so even `git status` does not refresh the real index. The test that holds this line hashes `.git/index` (for a linked worktree, `.git/worktrees/<name>/index` in the common dir) and reads HEAD before and after.

The ref lives in the common dir, so it outlives the worktree. A snapshot of a worktree whose newest snapshot already has the same tree and parent reuses that ref instead of minting another, so repeated sweeps over an unchanged worktree cost nothing.

### Untracked files that look like secrets

An untracked file is left out when any of these holds (`snapshot-secret-filter.ts`):

- Its mode has no group or other bits. Someone made it owner-only on purpose.
- Its name looks like a secret: `.env`, `.envrc` and `.env.*` (but not `.env.example`, `.env.sample` or `.env.template`), anything with `secret` or `credential` in it, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `.netrc`, `.npmrc`, `.pypirc`, and private SSH keys such as `id_rsa` and `id_ed25519`.
- Its first 64 KB holds a token: Anthropic, OpenAI, GitHub, Slack, AWS access key, Notion, a PEM private key, or a JWT.
- It cannot be read.

A symlink is judged by its name only, since git stores its target and not what it points at. The file stays on disk, untouched. Its path, never its content, goes into the commit message under `Not snapshotted: possible secret (left on disk)` and into the `Work snapshot` log line. It is also not saved: if the worktree is reclaimed later, the file goes with it.

The filter errs toward leaving a file out. A source file named `secrets.ts` is left out too, and named.

Only the untracked set is filtered. `add -u` stages modified tracked files as they are, and a pushed snapshot carries HEAD's unpushed commits as they are. A secret that is tracked or committed goes wherever the snapshot goes.

## Names

| What                                    | Name                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Ref                                     | `refs/backup/<YYYY-MM-DD>/<slug>`, then `<YYYY-MM-DD>-2`, `-3`… for a second snapshot the same day |
| Branch on a private personal repository | `backup/<YYYY-MM-DD>/<slug>`                                                                       |
| Bundle                                  | `<bundleDir>/<YYYY-MM-DD>/<slug>.bundle`                                                           |

`<slug>` is the worktree path with the home directory stripped and anything outside `[A-Za-z0-9_-]` folded to `-`. The date is the daemon's local date. An existing ref is never moved.

## Offsite: push to a private personal repository, bundle everything else

The ref is pushed as the backup branch only when both hold:

- `origin` is a GitHub repository under one of `personalOwners`.
- GitHub says the repository is private (`github-repo-visibility.ts`). The snapshotter asks `gh api repos/<owner>/<repo> --jq .private` first, since `gh` sees Tyler's private repositories. Without a definite answer from `gh`, it asks the API anonymously: a 404 means private or missing, and a 200 carries the `private` flag. A definite answer is cached per repository for an hour. A timeout, a rate limit or any other failure is unknown, and unknown is never cached.

`funkmastert/paseo` is public, so its worktrees are bundled.

The push uses `--no-verify` and goes to the origin URL rather than the remote name. `--no-verify` skips the repository's pre-push hook, which in these repos runs lint and tests, and with it any pre-push secret scanner, so the untracked-file filter above is the only secret check on what is pushed. Pushing to the URL writes no remote-tracking ref, so the pushed commits still count as unpushed to the next assessment and to the done janitor's git gate.

Everything else gets a `git bundle` under `bundleDir`: a public or unknown personal repository, every other origin including `git.wonderly.info` and `github.com/wonderlydotcom`, and a repository with no origin. A WIP branch on a shared company forge starts CI and shows up in everyone's branch list, so nothing is ever pushed there, and a company origin is never looked up. With a remote, the bundle leaves out what the remote already has. A failed push falls back to a bundle.

## The work-at-risk sweep

Every `sweepMinutes` it inventories:

- worktrees of agents that are **dead** (no runtime), **wedged** (a runtime in error, or a turn force-cancelled as unresponsive), each quiet for an hour, or **archived**;
- **orphaned** worktrees: directories under the Paseo worktrees root that no active workspace uses.

A worktree where a working agent still runs is skipped: that agent owns its work. Worktrees under `/tmp` and `/private/tmp` go first, then ones never handed over. At most `maxPerSweep` at-risk worktrees are snapshotted per sweep.

The hour of quiet exists because a daemon restart closes every agent at once and most are resumed within minutes. It is far inside the three days after which macOS purges `/tmp`.

What was handed over is kept in `$PASEO_HOME/work-snapshots.json`, by worktree path, tree and HEAD. A worktree is handed over again only when its snapshot changes.

## The judge

A snapshot saves the work; it does not say whether anyone needs it. When a sweep produces new snapshots, it observes one `work-at-risk` condition for the whole batch on the [remediation ladder](remediation.md): no deterministic remedy, grace 0, level `alert`, and a `mechanical` task. The evidence lists each worktree with its branch, owning agent and title, dirty and unpushed counts, ref, and offsite copy. The ladder starts one judge agent, which reads the snapshots without modifying any worktree and reports `FIXED` when every one is scratch, a duplicate, or already integrated elsewhere, or `NOT_FIXED` naming the ones that need follow-up. Only `NOT_FIXED` reaches Tyler.

The next sweep reports the condition inactive, which closes the episode; the ladder still reads the judge's report after that. New snapshots in that same sweep wait one more sweep, so each episode carries one batch.

## The done janitor

The done janitor snapshots every worktree of a dead tree before archiving it, and every worktree before deleting it. A snapshot that fails on a worktree at risk spares the worktree from reclamation that sweep, with the reason in the report. See [done-janitor.md](done-janitor.md#reclaiming-the-worktree).

## Restoring a snapshot

In any checkout of the repository:

```sh
git for-each-ref refs/backup/                  # list snapshots
git checkout -b restore refs/backup/2026-09-24/<slug>
```

The snapshot's parent is the HEAD it was taken from, so `git diff restore^ restore` is the uncommitted work and `git log restore^` the unpushed commits. From a personal remote, fetch `backup/<date>/<slug>`. From a bundle:

```sh
git bundle verify <file>                       # names any commits it needs from the remote
git fetch <file> 'refs/backup/*:refs/backup/*'
```

or `git bundle unbundle <file>` to write only the objects.

## Config

`agents.remediation.workSnapshots`, live-toggleable. `agents.remediation.remedies.enabled: false` turns the sweep off too.

| Key                     | Default               | Meaning                                                         |
| ----------------------- | --------------------- | --------------------------------------------------------------- |
| `enabled`               | `true`                | False: the sweep does nothing. The done janitor still snapshots |
| `dryRun`                | `false`               | Log what the sweep would snapshot; write no ref, state or batch |
| `sweepMinutes`          | `60`                  | Time between sweeps. The first runs five minutes after start    |
| `personalOwners`        | `["funkmastert"]`     | GitHub owners whose private repositories get the branch pushed  |
| `bundleDir`             | `$PASEO_HOME/backups` | Where bundles go                                                |
| `maxUntrackedFileBytes` | 20 MiB                | Untracked files larger than this are left out and named         |
| `maxPerSweep`           | `10`                  | Worktrees at risk snapshotted per sweep                         |

Grep `daemon.log` for `Work snapshot` and `Work-at-risk sweep`.
