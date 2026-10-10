# Work snapshots

An agent that dies, wedges or is archived can leave uncommitted files and unpushed commits in its worktree, and nothing else in the daemon protects them. The done janitor keeps a worktree that fails its git gate, but keeping is not saving: macOS purges `/tmp` and `/private/tmp`, a person deletes a directory, a later sweep reclaims it. A work snapshot copies that work into the repository's own refs, and offsite where that is safe, without touching the worktree.

`GitWorktreeSnapshotter` (`packages/server/src/server/agent/worktree-snapshot.ts`) takes the snapshots. Three callers share one instance: the done janitor, the work-at-risk sweep (`agent-work-snapshot-sweep.ts`), and the stalled-agent sweep before it nudges an agent ([stalled-agents.md](stalled-agents.md)).

## What is at risk

A worktree is at risk when either holds:

- `git status --porcelain --untracked-files=normal` reports anything. Ignored files do not count.
- HEAD has commits reachable from no remote-tracking ref. A repository with no remote at all has nothing anywhere else, so every commit counts.

Stashes and local branches other than HEAD are not looked at.

## How a snapshot is taken

The snapshot is a commit built through a temporary `GIT_INDEX_FILE`: seed it, `add -u`, add untracked files that are not ignored, `write-tree`, `commit-tree` with HEAD as the parent. An unborn branch gets an empty index and a commit with no parent. Untracked files over `maxUntrackedFileBytes` are left out and named in the commit message and the result.

**The agent's index, HEAD, working tree and branch refs are never written.** The only writes are git objects, one ref under `refs/backup/`, and the offsite copy. Every git call runs with `--no-optional-locks`, so even `git status` does not refresh the real index. Every git call also runs at background priority (`utils/spawn.ts`'s `priority: "background"`, the `backgroundNice` policy). By default that is the same nice agents run at (`agentNice`), so a sweep yields to your own apps and the daemon but competes with agent builds on equal terms. The test that holds this line hashes `.git/index` (for a linked worktree, `.git/worktrees/<name>/index` in the common dir) and reads HEAD before and after.

When HEAD exists, the temporary index starts as a copy of the worktree's own index and is then reset to HEAD's tree with a one-tree `read-tree -m HEAD`. The reset keeps git's stat cache (mtime, size) for every entry that still matches HEAD, so `add -u` re-hashes only a file whose stat moved, not every tracked file. The reset also drops whatever the agent staged but never committed. Those files are then listed as untracked and face the same checks as any other untracked file. Without the reset, a staged `.env` or a staged 4 GB build artifact went into the snapshot unchecked. A plain `read-tree HEAD`, with no stat cache, is the fallback in two cases: when the real index can't be found or copied, and when `read-tree -m` refuses an index with unmerged entries (a worktree mid-merge). An unborn branch has no index of its own yet and gets `read-tree --empty`.

The ref lives in the common dir, so it outlives the worktree. A snapshot of a worktree whose newest snapshot already has the same tree and parent reuses that ref instead of minting another, so repeated sweeps over an unchanged worktree write nothing new — and, with the stat-cache seed above, cost little to check even under load, rather than a full rehash of every tracked file before the reuse check can run.

### Untracked files that look like secrets

An untracked file is left out when any of these holds (`snapshot-secret-filter.ts`):

