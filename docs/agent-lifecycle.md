# Agent lifecycle

How an agent is created, runs, becomes a subagent, gets archived, and disappears from the UI. The model spans the daemon (lifecycle, archive) and the client (tabs, the subagents track).

## States

```
initializing → idle → running → idle (or error → closed)
                 ↑        │
                 └────────┘  (agent completes a turn, awaits next prompt)
```

Each live agent in `AgentManager` carries a `lastStatus` of `initializing`, `idle`, `running`, or `error`. `closed` is the persisted, resumable state for an agent record that has no live provider runtime. State transitions persist to disk and stream to subscribed clients via WebSocket.

## Runtime residency

An unarchived agent may be `closed` without being deleted or archived. Closing releases its provider
processes and subscriptions while retaining its Paseo identity, persistence handle, timeline,
workspace, labels, title, usage, attention, timestamps, and parent relationship. Opening or prompting
the agent runs through `ensureAgentLoaded()`, which resumes the durable provider session under the
same Paseo agent ID. Provider history is not appended again when the canonical timeline is already
primed.

Reload releases the old runtime before resuming its durable session: an idle provider process can
still own an exclusive writer. A close failure retains that runtime for cleanup and blocks the
replacement. Once closure succeeds, a failed resume leaves the durable agent closed and retryable.

Idle agents remain resident indefinitely. Runtime closure happens only through an explicit lifecycle
action such as archive, replacement, reload, workspace teardown, or daemon shutdown.
An agent that daemon shutdown (or a crash) closed mid-turn keeps an open run marker on its record,
and [restart recovery](restart-recovery.md) finds it on the next boot.

A provider runtime can still die on its own — crash, OOM kill, host suspend. Work the agent parked
inside that process dies with it: Claude Code's background Bash shells, `Monitor` watches, and
workflows all live in the CLI process, and the completion notification that would have woken the
agent never arrives. A runtime that dies mid-turn is reported by whatever is draining its stream, but
between turns nothing is watching, so the agent sits at `idle` looking healthy while its background
work is gone. Report that exit as a turn failure so the agent lands in `error` with a timeline entry.
Only the Claude provider does this today; the others still report a death only when a turn happens to
be in flight.

### Cancellation

Provider interruption is idempotent at the `AgentSession` boundary. It resolves when the prior
foreground turn can no longer run, including when the provider reports that it is already idle. It
rejects only when the provider may still own the turn. Provider adapters translate native errors
into that contract; lifecycle callers do not interpret provider-specific errors.

After an acknowledged interrupt, the manager settles the captured run even when no terminal event
arrives or the run was still waiting for its provider turn id. The captured run token prevents an
older cancellation from settling a newer turn. If interruption is rejected or times out, the agent
keeps its active foreground turn and replacement, reload, rewind, and Stop report the failure.
Accepting new work after an ambiguous interruption would create a split-brain session.

## Relationships

Agents can launch other agents via the agent-scoped `create_agent` MCP tool. Agent-scoped creation is always asynchronous and always stamps `paseo.parent-agent-id`, pointing back at the caller. Omit `workspaceId` to use the caller's workspace, or pass an existing workspace ID returned by `create_workspace`. Placement never changes parentage.

- **Subagents** — exist as part of the creating agent's work, appear in that agent's subagent track, and are archived with it.
- **Detached agents** — stand on their own after an explicit detach transition, do not appear in the former parent's subagent track, and are not archived with it.

Parent archive detaches a subagent instead of archiving it when either condition holds:

- The child belongs to another workspace.
- The child is currently open in an agent tab.

All other children archive with the parent. After the workspace layout hydrates, the client marks
every managed subagent present in its tabs with `paseo.open-agent-tab.<client-id>=true` through the
generic agent metadata update. This includes background and restored tabs; navigation does not own
the marker. Closing a tab sets that client's label to `false`. Any `true` client label keeps the child
open. Detach clears the parent and every open-tab label. The surviving child therefore becomes a
normal root agent immediately, and closing its still-open tab archives it.

Runtime ownership is resolved from explicit workspace ID and caller context, never from `cwd`. Workspace creation is a separate operation with `local | worktree` isolation; agent creation only selects an existing workspace.

Users can also detach an existing subagent from the subagents track. Detach is deliberately a manual lifecycle gesture, not an agent-facing MCP tool. It removes the parent and open-tab lifecycle labels: it does not stop, archive, move, or restart the agent. The agent keeps its current `cwd` and `workspaceId`, leaves the former parent's track, and behaves like a root agent for tab close, workspace activity, and future parent archive.

