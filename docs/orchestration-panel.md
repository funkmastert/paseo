# Orchestration panel

Agent trees on a host, spanning workspaces, with the per-account budget strip above them.
`packages/app/src/panels/orchestration-panel.tsx` is the shell; `packages/app/src/orchestration/`
holds the row, the tree selector, and the models.

It answers four questions at a glance — which agents are alive, what each is doing now, which are
stuck or waiting, what they are costing. A real fleet is 50-odd agents of which a handful are
running, and only a fraction of those are in the tree you are working in. Every rule below exists
to keep those four answers legible against that ratio.

## Scope

Two tabs, not one tab with a mode.

| Target                                    | Shows                  | Opened from                 |
| ----------------------------------------- | ---------------------- | --------------------------- |
| `{ kind: "orchestration", scopeAgentId }` | one tree               | the composer track-bar pill |
| `{ kind: "orchestration" }`               | every tree on the host | the Command Center          |

`scopeAgentId` is the agent whose session opened the tab, not necessarily the leader:
`orchestration-scope.ts` walks it to the root of its tree, so opening from a leader and from any
of its subagents land on the same tab. The walk is over the assembled tree rather than over
`parentAgentId` hops, because the tree already decides who counts as a root — an agent whose
parent is archived, pending-archive, or on another server is one — and already refuses to follow a
cyclic snapshot.

A scoped tree that no longer exists renders as "this tree is gone", never as the whole fleet and
never as "no agents". A scoped tab also badges for its own tree only.

They are separate tab identities so a split can hold both. The header's segmented control switches
by retargeting the current tab; a tab that moves to host-wide records the leader it came from in
tab state, which survives a same-kind retarget, so the control works in both directions.

**The global view is not a route.** Route ownership is the fragile part of this app — see
[expo-router.md](expo-router.md) — and nothing about "all agents" needs one. The tree already spans
workspaces from inside a workspace tab, and the panel depends on its pane context to open an agent
beside itself; a host route would duplicate that plumbing and buy a startup-restore question for
nothing.

The pill shows for any agent that is part of a tree, which includes one that only has a parent. A
leaf subagent is a session like any other, and without that the only way into your own tree from
inside it is the host-wide tab.

A phone has no Command Center, so the pill is its only way in, and the host-wide view is the
"All agents" segment of a tab that pill opened. A phone whose open workspace has no agent in a tree
has no way to reach the panel.

## What the default view shows

Archiving is the only thing that removes a row and nobody archives, so an unfiltered panel is a
log of every agent the machine has run this week. Measured on one daemon: 39 unarchived agents, 1
running, 22 idle, 16 closed, the oldest six weeks old.

A row is in the default view when any of these holds (`orchestration-visibility.ts`):

