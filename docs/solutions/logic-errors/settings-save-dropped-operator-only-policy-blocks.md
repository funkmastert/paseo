---
title: A settings save that rebuilds the policy field by field drops every block it doesn't name
date: 2026-10-21
category: logic-errors
module: role-model-policy
problem_type: logic_error
component: tooling
symptoms:
  - "after any save from the Agent Model Policy settings screen, agentModelPolicy.arena is gone from config.json"
  - "arena ranking keeps working until the next config reload or daemon restart, then silently switches off"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [role-model-policy, settings, config-patch, carry-through, arena]
---

# A settings save that rebuilds the policy field by field drops every block it doesn't name

## Problem

`role-model-policy.write` (`plugins/claude-account-pool/server/role-policy-rpc-handlers.ts`) builds the saved policy from the settings patch plus a hand-kept list of operator-only fields carried from the stored policy (`enforceToolsOnClassifiedRoles`, `exposeClassifierTool`, `allowUnlistedModels`, `childOutputStyle`, `codex`). `arena` was never on that list. The candidate is then written with `paseo.config.patch({ agentModelPolicy: … })`. The daemon deep-merges a patch into its in-memory config (`applySupportedPatch` in `packages/server/src/server/daemon-config-store.ts`), so `arena` survives at runtime. But the persisted file takes `agentModelPolicy` from the patch wholesale (`mergeMutablePatchIntoPersistedConfig`, same file), so the save dropped `arena` from `config.json`. The next `paseo reload` or daemon restart read the file back without it and switched arena ranking off, long after the save that caused it.

## Symptoms

- `agentModelPolicy.arena` disappears from `config.json` after an unrelated settings edit, while the running daemon still ranks.
- After a later reload or restart, arena picks stop appearing on new agents, with no error and no log line.

## What Didn't Work

Nothing failed loudly, and the delay hid the cause: the running daemon kept the block in memory, so the save looked harmless, and the loss showed up only after a later reload. The settings screen has no arena controls, so nobody saving there would think to check it. The bug was found by reading the save path while adding `arena.leader`, because a plan test scenario said "a round trip through the policy save path keeps `arena.leader`".

## Solution

Carry the block through like the others (`role-policy-rpc-handlers.ts:183`, next to `codex` at `:180`):

```ts
    codex: current.policy.codex,
    // Same again: arena ranking, the leader pick included, has no settings surface. Without this
    // an unrelated save drops the whole block, which switches ranking off.
    arena: current.policy.arena,
```

A test saves an unrelated patch over a stored policy with a full `arena` block, including `leader`, and asserts the patch carries it unchanged ("carries the arena block, leader settings included, through an unrelated save" in `role-policy-rpc-handlers.test.ts`). Shipped in funkmastert/paseo#69.

## Why This Works

The save is an allow-list rebuild, and the persisted side of `config.patch` replaces the whole plugin-owned `agentModelPolicy` rather than merging it. Any field the screen doesn't edit survives on disk only if it is named in the carry-through list. Adding `arena` there keeps it on every save.

## Prevention

- Adding an operator-only block to `RoleModelPolicySchema` means adding it to `write()`'s carry-through list in the same change, with a carry-through test like the existing ones for `allowUnlistedModels`, `thinking` and `childOutputStyle`.
- Prefer a merge over the stored policy for fields the screen does not own, so a new field is kept by default rather than dropped by default.
- When checking a config save, read `config.json` back, not the running daemon's view: the in-memory deep merge masks a field the persisted write dropped.
- A plan's test scenarios should include "an unrelated save keeps the new field" for any new policy key.