`notifyOnFinish` defaults to `true` for agent-scoped creation and background prompt follow-ups because most delegated work needs to report back to the creating agent. Set it to `false` only for truly fire-and-forget agents or prompts.
Permission requests are notification checkpoints, not the end of that subscription. The caller is notified again after a permission response when the child finishes, errors, or requests another permission.
The permission notification includes the normalized request plus the child and request IDs, so the caller can inspect it and respond without fetching agent status.
A watched child that closes before its finish event also notifies the caller so delegated work cannot disappear silently during archive or workspace teardown. A daemon shutdown is not such a close: the report stays owed on the child's record, and the restarted daemon delivers it. [finish-reports.md](finish-reports.md) covers the durable ledger, its retry and escalation ladder, and how the report follows a successor.

## Provider-managed child agents

Some providers can create their own child sessions inside one provider runtime. OMP's task tool reports these with `child_session` events; `AgentManager` imports the live provider handle, stamps `paseo.parent-agent-id`, and surfaces the result as a normal subagent in the parent's subagents track.

The provider still owns the underlying runtime. Paseo keeps an agent record so the child can be opened, tracked, archived, and cascaded with the parent, but prompts and history hydration route through the provider adapter for that native child handle.

## Archive

Archive is a **soft delete**: the agent record stays on disk with `archivedAt` set, the runtime is closed, and the agent disappears from active lists. Archive is **global** — it lives on the server and propagates to every connected client.

Archive sets `archivedAt`, invokes the provider's native archive hook, and cascades to managed
children.

`create_agent_request` can opt an agent into `autoArchive`. In that mode the daemon archives the agent after the first terminal turn event (`turn_completed`, `turn_failed`, or `turn_canceled`). When the agent owns an isolated workspace, auto-archive archives that workspace too; the managed worktree is removed when its final workspace reference is gone.

Archiving runs through `AgentManager.archiveAgent` (`packages/server/src/server/agent/agent-manager.ts`):

1. Snapshot the current session into the registry
2. Set `archivedAt` and normalize `lastStatus` away from `running`/`initializing`
3. Notify subscribers
4. Close the runtime (kills the process if still running)
5. **Resolve children** — detach cross-workspace and open-tab children; cascade-archive the rest recursively

Cascade is what keeps subagent fleets from outliving their orchestrator.

Workspace archive is a separate lifecycle: archiving an agent never archives its workspace, so a
finished agent's worktree stays on disk until someone archives the workspace. The opt-in
[done janitor](done-janitor.md) archives dead unpinned agents and agents that say they are done,
and deletes the worktrees of work it can prove is saved. Archiving or removing a worktree can close a surviving
agent record without setting the agent's `archivedAt`, while its `workspaceId` still points at the
archived workspace. History navigation must not infer workspace lifecycle from `agent.archivedAt`
or mutate either lifecycle. The workspace route asks the daemon for authoritative recovery state;
only the route's explicit Unarchive or Restore action changes the archived workspace.

History navigation preserves the selected agent as an explicit recovery target. If both that agent
and its workspace are archived, the workspace recovery action restores the workspace and unarchives
the selected agent as one user action. Other archived agents in the restored workspace remain
recoverable from History. Opening one pins its tab and renders the archived-agent callout. Authoritative
timeline catch-up may load provider history with a runtime-only `history` resume purpose, which must
leave both Paseo's `archivedAt` and the provider's native archive state unchanged. **Unarchive** remains
the only transition back to an interactive runtime: it runs the provider's native unarchive hook
(including Codex `thread/unarchive`) before the normal agent resume and timeline hydration flow. A
provider session can be archived outside Paseo while its Paseo agent remains active. Interactive
resume repairs that drift through the provider's native unarchive hook; history resume does not.

Provider session connection owns every process it spawns until the session is registered with
`AgentManager`. If initialization, persisted-session resume, or initial history hydration fails,
`connect()` must dispose that process before rethrowing; the manager cannot clean up a session it never
received.

## Tabs vs archive

These are two distinct concepts that used to be conflated:

| Concept                    | Scope      | Triggers                   |
| -------------------------- | ---------- | -------------------------- |
| **Tab** (workspace layout) | Per-client | User opens/closes a view   |
| **Archive** (lifecycle)    | Global     | Explicit lifecycle gesture |

