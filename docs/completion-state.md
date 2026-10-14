# Completion state

A session row can show a third signal besides question/working/idle: an agent's own claim that it
is ready to merge, or fully done. The claim lives in labels, so it needs no protocol change — every
client already reads an agent's labels off the snapshot.

## The two states

- `ready-to-merge`: the work is finished, every question is resolved, tests and CI are green, and
  a PR is open waiting only on the merge.
- `done`: all of that, plus the PR (or PRs) merged and any deploy done. Nothing is left; the
  session is ready to archive.

## The contract

Three labels, written and cleared together:

| Label                   | Value                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `paseo.completion`      | `"ready-to-merge"` or `"done"`. Absent means no claim.                                                               |
| `paseo.completion-note` | Optional, at most 200 characters. A one-line human summary, e.g. "PR #41 merged, deployed". Shown in the UI tooltip. |
| `paseo.completion-at`   | ISO timestamp, set with the state.                                                                                   |

An agent sets them by calling the `set_completion_state` MCP tool (`{ state, note?, agentId? }`).
With no `agentId` it targets the caller itself; a parent may target its own child the same way —
nobody else may. `state: "clear"` always succeeds, whatever the agent's current state, and removes
all three labels.

## Verification

`ready-to-merge` and `done` are refused — with a reason the agent can act on — when:

- the agent has a pending permission request or an unanswered `AskUserQuestion` (the same
  pending-permission mechanism; there is no separate "open question" signal);
- any descendant (child, grandchild, …) is still `running` or `initializing`;
- the agent's workspace is a git worktree whose work exists nowhere else — uncommitted changes, or
  commits reachable from no remote and no local base branch. This reuses the done janitor's
  worktree gate (`checkWorktreeDeletionSafety`, `packages/server/src/server/done-janitor-worktree.ts`)
  rather than a second one.

`done` additionally requires the branch be merged into its _remote_ base branch specifically —
`checkMergedIntoRemoteBase` in the same file, a sibling to the deletion-safety check, since "pushed
somewhere" is not "the PR merged".

When a check can't be run — no workspace record, a non-worktree workspace (`local_checkout` or
`directory`), or no remote holds the recorded base branch — the call is allowed through rather than
refused, and the response names why.

## Auto-clear

The three labels clear the moment the agent receives a new, non-system-injected `user_message` —
a real prompt, not a heartbeat, a finish report, or the done janitor's own "are you done" question
(`isSystemInjectedEnvelope`, `packages/server/src/server/agent/agent-prompt.ts`). New work means the
claim is no longer current; the agent sets it again when it finishes again.

## How agents are told

Agents are told about the tool through `daemon.appendSystemPrompt` text named
`COMPLETION STATE (Bozeo)` — not checked into this repo. The account-pool plugin's leader policy
notice (`plugins/claude-account-pool/server/compound-policy.ts`) carries a one-line pointer to it.
