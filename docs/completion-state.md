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
somewhere" is not "the PR merged". Ancestor reachability (`git rev-list --count`) is the fast path,
but it is blind to the default GitHub/Gitea "squash and merge" and to a "rebase and merge": both
land the branch's net changes on the base in a commit that is never a descendant of the branch's
own commits, so reachability never reads it as merged. When reachability fails,
`isContentMergedIntoRemoteBase` falls back to a content check: `git merge-tree --write-tree
<remoteBase> HEAD` with no conflict, whose result tree equals `<remoteBase>^{tree}` — i.e. merging
the branch into the base would change nothing, because the base already has it. This never fetches
(below); a refusal from this path says so and tells the agent to `git fetch` and retry.

When a check can't be run — no workspace record, a non-worktree workspace (`local_checkout` or
`directory`), or no remote holds the recorded base branch — the call is allowed through rather than
refused, and the response names why.

## Auto-clear

The three labels clear at the moment a non-system-injected prompt is actually dispatched to the
agent — `sendPromptToAgent` and `deliverQueuedPrompt` in
`packages/server/src/server/agent/agent-prompt.ts`, which cover every surface that sends a prompt
(Session/WS, MCP, CLI-through-MCP) and a prompt that was queued behind a busy turn and is now being
drained and delivered. A system-injected envelope (`isSystemInjectedEnvelope`) — a heartbeat, a
finish report, the done janitor's own "are you done" question — never clears it.

`startAgentRun` clears before it returns for an out-of-band command, so a slash command a provider
handles without starting a turn clears the state too: OMP's `/steer` and `/follow-up` deliver a
message that way. `/compact`, `/autocompact`, `/handoff` and `/goal` clear it as well, as they do on
a provider that has no out-of-band handler and treats them as ordinary prompts. The out-of-band
command is accepted first, so a prompt that fails there leaves the state alone.

This is deliberately not a stream/timeline check. A live `user_message` timeline event is not proof
of new work: Claude Code's session-resume replay (what a daemon restart does to resume a session)
pushes the agent's entire prior transcript back through the same live stream path, untagged, so a
clear keyed off that event would wipe the state off every idle, "done" agent a restart resumes. The
explicit history-hydration path (`hydrateTimelineFromLegacyProviderHistory`, `fromHistory`) was
already excluded before this, but the SDK's own resume replay was not — moving the clear to dispatch
time removes the stream as a trigger entirely, closing both.

## How agents are told

Agents are told about the tool through `daemon.appendSystemPrompt` text named
`COMPLETION STATE (Bozeo)` — not checked into this repo. The account-pool plugin's leader policy
notice (`plugins/claude-account-pool/server/compound-policy.ts`) carries a one-line pointer to it.