Closing a tab on a **root agent** still archives — the tab is the agent's home, so closing it means "I'm done with this agent." A confirm dialog protects against archiving a running agent by accident.

Closing a tab on a **subagent** (any agent with `parentAgentId`) is **layout-only**. The app clears the current client's open-tab label before removing the tab. Another client's open tab remains protected. The agent stays unarchived and stays in its parent's track, so a later parent archive cascades to it when no client still has it open. The user can re-open the tab from the track at any time. Single and bulk tab close apply the same policy.

The asymmetry is intentional: a subagent's persistent relationship lives in the parent's track. Same-workspace subagents are not auto-opened as tabs; the user opens one from that track when needed. A cross-workspace subagent is also auto-opened as a tab in its own workspace so opening that workspace does not appear empty. It remains in the parent's track until it is actually detached.

## Workspace activity

Agent lifecycle status stays literal: a parent agent is `idle` when its own turn is idle, even if a child is running.

Workspace status is an aggregate activity signal computed **per `workspaceId`**. Ownership is never derived from `cwd` — many workspaces may share one directory, and same-`cwd` siblings do not clump under one status. Root agents and cross-workspace subagents contribute their normal state bucket to their own workspace. Same-workspace descendants contribute `running` to the nearest ancestor in that workspace; their non-running attention, permission, and error states stay in the parent's subagents track. This makes a cross-workspace subagent behave like a detached agent for workspace visibility and status without removing its parent relationship.

Running provider-native subagents contribute `running` to the workspace owned by their parent agent. Their completed, failed, and canceled states stay in the parent's subagents track.

A finished workspace can be marked unread after it has been reviewed. The daemon restores
`finished` attention on its newest eligible workspace-root agent without sending a new completion
notification. Opening the workspace clears that attention through the normal focus flow.

## Attention

`requiresAttention` is an **unread** signal, not a state: `checkAndSetAttention` sets it on an
edge (`running` → `idle` is `finished`, anything → `error` is `error`, a permission request is
`permission`) and it stays until something reads it. Two things clear it — opening the agent, and
archiving it. Closing does not: `closeAllAgents` runs on every shutdown, so clearing there would
wipe every genuine unread finish each time the daemon restarts.

**A delegated agent's finish never raises attention.** Its parent already has the result in-band,
through the tool call that spawned it; `broadcastAgentAttention` has skipped delegated agents
since #1293, so the flag was never surfaced either. What it did do was accumulate: nothing clears
it, because a human does not open a subagent to read it. Measured on one daemon, 34 of 50
unarchived agents were flagged, 27 of them finished subagents and the oldest three weeks old — a
signal on two thirds of the fleet separates nothing. The rule is applied when the flag is set and
again when a stored record is projected (`agent-projections.ts`), so records written before it
stop badging without a migration. An **error** on a delegated agent still flags: a subagent that
failed is not the normal case.

A **permission** is the exception to the delegated rule. A finished subagent is fine unheard —
its parent has the result in-band. A blocked one produces nothing at all: it does not run, and
if its parent is waiting on it, the parent waits forever. So a delegated agent's permission
request escalates to a person, but only when nothing else can answer it. `AgentManager` tracks
which children have a live notify-on-finish observer (`noteFinishObserver`, set by
`setupFinishNotification`); while one exists, the request goes to the caller, which answers with
`respond_to_permission`, and no push is sent. With none — after a daemon restart, until the
child runs again and its watcher is re-attached, with `notifyOnFinish: false`, or once an archived
caller releases its own observer — the push is the only way anyone learns.

Most subagents run `bypassPermissions` and never prompt: 27 of 28 live delegated agents on one
machine, and 844 of 1007 across its history. The other 163 ran in `auto`, `acceptEdits`, `plan`
or `default`, any of which can block. Rare, but the failure is a permanent hang rather than a
delay, and nothing times a pending permission out.

The flag is also what stops a push repeating. `checkAndSetAttention` returns early when the agent
is already flagged, so an unread agent cannot notify twice — which means a stale flag suppresses
notifications rather than causing them. The noise a stale flag causes is in the UI.

## Activity summary

`lastActivitySummary` is the one-line "what is this agent doing" the subagents track shows as a
row's subtitle. It is computed from each discrete timeline item as it arrives and **is never
persisted**, deliberately: it changes on every tool call, so writing it would mean an agent
snapshot per tool call across the whole fleet. `assistant_message` and `reasoning` are excluded
because the stream coalescer emits them as ~60ms fragments.

