# Orchestration panel

The fleet view: every live agent on a host as one tree, spanning workspaces, with the per-account
budget strip above it. `packages/app/src/panels/orchestration-panel.tsx` is the shell;
`packages/app/src/orchestration/` holds the row, the tree selector, and the models.

It answers four questions at a glance — which agents are alive, what each is doing now, which are
stuck or waiting, what they are costing. A real fleet is 50-odd agents of which a handful are
running, so every rule below exists to keep those four answers legible against that ratio.

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

One line per agent, at a fixed height, whatever the agent is doing. A row that grows when its state
changes reflows the list under the reader (docs/design.md §11), so the variable content is chosen
to fit rather than given more room.

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
- **The model is not on the row.** Fifty rows repeating one model name is not a signal, and it was
  what pushed the timestamp off the right edge of a narrow panel.

Roots are ordered by the most urgent state anywhere in their subtree
(`orchestration-ordering.ts`), then by age. Children keep creation order, so nesting still reads as
the order the work was handed out.

## Capturing it

`orchestration-row.browser.test.tsx` renders a fixture fleet — 53 agents, 4 running, 30 idle, 19
closed, modelled on a measured one — in a real browser and writes the screenshots in
`docs/assets/orchestration-panel-fleet-*.png`. Run it before and after a presentation change; the
panel's problems only appear at that size, and no daemon is reliably in that shape when you want to
look at it.

```bash
npx vitest run --project browser src/orchestration/orchestration-row.browser.test.tsx
```

The rows are captured rather than the whole panel: importing the panel pulls `navigateToAgent` and
therefore expo-router, which does not bundle for the browser project. Keep the row module free of
runtime imports that reach the app graph, or the capture stops working.
