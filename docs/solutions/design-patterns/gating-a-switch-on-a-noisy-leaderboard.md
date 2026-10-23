---
title: Gating an automatic switch on a noisy public leaderboard
date: 2026-10-21
category: design-patterns
module: arena-rankings
problem_type: design_pattern
component: tooling
severity: medium
applies_when:
  - "a decision (which model runs a leader, a default, a fallback) should follow a public leaderboard that republishes on its own schedule"
  - "the leaderboard reports confidence intervals and a wrong switch is expensive to reverse"
  - "an alert reads the same capped top-N list it compares against"
tags:
  [arena-rankings, leader-pick, confidence-interval, streak, publish-date, shadow-mode, calibration]
---

# Gating an automatic switch on a noisy public leaderboard

## Context

The arena leader pick (`decideLeaderPick` in `plugins/claude-account-pool/server/arena-model-pick.ts`, shipped in funkmastert/paseo#69) decides which model a new Bozeo leader would run, from the LMArena leaderboard. A leader is the longest-lived agent in the fleet, and a model switch rebuilds its whole prompt cache, so the rule has to move only on a clear, lasting lead. Four things went wrong or nearly went wrong while building it. Each is general to any rule that switches on a public ranking.

## Guidance

**1. Count real publishes, not fetches.** `arena-rankings.json`'s `publishDate` is the day the daily job ran (`plugins/claude-account-pool/server/arena-rankings.ts:565`, `new Date().toISOString().slice(0, 10)`), not an Arena publish. It changes on every run whether or not anything was republished, and boards publish on different days (on 2026-10-20 `agent_bash_recovery_steps` was dated 10-08 while `agent` was 10-19). A streak keyed on it would count three calendar days of the same stale data as three publishes. Key per-publish history on each board's own `leaderboard_publish_date` (`mergeLeaderBoards`, `arena-rankings.ts:259`). This means threading that field through normalization, which originally dropped it. A refresh sees only the latest publish, so two publishes between refreshes leave one unrecorded.

**2. A margin rule must refuse degenerate CIs.** The bar is "the challenger's lower bound clears the incumbent's upper bound by k widths of the challenger's own CI". With an inverted row (`ratingLower > ratingUpper`) the width is negative, and `lower - k * width` becomes a head start instead of a penalty. One malformed row could then count toward a streak. `clearsLeaderBar` (`plugins/claude-account-pool/shared/arena-leader-rule.ts:23`) returns false unless `width > 0`. The schema does not enforce `lower <= upper`, so the rule has to.

**3. Don't find the baseline in the capped list you compare against.** The unpooled-challenger alert compares the board's top rows, capped at 10, against the incumbent. The first version also looked the incumbent up in that capped list, so once ten models ranked above it, the incumbent dropped out and the alert went quiet, exactly when it mattered most. `incumbentRow` (`plugins/claude-account-pool/shared/arena-unpooled.ts:47`) reads the newest publish's full matched rows first and uses the capped top rows only for display names.

**4. Calibrate the bar against real history before shipping.** The dataset's `full` split carries every publish (42 for `agent` between 2026-06-04 and 2026-10-19). Replaying the rule over it showed the default bar (one extra CI width, three consecutive publishes) behaves as intended. Fable 5.1 led Opus 5.5 (High) for four publishes, 09-27 to 10-02, by 0.005 to 0.022, and its CI never cleared Opus 5.5's (margins of -0.42 to -0.94 widths), so the rule held the incumbent. A calibration test pins three of those publishes (09-28, 09-30, 10-02, with rounded values) and asserts the incumbent holds ("calibration", `plugins/claude-account-pool/server/arena-model-pick.test.ts:525`).

Ship it in shadow (record the would-be pick, apply nothing), off by default, decided once at create. The record shows what a live rule would have done before anyone turns it on.

## Why This Matters

Each failure turns noise into a switch. A fetch-date streak fires after three days of one publish. An inverted row skips the margin. A capped baseline hides the case the alert exists for. An uncalibrated bar is a guess. Leaderboard data is external, republished on its own schedule, and only loosely validated, so the rule is the last line of defense.

## When to Apply

- Any automatic choice driven by a public ranking: default models, fallback order, provider routing.
- Any streak or "N consecutive" rule over data you poll: key it on the source's own version or date, never on your poll time.
- Any alert of the form "X is above our pick": source the baseline independently of the list it is judged against.

## Examples

Arena rows as the rule sees them, half-widths of 0.02:

```text
incumbent  Opus 5.5   0.20 [0.18, 0.22]
challenger Sonnet 5.5 0.27 [0.25, 0.29]   non-overlap, but 0.25 - 1*0.04 = 0.21 < 0.22 -> holds
challenger Sonnet 5.5 0.32 [0.30, 0.34]   0.30 - 0.04 = 0.26 > 0.22 -> wins this publish
inverted   Sonnet 5.5 0.32 [0.50, 0.30]   width -0.20: refused, never a win
```

Three wins on three consecutive recorded publishes, by the same challenger fixed from the newest publish, make it the pick. A miss anywhere in between resets the count.

Related: `docs/arena-ranking.md` ("Leaders"), `docs/design-notes/2026-10-20-leader-model-research.md`, and `docs/solutions/logic-errors/pager-cap-exhaustion-must-fail-not-succeed-silently.md` (the same module's earlier silent-cap bug).
