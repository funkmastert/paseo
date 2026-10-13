---
title: A bare pool ref's null provider means the pool family, so resolve it before comparing it with the requested family
date: 2026-10-13
category: logic-errors
module: claude-account-pool-classifier
problem_type: logic_error
component: tooling
symptoms:
  - "a Codex child asking for codex/gpt-6-luna fails its first turn with a provider 400 saying the Claude model is not supported when using Codex"
  - "the create succeeds and comes up guarded; the 400 only arrives when the queued first turn runs, minutes later"
  - "the classifier-decision log line shows a Claude model.final next to account.providerId codex"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags:
  [classifier, role-router, provider-family, implicit-default, null-default, codex, account-pool]
---

# A bare pool ref's null provider means the pool family, so resolve it before comparing it with the requested family

## Problem

A pool entry written without a `provider/` prefix (a bare ref, such as `claude-haiku-4-5`) reaches `decideModel` with `outcome.provider === null`, which means the pool family, Claude (`POOL_FAMILY`, `plugins/claude-account-pool/shared/role-policy-schema.ts:194`). The family check treated that null as "same family as the request". A Codex create the pool overrode onto a bare Claude entry therefore never crossed families, and the child went to Codex with a Claude model id. Fixed in PR #33.

## Symptoms

- The first turn of a `codex/gpt-6-luna` child fails with a provider 400: "The 'claude-haiku-4-5' model is not supported when using Codex with a ChatGPT account."
- `create_agent` returns success and `currentModeId: guarded`. In the smoke test that found this, the first turn sat in the child-slot queue, so the 400 surfaced about seven minutes after the create (session history).
- The `classifier-decision` log line shows `model.final: claude-haiku-4-5` next to `account.providerId: "codex"`.

## What Didn't Work

- **A smoke test that only checked the guard.** The test that found this was checking that a full-access Codex child comes up guarded. It passed that check at create time, and only waiting for the first turn exposed the bad provider/model pair (session history). The re-test after the fix also required the `classifier-decision` line to show the request honored on `codex`, and the child to finish its task.
- **A test that pinned the bug.** One role-router JEV test already sent a Codex request onto a bare Claude entry, and it asserted the buggy result: no JEV arm, as if the create ran on Codex. #33 rewrote it (`role-router.test.ts:3098`).
- **Patching one consumer (not attempted; the tree argues against it).** The bug showed up in the role router's `config.provider` rewrite. Seven readers choose a provider or family from `model.provider`, and each maps null to the requested family:
  - the gate shape, `crossesRequestedFamily && provider !== null`: `role-router.ts:370` (`resolveFinalProviderId`), `role-router.ts:1277` (the rewrite), and `classifier.ts:1073-1074` (`decideRootAccount`);
  - the chain shape, `model.provider ?? input.requestedProvider ?? POOL_FAMILY`: `classifier.ts:1116` (`decideAccount`), `:1197` (`effectiveThinkingModel`), `:1556` (`decideOutputStyle`) and `:1797` (`decideJevTools`).

  A router-only fix would have left account choice, thinking, output style and JEV tools keyed on Codex for a create that runs Claude. Display and enforcement sites read the field too (`decision-summary.ts:25`, `jev-hint.ts:175`, `role-router.ts:1108`) and handle null their own way.

The policy override came from a pool edit that hadn't been loaded: nothing between the config edit and the create reloaded the daemon's config (session history). That is a separate gotcha, covered in the plugin README's [Troubleshooting](../../../plugins/claude-account-pool/README.md#troubleshooting). This bug is what turned the missing reload into a 400 instead of a logged fallback to Claude.

## Solution

`decideModel` resolves the bare ref's family before comparing, and reports the resolved family once the model crosses (`plugins/claude-account-pool/server/classifier.ts:949-958`):

```ts
// before
const crossesRequestedFamily = outcome.provider !== null && outcome.provider !== requestedFamily;
// ...
provider: outcome.provider,

// after
const effectiveOutcomeFamily = outcome.provider ?? POOL_FAMILY;
const crossesRequestedFamily = effectiveOutcomeFamily !== requestedFamily;
const resolvedProvider = crossesRequestedFamily ? effectiveOutcomeFamily : outcome.provider;
// ... in both the `selected` and `unavailable` returns:
provider: resolvedProvider,
```

A same-family bare ref, such as a Claude request landing on a bare Claude entry, still reports `provider: null`. None of the seven readers changed.

## Why This Works

The producer and the readers disagreed about what null meant. `decideModel` wrote null for "the pool family". Every reader resolved null to the requested family. Those agree only when the request is itself Claude, the only case the tests got right. Resolving at the producer for the crossing case gives every reader a non-null family, so none of them reaches its fallback. In the same-family case the readers' fallback lands on the requested family, which is the pool family, so null stays correct there.

[codex-workers.md, "Classifier plumbing for a routed Codex child"](../../codex-workers.md#classifier-plumbing-for-a-routed-codex-child) records the field's other path-dependent meanings, and why the Codex guard keys on `resolveFinalProviderId` instead of reading it directly.

## Prevention

- When null stands for an implicit default, resolve it to the real value before comparing it with anything. A short-circuit like `x !== null && x !== y` turns the default into a wildcard match.
- When a producer and its readers each resolve the same null, check that they resolve it to the same thing. Here the producer meant "pool family" and every reader meant "requested family".
- Pin both layers in tests. `classifier.test.ts:631` asserts the decision (`crossesRequestedFamily: true`, `provider: "claude"`). `role-router.test.ts:182` asserts the request actually leaves with `config.provider` rewritten, and `role-router.test.ts:3098` asserts JEV tools follow the model that runs.
- Before opening a pool to Codex, run a real child through it and read what reached Codex: [codex-workers.md, "Opening a pool to Codex"](../../codex-workers.md#opening-a-pool-to-codex).

## Related Issues

- [guard-every-return-path-key-on-true-signal.md](../security-issues/guard-every-return-path-key-on-true-signal.md): the same field read as a guard signal on paths where it didn't mean what the guard assumed.
