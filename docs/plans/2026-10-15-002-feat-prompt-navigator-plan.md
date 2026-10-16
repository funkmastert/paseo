---
title: Prompt Navigator on the Sticky Prompt Bar - Plan
type: feat
date: 2026-10-15
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Prompt Navigator on the Sticky Prompt Bar - Plan

## Goal Capsule

- **Objective:** give the sticky last-prompt bar (`packages/app/src/agent-stream/sticky-last-prompt/`) back/forward arrows that step through at least the last 5 prompts Tyler sent in the current agent session, with a "3/7"-style position label, disabled arrows at the ends, and reset-to-newest on a new prompt. Tapping the prompt text jumps the timeline to that message (reveal + scroll + brief highlight), reusing the existing reveal/scroll/settle machinery — no new fetch mechanism. The full-prompt viewer moves behind a small expand icon since the body tap now jumps.
- **Authority:** this plan, then `docs/agent-stream-performance.md`, `docs/unistyles.md`, `docs/hover.md`, `docs/pinned-grid.md`, `docs/design.md`, `CLAUDE.md` platform-gating section, `docs/protocol-compatibility.md`.
- **Execution profile:** single worktree, single implementer, sequential units U1 → U6 (each depends on the last). No parallel workers needed at this size.
- **Stop conditions:** stop and report, don't guess, if extending `StickyPromptBarProps` would require a style contract change `ce-simplify-code` can't absorb cleanly, or if `revealLoadedHistory`/`viewportRef.current.scrollToMessage` behave differently enough between native and web that the single cross-platform navigator hook (U3) can't stay platform-neutral.
- **Tail ownership:** commit locally on `feat/prompt-navigator`; never push. The leader runs the wider review, merge, and device verification.

---

## Product Contract

### Problem Frame

Tyler asked (verbatim): "i dont see my pinned prompts at the top... actually iw ant to make it a deeper feature.. there should be back and forward arrows to cycle through all my previous prompts (at least the last 5) and then click to jump to it."

