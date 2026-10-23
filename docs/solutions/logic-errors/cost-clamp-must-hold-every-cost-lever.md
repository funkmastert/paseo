---
title: A "never pricier" clamp must hold every cost lever, and its test must run on a model where the lever exists
date: 2026-10-16
category: logic-errors
module: claude-account-pool-classifier
problem_type: logic_error
component: tooling
symptoms:
  - "a JEV spawn hint that raised a child's class on a flat-priced model lifted thinking from high to xhigh with no clamp"
  - "the down-only clamp held the model to the no-JEV pick but thinking still followed JEV's class"
  - "a thinking assertion added for the clamp passed with the clamp turned off"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [jev, spawn-hint, classifier, thinking, cost-clamp, vacuous-test, mutation-check]
---

# A "never pricier" clamp must hold every cost lever, and its test must run on a model where the lever exists

## Problem

The owner's rule for JEV's spawn hint is "only move down": a hint may change a child's class or role, but the create must never cost more than it would without the hint. The first clamp (PR #52, its first commit) compared only the model's `priceWeight`. Thinking was still decided from JEV's class and role, and thinking is a second cost lever on the same model.

## Symptoms

- A class raise whose role has the same model in its standard and hard pools leaves `priceWeight` flat, so no model clamp fires, but `policy.thinking.byTaskClass` lifts thinking from `high` (standard) to `xhigh` (hard).
- The first fix for this, "decide thinking from the no-JEV class when the model was clamped", still missed that flat-price case.
- The test added with that fix asserted `decision.thinking` equals the no-JEV decision, and passed with the fix reverted.

## What Didn't Work

- **Holding thinking only when the model was clamped.** That keys the second lever on the first lever's outcome. A raise that leaves the model alone never trips it. Two review lenses (agent-native, learnings) found this independently.
- **Asserting thinking on the mechanical seed's model.** The seed ran Haiku, and both test catalogs list Haiku with `optionIds: []` (`plugins/claude-account-pool/server/jev-hint.test.ts:98`, `plugins/claude-account-pool/server/classifier.test.ts:61`). `decideThinking` returns `outcome: "no-thinking-options"` (`plugins/claude-account-pool/server/classifier.ts:1464`) before it reads the class or role, so the decision is identical whichever class is passed. The `jev-hint.test.ts` world also sets every `byTaskClass` level to `high` (line 361), so even a Sonnet case there could not tell the classes apart.

## Solution

Whenever the hint applied, decide thinking twice for the model that runs, once from JEV's class and role and once from the no-JEV ones, and keep the lower level (`lowerThinking`, `plugins/claude-account-pool/server/classifier.ts:1511`; call site at line 1857):

```ts
const jevThinking = decideThinking(input, world, model, taskClass.taskClass, roleDecision, asChild);
const thinking = hintChangedModel
  ? lowerThinking(
      jevThinking,
      decideThinking(input, world, model, baselineClass, toolRole, asChild),
    )
  : jevThinking;
```

A level `thinkingLevelRank` doesn't rank (Ultra Code, an id off Paseo's ladder) is never judged, matching the model clamp's rule for a model `priceWeight` doesn't know. The held decision's reason sentence says the level was held.

The discriminating test lives in `classifier.test.ts` ("a class raise that leaves the model's price flat still never raises thinking"): `worker`'s hard pool is set to Sonnet, JEV answers `hard`, the model stays Sonnet with `modelClamped: false`, and thinking stays `high`, not `xhigh`.

## Why This Works

The invariant is about cost, and cost has more than one input. Comparing each lever against its own no-hint value, independently, holds the invariant on every path, including the one where the first lever didn't move. Taking the lower of the two thinking levels also keeps a saving JEV earned: a clamped role move whose JEV class is `mechanical` still thinks `low`.

## Prevention

- When a rule says "never more expensive", list every input to the price before writing the clamp: here model and thinking. Check each against its own baseline; never gate one lever on whether another was clamped.
- Run a mutation check on any new guard: turn it off (`hintChangedModel ? lowerThinking(...)` to `false ? ...`), run the test file, and confirm a test fails. This is how the vacuous assertion above was caught.
- Pin a thinking assertion on a model whose catalog offers thinking levels, in a world whose `byTaskClass` levels differ by class. Otherwise `decideThinking` short-circuits and the assertion checks nothing.

## Related Issues

- `docs/solutions/security-issues/guard-every-return-path-key-on-true-signal.md`: the same shape for a safety guard. An invariant that can be broken through several routes has to hold on every route, keyed on the real signal.
- `docs/solutions/logic-errors/bare-pool-ref-family-resolves-before-compare.md`: when a decision is overridden after it is made, every consumer (account, thinking, output style, JEV tools) has to see the overridden value.
- PR #52: the clamp, the thinking hold and the tests. `docs/jev.md`, Feature 2, "The clamp".
