# Global back button with navigation history

Status: design complete, ready for implementation.
Provenance: read-only design agent (Sonnet 5) on 2026-09-11; verified against the tree at `84e1397d2`.

## User ask

"There should be a global back button that takes me back to whatever the last screen was, with some bit of history."

## How navigation state is composed today

**Route layer (expo-router).** Per `docs/expo-router.md`, the router owns coarse boundaries only: `/` → `/h/[serverId]` (host) → `workspace/[workspaceId]/index`. App-wide routes (`/new`, `/settings`, `/sessions`, plugin surfaces) are siblings of the host tree. Everyday movement — switching workspaces, opening a different agent, flipping tabs — mostly does **not** push a route; it mutates Zustand store state under the one mounted workspace route.

**The three navigation layers:**

1. **Active workspace** — `packages/app/src/stores/navigation-active-workspace-store/navigation.ts`. `navigateToWorkspace(input, deps)` (`:85`) is the single choke point: resolves the workspace, optionally opens a tab target via `deps.openTab`, calls `deps.rememberLastWorkspace()` (persists to `stores/last-workspace-selection.ts`, key `paseo:last-workspace-route-selection`), then `deps.navigateToRoute(route)` (expo-router `dismissTo`/POP_TO in `navigation/workspace-route-navigation.ts`). `navigateToAgent()` (`utils/navigate-to-agent/index.ts:8`) converges on the same function.
2. **Tab/pane focus inside a workspace** — `stores/workspace-layout-store.ts`: per-workspace split-pane tree (`layoutByWorkspace`) with `openTab`/`focusTab`/`selectTabInPane`/`replaceTab`/`closeTab`/`splitPane`. `WorkspaceTabTarget` (`workspace-tabs/model.ts:34`) enumerates every "screen" a tab can show — this is the real granularity of "where the user is."
3. **Cross-cutting UI state** (sidebar visibility, side-pane id, focused pane) — also `workspace-layout-store.ts`.

**Today there is no cross-workspace/tab back at all.** `router.back()` is used only inside genuinely nested app-wide flows (Settings `settings-screen.tsx:1187`, Sessions `sessions-screen.tsx:202`, pairing, plugin surfaces, add-project). Only the _last_ workspace is remembered (single slot, `last-workspace-selection.ts`). No `BackHandler`, no `popstate` wiring anywhere in `packages/app/src`. `ScreenHeader` (`components/headers/screen-header.tsx`) already has `left`/`right` slots — the established frame for a back control. Desktop titlebar chrome: `components/desktop/titlebar-drag-region.tsx` + `components/desktop/window-controls.tsx`, composed in `ScreenHeader` and `left-sidebar.tsx` (`:736`, `:752`).

## Keyboard shortcut conflict (verified)

`keyboard/keyboard-shortcuts.ts:616-688` already binds `Cmd+[`/`Cmd+]` (mac), `Ctrl+[`/`]` (non-mac desktop), `Alt+[`/`]` (web) to `workspace.navigate.relative` (list-order cycling), and `Alt+Shift+[`/`]` to tab cycling. **Free and chosen:** `Cmd+Shift+[` / `Cmd+Shift+]` (mac), `Ctrl+Shift+[` / `Ctrl+Shift+]` (non-mac desktop and web) for history back/forward — mirrors the workspace-cycle key, disambiguated by Shift.

## Design

### Entry shape

```ts
interface NavHistoryEntry {
  serverId: string;
  workspaceId: string;
  // Present only when the navigation named a specific tab (mirrors
  // navigateToWorkspace's optional `target`); omitted = workspace's own last focus.
  target?: WorkspaceTabTarget;
}
```

Reuses `NavigateToWorkspaceInput`'s existing `{serverId, workspaceId, target}` shape (`navigation.ts:26`) — no new screen taxonomy. Excludes pane geometry, scroll position, sidebar state: workspace-layout-store already remembers those per-workspace; duplicating them would go stale on rearrange.

### History stack

- New session-only Zustand store (no `persist` — pattern-matches `keyboard-shortcuts-store.ts`).
- Back-stack + forward-stack, browser-style: normal navigation pushes back-stack and clears forward-stack; Back pops back → pushes current to forward; Forward mirrors.
- Bounded at 50 entries; consecutive-duplicate pushes dropped (value-compare the triple).
- Pruning:
  - `workspace/use-workspace-archive.ts:18` already calls layout-store `purgeWorkspace(workspaceKey)` — add `pruneWorkspace(workspaceKey)` on the history store beside it.
  - Closed tabs: resolve **lazily** — on Back, validate the top entry against current state (workspace exists? tab target resolvable via `getWorkspaceTabs`/`collectAllTabs`?) and pop-and-skip dead entries. Keeps the history store one-directional (reads other stores; they never learn it exists).