It does not need persisting, because it is recoverable. Loading an agent already replays the
provider's own transcript into the in-memory timeline (`hydrateTimelineFromProvider`), and that
replay goes through `recordTimeline` rather than the live path that computes the summary — which
is the whole reason it came back blank. `recoverActivitySummary` walks the replayed rows
backwards for the newest summarizable item, applying the same exclusions the live path applies so
a restart reproduces the value rather than a different-looking one. No read and no write of its
own; the rows are already in memory.

There is no durable timeline store in production — `durableTimelineStore` is wired only in a
test — so the provider transcript is the only copy of these items, and it is the one being read.

An agent whose transcript holds nothing summarizable (only assistant prose) recovers nothing.
That is a true answer, not a gap: the live path would not have shown a subtitle for it either.

## Title tracking

Two trackers keep names current at two altitudes: an agent's title says what that session is
doing, and a workspace's name says what the workspace is about. The workspace one is built on
top of the agent one — it reads agent titles rather than timelines — so read this section in
order.

### Agent titles

An agent's title refreshes from two triggers: a turn finishing (`running` -> `idle`), and a periodic sweep every 60 seconds over every non-internal, non-archived agent that is `running` or `idle`. Both routes call an LLM through the same fingerprint — a hash of the agent's newest user message and a digest of its recent activity — so an unchanged agent never costs a second call. The sweep additionally waits at least `agents.metadataGeneration.titleTracking.refreshIntervalMinutes` (default 10) since it last considered an agent before looking at it again. An idle agent costs nothing after its first refresh. An agent that keeps running has new activity at every checkpoint, so it costs one small call per interval for as long as it runs; raise the interval if that adds up across a large fleet. A title the user set explicitly (`titleManuallySet`) is never touched by either trigger. See `agent-title-tracker.ts`.

### Workspace names

A workspace is named once, when its first agent is created, from that agent's opening prompt
(`workspace-auto-name.ts`). That is right for a worktree cut for one task and wrong for a
long-lived checkout, which goes on hosting unrelated work for months under the name of whatever
was asked first. `WorkspaceTitleTracker` is the same machine as the agent tracker one level up:
a 60-second sweep, a changed-fingerprint gate, the same structured-generation fallback. It
defaults **on**.

**What it reads.** A workspace is described by its recent agents — the four most recently active,
newest first — and each one contributes its title and its current activity summary. Agent titles
are the unit deliberately: the agent tracker already keeps them describing what a session is
doing now, so the workspace tracker gets a curated summary for free instead of re-reading four
timelines. Membership is `workspaceId` only; an agent created before ownership stamping has none
and never names a workspace.

**What makes a rename worth doing.** The fingerprint covers the workspace's current name plus its
recent agents' ids and titles — **not** their activity summaries, which change on every tool call.
An agent's title only moves when that session's own work materially moves on, so the workspace
only costs a call when something at the workspace's altitude changed. The prompt then asks for the
durable subject and to keep the current name through continuations and refinements. Between the
default 30-minute interval and that instruction, a name changes a few times a day in a busy
workspace, not every few minutes.

**Provenance decides scope, not workspace kind.** `titleSource` on the workspace record is `"auto"`
when Paseo generated the name and `"manual"` when a person or an agent chose it — through the
rename field or `rename_workspace`. Only `"auto"` is eligible. **Absent means hand-set**: every
record written before provenance existed reads as manual, because silently renaming something the
user named is worse than leaving a stale name. A workspace created without a name carries no
provenance at all — "nobody named this" and "Paseo owns naming this" are different states.
Renaming a workspace to **empty** produces the second, and is how an existing workspace hands
naming back to Paseo: the row falls back to the branch or directory name the rename field shows
as its placeholder, and the tracker names it from there. Provenance is re-read inside the registry write, so a rename that lands
while the LLM is running wins.

**Cost.** A refresh is one small structured call: about 700 input tokens and 20 output — under a
tenth of a cent on Haiku. Two gates keep the count down. A workspace with no running-or-idle agent
active inside `activityWindowMinutes` (default 60) is never swept, so a dormant checkout costs
nothing and keeps the name of what last happened in it, which is the true answer. And the
fingerprint means an active workspace whose agents are still on the same work costs nothing
either. Across a fleet of ~120 workspaces with ~20 active on a given day, expect a few hundred
calls — well under a dollar a day. The ceiling, every eligible workspace changing subject at every
interval around the clock, is 48 calls per workspace per day.

