---
title: Anything that looks up an agent-stream row id must search the live head as well as the committed tail
date: 2026-10-14
category: ui-bugs
module: agent-stream
problem_type: ui_bug
component: tooling
symptoms:
  - "the sticky last-prompt bar never appears while an agent is mid-turn, even after the prompt has scrolled well off the top"
  - "the bar works on a finished conversation and fails on a live one"
root_cause: scope_issue
resolution_type: code_fix
severity: medium
related_components:
  - sticky-last-prompt
  - chat-outline
  - stream-strategy-web
tags:
  [
    agent-stream,
    live-head,
    reading-position,
    sticky-prompt,
    scroll,
    browser-test,
    synthetic-fixtures,
  ]
---

# Anything that looks up an agent-stream row id must search the live head as well as the committed tail

## Problem

The sticky last-prompt bar (PR #40) stayed hidden during long turns, which is when it is needed most.
The report was "im not seeing my latest prompts being sticky at the top". It looked up the reading
row in the committed tail only, and during a turn the reading row is almost always in the live head.

## Symptoms

- No sticky bar while an agent is streaming, however far the prompt has scrolled off.
- The bar shows on a conversation whose turn has finished, because by then every row is in the tail.

## What Didn't Work

- **Review and unit tests.** The feature went through four review rounds and its unit suite passed.
  Every test built its items by hand with ids like `p1` and `a2` in one flat list
  (`packages/app/src/agent-stream/sticky-last-prompt/model.test.ts`). None had a tail/head split, so
  none could produce a reading-row id missing from `items`.
- **A jsdom test of the real tree.** `reportReadingPosition` picks the row from
  `getBoundingClientRect()`, and jsdom returns zero rects for every element, so a jsdom render cannot
  tell "no reading row" from "the wrong reading row".

## Solution

Fixed in PR #44. The stream renders two lists: the committed tail (`effectiveStreamItems` in
`packages/app/src/agent-stream/view.tsx`) and the streaming head (`effectiveStreamHead`, rendered
as `liveHead` rows in `packages/app/src/agent-stream/strategy-web.tsx`). Both carry
`data-history-row-id`, and `reportReadingPosition` in `strategy-web.tsx` reports whichever one sits
at the reading line.

`view.tsx` now passes the head to the hook, and
`packages/app/src/agent-stream/sticky-last-prompt/use-sticky-last-prompt.web.ts` searches
`[...items, ...head]`. `packages/app/src/agent-stream/chat-outline/use-chat-outline.ts` already did
the same with its `loadedItems`.

## Why This Works

`isLastPromptAboveViewport` (`packages/app/src/agent-stream/sticky-last-prompt/model.ts`) returns
false when the reading row's `findIndex` is -1. With only the tail, a reading row in the head always
missed, so the bar was never shown. The combined list holds every row the strategy can report.

## Prevention

- Anything that consumes reading-position or row ids from the stream looks them up in tail + head.
  Take `head` next to `items` and combine them the way `use-chat-outline.ts` does.
- Tests for scroll and visibility features render the real strategy row markup with a tail/head
  split, in real Chromium. The test that caught this is
  `packages/app/src/agent-stream/sticky-last-prompt/sticky-last-prompt-live-head.browser.test.tsx`:
  it mounts `createWebStreamStrategy` with the prompt in the tail and four rows in the head, scrolls
  to the bottom, and expects the bar visible. Run `*.browser.test.tsx` files through the browser
  project ([testing.md](../../testing.md)).
- Hand-written ids in one flat list are fine for the pure model. They cannot stand in for the
  rendered stream.

## Related Issues

- [agent-stream-performance.md](../../agent-stream-performance.md) — the stream pipeline and the
  live head.
- [timeline-sync.md](../../timeline-sync.md) — how live rows stay in the separate live head until
  they reconcile with history.
