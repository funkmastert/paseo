# Insights

A compaction episode ledger: what each leader compaction cost, what it dropped, and what it is
estimated to have paid back. Lives in the app's Insights screen (sidebar, beside JEV), which starts
with a Compactions section and links out to the JEV dashboard, the classifier Decisions dashboard
(Settings → Agent roles), and Token usage.

## Measured, estimated, unmeasured

Every figure on a compaction row is one of three things. Say which, everywhere one of these
figures appears — the UI labels unmeasured rows explicitly rather than leaving the distinction
implicit.

- **Measured.** A monitor-driven episode's cost: `agent.totalTokens` (the lifetime weighted-token
  counter [docs/token-burn.md](token-burn.md#the-unit-is-cost-weighted-tokens) already maintains)
  snapshotted at the start and end of each prepare/compact/restore step, diffed and summed. An
  episode is `costBasis: "measured"` only when every one of its steps got both snapshots; one
  missing snapshot (a daemon restart mid-step) makes the whole episode `"unmeasured"` rather than
  reporting a partial figure as if it were the whole cost.
- **Estimated.** The payback: tokens the compaction dropped from the context (`contextBeforeTokens
− contextAfterTokens`) times the weighted-token requests the agent has made since, at the
  cache-read weight (0.1 — every later request re-reads the smaller context from cache). This
  number grows live as the agent keeps working and is explicitly marked as an estimate, never
  folded into "cost" as if it were measured spend.
- **Unmeasured.** Claude Code's own auto-compact, a user's manual `/compact`, and every backfilled
  historical row. None of these have step boundaries a `totalTokens` snapshot could be taken
  against, so their cost is `null` rather than a guess.

## The ledger

`CompactionLedgerStore` (`packages/server/src/server/compaction-ledger/compaction-ledger-store.ts`)
is one Zod-versioned state file under `$PASEO_HOME/compactions/state.json`, atomic debounced
writes, bounded by row count and retention days — the same shape as
[docs/token-usage.md](token-usage.md)'s `TokenUsageStore`. `CompactionLedgerService`
(`compaction-ledger-service.ts`) is the only writer:

- It implements `AgentLeaderCompactionMonitor`'s `episodeObserver` (an additive hook on the
  monitor, `onStepStarted`/`onStepFinished`; see [leader-compaction.md](leader-compaction.md#the-ledger)),
  recording each monitor-driven episode's steps, context before/after, outcome, and cost as it
  happens.
- `recordNativeCompaction` writes a single already-closed, unmeasured row for Claude's own
  auto-compact or a manual `/compact`. The method exists; wiring it to the Claude provider's own
  compaction-detection call sites (`packages/server/src/server/agent/providers/claude/agent.ts`,
  where `CompactionItem`s already carry `trigger`/`preTokens`/`postTokens`) is not done yet — a
  follow-up, not a gap in the ledger's own design.
- A one-time backfill (`compaction-ledger-backfill.ts`) reconstructs closed episodes from the
  monitor's own `"Leader compaction started/finished a step"` and `"gave up"` daemon log lines,
  guarded by the store's `backfillDoneAtMs` marker so it never reruns. Backfilled rows carry no
  cost — the log never recorded a `totalTokens` snapshot — and no agent title, note length, or
  carried-prompt count, since the log doesn't carry those either.
- Payback is tracked live: a `subscribeTokenBurn` hook on `AgentManager` (one call per API request,
  [docs/token-burn.md](token-burn.md)) increments the most recently closed episode's request count
  until that agent's _next_ episode opens, at which point the window closes and the estimate stops
  moving.

Quiet-gate wait (`quietMinutes`/`ceilingTokens`) and carried-prompt count are optional fields on
every episode row, filled only once the monitor reports them. As of this writing the quiet-gate
branch (`fix/compaction-quiet-moment`) has not landed on the shared base — the ledger's schema and
the monitor's observer hook already carry these fields as optional so wiring them through is a
small follow-up, not a ledger change.

## The RPC

`compaction.episodes.list` / `compaction.episodes.summary`
(`packages/protocol/src/compaction/rpc-schemas.ts`), gated on
`server_info.features.compactionLedger`, permission `daemon.read` (compactions aren't
workspace-scoped, the same tier as token usage). `list` pages by cursor — the previous page's last
row's `startedAtMs` — filterable by `agentId` and `range` (`today` | `7d` | `all`, an open string on
the wire per [docs/protocol-compatibility.md](protocol-compatibility.md); `compaction-session.ts`
is the one place that validates it against what the daemon actually serves). `summary` returns the
same filtered set's totals: count, total/average cost, total estimated saved, measured vs.
unmeasured counts.

## The app

- **Insights screen** (`packages/app/src/screens/insights-screen.tsx` /
  `insights-view.tsx`): totals tiles (count, total cost, average cost, estimated saved) and a
  newest-first episode list, each row showing agent, time, trigger, before → after context, cost,
  payback, and the quiet-gate/carried-prompt fields when present. Three link rows at the top open
  the JEV dashboard, Settings (where Agent roles' Decisions dashboard lives — no direct route exists
  for it in this app), and Token usage. `useCompactionEpisodesSummary`/`useCompactionEpisodesList`
  (`packages/app/src/compactions/use-compaction-episodes.ts`) mirror
  `use-jev-savings-summary.ts`/`use-jev-savings-events.ts`'s polling and cursor-paging shape. The
  sidebar entry (`SidebarInsightsRow`) follows `SidebarTokenUsageRow`'s pattern exactly: hidden
  when there's no connected host speaking `compactionLedger`, same as token usage's own row.
- **Timeline Compaction row** (`CompactionMarker` in `packages/app/src/components/message.tsx`):
  joins its `CompactionItem` to the agent's ledger episodes by timestamp
  (`findMatchingCompactionEpisode`, a tolerance window around the episode's span — a few minutes
  either side covers prepare/compact/restore's real wall-clock spread). A match upgrades the row's
  label to `<before> → <after> tokens, <trigger>, cost <figure|not measured>` and makes it
  tappable/hoverable — the same `Tooltip` pattern `JevMarkerChip`, `TokenBurnBadge`, and
  `ContextWindowMeter` use — opening `CompactionMarkerPopover` (`packages/app/src/compactions/`):
  every step's duration and cost, the payback estimate, and the quiet-gate/carried-prompt fields
  when present. No match renders exactly the original plain divider — never a dead tap target.
  `use-agent-compaction-episodes.ts` mirrors `use-agent-jev-decisions.ts`'s per-agent fetch; the
  join happens at render time in `agent-stream/view.tsx`'s existing `"compaction"` case, the same
  place the JEV marker already reads its own per-agent data — no synthetic timeline-item insertion,
  since this enriches an existing item rather than adding a new one.

`CompactionMarkerPopover` is kept in its own file, outside `message.tsx`, so it stays
browser-testable with fixtures directly: importing anything through `message.tsx` pulls in its full
dependency graph, which breaks the browser capture's esbuild loader (the same trap
`jev-dashboard-view.tsx`'s own file comment warns about).

## Not done yet

- `recordNativeCompaction`'s wiring to the Claude provider's own compaction-detection call sites —
  Claude Code's own auto-compact and a user's manual `/compact` are not recorded in the ledger yet,
  only monitor-driven episodes and the log backfill.
- The quiet-gate and carried-prompt fields are plumbed through as optional but unfilled, pending
  `fix/compaction-quiet-moment` landing on the shared base.
- Moving the JEV, Decisions, or Token usage dashboards' content into the Insights screen. Today it
  only links out to them.