Config sits beside the agent title settings; every key is optional and absent means the default.

| Key                                                        | Default | What it paces                                                    |
| ---------------------------------------------------------- | ------- | ---------------------------------------------------------------- |
| `agents.metadataGeneration.workspaceTitleTracking.enabled` | `true`  | Turns the sweep off entirely                                     |
| `...workspaceTitleTracking.refreshIntervalMinutes`         | `30`    | Minimum wait before a workspace is reconsidered                  |
| `...workspaceTitleTracking.activityWindowMinutes`          | `60`    | How recently an agent must have acted for its workspace to count |

See `workspace-title-tracker.ts`.

## The subagents track

The track is a pill at the foot of an agent's pane (`packages/app/src/subagents/track.tsx`): a count you can read at a glance, and a panel behind it — a popover on wide screens, a sheet on compact ones — holding the rows. It floats over the transcript rather than sitting in a band above the composer, so the timeline scrolls underneath it; `packages/app/src/panels/agent-tracks.tsx` owns that placement, and the pill frame is shared with the task list in `packages/app/src/composer/tracks.tsx`.

The rows combine two kinds of children:

- **Paseo subagents** are full managed agents. Their membership rule (`packages/app/src/subagents/select.ts`) is:

```
parentAgentId === thisAgent.id  AND  !archivedAt
```

- **Provider subagents** are child executions owned by Claude, Codex, or OpenCode. They are not inserted into `AgentManager` as managed agents. Providers emit a separate descriptor and timeline stream through `agent.provider_subagents.*`; the client keeps that state outside the normal agent store and merges only the presentation rows into the track. A descriptor's optional `parentSubagentId` identifies its direct provider-subagent parent; an absent value identifies a direct child of the managed agent.

Clicking either kind opens a workspace tab. A Paseo subagent tab is a normal interactive agent pane. A provider subagent tab is a read-only timeline pane with no composer, archive, detach, rewind, or fork actions. It shows its own direct children in a subagents track. Both panes use `AgentStreamView`, so message, reasoning, tool-call, and layout rendering stay identical.

Provider timelines use the same structural timeline item format but deliberately have a separate lifecycle and transport. A provider thread/session identifier is not a Paseo agent identifier, and closing its tab is always layout-only.

Provider descriptors may include one compact subtitle. The provider owns its contents and formatting; clients display and truncate it without interpreting provider-specific model, thinking, or usage fields.

### Claude provider subagents: the task protocol

Claude Code announces subagent lifecycle on the SDK stream (`task_started` / `task_updated` / `task_notification` / `task_progress`), and Paseo reads those announcements rather than reconstructing them from sidechain frames. The live source (`subagents/live-source.ts`) and the replay source (`subagents/replay-source.ts`) both translate into one observation vocabulary (`subagents/observation.ts`), so a fact is derived once for both paths instead of once per path. Gotchas that are not obvious from the SDK types:

