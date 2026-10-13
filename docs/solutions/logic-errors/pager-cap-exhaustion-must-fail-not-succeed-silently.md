---
title: A paging safety cap that runs out must be treated as a failure, not as "done"
date: 2026-10-12
category: logic-errors
module: arena-rankings
problem_type: logic_error
component: tooling
symptoms:
  - "text_style_control's instruction_following category is recorded as a board with 0 rows instead of appearing in failedBoards"
  - "a config with roughly 11,000 rows across 29 categories only has its first roughly 4,000 rows read"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [arena-rankings, pagination, safety-cap, partial-credit, silent-failure]
---

# A paging safety cap that runs out must be treated as a failure, not as "done"

## Problem

`MAX_PAGES_PER_CONFIG` capped every dataset-config scan at 40 pages (4,000 rows) as a safety circuit breaker against an infinite loop. `fetchConfigCategoryRows` only recorded an error when a page fetch itself threw — running out of allowed pages while rows remained wasn't a thrown error, so a category whose block the scan hadn't finished reading by page 40 was recorded as a present board with whatever partial rows it had collected (often 0), not as a failed board. `text_style_control` has roughly 11,000 rows across 29 categories, so `instruction_following` — past row 4,000 — was never read, and because it looked like a normally-empty board rather than a failed one, the failed-board retry poller never picked it up.

## Symptoms

- A category's rows stop appearing past a certain row count in a config with more categories/rows than the page cap covers.
- The affected board shows 0 rows with no error anywhere in the output, rather than appearing in `failedBoards`.

## What Didn't Work

Raising the cap alone (to 300 pages / 30,000 rows) buys headroom today but doesn't fix the underlying bug — the next config that outgrows the new cap hits the exact same silent-empty-board failure mode, just at a higher row count.

## Solution

Track whether the scan actually reached the end of the config (a short/empty page, or the running offset reaching `num_rows_total`) versus simply running out of allowed pages. When it's the latter, return a synthetic error alongside whatever partial rows were collected, so the category the scan never reached falls into `failedBoards` through the existing partial-credit logic in `fetchBoardsGroupedByConfig` — instead of being normalized as an empty-but-successful board. Raise `MAX_PAGES_PER_CONFIG` so it's a last-resort circuit breaker against a dataset-shape change, not something real data comes anywhere near triggering (`plugins/claude-account-pool/server/arena-rankings.ts`).

## Why This Works

The cap's job is to stop an infinite loop if the reported total row count lies or a page never comes back short — it was never supposed to be the normal stopping condition. Treating "ran out of pages" identically to "a page fetch threw" means both failure modes route through the same failed-board machinery that already exists (retry polling, no silent data loss), rather than needing a second success/failure signal that downstream consumers would also have to check.

## Prevention

- Any paging loop with a safety cap needs to distinguish "stopped because we reached the end" from "stopped because the cap ran out" — and the latter must be reported as a failure, because a cap sized for today's data will eventually be exhausted by tomorrow's.
- Pin the cap's exhaustion behavior in regression tests by asserting something that actually proves the cap value (e.g. the fetch call count), not just "more rows than the old cap allowed" — a test that only proves the new cap is greater than some smaller number doesn't catch a future regression landing between the two.

## Related Issues

- None found in this repo at the time of writing.