The sticky bar (PR #40, fixed for the live-head case in PR #44) already shows the single most recent prompt once it scrolls off-screen, and already has a jump-to-original control and a full-prompt viewer (`sticky-prompt-bar.tsx`). This plan extends that bar from "show the last prompt" to "browse the last N prompts," without inventing a second jump or fetch mechanism:

- `viewportRef.current.scrollToMessage(id)` (`strategy-web.tsx` / `strategy-native.tsx`) already reveals, scrolls, and settles onto a row, with jump-cancel-on-user-scroll built into `prompt-jump-settle.ts`'s settle controller on both platforms (`subscribeToUserIntent`). Calling this again for the navigator gets scroll-cancellation for free.
- `revealLoadedHistory` (`use-stream-history-window.ts`, already wired into `view.tsx` for jump-to-start and chat-outline) brings an already-fetched-but-unmounted row into the virtualized window before a scroll target can be measured.
- `loadOlder` / `hasOlder` (same `useStreamHistoryWindow`) is the existing older-history pagination (`planTimelineOlderFetch` + merge) already used for scroll-up infinite loading. The navigator reuses this — not a second fetch path — when the back arrow needs a prompt older than what's currently loaded.

### "Recent prompts" rule (reused, not reinvented)

The navigator's candidate list is every `user_message`-kind item in the agent's own loaded timeline (`tail` + streaming `head`, combined exactly like `use-sticky-last-prompt.web.ts`/`.native.ts` already does), in timeline order. `sticky-last-prompt/model.ts`'s existing comment already establishes why no further filtering is needed: the daemon never dispatches synthetic prompts (heartbeats, schedule fires, `<paseo-system>` notes, refocus restatements) as timeline items, so every `user_message` is a real, person-sent prompt. `selectRecentPrompts` (U1) generalizes the existing `selectLastPrompt` to return the whole ordered list instead of only the newest.

Because every prompt the navigator ever lets Tyler _select_ is, by construction, already loaded (extended via `loadOlder` at the moment the back arrow needs more, not lazily at tap time — see U2), tapping a prompt to jump is always a same-tick reveal+scroll; there is no "fetch at jump time" branch to build, which satisfies "if the message is not in the loaded window, load enough history to include it" by making that condition only ever occur at the back-arrow boundary, where it's already handled.

### Requirements

- R1. The sticky bar shows back (`<`) and forward (`>`) arrows and a position label (e.g. "3/7") alongside the existing prompt text, jump-to-original control, and (new) expand icon.
- R2. The arrows step the _selected_ prompt through the loaded prompt history, oldest to newest. At least the last 5 prompts are reachable whenever that many exist in the agent's timeline; more are reachable when older history is already loaded or one `loadOlder` page cheaply reaches them (U2).
- R3. The back arrow is disabled when the oldest reachable prompt is selected (no older history left to load). The forward arrow is disabled when the newest prompt is selected.
- R4. A new prompt from Tyler resets the selection to the newest prompt.
- R5. Tapping the prompt text jumps the transcript to the _selected_ prompt's row: reveal into the mounted window if needed, scroll to it, then apply a brief highlight flash. A second tap (on the same or a different prompt) or a new arrow press while a jump is settling cancels the superseded jump cleanly; a user scroll while settling is already cancelled by the existing settle controller.
- R6. A small expand icon (not the body tap) opens the existing full-prompt viewer for the _selected_ prompt, since the body tap now jumps.
- R7. Works on iOS, Android, web browser, Electron, at compact and wide form factors, and inside pinned-grid cells (one-line chrome, `compact` prop already threaded through `StickyPromptBar`). Arrow hit targets are usable on a phone (match the existing jump button's `hitSlop={8}` pattern at minimum).
- R8. No `onPointerEnter`/`onPointerLeave`; arrows and the position label are always visible (no hover-to-reveal), consistent with the existing jump button and `docs/hover.md`'s guidance that native/compact controls stay always-visible.
- R9. No server or protocol change. The feature ships by republishing the web UI (and a normal app build for native/Electron) alone.

### Scope Boundaries

- No change to the chat outline rail, its prompt index, or `agentTimelinePromptIndex` — that feature is web-only and settings-gated (`chatOutlineEnabled`) today, which would make the navigator's base behavior (always-on, every platform) conditional on an unrelated toggle. The navigator uses only the always-loaded `tail`/`head` items already powering the sticky bar.
- No new WebSocket RPC, fetch plan, or protocol field. `loadOlder`/`planTimelineOlderFetch` and `viewportRef.current.scrollToMessage` are the only data-reaching primitives used.
- No change to `selectLastPrompt`'s existing behavior or callers — `selectRecentPrompts` is additive.

### Deferred to Follow-Up Work

- Reaching _every_ prompt in a very long, mostly-unpaginated session (beyond what one `loadOlder` page surfaces) by consulting the chat-outline prompt index when available — deferred because it would couple the always-on navigator to a settings-gated, web-only feature; flagged as a possible enhancement once chat outline ships on native.
- E2E and real-device verification (iOS/Android simulators, Electron, mobile Safari/Chrome) — rapid mode; targeted unit/component tests only. The leader verifies on-device before merge.
- Keyboard shortcuts for stepping the navigator (e.g. arrow keys while the bar has focus).

---

## Planning Contract

### Key Technical Decisions

- **KTD1 — Prompt source stays local-tail-only, not the chat-outline index.** The navigator reads `selectRecentPrompts(tail + head)` rather than `useChatOutline`'s `agentTimelinePromptIndex`. Rationale: the index is gated behind `supportsChatOutline && chatOutlineEnabled` and is explicitly disabled on native (`!isWeb` in `use-chat-outline.ts`) — building the navigator on it would make "every surface" and "always on" both conditional on a setting Tyler might have off. The always-loaded tail already satisfies "at least the last 5" in practice (the full fetched tail, not just the virtualized/rendered window, is scanned).
- **KTD2 — Reaching further back uses the existing `loadOlder` pagination, triggered at the back-arrow boundary, not at tap time.** This keeps "tap to jump" always synchronous (the selected prompt is always already loaded by construction) and reuses `useStreamHistoryWindow`'s existing fetch+merge path instead of adding a second one (the brief's explicit constraint).
- **KTD3 — Selection state is ordinary React state in a new hook (`use-prompt-navigator.ts`), not an outside-React publisher like `createStickyLastPromptPublisher`.** The publisher pattern exists specifically to avoid re-rendering the transcript on every scroll frame (`stickyLastPrompt`'s visibility recomputes per scroll). Navigator selection only changes on a user tap/arrow press or a new prompt — low-frequency, user-driven — so plain memoized state passed as props to `StickyPromptOverlay` is simpler and sufficient.
- **KTD4 — Row highlight is a new, minimal outside-React publisher (`row-highlight.ts`), mirroring `createStickyLastPromptPublisher`'s shape.** No existing jump (jump-to-start, chat-outline, jump-to-original) highlights its target today, so this is net-new. Keeping it outside React and subscribed per-row (by id) avoids re-rendering the whole transcript for a one-row, auto-clearing flash.
- **KTD5 — The body `Pressable` in `StickyPromptBar` now jumps to the selected prompt; a new `Maximize2` icon button opens the full-prompt viewer.** Matches the existing icon vocabulary (`Maximize2` is already used for "expand" in `packages/app/src/components/markdown/fence/mermaid/host.web.tsx`) and `ChevronLeft`/`ChevronRight` for the arrows (already the app's prior/next convention, e.g. `command-center.tsx`).

---

## Implementation Units

### U1. Pure navigator selection model

**Goal:** generalize "the last prompt" into "the ordered list of loaded prompts," plus pure helpers for stepping/resetting selection and deriving the position label.

**Requirements:** R2, R3, R4

**Dependencies:** none

**Files:**

- `packages/app/src/agent-stream/sticky-last-prompt/model.ts` — add `selectRecentPrompts(items: readonly StreamItem[]): UserMessageItem[]`, scanning in forward order (reuses the same single-pass style as `selectLastPrompt`; does not change `selectLastPrompt` itself).
- `packages/app/src/agent-stream/sticky-last-prompt/navigator-model.ts` (new) — `PromptNavigatorSelection` (`{ prompts: UserMessageItem[]; selectedIndex: number }`), `resolveInitialSelection`, `stepSelection(selection, direction: "back" | "forward")`, `canStepBack`/`canStepForward`, `resolvePositionLabel(selection)` (returns `"3/7"` 1-based), and `reconcileSelectionOnNewPrompts(previous, nextPrompts)` — resets to the newest index when the newest prompt's id changed, otherwise keeps the previous selection pinned to the same prompt id (by id, not raw index, since `loadOlder` shifts earlier indices).
- `packages/app/src/agent-stream/sticky-last-prompt/navigator-model.test.ts` (new).

**Approach:** Keep everything here pure and platform-agnostic — no React, no I/O. `reconcileSelectionOnNewPrompts` is the one subtle piece: it must tell "a new prompt arrived" (reset to newest) apart from "older history loaded, growing the list from the front" (keep the same prompt selected, index shifts). Compare by the previously-selected prompt's `id`, re-finding its index in the new list; if the id can't be found (shouldn't happen — loaded prompts never disappear) or there was no previous selection, select newest.

**Test scenarios:**

- `selectRecentPrompts` returns all `user_message` items in order, across tail+head combined, with no assistant/tool items included (mirror the existing `selectLastPrompt` test fixtures).
- `selectRecentPrompts` returns an empty array for a list with no user messages.
- `stepSelection("back")` decrements and is a no-op at index 0; `stepSelection("forward")` increments and is a no-op at the last index.
- `canStepBack`/`canStepForward` reflect the bounds correctly for 1-prompt, 5-prompt, and empty lists.
- `resolvePositionLabel` renders `"1/1"`, `"3/7"`, and is defined (doesn't throw) for an empty list.
- `reconcileSelectionOnNewPrompts`: newest prompt id changed → selects the new newest. Same newest id, list grew at the front (older history loaded) → keeps the same prompt selected, index shifts to match its new position. Identical list → selection unchanged (referential stability check, since this feeds `useMemo`/`memo` boundaries per KTD3).

**Verification:** `npx vitest run packages/app/src/agent-stream/sticky-last-prompt/navigator-model.test.ts` and the existing `model.test.ts` both green.

---

### U2. `use-prompt-navigator` hook — selection + back-arrow pagination

**Goal:** a single cross-platform hook that owns navigator selection state, resets on a new prompt, and triggers `loadOlder()` when the back arrow would otherwise be disabled but more remote history exists.

**Requirements:** R2, R3, R4

**Dependencies:** U1

**Files:**

- `packages/app/src/agent-stream/sticky-last-prompt/use-prompt-navigator.ts` (new).
- `packages/app/src/agent-stream/sticky-last-prompt/use-prompt-navigator.test.ts` (new) — jsdom is fine here; no DOM measurement involved (compare with `use-sticky-last-prompt.web.test.ts`'s style, not the `.browser.test.tsx` style, since this hook does no `getBoundingClientRect` work).

**Approach:** Input: `{ agentId, items (tail), head, hasOlderHistory, isLoadingOlderHistory, loadOlder }` — the same `hasOlder`/`isLoadingOlder`/`loadOlder` already computed once in `view.tsx` by `useStreamHistoryWindow` and already passed to the stream render strategy; no new data source. On mount and whenever `items`/`head` change, recompute `selectRecentPrompts` and run `reconcileSelectionOnNewPrompts` (U1). Expose `{ prompts, selectedIndex, canStepBack, canStepForward, isLoadingOlder, positionLabel, stepBack, stepForward }`. `stepBack()`: if `canStepBack`, decrement locally; else if `hasOlderHistory && !isLoadingOlderHistory`, call `loadOlder()` (fire-and-forget — the effect on `items` change will extend the list and `reconcileSelectionOnNewPrompts` keeps the current prompt selected since its id is unchanged, then a once-more `stepBack()` naturally becomes available). `stepForward()` is always local (never needs to fetch forward). Reset-to-newest (R4) is exactly `reconcileSelectionOnNewPrompts` firing when the newest prompt's id changes.

**Test scenarios:**

- Initial mount with 5 loaded prompts selects the newest; `positionLabel` is `"5/5"`; `canStepForward` is false, `canStepBack` is true.
- `stepBack()` repeatedly through all 5 without pagination (`hasOlderHistory: false`): lands on index 0, `canStepBack` becomes false, `loadOlder` is never called.
- `stepBack()` at index 0 with `hasOlderHistory: true` and `isLoadingOlderHistory: false`: calls `loadOlder()` exactly once; does not call it again on a repeat press while `isLoadingOlderHistory` is true.
- After `loadOlder()` resolves and `items` grows with 2 more, older prompts prepended: selection stays on the same prompt (by id), `canStepBack` becomes true, and a following `stepBack()` moves into the newly loaded prompts.
- A new prompt arrives while the user has stepped back to an older one: selection resets to the new newest prompt (R4), and `positionLabel` reflects the grown total.
- `stepBack()`/`stepForward()` are no-ops (don't throw, don't call `loadOlder`) when `prompts` is empty.

**Verification:** `npx vitest run packages/app/src/agent-stream/sticky-last-prompt/use-prompt-navigator.test.ts`.

---

### U3. Jump-to-selected-prompt wiring (reveal + scroll + cancel)

**Goal:** wire "tap the prompt text" to reveal (if needed) and scroll to the selected prompt's row, reusing the existing reveal/scroll/settle machinery, with cancellation on a superseded jump.

**Requirements:** R5

**Dependencies:** U2

**Files:**

- `packages/app/src/agent-stream/sticky-last-prompt/use-prompt-navigator.ts` — extend with a `jumpToSelected()` action (or a thin wrapper in `view.tsx`, whichever keeps the hook's inputs minimal — the hook already needs `viewportRef` and `revealLoadedHistory`/`visibleItemIds` for this, mirroring exactly what `handleJumpToOutlinePrompt`/`useChatOutline.jumpToPrompt`'s "loaded" branch already does).
- `packages/app/src/agent-stream/sticky-last-prompt/use-prompt-navigator.test.ts` — add scenarios below.

**Approach:** Mirror the existing pattern verbatim (`view.tsx`'s `jumpToStickyLastPrompt`, `useChatOutline.jumpToPrompt`'s loaded branch): if the selected prompt's id isn't in `visibleItemIds`, call `revealLoadedHistory(id)` first; then call `viewportRef.current?.scrollToMessage?.(id)`. Add a local generation counter (same shape as `useJumpToStart`'s `generationRef`/`invalidateJumpToStart`) bumped on every `jumpToSelected()` call and every `stepBack`/`stepForward`, so a stale reveal callback (if `revealLoadedHistory` is itself async/deferred a frame) doesn't scroll to a prompt the user has since navigated away from. Scroll-cancel-on-user-scroll is already handled inside `scrollToMessage`'s settle controller on both platforms — nothing new needed there. After `scrollToMessage` is called, trigger the U4 highlight publisher for that id.

**Test scenarios:**

- `jumpToSelected()` on an already-visible prompt calls `scrollToMessage` directly, does not call `revealLoadedHistory`.
- `jumpToSelected()` on a loaded-but-not-visible (virtualized-away) prompt calls `revealLoadedHistory(id)` then `scrollToMessage(id)`.
- Calling `jumpToSelected()` twice in a row for two different selections only acts on the second (the first's generation is superseded) — assert `scrollToMessage` is called once, with the second id.
- `stepBack()` immediately followed by `jumpToSelected()` targets the newly-selected (stepped-back) prompt, not the prior one.

**Verification:** same vitest file as U2, green.

---

### U4. Brief row highlight on jump

**Goal:** flash the jumped-to row briefly so Tyler can find it after the scroll lands.

**Requirements:** R5

**Dependencies:** none (parallel to U1-U3; wired together in U6)

**Files:**

- `packages/app/src/agent-stream/row-highlight.ts` (new) — `createRowHighlightPublisher()` (subscribe/getHighlightedId, same shape as `createStickyLastPromptPublisher` in `sticky-last-prompt/model.ts`), plus a pure `HIGHLIGHT_DURATION_MS` constant.
- `packages/app/src/agent-stream/row-highlight.test.ts` (new).
- `packages/app/src/agent-stream/row-highlight-boundary.tsx` (new) — a small component taking `{ itemId, source, children }`, subscribing via `useSyncExternalStore(source.subscribe, source.getState)`, rendering `children` wrapped in a `View` whose background briefly animates/transitions when `getState().highlightedId === itemId`, then auto-clears.
- `packages/app/src/agent-stream/row-highlight-boundary.test.tsx` (new, jsdom — asserts the wrapper applies/removes the highlight style around the publisher's state, not pixel output).

**Approach:** `publish(id)` schedules its own auto-clear via a caller-supplied timer function (inject `setTimeout`/`clearTimeout` for testability, same style as other timer-using hooks in this codebase) so the model stays a pure state container and the clearing policy (duration) is explicit and testable. A second `publish(otherId)` before the first clears cancels the pending clear and starts a new one — only one row is ever highlighted at a time. Integrate the boundary at the single place `view.tsx` already composes each row's rendered output (`renderLiveHeadStreamItem`/`renderStreamItem` callsites for `renderHistoryVirtualizedRow`/`renderHistoryMountedRow`/`renderLiveHeadRow`), not inside `message.tsx`, keeping the change contained to `agent-stream/`.

**Test scenarios:**

- `publish(id)` then `getState().highlightedId === id`; after `HIGHLIGHT_DURATION_MS` (fake timers) it's `null` again.
- `publish(id1)` then `publish(id2)` before the first clears: only `id2` is highlighted, and the first's scheduled clear does not fire and clobber `id2`.
- `RowHighlightBoundary` renders its highlighted style only when `itemId` matches the published id, for both a matching and a non-matching row.
- `RowHighlightBoundary` un-highlights when the publisher clears (timer fires) — simulate via fake timers + act.

**Verification:** `npx vitest run packages/app/src/agent-stream/row-highlight.test.ts packages/app/src/agent-stream/row-highlight-boundary.test.tsx`.

---

### U5. `StickyPromptBar` UI — arrows, position label, expand icon

**Goal:** add the navigator controls to the bar and move "open full viewer" behind a new expand icon.

**Requirements:** R1, R3, R6, R7, R8

**Dependencies:** U1 (for the shape of position/selection props)

**Files:**

- `packages/app/src/agent-stream/sticky-last-prompt/sticky-prompt-bar.tsx` — extend `StickyPromptBarProps` with `positionLabel: string | null`, `canStepBack: boolean`, `canStepForward: boolean`, `onStepBack: () => void`, `onStepForward: () => void`, `onJumpToSelected: () => void` (replaces the body `Pressable`'s current `onOpenViewer`), `onOpenViewer: () => void` (now wired to the new expand icon instead). Add `ChevronLeft`/`ChevronRight` arrow buttons (disabled + dimmed per `canStepBack`/`canStepForward`, `hitSlop={8}` minimum) and the position label (small muted text, hidden/omitted when there's only one prompt — avoid showing a pointless "1/1"), plus a `Maximize2` expand icon button next to the existing jump (`ArrowUp`) button.
- `packages/app/src/agent-stream/sticky-last-prompt/sticky-prompt-bar.test.tsx` (existing file — extend).

**Approach:** Follow `docs/design.md`'s control-geometry sizing (`xs`/`sm` tier, matching the bar's existing compact chrome) and alignment-to-glyph rules. Compact mode (`compact=true`, pinned-grid cells): keep arrows and label present but smallest tier — R7 explicitly requires it to work in pinned-grid cells, not hide the feature there. No `onPointerEnter`/`onPointerLeave` anywhere (R8) — arrows are always rendered, never hover-revealed, same as the existing jump button today. Disabled arrows get `disabled` + `accessibilityState={{ disabled: true }}`, not removed from the tree, so hit-target geometry stays stable (no layout shift from an arrow appearing/disappearing).

**Test scenarios:**

- Renders `positionLabel` when provided and more than one prompt exists; omits it for a single-prompt session.
- Back arrow `onPress` fires `onStepBack`; is disabled (no press handler fires) when `canStepBack` is false.
- Forward arrow mirrors the above for `canStepForward`/`onStepForward`.
- Tapping the body `Pressable` calls `onJumpToSelected`, not `onOpenViewer`.
- Tapping the new expand icon calls `onOpenViewer`.
- `compact` prop still renders one-line text (`numberOfLines={1}`) and all navigator controls remain present (not hidden) in compact mode.
- No `onPointerEnter`/`onPointerLeave` prop is attached to any new element (grep-style assertion or snapshot of props, consistent with how the repo guards this elsewhere).

**Verification:** `npx vitest run packages/app/src/agent-stream/sticky-last-prompt/sticky-prompt-bar.test.tsx`.

---

### U6. Integration into `AgentStreamView` and the overlay chain

**Goal:** instantiate the navigator hook in `view.tsx`, thread its state/handlers through `StickyPromptOverlay` and `TopOverlay` to the bar, and wire the highlight publisher into row rendering.

**Requirements:** R1-R9 (closes the loop)

**Dependencies:** U1, U2, U3, U4, U5

**Files:**

- `packages/app/src/agent-stream/view.tsx` — instantiate `usePromptNavigator` alongside the existing `stickyLastPrompt`/`chatOutline`/`useJumpToStart` hooks, reusing the already-computed `hasOlder`, `isLoadingOlder`, `loadOlder`, `revealLoadedHistory`, `viewportRef`, `visibleHistoryItemIds`. Instantiate `createRowHighlightPublisher()` once (useMemo) and pass it to the row-render callsites (wrap with `RowHighlightBoundary`) and to the navigator's jump handler.
- `packages/app/src/agent-stream/sticky-last-prompt/sticky-prompt-overlay.tsx` — accept the navigator's derived props (position label, canStep\*, step handlers, jump handler) and pass them to `StickyPromptBar`; `onOpenViewer`'s existing full-viewer flow (`viewerPrompt` state, `handleJumpFromViewer`, `handleViewerDismissed`) is unchanged, just now triggered by the new expand icon instead of the body press.
- `packages/app/src/agent-stream/top-overlay.tsx` — extend `TopOverlayProps` to pass the navigator props through to `StickyPromptOverlay` (plain prop threading, no new logic).
- `packages/app/src/agent-stream/top-overlay.test.tsx`, `packages/app/src/agent-stream/sticky-last-prompt/sticky-prompt-overlay.test.tsx` — extend with the new props wired through (existing files, per the earlier `git show a70ad20ea --stat` listing).

**Approach:** This unit is pure wiring — no new logic beyond what U1-U5 already built and tested in isolation. Keep `TopOverlay`'s existing `key={agentId}` remount-on-agent-switch behavior (it already resets `StickyPromptOverlay`'s internal state on an agent switch; `usePromptNavigator`'s own `agentId`-keyed reset in `view.tsx` mirrors `useJumpToStart`'s `invalidateJumpToStart` effect on `input.agentId`).

**Test scenarios:**

- `TopOverlay`/`StickyPromptOverlay` component tests (extend existing files): position label and arrows render inside the overlay alongside the existing jump-to-start button, in the expected stacking order.
- Pressing a navigator arrow inside the mounted overlay calls the supplied `onStepBack`/`onStepForward` prop (component-level, not hook-level — hook behavior is already covered in U2/U3).
- Switching `agentId` (remount via `key={agentId}`) resets the navigator to "no selection"/newest, mirroring the existing sticky-bar reset behavior already tested for `StickyPromptOverlay`.
- Pinned-grid smoke: render `AgentStreamView` (or the narrowest existing harness that already proves `compact={true}` renders the bar — see `sticky-prompt-bar.test.tsx`'s existing compact coverage) and assert the navigator controls are present, not stripped, when `compact` is true.

**Verification:** `npx vitest run packages/app/src/agent-stream/top-overlay.test.tsx packages/app/src/agent-stream/sticky-last-prompt/sticky-prompt-overlay.test.tsx`, plus a re-run of every test file touched by U1-U5 together to catch cross-unit regressions in one pass.

---

## Verification Contract

- Every new/changed test file listed in U1-U6 passes via targeted `npx vitest run <file>` from `packages/app` — never the full suite (rapid mode / repo convention).
- `npm run typecheck` and `npm run lint -- <changed files>` clean after all units land.
- No change to `packages/protocol`, `packages/server`, or any wire schema — confirm with `git diff --stat` before commit that only `packages/app/src/agent-stream/**` (and its tests) changed.
- Manual/device verification (iOS, Android, Electron, mobile Safari/Chrome, pinned-grid on a real phone width) is explicitly deferred to the leader per rapid mode — not part of this plan's Definition of Done.

## Definition of Done

- Sticky bar shows arrows + position label; stepping and jump-to-selected behave per R1-R6 in targeted tests.
- Full-prompt viewer still reachable via the new expand icon (R6).
- Works in pinned-grid `compact` mode per existing/extended `sticky-prompt-bar.test.tsx` coverage (R7).
- No `onPointerEnter`/`onPointerLeave` introduced; controls always visible, no hover-gating (R8).
- No server/protocol file touched (R9).
- All six implementation units committed locally on `feat/prompt-navigator`, not pushed.

## Open Questions

- None blocking. The one soft call — whether to also reach into the chat-outline prompt index for sessions with more history than one `loadOlder` page surfaces — is recorded under Deferred to Follow-Up Work rather than left open, since it isn't required to meet "at least the last 5."
