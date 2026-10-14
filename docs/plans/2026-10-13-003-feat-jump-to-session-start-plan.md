# Jump to start of session

A "jump to start" button, mirroring the scroll-to-bottom button, that loads the
earliest window of the session (reusing the existing older-history loader) and
lands at the top. RAPID MODE.

## Behavior

- Button stacks directly above the scroll-to-bottom button in the same
  floating cluster (`packages/app/src/agent-stream/view.tsx`), icon
  `ArrowUpToLine` (lucide), label `agentStream.jumpToStart`.
- Shows when `hasOlderHistory || !isNearHistoryStart` — mirrors
  `!isNearBottom || isTimelineDetached` for the bottom button.
- On press: drives a new pure controller that repeatedly calls the existing
  `loadOlder()` (same fn used by scroll-triggered pagination) until
  `hasOlderHistory` is false, then calls `scrollToStart()` on the viewport
  handle. Shows a pending spinner in the button meanwhile.
- No parallel fetch mechanism — reuses `loadOlder`/`hasOlder`/`isLoadingOlder`
  already in `view.tsx`.
- Web: `scrollToStart` sets `scrollTop = 0` (and `followOutput = false`).
  Native (inverted list): `scrollToStart` calls `flatListRef.scrollToEnd()`.
- Pinned-grid cells render the same `view.tsx` tree in read-only mode, so the
  button appears there for free — no cell-specific code.

## Changes

1. **`agent-stream/jump-to-start-controller.ts`** (new) — pure, frame-driven
   controller shaped like `prompt-jump-settle.ts`: `start()/cancel()/isActive()`,
   takes `hasOlderHistory`, `isLoadingOlderHistory`, `loadOlder`, `scrollToStart`,
   `requestFrame`/`cancelFrame`, `onSettle`. Iteration cap as a circuit breaker.
2. **`agent-stream/strategy.ts`** — add `scrollToStart` to `StreamViewportHandle`;
   add `onNearHistoryStartChange: (value: boolean) => void` to `StreamRenderInput`.
3. **`agent-stream/strategy-web.tsx`** — fold a proximity report
   (`distanceFromHistoryStart <= HISTORY_START_THRESHOLD_PX`) into the existing
   `evaluateHistoryStart`; add `scrollToStart` to the viewport handle.
4. **`agent-stream/strategy-native.tsx`** — same proximity fold into
   `evaluateHistoryStart`; add `scrollToStart` (`flatListRef.scrollToEnd`).
5. **`agent-stream/view.tsx`** — `isNearHistoryStart` state (default true, reset
   on agent change like `isNearBottom`); `jumpToStart` handler driving the
   controller; the new button, stacked above `scrollToBottomButton`.
6. **i18n** — `agentStream.jumpToStart` key in all 9 locales.
7. **Tests** — `jump-to-start-controller.test.ts` (loads older history, then
   lands at top; stops when already at start; cancel mid-flight). A small
   visibility-rule unit test colocated with existing `history-start-pagination`
   coverage if a natural seam exists; otherwise inline reasoning in the
   controller test is enough for rapid mode.

## Out of scope

- No changes to `prompt-jump-settle.ts` itself (sticky-prompt feature, not
  merged) — this reuses its _shape_, not its code.
- No new browser e2e test — the scroll-to-bottom button has no dedicated one
  either (only e2e helpers that assume it).
