---
title: Sticky Last Prompt in the Agent Conversation View - Plan
type: feat
date: 2026-10-13
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Sticky Last Prompt in the Agent Conversation View - Plan

## Goal Capsule

- **Objective:** in the agent conversation view (`packages/app/src/agent-stream/`), pin the agent's most recent human-authored instruction at the top of the transcript once its own row scrolls above the viewport, so Tyler never loses track of what he asked while reading a long reply. Compact two-line bar, tap/click to open a full-prompt viewer (scrollable, selectable, dismissible), a control to jump back to the original row, on every platform and inside pinned-grid cells.
- **Authority:** this plan, then `docs/agent-stream-performance.md`, `docs/unistyles.md`, `docs/hover.md`, `docs/pinned-grid.md`, `docs/design.md`, `CLAUDE.md` platform-gating section.
- **Execution profile:** single worktree, single implementer, sequential units U1 → U6 (each depends on the last). No parallel workers needed at this size.
- **Stop conditions:** stop and report, don't guess, if `AgentStreamView` has no existing signal for "this instance is inside a pinned-grid cell" (verify before U6), or if adding native row-visibility tracking would require re-architecting `strategy-native.tsx`'s list beyond a `viewabilityConfig` callback.
- **Tail ownership:** commit locally on `feat/sticky-last-prompt`; never push. The leader runs the wider review, merge, and device verification.

---

## Product Contract

### Problem Frame

Tyler reads long agent replies in the conversation view and loses sight of what he originally asked, because the prompt that started the turn scrolls off the top of the screen while the reply underneath it keeps growing. He wants his last prompt to stay visible at the top of the conversation as he scrolls, so it reads like a sticky header over the transcript.

The transcript already ships two close relatives that this feature builds on instead of duplicating:

- `prompt-jump-settle.ts` + `use-scroll-to-message.web.ts` — jump-to-a-prompt-and-settle, used today by the chat outline rail. Web-only; no native binding exists yet (`StreamViewportHandle.scrollToMessage` is optional and unimplemented in `strategy-native.tsx`).
- `chat-outline/` — tracks "which prompt is the reader currently near" via `onReadingPositionChange` (web-only today) and a non-React pub/sub (`createActivePromptPublisher()`) so the rail updates every scroll frame without re-rendering the transcript. This is the direct precedent for how the sticky bar must track visibility without touching list-row render identity (`docs/agent-stream-performance.md`).

Neither mechanism answers this feature's actual question — "has the one specific row holding the _last_ prompt scrolled above the viewport" — so a small, purpose-built, pure answer to that question is still needed. Everything else (picking the prompt, jumping back to it) reuses what exists.

### "Last instruction" rule (exact)

**The pinned content is the most recent item of kind `user_message` in the agent's own timeline (`StreamItem[]`), in timeline order.** No other filtering is applied, and none is needed:

