# Jump to start of session

A "jump to start" button, mirroring the scroll-to-bottom button, that loads the
earliest window of the session and lands at the top. RAPID MODE.

## Revision (post-review)

The first pass drove this by repeatedly calling the scroll-triggered older-history
loader in a loop. Tyler asked whether the protocol can fetch the head directly
instead — it can: an `"after"`-direction `fetch_agent_timeline` request with no
`cursor` defaults server-side to `baseSeq = 0` (`agent-timeline-store.ts`
`fetchAfter`), which is mathematically guaranteed to return rows starting at the
true genesis in one bounded page (at most `limit` rows can have `seq < limit`).
Combined with `mergeWindow: true` (already used by `planTimelinePromptJump` for
jump-to-message), this merges the earliest page into the store without discarding
whatever's already loaded near the live tail. One request, not a loop. See
`planTimelineStartFetch` in `timeline-sync-plan.ts`. This is backward-compatible
by construction — `cursor` and `direction` are already-optional wire fields; no
protocol or server change.

## Behavior

- Button stacks directly above the scroll-to-bottom button in the same
  floating cluster (`packages/app/src/agent-stream/view.tsx`), icon
  `ArrowUpToLine` (lucide), label `agentStream.jumpToStart`.
- Shows when `hasOlderHistory || !isNearHistoryStart` — mirrors
  `!isNearBottom || isTimelineDetached` for the bottom button.
- On press (`useJumpToStart`): if the server has more older history
  (`hasRemoteOlderHistory`), fetch the genesis page once via
  `planTimelineStartFetch()`; then reveal the earliest loaded item locally
  (`revealLoadedHistory(earliestId)`, a one-shot jump, not the incremental
  scroll-triggered reveal) and scroll to it. Shows a pending spinner meanwhile.
- Reuses the sticky-prompt work's jump machinery instead of a parallel one:
  native's `scrollToStart` delegates to the same `jumpToMessage`/
  `promptJumpSettleController` pair `scrollToMessage` uses (coarse
  `scrollToIndex` + settle/retry); web's delegates to the existing
  `scrollToMessage` (`use-scroll-to-message.web.ts`), same reasons — the
  target row may not be mounted yet when the call lands, so a raw
  `scrollTop`/`scrollToEnd` write would land a frame early with no retry.
- `scrollToStart` takes an optional target item id (the one just revealed);
  without one it falls back to "whatever's currently the earliest loaded row"
  (native: `historyRows.at(-1)`; web: first virtualized/mounted row).
- Pinned-grid cells render the same `view.tsx` tree in read-only mode, so the
  button appears there for free — no cell-specific code.

## Changes

1. **`timeline/timeline-sync-plan.ts`** — `planTimelineStartFetch()`: `{direction:
"after", limit: TIMELINE_FETCH_PAGE_SIZE, projection: "projected",
mergeWindow: true}`, no cursor.
2. **`agent-stream/timeline-start-navigation.ts`** (new) — pure
   `jumpToTimelineStart`, mirrors `timeline-tail-navigation.ts`'s
   `returnToTimelineTail`: fetch (if needed) → reveal → scroll, swallow/report
   errors the same way.
3. **`agent-stream/use-jump-to-start.ts`** — thin hook: pending state, guards
   double-press, reads the live store (`agentStreamTail`) for the earliest
   item after the fetch resolves (not the render-closure value), defers the
   scroll one frame so the reveal's state update commits first.
4. **`agent-stream/strategy.ts`** — `scrollToStart(itemId?: string | null)` on
   `StreamViewportHandle`; `onNearHistoryStartChange` on `StreamRenderInput`.
5. **`agent-stream/strategy-web.tsx` / `strategy-native.tsx`** — fold a
   proximity report (`distanceFromHistoryStart <= HISTORY_START_THRESHOLD_PX`)
   into the existing `evaluateHistoryStart`; `scrollToStart` delegates to
   `scrollToMessage`'s settle machinery.
6. **`agent-stream/view.tsx`** — `isNearHistoryStart` state (default true,
   reset on agent change like `isNearBottom`); the new button, stacked above
   `scrollToBottomButton`.
7. **i18n** — `agentStream.jumpToStart` key in all 9 locales.
8. **Tests** — `timeline-sync-plan.test.ts` (new plan shape),
   `timeline-start-navigation.test.ts` (fetch/skip-fetch, ordering, error
   path).

## Out of scope

- No changes to `prompt-jump-settle.ts` itself — reused as-is, not forked.
- No new browser e2e test — the scroll-to-bottom button has no dedicated one
  either (only e2e helpers that assume it).
