# Done janitor

Nothing else in the daemon removes finished work. Archiving an agent does not archive its workspace, and archiving the workspace is the only thing that deletes its worktree, so every finished task leaves a worktree behind: about 3 GB each once `node_modules` and build output are in it. `AgentDoneJanitor` (`packages/server/src/server/agent-done-janitor.ts`) finds agents that are definitely finished, asks each one, archives it on a strict yes, and then deletes its worktree if nothing in it exists anywhere else.

Archive semantics — cascade to subagents, detach of cross-workspace and open-tab children, workspace archive as a separate lifecycle — are in [agent-lifecycle.md](agent-lifecycle.md#archive). The janitor uses the same paths a person's archive does and adds no semantics of its own.

## Turning it on

Off by default. Config lives under `agents.doneJanitor` and is live-toggleable like its siblings. Turn on `dryRun` first.

| Key                    | Default | Meaning                                                               |
| ---------------------- | ------- | --------------------------------------------------------------------- |
| `enabled`              | `false` | Absent or false: the sweep returns before reading anything            |
| `dryRun`               | `false` | Report what it would ask, archive and delete; do none of it           |
| `quietHours`           | `72`    | How long an agent and its whole tree must be quiet before it is asked |
| `maxQuestionsPerSweep` | `1`     | Questions per 30-minute sweep                                         |
| `maxArchivesPerSweep`  | `3`     | Agents archived, plus orphaned worktrees deleted, per sweep           |
| `answerTimeoutMinutes` | `10`    | How long to wait for the answer before cancelling the turn            |
| `reclaimWorkspaces`    | `true`  | False keeps every worktree; finished agents are still archived        |

`agents.*` sections are strict: a daemon built before this key existed rejects the whole config file, and every agent MCP request fails with it. Add the key only once the running daemon has this build.

The quiet period is three days because an idle agent is not a finished one. Agents are left idle overnight and over a weekend and picked up again; Friday evening to Monday morning is about 64 hours.

## What "finished" means

The janitor considers root agents only. Archive cascades, so a root's whole unarchived tree has to pass every check, and any one failing spares the tree (`agent/done-janitor-detector.ts`):

- **Not running, initializing or in error.** A failed agent is a problem nobody has looked at yet.
- **No turn in flight, no pending permission, no queued run.**
- **No unread attention flag, `finished` included.** Archiving clears the flag, which would erase the only sign that there is a result nobody has read.
- **No live token-burn, spend-governor or resource alert.**
- **No provider subagent still running.** A Claude Task subagent or workflow runs inside the parent's process and the parent can look idle while it does.
- **No schedule or heartbeat that is not completed targets it.** Something is going to wake it.
- **Not retired by account failover.** Its successor carries the work on.
- **Quiet for `quietHours`**, measured from the newest activity timestamp the daemon holds. An agent with no readable timestamp is not quiet.
- **Not pinned.** Any value of the `paseo.keep` label pins an agent, its tree and its workspace, `"false"` included. Set it with `update_agent` (`labels: { "paseo.keep": "true" }`).

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

Only the whole reply, trimmed, equal to `DONE` (one trailing period allowed) counts, and only if the turn made no tool call. `Done`, `DONE, but…`, a question back, markdown, silence, a permission request and a failed turn are all "not done". The answer is read from the question's own turn: the last assistant message would credit an agent that said nothing with whatever it said last time. A permission request or a timeout cancels the turn the janitor started. After a `DONE`, the tree is re-checked against fresh state before the archive, so an agent someone prompted in the meantime is left alone.

The question turn is quiet (`AgentManager.markQuietTurn`): its finish raises no `finished` flag, sends no push and does not refresh the title. An error on it still flags.

Asking costs a turn, and resuming a closed agent re-reads its whole context at cache-cold prices. So the janitor asks only agents that passed every check, one per sweep by default, most reclaimable disk first, and each at most once per quiet period: the answer is itself activity. Each consecutive "not done" doubles the wait before the next question, up to 8×. The backoff lives in memory; a restart resets it, never the quiet period.

An agent that cannot be asked is left and reported as `cannot-ask`: no provider session to resume, a provider that reports itself unavailable, a usage window at 100%, a usage source in error (how a logged-out account shows), or any agent on the account with a limit-shaped error. Asking one would fail its turn and flag it, noise the janitor would have made itself.

## Reclaiming the worktree

Only after the agent is archived, through archive-by-scope, and only when all of these hold. Otherwise the workspace is kept and the reason reported:

- It is a `worktree` workspace marked Paseo-owned, and its directory is inside the Paseo worktrees root. A `local_checkout` or `directory` workspace is never a candidate.
- It overlaps neither its primary checkout nor any other active workspace's directory.
- No unarchived agent belongs to it or runs anywhere under it. No terminal is open in it.
- It passes the git gate (`done-janitor-worktree.ts`), which refuses on any git failure:
  - the directory is the root of a **linked** worktree — its git dir differs from the common dir, so a primary checkout is refused wherever it lives;
  - it is not locked with `git worktree lock`, and no merge, rebase, cherry-pick, revert or bisect is half done;
  - `git status --untracked-files=all` is empty. Ignored files do not count: they are the build output being reclaimed;
  - every commit reachable from HEAD is reachable from a remote-tracking ref or the local base branch recorded at creation. Both survive the deletion. Another local branch does not count: it may be the next worktree the janitor deletes. A squash-merged branch whose remote branch was deleted fails this check and is kept.

A workspace whose agents were all archived earlier — by a person, or by a sweep whose reclaim failed — is reclaimed on the same terms once it has been quiet for `quietHours`, without asking anyone. A workspace that never had an agent is never touched: it may be one someone created a minute ago.

The size is sampled with `du` immediately before the deletion.

## What you see

Each report line is logged to `daemon.log` when it changes, never every sweep. Grep for `Done janitor`. A dry run logs lines like:

```
{"action":"would-ask","agentId":"a1…","title":"Build the feature","workspaceId":"ws-1","reason":"every mechanical check passed; quiet for 4d","dryRun":true,"msg":"Done janitor (dry run)"}
{"action":"would-archive","agentId":"a1…","reason":"if it answers DONE (with 2 subagent(s) by cascade)","dryRun":true,…}
{"action":"would-delete","workspaceId":"ws-1","path":"~/.paseo/worktrees/…/feature","reason":"clean tree and branch feature is merged or pushed","dryRun":true,…}
{"action":"kept-workspace","workspaceId":"ws-2","path":"…","reason":"feature-2 has 3 commit(s) neither merged into main nor pushed to any remote","dryRun":true,…}
{"action":"cannot-ask","agentId":"b2…","reason":"account claude-b is at its usage cap","dryRun":true,…}
```

`not-done` lines are not logged; `tick()` returns them in its report. A live sweep that archived or deleted something sends one push — "Archived 1 finished agent and deleted 1 worktree, freeing 2.9 GB. Kept …: …" — and a sweep that only checked sends nothing.

## Not automated

- **Squash-merged branches whose remote branch is gone.** Their commits are unreachable from anything that survives, so they are kept and reported; delete them by hand after checking.
- **Ignored files.** Treated as build output. A worktree holding the only copy of a file matched by `.gitignore` loses it.
- **Background shells and `Monitor` watches inside a Claude process.** The daemon cannot see them. The quiet period and the question are the only defence: an agent waiting on one should answer `NOT_DONE`.
- **Subagents on their own.** A subagent is archived with its root. One in another workspace, or open in a tab, is detached instead ([agent-lifecycle.md](agent-lifecycle.md#relationships)), becomes a root, and is asked on its own later.
- **Agents with no workspace, or whose workspace is not a worktree.** Archived, never reclaimed.