### Surfaces

- **Desktop titlebar:** back/forward chevron pair in `ScreenHeader`'s `left` slot; same component reused in `left-sidebar.tsx`'s titlebar row when the sidebar owns that row.
- **Compact/mobile header:** same control, compact-sized, gated by `useIsCompactFormFactor()` (sizing only, behavior identical).
- **Shortcuts:** new `KeyboardActionId`s `navigation.history.back`/`navigation.history.forward` in `keyboard/actions.ts`, bound per above, with `help` entries beside `workspace-prev`/`workspace-next`.
- **Long-press / right-click:** popover of last ~8 distinct back entries (workspace name + tab label), reusing `DropdownMenu*` primitives (see `workspace-header-menu.tsx`); check `adaptive-modal-sheet.tsx` for the native sheet variant.
- **Command center:** "Go back" / "Go forward" / "Recent" contributions in `command-center/workspace-registration.tsx` beside `previousTab`/`nextTab`.
- **Android hardware back:** invoke `back()` when the stack is non-empty, else default OS behavior — the one place mobile gains capability. Do **not** wire browser `popstate` (the URL only reflects the route layer; fighting the router is the exact bug class `docs/expo-router.md` warns about). Electron mouse XButton1: stretch goal, not wired anywhere today.

### Integration — replay actions, don't push routes

`back()`/`forward()` replay the entry through the existing `navigateToWorkspace()` (never raw `router.push` — see `docs/expo-router.md`'s hidden-deck warning). Capture happens in `navigateToWorkspace`/`navigateToAgent` guarded by a `fromHistoryReplay` flag so replays don't re-record (the flag lives at the single choke point; mirrors the `pendingIntent` ref pattern in `workspace-route-navigation.ts:26`). Skip recording for `openTab` intent `"background"` (non-navigational by design).

### Persistence: none (session-only)

1. Cold-start restore is already solved by `last-workspace-selection.ts` — a persisted stack would be a second source of truth.
2. Entries reference live ids (agents, terminals, tabs) that may not survive a daemon restart; replaying stale ids invites the permanent-defensive-branch pattern `docs/protocol-compatibility.md` warns against.
3. "Some bit of history" reads as in-session convenience.

## Implementation plan

**New files**

- `packages/app/src/stores/navigation-history-store.ts` — stack, dedup, cap, prune, lazy stale-skip; exports `useNavigationHistoryStore`, `recordNavigationHistory`, `goBack(deps)`, `goForward(deps)`, `pruneWorkspace`, `canGoBack`/`canGoForward` selectors.
- `packages/app/src/stores/navigation-history-store.test.ts` — pure logic tests (style of `last-workspace-selection.test.ts`).
- `packages/app/src/components/navigation/history-back-button.tsx` — shared control incl. long-press/right-click popover.
- `packages/app/src/components/navigation/history-recent-menu.tsx` — recent-entries popover/sheet.

**Edits**

- `keyboard/actions.ts` — two new `KeyboardActionId`s + i18n keys.
- `keyboard/keyboard-shortcuts.ts` — bindings + help entries (regression guard: must not collide with `workspace.navigate.relative` / `workspace.tab.navigate.relative`).
- `hooks/use-keyboard-shortcuts.ts` — dispatch to `goBack`/`goForward`.
- `stores/navigation-active-workspace-store/navigation.ts` — record unless `fromHistoryReplay`.
- `utils/navigate-to-agent/index.ts` — thread the flag.
- `workspace/use-workspace-archive.ts` — prune beside `purgeWorkspace`.
- `components/headers/screen-header.tsx` consumers (workspace screen only) — pass `<HistoryBackButton/>` into the `left` slot; Settings/Sessions keep their local `router.back()`.
- `components/left-sidebar.tsx` — titlebar variant near `TitlebarDragRegion` (`:736`/`:752`).
- `command-center/workspace-registration.tsx` — the three contributions.
- i18n resources (all 9 locales) for new labels.

**Tests**

1. Store: push/dedup/cap/prune/stale-skip, back↔forward round trip, forward-stack clears on new navigation.
2. Shortcuts: new combos resolve correctly and don't collide with existing bracket bindings.
3. Replay through `navigateToWorkspace` does not re-record.
4. Popover renders + item click navigates (component test or browser-capture harness).
5. Android hardware back falls through when the stack is empty (Maestro, per `docs/mobile-testing.md`).