- Its mode has no group or other bits. Someone made it owner-only on purpose.
- Its name looks like a secret:
  - `.env`, `*.env`, `.envrc`, and `.env.*`, `.env-*` or `.env_*` unless it ends in `example`, `sample` or `template`;
  - anything with `secret` or `credential` in it;
  - `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `.htpasswd`, `kubeconfig*`, and private SSH keys such as `id_rsa` and `id_ed25519`;
  - a name that ends in `token`, `api_key` or `password` once its extension is off (`token.txt`, `github-token`, `db_password.txt`), but not `useToken.ts` or `ResetPassword.tsx`.
- It is under a `secret(s)` or `credential(s)` directory, dotted or not, or under `.aws`, `.ssh`, `.gnupg`, `.kube` or `.docker`.
- Its path, or its first 64 KB, holds a token: Anthropic, OpenAI (including `sk-svcacct-` and `sk-admin-`), Stripe live keys, GitHub, GitLab, Hugging Face, npm, Slack tokens and webhooks, AWS access key, Google API key, Notion (`ntn_` and the older `secret_`), a PEM private key, a JWT, or a database or queue URL with a password in it. NULs are dropped before matching, so UTF-16 text counts.
- It cannot be read.

A symlink is judged by its path only, since git stores its target and not what it points at. The file stays on disk, untouched. Its path, never its content, goes into the commit message under `Not snapshotted: possible secret (left on disk)` and into the `Work snapshot` log line; a path that itself holds a token is written as `<path withheld: looks like a token>`, there and in the size-cap list. It is also not saved: if the worktree is reclaimed later, the file goes with it.

The filter errs toward leaving a file out. A source file named `secrets.ts` is left out too, and named.

This filter decides what goes into the snapshot. `add -u` still stages modified tracked files as they are, and the snapshot's parent is HEAD with its unpushed commits. Those reach a local ref and a bundle unfiltered; before a push, the scan below reads them.

## Names

| What                                    | Name                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Ref                                     | `refs/backup/<YYYY-MM-DD>/<slug>`, then `<YYYY-MM-DD>-2`, `-3`… for a second snapshot the same day |
| Branch on a private personal repository | `backup/<YYYY-MM-DD>/<slug>`                                                                       |
| Bundle                                  | `<bundleDir>/<YYYY-MM-DD>/<slug>.bundle`                                                           |

`<slug>` is the worktree path with the home directory stripped and anything outside `[A-Za-z0-9_-]` folded to `-`. The date is the daemon's local date. An existing ref is never moved.

## Offsite: push to a private personal repository, bundle everything else

The ref is pushed as the backup branch only when all three hold:

- `origin` is a GitHub repository under one of `personalOwners`.
- GitHub says the repository is private (`github-repo-visibility.ts`). The snapshotter asks `gh api repos/<owner>/<repo> --jq .private` first, since `gh` sees Tyler's private repositories. Without a definite answer from `gh`, it asks the API anonymously: a 404 means private or missing, and a 200 carries the `private` flag. A definite answer is cached per repository for five minutes. A timeout, a rate limit or any other failure is unknown. Unknown is never cached, and a snapshot bundled on an unknown answer is offered again at the next sweep, even when the worktree has not changed; every other outcome is final for that snapshot.
- Nothing the push would send looks like a secret. The scan reads every commit of the snapshot that no remote-tracking ref reaches: the snapshot itself and HEAD's unpushed commits, merges diffed against their first parent. Every added line and every commit message is tested against the token list above, and every changed path against the name and directory rules. This covers tracked edits, committed files, a token added in one commit and removed in the next, and untracked files past the filter's 64 KB window or rewritten after the filter read them. A hit bundles instead, and the warning `possible secret in what the push would send` names each path (or `(commit message)`) and the kind of token, never the token. More than 32 MB of git output to read, or a git failure, also bundles.

`funkmastert/paseo` is public, so its worktrees are bundled.

The push uses `--no-verify` and goes to the origin URL rather than the remote name. `--no-verify` skips the repository's pre-push hook, which in these repos runs lint and tests, and with it any pre-push secret scanner, so the untracked-file filter and the scan above are the only secret checks on what is pushed. Pushing to the URL writes no remote-tracking ref, so the pushed commits still count as unpushed to the next assessment and to the done janitor's git gate.

Everything else gets a `git bundle` under `bundleDir`: a public or unknown personal repository, every other origin including `git.wonderly.info` and `github.com/wonderlydotcom`, and a repository with no origin. A WIP branch on a shared company forge starts CI and shows up in everyone's branch list, so nothing is ever pushed there, and a company origin is never looked up. With a remote, the bundle leaves out what the remote already has. A failed push falls back to a bundle.

### Known gaps

- **A repository made public later publishes its backup branches.** Privacy is checked at push time only, and an answer can be up to five minutes old. Before making a personal repository public, delete its `backup/*` branches.
- **The scan trusts the remote-tracking refs.** What they reach counts as already on the remote and is not read. A repository that has never been fetched has none, so its whole history is scanned and, past 32 MB, bundled.
- **Encoded content is not decoded.** A token inside a compressed file or in base64 is not found by the filter or the scan. A token glued to a preceding letter, digit, `_` or `-` does not match either, which is what keeps `task-…` from reading as an `sk-` key.
- **The untracked filter reads 64 KB.** A token past that goes into the local ref and the bundle, both on this machine. The scan catches it before any push.

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

The done janitor snapshots every worktree of a dead tree before archiving it, and every worktree before deleting it. A snapshot that fails on a worktree at risk spares the worktree from reclamation that sweep, with the reason in the report. See [done-janitor.md](done-janitor.md#reclaiming-the-worktree). Before any deletion it verifies the snapshot's bundle or pushed branch and reads the worktree against the snapshot commit, so a file the snapshot left out, for any reason, keeps the worktree ([done-janitor.md](done-janitor.md#the-deletion-invariant)).

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