- it moved inside `ORCHESTRATION_RECENT_WINDOW_MS` — six hours, one working session;
- it is **alive** (`running`, `initializing`), **blocked** (a pending permission), **failed**
  (`error` status or attention), **over budget** (`tokenBurnAlert`), or **owes its parent a
  report** (`owedFinishReport`, [finish-reports.md](finish-reports.md#what-the-panel-shows)) — at
  any age;
- it is an ancestor of a row that is kept, or it is the agent the tab is scoped to.

Ancestors are kept so a running subagent never renders at a depth with nothing above it, and so
`depth` stays correct without renumbering.

Unread **finished** attention deliberately does not pin a row. It is set on every finish and only
a human opening the agent clears it, so a third of a fleet carries it indefinitely
([agent-lifecycle.md](agent-lifecycle.md#attention)) — the row declines to badge it for the same
reason.

Nothing is hidden silently. The header carries the count and the control that shows them, and an
empty list says whether it is empty because of the window or because there are no agents.

**Archive finished acts on the whole tree, not the visible rows.** Hiding a row is a reading
decision; archiving is a lifecycle one, and the backlog you want gone is mostly what the window
already dropped.

The cutoff is re-evaluated on the shared half-hourly tick, not only when an agent moves
(`use-orchestration-visible-rows.ts`). A fleet that goes quiet sends no updates, and a filter
frozen at the last update is the freshness problem below in a new costume.

## Budget strip

One entry per account in the daemon's account pool, not per provider that has agents in the tree.
A strip built from the tree drops the account nobody is using right now, which is the one whose
headroom decides where the next agent goes.

The pool is `providers.<id>.params.accountPool` (`{ role, priority }`) in the daemon config the app
already holds through `useDaemonConfig`, so it needs no wire field and follows a config change on the
`daemon_config_changed` push. The leader is the leader, the lowest-priority worker is the primary,
and every worker after it is a backup. The role badge comes from that config and never from the
account's label. A host with no pool shows the tree's providers only, as it did before.

- **A pool member always gets a row.** One the usage endpoint has no reading for renders as
  unavailable rather than disappearing. Providers outside the pool still show only while they have
  agents in the tree.
- **Each row says how many leaders and workers are on the account.** A worker counts while it is
  running or initializing. A leader counts when it is alive itself or has a live agent below it: it
  sits idle between turns while its workers run, and an account reading "Not in use" during exactly
  the work it is orchestrating is wrong. The count is fleet-wide, so a tab scoped to one tree still
  shows what the whole host is drawing. The row keeps its line when the count is zero ("Not in
  use") so a first agent arriving does not move the bars.
- **On a phone the strip collapses to one summary.** It names the fullest window across every
  account with its role, a meter, the reset, which accounts have agents on them, and the read time.
  Six full-width bars took most of a screen before the first agent row. A tap opens the rows.

## Freshness

Nothing in the panel is polled except the budget strip. Everything else is a replica of daemon
state, which means it keeps its last contents when updates stop rather than emptying — a
disconnected panel looks exactly like a connected one whose agents happen not to have moved.

| Field                               | Source                   | Refreshed by                              | Worst case                                                    |
| ----------------------------------- | ------------------------ | ----------------------------------------- | ------------------------------------------------------------- |
| status, title, attention, timestamp | agent directory replica  | `agent_update` push                       | Frozen at disconnect; the stale notice says so                |
| `lastActivitySummary`               | live-only daemon field   | `agent_update`, per timeline item         | Absent for the whole fleet after a daemon restart             |
| `recentTokenRate`                   | live-only daemon field   | `agent_update`, plus a client-side expiry | Ten minutes, then the badge drops                             |
| Budget strip windows                | `listProviderUsage` poll | 75s poll, focus, reconnect                | ~5 min (the daemon's own cache), and it carries its read time |
| Budget strip pool and roles         | daemon config            | `daemon_config_changed` push              | Frozen at disconnect, like the directory                      |

Three rules follow from that table.

**A surface that reads directory rows declares demand.** The daemon streams `agent_update` only to
a session that asked for it, and that ask is the directory demand described in
[architecture.md](architecture.md#packages). The panel holds its own
(`use-orchestration-directory-demand.ts`) rather than riding on whichever other screen happens to
be mounted — the sidebar's demand is released when its panel closes, and a reconnect with no holder
leaves the new session with no agent subscription at all.

**Live-only fields are not persisted and must not be shown as current when they cannot be.**
`lastActivitySummary` and `recentTokenRate` exist only on the running daemon. The summary keeps its
last value when an agent goes quiet, so a finished row showing it in a "doing now" column presents
hours-old work as current; the row shows it only while the agent is running. The token rate has an
explicit staleness window, which only expires if something re-evaluates it — see
`use-token-burn-tones.ts` for why a quiet fleet would otherwise keep its badges forever.

**A value that cannot be fresh says how old it is.** The budget strip carries the time it was read,
because usage is polled from a cached daemon endpoint and is never live. When the tree stops being
updated at all, the panel shows a stale notice with the time it stopped rather than presenting the
last known fleet as the current one.

## Rows

One line per agent on a wide layout and two on a compact one, at a fixed height either way,
whatever the agent is doing. A row that grows when its state changes reflows the list under the
reader (docs/design.md §11), so the variable content is chosen to fit rather than given more room.
The layout switches on `useIsCompactFormFactor()`.

- **Every row carries a status dot**, including finished ones (`showInactive`). Most of a fleet is
  finished; without it the leading rail collapses on most rows and the titles sit at two different
  left edges down the list.
- **Closed is not idle.** A closed agent has no runtime and must be resumed before it can do
  anything. Its title drops to `foregroundMuted` — it is context, not something being acted on.
- **Badges mark only what needs a decision** — needs input, failed. "Finished" is the ordinary end
  state of most of the fleet and the dot already carries it; a badge on thirty rows is not a signal.
- **The title has a minimum width.** A wide badge plus a timestamp could otherwise squeeze it out
  of its own row, leaving a row that says a lot about an agent you cannot identify.
- **The activity column is width-gated** at `ACTIVITY_COLUMN_MIN_WIDTH`. Below it a fourth flexible
  column truncates everything including the title, so a narrow pane shows title, state and time.
- **The phone row spends its second line instead.** The title alone has the first line. The second
  carries the badges, then the activity while the agent runs or its state in words otherwise, then
  the time. That line is always as tall as a badge, so a badge arriving does not change the row's
  height, and the whole row is at least 44pt to tap.
- **Archive and detach are not on the phone row.** Two small icons side by side under a thumb is how
  the wrong agent gets archived, and they cost the title its width. A long press opens a sheet with
  both (right-click does the same on web, where a long press does not open it).
- **The model is not on the row.** Fifty rows repeating one model name is not a signal, and it was
  what pushed the timestamp off the right edge of a narrow panel.

Roots are ordered by the most urgent state anywhere in their subtree
(`orchestration-ordering.ts`), then by age. Children keep creation order, so nesting still reads as
the order the work was handed out.

## Capturing it

`orchestration-row.browser.test.tsx` renders a fixture fleet — 53 agents, 4 running, 30 idle, 19
closed, modelled on a measured one — in a real browser and writes screenshots to `docs/assets/`:

| Capture                                | What it shows                                     |
| -------------------------------------- | ------------------------------------------------- |
| `orchestration-panel-fleet-*.png`      | every row, unfiltered — the shape the rules fight |
| `orchestration-panel-default.png`      | the host-wide default view with its hidden count  |
| `orchestration-panel-scoped.png`       | one tree, from a tab opened in a session          |
| `orchestration-panel-scoped-older.png` | the same tab with its older agents shown          |
| `orchestration-panel-compact.png`      | the phone row: title, then badges, activity, time |

Run it before and after a presentation change; the panel's problems only appear at that size, and
no daemon is reliably in that shape when you want to look at it.

```bash
npx vitest run --project browser src/orchestration/orchestration-row.browser.test.tsx
```

The unistyles stub has no runtime, so the real form-factor hook never reports compact there. The phone
tests mock `useIsCompactFormFactor` instead of resizing the viewport; a wider viewport changes
nothing.

The rows and `orchestration-header-controls.tsx` are captured rather than the whole panel:
importing the panel pulls `navigateToAgent` and therefore expo-router, which does not bundle for
the browser project, and the budget strip needs a live host. Keep those two modules free of runtime
imports that reach the app graph, or the capture stops working. A new lucide icon also needs adding
to `packages/app/test-stubs/lucide-react-native.ts`. Do not build JSX at module scope in either: the
classic runtime reads `React` off the global, which the test stubs only once a test is running, after
the import.

A fixture cannot show the budget strip or real activity text. To see those, point a dev web build at
the live daemon through a bridge that forwards only read-type frames, and keep the captures out of
`docs/assets`: they carry agent titles and account emails.