- **Not every announced task belongs in the track.** Task subagents announce as `local_agent` and workflows as `local_workflow`; a backgrounded shell announces as `local_bash` with the same `tool_use_id` shape, and ambient housekeeping sets `skip_transcript`. The Claude provider normalizes a workflow to a generic provider-subagent descriptor titled `Workflow`, using Claude's summary as its description and timeline opener. Shared storage, protocol, and UI do not distinguish it from another provider subagent.
- **A task that was never declared gets no descriptor, by any route.** Filtered tasks still emit `task_notification`s carrying a `tool_use_id`, and still emit frames carrying `parent_tool_use_id`. Attributing either produces a descriptor with no identity and a defaulted `running` status — a nameless row that never finishes. Status, presentation updates, and sidechain frames all route through the declaration table.
- **Task ids are session-scoped, not turn-scoped.** Cancelling a turn must not clear the routing table: a backgrounded child settles after the interrupt and needs its descriptor to still exist. Cancellation instead terminalizes the declared children that were running in the foreground, and a later `task_notification` is free to correct that guess. Backgrounded children are identified by `task_updated.patch.is_backgrounded`.
- **A resumed task can be announced again with a new `tool_use_id`.** The first Task tool id remains the canonical descriptor and later ids are routing aliases for the same session-scoped task. The resumed prompt is added to that child timeline.
- **Effort is only reachable through hooks.** It appears nowhere on the message stream at any depth, and the level Paseo requests is not necessarily the level that runs — a model that does not support it is silently downgraded. A hook firing inside a subagent reports the active post-downgrade level next to its `agent_id`, which is the same id `task_started` calls `task_id`.
- **Backgrounded subagents emit no frames carrying `parent_tool_use_id` at all.** Everything keyed off that field sees nothing for one; they are visible only because the task protocol announces them.
- **Nested ownership comes from the launching sidechain, not `spawn_depth` alone.** A sidechain's Agent or Bash tool call records the direct owner of that `tool_use_id`; the following `task_started` inherits it. This routes a grandchild descriptor and child-owned background notifications without relying on labels or flattening them into the managed parent.
- **On replay, `<session>/subagents/` holds every descendant beside the root.** Resolve the tree one proven generation at a time: the root transcript admits direct children, then each admitted sidechain transcript admits its children by `toolUseId`. `spawnDepth` orders candidates but does not establish ownership. Unresolved sidecars remain excluded as ambient or unrelated work.
- **Replay `totalTokens` is a context-size reading, not cumulative spend.** Claude Code finalizes a subagent by summing the _last_ assistant message's usage block and shipping that as `usage.total_tokens`. Summing per-entry usage instead multiplies the cached prefix by the turn count and reports a number several times larger than the live path.

Archived Paseo subagents disappear from the track, by design. To remove one from the track without closing its tab, use the **archive button** on the row — it opens a confirm dialog and archives the subagent on confirm. Provider-owned rows have no individual Paseo lifecycle controls.

The **Archive finished** row at the foot of the panel covers every finished row. It archives idle or errored managed Paseo subagents one at a time, and hides completed, failed, or canceled provider-owned rows in the current app session. Native sessions and timelines are untouched. Running and initializing children remain in the track. If a hidden provider child starts running again, the app brings it back to the track.

To keep the agent alive but remove it from the parent's track, use **detach**. The daemon clears the relationship lifecycle labels, emits the normal agent update, and every client reclassifies the agent from subagent to root/sibling from that updated snapshot.

## Why this shape

The decision was to **decouple "close tab" from "archive" only for subagents**, rather than universally:

- **Closing a tab on a root agent still archives** — preserves the existing UX users are trained on
- **Closing a tab on a subagent is layout-only** — fixes the lossy "click to read, close to dismiss view, lose the row" flow
- **Archive button on track rows** — gives subagents an explicit lifecycle gesture in their home surface
- **Detach button on track rows** — lets a subagent continue independently without killing its work
- **Cascade archive on parent** — keeps subagents from leaking when the parent is archived

We considered universal decoupling (no tab close ever archives, archive is always explicit) but rejected it: it changes a behavior root-agent users rely on.

## Limitations

### Subagent accumulation under long-lived parents

A parent that spawns many subagents will see the panel's list grow; the pill only counts them. Managed Paseo subagents can be archived individually or with **Archive finished**. That action hides finished provider-owned rows locally; this presentation state resets when the app restarts.

### Cross-client tab dismissal

Closing a subagent's tab on one client doesn't affect other clients' layouts. This is the expected behavior of decoupled tabs and is consistent with how layouts have always worked. Archive remains the global gesture for cross-client cleanup.

## Storage

```
$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json
```

`{cwd-with-dashes}` is derived from the agent's filesystem `cwd`. It is not the workspace id; agent storage stays cwd-keyed while workspace identity is the opaque workspace id.

Each agent is a single JSON file. Fields relevant to this doc:

| Field                                        | Type          | Meaning                                                                            |
| -------------------------------------------- | ------------- | ---------------------------------------------------------------------------------- |
| `id`                                         | `string`      | Stable identifier                                                                  |
| `archivedAt`                                 | `string?`     | Soft-delete timestamp (ISO 8601)                                                   |
| `labels["paseo.parent-agent-id"]`            | `string?`     | Parent agent ID, set automatically for agent-scoped creation and removed by detach |
| `labels["paseo.open-agent-tab.<client-id>"]` | `string?`     | `"true"` protects an open tab on that client; detach clears every matching label   |
| `lastStatus`                                 | `AgentStatus` | `initializing` / `idle` / `running` / `error` / `closed`                           |

See [`docs/data-model.md`](./data-model.md) for the full agent record.