- The daemon never dispatches heartbeat/schedule firings, `<paseo-system>` finish reports, restart-recovery notes, task notifications, refocus restatements, or `broadcast_agent_prompt` broadcasts (also `formatSystemNotificationPrompt`-wrapped, per `coordination-tools.ts`) to any client as timeline items — `isSystemInjectedEnvelope()` short-circuits them server-side in `agent-manager.ts` before they ever become a `user_message` the client can see (verified: `buildImportedTimelineRows`, both history-replay sites, and the live-dispatch path all skip these before `shouldDispatchEvent` becomes true). This list is illustrative, not exhaustive — the actual rule is "anything `isSystemInjectedEnvelope()` matches," so a client-side exclusion list would be dead code.
- A child agent with "no human prompt" still has an ordinary, visible first `user_message` in its own timeline — the parent's `initialPrompt` is recorded as a normal first message (`getFirstUserMessageTextFromRows`), not wrapped or hidden. So "latest `user_message` in this agent's timeline" is already correct for a child agent; no parent-lookup fallback is needed.
- "While a turn is running it shows that turn's prompt; after it ends, it shows the last one" falls out for free: the newest `user_message` _is_ the running turn's prompt until a new one is sent, with no running/ended branch to write.
- Provider-internal subagents (Claude Code's own Task-tool sub-conversations) have their own separate timeline/viewer (`agent.provider_subagents.*`) and are out of scope — this feature only ever reads the main agent's `StreamItem[]`.

This is the honest heuristic for "closest marker to a sent-by-a-person message" in a schema with no `role`/`source` field: there is no such field because the filtering already happened upstream, server-side.

### Requirements

- R1. While viewing an agent's conversation, once the row holding the latest `user_message` has scrolled above the top of the visible transcript, a compact bar pins to the top showing that prompt's text, two lines, ellipsized.
- R2. While that row is on-screen (at or below the viewport top), no bar renders — no permanent reserved space, no duplicate of the row's own content.
- R3. Tapping or clicking the bar body opens a full-prompt viewer showing the whole prompt text, scrollable and selectable, with a "Jump to message" action that calls the same jump control as the bar. Closes via an X, Esc on web/desktop, a tap outside, or back/swipe on mobile. The bar itself stays short (at most two lines, one in compact mode) — there is no inline expand.
- R4. The bar carries a control that scrolls the transcript back to the original prompt row, reusing `prompt-jump-settle.ts` / `use-scroll-to-message.web.ts` on web. Native has no existing jump-to-message binding; this plan adds the minimal one needed (U5) by wiring `strategy-native.tsx`'s `FlatList` to the same platform-neutral `PromptJumpSettleController`, not a second settle engine.
- R5. Works on iOS, Android, web, and Electron desktop, at compact and wide form factors, and inside pinned-grid cells, where the bar renders one line and stays visually quiet. Compact cells open the same full-prompt viewer on tap (reading the whole thing is the point); the bar's own jump control still jumps directly without opening the viewer (see U6).
- R6. The bar never forces a re-render of the transcript's rows. Its own visibility and content update through state that lives outside the virtualized/list render path, following the `chat-outline` pub/sub precedent.

### Scope Boundaries

- No change to what the daemon records, dispatches, or filters — the exclusion of synthetic prompts is already correct and happens upstream (see "Last instruction rule" above).
- No change to the chat outline rail, its active-prompt resolution, or its rendering.
- No new persistence — the bar is derived, in-memory UI state only.

### Deferred to Follow-Up Work

- A `*.browser.test.tsx` for this feature: the `agent-stream/` directory has no existing Vitest-browser-mode tests to extend (its browser-level coverage is Playwright e2e specs under `packages/app/e2e/browser/`). Adding a new Playwright spec is reasonable future work but is a different test tier than what this plan's unit tests cover; not added here to keep this change scoped to the logic it introduces.
- Any doc update beyond this plan (e.g., a short mention in `docs/agent-stream-performance.md` of the bar as another external-pub/sub consumer) — left for the leader's review pass to decide if it earns a durable line.

---

## Planning Contract

### Key Technical Decisions

- **Visibility is derived, not newly measured, on web.** `strategy-web.tsx` already reports `onReadingPositionChange(rowId)` — the row currently under the top of the viewport — every scroll/content-size change, without re-rendering list rows (the existing `chat-outline` consumer proves this). This feature reuses that exact signal: compare the reading-position row's position in `StreamItem[]` order against the last-prompt row's position. If the reading-position row comes **after** the last prompt (the viewport top has moved into the reply that followed it), the prompt has scrolled above the viewport → show the bar. Otherwise → hide it. No new scroll listener, no virtualizer-offset math, no IntersectionObserver.
- **The bar is an absolutely-positioned sibling, not a list row.** `view.tsx` already mounts `<ChatOutlineRail>` and the floating scroll-to-bottom button as siblings inside `AgentStreamView`'s relatively-positioned wrapper (`view.tsx:1124-1143`), overlaying the scrollable content without participating in its layout flow. The sticky bar follows the same pattern: `position: "absolute", top: 0` (web can additionally rely on CSS `position: sticky` within the scroll container if that proves simpler at implementation time, but the absolute-overlay approach already works identically on both platforms and is the lower-risk default). This means mounting it once in `view.tsx` makes it show up in every host of `AgentStreamView`, including pinned-grid cells, with no separate pinned-grid-specific wiring beyond the `compact` prop in U6.
- **Native visibility uses a "seen then left" state machine over `FlatList`'s own viewability callback**, not inverted-list index/offset math. `strategy-native.tsx` has no reading-position equivalent today, and building one is out of scope. Instead: `onViewableItemsChanged`/`viewabilityConfig` already tells us, cheaply, whether the last-prompt's row id is currently in the viewable set. A freshly-sent prompt always starts on-screen, so: track "has this row's id appeared in the viewable set since it became the last prompt" (`seen`); once `seen` is true and the id subsequently drops out of the viewable set, the bar shows. This needs no assumption about which direction in `FlatList`'s `data` array counts as "scrolled past" under `inverted`, which is the risky part of any offset-based native approach.
- **"Which prompt" selection is a pure, platform-neutral function** (`model.ts`), independent of how visibility is detected per platform. This keeps the exclusion rule and the prompt-selection rule unit-testable with plain data, with only the two visibility derivations needing platform-specific files (`.web.ts` / `.native.ts` per `CLAUDE.md`'s platform-gating rules). The full-prompt viewer's open/close state lives in the bar component itself (U2) — it is a display concern, not something other units observe.
- **Jump-to-original reuses, not re-implements, `prompt-jump-settle.ts`.** On web this is already wired (`use-scroll-to-message.web.ts`). On native, U5 adds a `PromptJumpSettleViewport` adapter over `FlatList` (`findTargetTop`/`getContainerTop`/`getScrollMetrics`/`setScrollTop`/`subscribeToUserIntent`, matching the interface `prompt-jump-settle.ts` already defines) and assigns the resulting function to `StreamViewportHandle.scrollToMessage`, which is currently unset on native. This is new binding code, not a new settle algorithm.
- **Hover follows `docs/hover.md`, not `docs/design.md` §14.** The two docs disagree on `onPointerEnter`/`onPointerLeave`; `docs/hover.md` is the detailed, regression-backed one and is authoritative here. The bar's tap target that opens the viewer is a `Pressable` with its own `onPress`, not driven by hover state, so this mostly matters if a future hover-to-preview affordance is added to the bar — not needed for this plan's scope.
- **No `useUnistyles()`.** Styling via `StyleSheet.create((theme) => ({...}))`; the one dynamic, high-churn value (whatever geometry controls the bar's reveal) goes through `inlineUnistylesStyle` if it ends up being more than a boolean show/hide (expected not to be, given the absolute-overlay decision above keeps `top: 0` static).
- **The full-prompt viewer reuses `AdaptiveModalSheet`** (`packages/app/src/components/adaptive-modal-sheet.tsx`), the app's existing adaptive dialog/bottom-sheet primitive (centred card on wide screens via a web portal or native `Modal`, `@gorhom/bottom-sheet` on compact). It already provides the Android Portal/Modal escape (`docs/floating-panels.md`), Esc-to-close on web, backdrop tap-outside, an X close button, and pan-to-close/back on mobile — no new modal primitive is built for this. The "Jump to message" action sits in the sheet header's `actions` slot, matching the icon-button pattern in `provider-diagnostic-sheet.tsx`.

---

## Implementation Units

### U1. Pure selection and visibility-derivation logic

**Goal:** platform-neutral, fully unit-testable functions for "what is the last prompt" and "should the bar be visible", with no DOM/React Native dependency.

**Requirements:** R1, R2, R6 (Last instruction rule).

**Dependencies:** none.

**Files:**

- `packages/app/src/agent-stream/sticky-last-prompt/model.ts` (new)
- `packages/app/src/agent-stream/sticky-last-prompt/model.test.ts` (new)

**Approach:**

- `selectLastPrompt(items: StreamItem[]): UserMessageItem | null` — scans for the last item with `kind: "user_message"`; returns `null` when none exists (e.g. before the first prompt is sent).
- `isLastPromptAboveViewport(input: { lastPromptId: string; readingPositionRowId: string | null; items: StreamItem[] }): boolean` — the web-path derivation described in the Key Technical Decisions: finds both ids' index in `items`, returns `true` only when the reading-position row's index is strictly greater than the last prompt's index. Returns `false` when `readingPositionRowId` is `null` (nothing reported yet, e.g. short transcript with no scroll) or either id isn't found.
- `createSeenThenLeftTracker(): { update(targetId: string, isCurrentlyVisible: boolean): boolean }` — the native-path state machine: resets its internal "seen" flag whenever `targetId` changes from the previous call, sets `seen = true` whenever `isCurrentlyVisible` is `true`, and returns `true` (bar should show) only once `seen` has been `true` and the current call reports `isCurrentlyVisible: false`.

**Patterns to follow:** `packages/app/src/agent-stream/turn-membership.ts` for the shape of small, pure, well-named predicate/selector functions over `StreamItem[]`; `packages/app/src/agent-stream/chat-outline/model.ts`'s `resolveActivePromptSeq` for a similar "pick the right item for this position" function.

**Test scenarios:**

- `selectLastPrompt`: returns the last `user_message` among a mix of `user_message`/assistant/tool items; returns `null` on an empty list and on a list with no `user_message`; returns the newer one after a second `user_message` is appended (simulating a new turn starting).
- `isLastPromptAboveViewport`: `false` when `readingPositionRowId` equals the last prompt's own id (viewport top is exactly at the prompt); `false` when the reading-position row is _before_ the last prompt in order (user scrolled up into older history); `true` when the reading-position row is some item that comes after the last prompt (inside its reply); `false` when `readingPositionRowId` is `null`.
- `createSeenThenLeftTracker`: starts `false` (not shown) on the first call even if `isCurrentlyVisible` is `false` (never-seen row isn't "scrolled past", it just hasn't rendered yet); becomes `true` only after at least one `true` call followed by a `false` call; resets to not-shown when `targetId` changes (new prompt arrives while bar was showing for the old one).

**Verification:** `npx vitest run packages/app/src/agent-stream/sticky-last-prompt/model.test.ts` passes with no skipped cases.

---

### U2. Sticky prompt bar presentational component

**Goal:** the visual bar itself — compact two-line (or one-line in `compact` mode) ellipsized text, a jump-to-original control, and tap/click on the bar body opens a full-prompt viewer — with no platform-specific logic inside it.

**Requirements:** R1, R3, R5.

**Dependencies:** U1 (for the `UserMessageItem` shape it renders).

**Files:**

- `packages/app/src/agent-stream/sticky-last-prompt/sticky-prompt-bar.tsx` (new)
- `packages/app/src/agent-stream/sticky-last-prompt/sticky-prompt-bar.test.tsx` (new)

**Approach:**

- Props: `{ prompt: UserMessageItem; compact?: boolean; onJumpToOriginal: () => void }`. Owns its own `viewerOpen` boolean as local state — opening/closing the viewer is purely a display concern, not something other units need to observe. (Bar visibility itself is owned by the overlay that mounts this component in U6, not by a `visible` prop here.)
- Bar: `Pressable` wrapping a `Text` with `numberOfLines={compact ? 1 : 2}` (RN's built-in ellipsis truncation, cross-platform) plus a small jump-icon control as a separate nested `Pressable` (per `docs/hover.md`'s "separate inner Pressable for press" rule — avoids the nested-Pressable hover conflict even though this bar has no hover affordance today; keeps the structure consistent with the codebase's one documented hover pattern for if hover is added later). The bar body carries a cursor-pointer cue (`Pressable` defaults to `cursor: pointer` on web via React Native Web) plus a pressed-opacity style, and an accessibility label of "Show full prompt".
- Tapping the bar body — in both compact and non-compact mode — opens a full-prompt viewer: a `FullPromptViewer` built on `AdaptiveModalSheet` (`packages/app/src/components/adaptive-modal-sheet.tsx`), showing the whole prompt in a selectable `Text`, with a "Jump to message" action in the sheet header that calls `onJumpToOriginal` and closes the viewer. `AdaptiveModalSheet` already supplies the centred-dialog/bottom-sheet adaptation, the Android Portal/Modal escape, and all the close affordances (X, Esc, tap outside, back/swipe) — no new modal primitive is built here.
- Styling via `StyleSheet.create((theme) => ({...}))` per `docs/unistyles.md`; no `useUnistyles()`.
- The bar's own jump-icon `Pressable` (separate from the body) still calls `onJumpToOriginal` directly without opening the viewer, in both compact and non-compact mode — unchanged from the original jump control.

**Patterns to follow:** `packages/app/src/account-alerts/account-alert-banner.tsx` for token usage on a compact alert-like surface (foreground/muted colors, spacing scale) — note it pushes layout down rather than overlaying, which this bar does not do; borrow its token choices, not its layout behavior. `packages/app/src/components/keyboard-shortcuts-dialog.tsx` and `packages/app/src/components/provider-diagnostic-sheet.tsx` for how a read-only `AdaptiveModalSheet` consumer is wired (header title, header `actions` icon button, scrollable body). `docs/design.md`'s banned-pattern list: no bespoke pill (not needed here).

**Test scenarios:**

- Renders two-line text by default; renders one-line when `compact` is true; the viewer is closed initially.
- Tapping the bar body opens the viewer showing the full prompt text.
- Tapping the bar body in compact mode also opens the viewer (reading the whole thing is the point in a pinned-grid cell too).
- Tapping the bar's own jump control calls `onJumpToOriginal` exactly once and does not open the viewer.
- Tapping the viewer's "Jump to message" action calls `onJumpToOriginal` exactly once and closes the viewer.
- Closing the viewer via its close control does not call `onJumpToOriginal`.

**Verification:** `npx vitest run packages/app/src/agent-stream/sticky-last-prompt/sticky-prompt-bar.test.tsx`.

---

### U3. Web visibility wiring

**Goal:** connect the web transcript's existing `onReadingPositionChange` signal to `isLastPromptAboveViewport` from U1, exposed through a non-React pub/sub so subscribing to it never re-renders transcript rows.

**Requirements:** R1, R2, R6.

**Dependencies:** U1.

**Files:**

- `packages/app/src/agent-stream/sticky-last-prompt/use-sticky-last-prompt.web.ts` (new)

**Approach:** mirror `chat-outline/model.ts`'s `createActivePromptPublisher()` shape — a tiny subscribe/publish object created once per `AgentStreamView` instance, updated from the same place `view.tsx:1113` already wires `onReadingPositionChange: chatOutline.reportReadingPosition`. This feature adds its own call alongside that one (both can observe the same `rowId` independently; no coupling to `chatOutline` needed). The hook recomputes `selectLastPrompt` from the current `streamItems`/`streamHead` whenever they change, and recomputes `isLastPromptAboveViewport` whenever the reading-position publisher fires, publishing `{ prompt, visible }` to its own subscribers (just the sticky bar's render site in U6).

**Patterns to follow:** `packages/app/src/agent-stream/chat-outline/model.ts`'s publisher; `packages/app/src/agent-stream/chat-outline/use-chat-outline.ts` for how a hook composes timeline data with a reading-position callback without causing list re-renders.

**Test scenarios:**

- Publishes `visible: true` once a reading-position update reports a row after the last prompt; `visible: false` once it reports a row at/before it.
- Recomputes the selected prompt (and resets visibility to `false`) when a new `user_message` is appended to `streamItems`.
- Subscribing/unsubscribing does not throw and stops delivering updates after unsubscribe (standard pub/sub hygiene, matching `createActivePromptPublisher`'s existing test coverage style if any exists, else a direct test here).

**Verification:** covered by `use-sticky-last-prompt.web.test.ts` if the logic is non-trivial enough to warrant its own test beyond U1's coverage of the pure functions it calls; otherwise this unit's correctness is verified through U6's integration and manual check, since the wiring itself is thin glue. Use judgment: add the test file if there's real branching logic here beyond calling U1's functions.

---

### U4. Native visibility wiring

**Goal:** connect `strategy-native.tsx`'s `FlatList` viewability to `createSeenThenLeftTracker` from U1.

**Requirements:** R1, R2, R5, R6.

**Dependencies:** U1.

**Files:**

- `packages/app/src/agent-stream/sticky-last-prompt/use-sticky-last-prompt.native.ts` (new)
- `packages/app/src/agent-stream/strategy-native.tsx` (modify: wire a `viewabilityConfigCallbackPairs`/`onViewableItemsChanged` entry that reports whether the current last-prompt row id is in the viewable set)

**Approach:** add (or extend, if one already exists for another purpose) a `viewabilityConfig`/`onViewableItemsChanged` pair on the existing `FlatList`. On each callback, check whether the current last-prompt's row id appears in `viewableItems`, and feed that boolean plus the row's id into `createSeenThenLeftTracker().update(...)`, publishing the result the same way U3 does (same pub/sub shape, different source signal) so U6 can consume both through one interface.

**Patterns to follow:** `packages/app/src/agent-stream/scroll-keyboard-dismiss/` for an existing example of native `FlatList` scroll-event wiring kept outside of row render.

**Test scenarios:**

- `createSeenThenLeftTracker` itself is already covered in U1; this unit's own test scope is the `FlatList` wiring, which is harder to unit test meaningfully without a full native test harness — if `strategy-native.tsx` already has a test file with FlatList-callback-level coverage, add cases there for "viewable items containing/not containing the target id maps to the tracker's two inputs correctly"; otherwise rely on U1's pure-function coverage plus manual device verification (this is a thin-adapter unit, same judgment call as U3).

**Verification:** `npx vitest run` on whichever existing `strategy-native.test.*` file picks up the new wiring, if one exists; otherwise manual verification on iOS/Android simulators per the brief's "everywhere" requirement, called out explicitly as device-verified rather than unit-verified in the finish report.

---

### U5. Native jump-to-original binding

**Goal:** implement the native half of `StreamViewportHandle.scrollToMessage`, currently unset in `strategy-native.tsx`, by adapting the existing platform-neutral `prompt-jump-settle.ts` controller to `FlatList` — not a second settle implementation.

**Requirements:** R4.

**Dependencies:** none beyond what already exists in `prompt-jump-settle.ts`.

**Files:**

- `packages/app/src/agent-stream/strategy-native.tsx` (modify: implement and assign `scrollToMessage` on the handle object)

**Approach:** build a `PromptJumpSettleViewport` (the interface `prompt-jump-settle.ts` already defines) backed by the `FlatList` ref: `findTargetTop` via `scrollToIndex`'s target item lookup or an `onViewableItemsChanged`-maintained item-position cache, `getContainerTop`/`getScrollMetrics` from the list's measured layout, `setScrollTop` via `scrollToOffset`, `subscribeToUserIntent` via the list's existing scroll-begin-drag handling (`strategy-native.tsx` already wires `onScrollBeginDrag`). Hand this viewport to `createPromptJumpSettleController` exactly as `use-scroll-to-message.web.ts` does, and assign the resulting `start(itemId)` (wrapped to match the `(itemId: string) => void` signature) to `StreamViewportHandle.scrollToMessage`.

**Execution note:** the exact `FlatList` geometry calls (`scrollToIndex` vs `scrollToOffset` plus a maintained offset cache) are an implementation-time discovery — confirm against the real `FlatList`/`inverted` behavior rather than the plan guessing precise RN API call shapes.

**Patterns to follow:** `packages/app/src/agent-stream/use-scroll-to-message.web.ts` for the exact shape of the `PromptJumpSettleViewport` adapter and how it's wired to `createPromptJumpSettleController`.

**Test scenarios:**

- Test expectation: primarily covered by `prompt-jump-settle.test.ts`'s existing platform-neutral coverage of the controller itself; this unit's new code is a thin `FlatList` adapter, which — like U4 — is best verified by manual on-device jump testing (tap the bar's jump control, confirm the transcript scrolls to and settles on the original prompt row on both iOS and Android) rather than invented mock-FlatList unit coverage that wouldn't catch real geometry bugs anyway.

**Verification:** manual device verification (iOS simulator + Android emulator), called out in the finish report rather than claimed as unit-tested.

---

### U6. Integration into `AgentStreamView`

**Goal:** mount the sticky bar inside `view.tsx` as a sibling overlay (same tier as `<ChatOutlineRail>`), wire it to the right visibility source per platform, and wire its `compact` prop for pinned-grid cells.

**Requirements:** R1–R6 (ties every prior unit together).

**Dependencies:** U1, U2, U3, U4, U5.

**Files:**

- `packages/app/src/agent-stream/view.tsx` (modify)

**Approach:**

- Import the platform-appropriate hook from U3/U4 via the existing `.web.ts`/`.native.ts` Metro-resolution convention (import path without extension, e.g. `./sticky-last-prompt/use-sticky-last-prompt`).
- Mount `<StickyPromptBar>` as a sibling immediately alongside `<ChatOutlineRail>` (`view.tsx:1124`), passing `onJumpToOriginal={() => viewportRef.current?.scrollToMessage?.(prompt.id)}` (the `?.` guards the native-not-yet-wired case gracefully during development, though after U5 it will always be defined).
- **Open item to resolve before writing this unit's code:** confirm whether `AgentStreamView`/the pinned-grid host already exposes a signal for "this instance is a pinned-grid cell" (research found `readOnly` but no explicit "is pinned cell" flag). If none exists, add a minimal `compact?: boolean` prop to `AgentStreamViewProps` threaded from wherever pinned-grid constructs `WorkspacePaneContent`/`buildWorkspacePaneContentModel`, defaulting to `false` everywhere else. This is the one place in the plan where the exact existing prop surface needs confirming against the live code before writing the change — flagged per the plan's stop condition.

**Patterns to follow:** `view.tsx:1124-1143`'s existing overlay-sibling mounting of `<ChatOutlineRail>` and the scroll-to-bottom button — same positioning tier, same "doesn't participate in list layout" property.

**Test scenarios:**

- Test expectation: this unit is integration wiring over already-tested pieces (U1–U5); its own correctness is best shown by the existing `render-strategy.test.ts`-style platform-neutral tests if `view.tsx` has component-level tests today, extended with one case confirming the bar renders when `streamItems` contains a `user_message` whose row is reported as scrolled-past, and does not render otherwise. If `view.tsx` has no existing component-level test harness to extend cheaply, cover this through manual verification (web browser + iOS/Android devices) instead of inventing a new harness for one integration point.

**Verification:** manual verification across web (desktop + mobile breakpoint), Electron, iOS, and Android, plus inside at least one pinned-grid cell, confirming: bar appears only once the prompt scrolls above, shows two lines (one line in pinned-grid), tapping the bar opens the full-prompt viewer (centred dialog on wide screens, bottom sheet on compact) with selectable scrollable text, "Jump to message" from the viewer jumps and closes it, the viewer closes via X/Esc/tap-outside/back-swipe, and the bar's own jump control still jumps directly without opening the viewer.

---

## Verification Contract

- Unit tests: `npx vitest run packages/app/src/agent-stream/sticky-last-prompt/model.test.ts packages/app/src/agent-stream/sticky-last-prompt/sticky-prompt-bar.test.tsx` (plus any thin wiring tests added in U3/U4 if warranted), run without `--bail`, plus the existing `packages/app/src/agent-stream/*.test.ts(x)` files that import anything this plan touches (`view.tsx`, `strategy-native.tsx`) to catch regressions — e.g. `render-strategy.test.ts`, `strategy-web.test.tsx` if it exists, `turn-membership.test.ts`. Confirm the file list passed to `vitest run` is non-empty before running.
- `npm run typecheck` across the repo; `npm run format:files` and `npm run lint` scoped to every file this plan creates or modifies.
- No full suite run, no `*.e2e.test.ts`, no daemon restart, no push, no deploy — per the brief and `CLAUDE.md`.
- Manual device/browser verification for everything called out above as "manual" (native visibility, native jump-to-original, pinned-grid rendering) — these are real gaps in automated coverage for this plan size and are reported as such, not glossed over.

## Definition of Done

- U1–U6 implemented and committed on `feat/sticky-last-prompt` in this worktree (no push).
- Unit tests above pass; typecheck, format, and lint are clean on touched files.
- The bar behaves per R1–R6 when manually exercised on at least web and one native platform (iOS or Android), and inside a pinned-grid cell.
- The finish report names exactly what was device-verified vs. unit-tested vs. left open (U4/U5's native geometry, the pinned-grid "compact" signal question in U6, the deferred browser test).

## Open Questions

- Does `AgentStreamView`/pinned-grid already carry a "this is a pinned cell" signal, or does one need adding? (U6 — resolve by reading the pinned-grid mounting code at implementation time; not blocking for U1–U5.)
- (Resolved during a follow-up pass: the inline expand-in-place was replaced by a full-prompt viewer built on the existing `AdaptiveModalSheet` primitive, so the 40%-of-panel-height question no longer applies — the sheet owns its own sizing.)
