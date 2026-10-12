---
title: A per-branch safety override must key on the request's own field, not a decision field whose meaning changes per branch
date: 2026-10-12
category: security-issues
module: role-router
problem_type: security_issue
component: tooling
symptoms:
  - "a Codex child created through the honored, unconfigured, or recovered classifier path runs with no guard: full-access mode, no catastrophe gate, no device gate"
  - "only a child created through the ordinary model-rewrite path was forced into guarded mode"
root_cause: missing_validation
resolution_type: code_fix
severity: critical
tags: [role-router, codex-guard, defense-in-depth, fail-open, classifier]
---

# A per-branch safety override must key on the request's own field, not a decision field whose meaning changes per branch

## Problem

The Codex guard step in the account-pool classifier (`plugins/claude-account-pool/server/role-router.ts`) ran on only one of the router's several return paths — the ordinary rewrite path, where `decision.model.provider === "codex"` reliably means the child is about to run on Codex. The other paths (honored-request, unconfigured, recovered) can also hand a child the codex provider, but `decision.model.provider` doesn't mean the same thing on them: it's `null` for `unconfigured`, it just echoes whatever the caller asked for on `honored-request`, and on the recovery path it names the model the rewrite _abandoned_, not what actually runs. A Codex child created with `modeId: full-access` through any of those three paths kept that mode — no catastrophe gate, no device gate, no guard of any kind.

## Symptoms

- A Codex child spawned with `settings.modeId=full-access` via `create_agent` runs guard-free when the classifier logs `model.outcome: "honored-request"`.
- `currentModeId` on the created child shows `full-access`, not `guarded`, even though every Codex child is supposed to always run guarded.

## What Didn't Work

Reading `decision.model.provider` to decide whether to guard looked right on the rewrite path, where it's trustworthy, but the same field is unreliable or outright misleading on the other three return paths — it isn't the signal that tells you what provider the child is actually about to run on.

## Solution

Key the guard on the thing that's actually true on every path: the request's own `config.provider` field, checked alongside whether this is a child create (a caller agent id present — root creates from the app keep their own mode). A single guard helper applies this uniformly: force `modeId: "guarded"`, strip the caller's own `approval_policy`/`sandbox_mode`/`sandbox_workspace_write`, and reserve the guard slot — called at the top of every return branch that can hand a codex-provider child create to the caller (honored/unconfigured, recovered, and the rewrite path), applied to the request _before_ that branch's own tool-profile/enforcement step runs, so enforcement's own trusted overrides can still land on top afterward.

Independently, the daemon itself (`packages/server/src/server/agent/agent-manager.ts`, `enforceCodexChildGuard`) forces `modeId: "guarded"` on any Codex child create regardless of what the plugin decided, and refuses the create outright if the guard isn't proven healthy — because the plugin is fail-open by contract (any throw passes the request through untouched), so a plugin that's down, throws, or isn't installed must not be the only thing standing between a Codex child and an unguarded mode.

## Why This Works

Every return path that can produce a codex-provider child create now guards on its own request data, not on a field whose meaning changes depending on which branch set it. The daemon-side enforcement means the guard holds even if the plugin layer is entirely absent — the catastrophe gate is a daemon invariant, not a plugin-only one, and Codex's guarded mode is that gate's Codex-specific form.

## Prevention

- When a router or classifier has multiple return paths that can produce the same dangerous outcome (here: "child runs on Codex"), apply any required safety override on **every** path that can produce it, keyed on a field that means the same thing on all of them — never on a decision/intent field whose semantics are branch-specific.
- Smoke-test a safety gate with one real, maximally-permissive child create through _each_ return path before trusting it's closed — the honored-request path here was functionally equivalent to no gate at all, and nothing but a real create exposed it.
- Any fail-open plugin layer (by contract: throws pass through untouched) needs an independent, fail-closed enforcement point in the daemon for anything safety-critical. Don't let the only enforcement of an invariant live in a layer whose contract is to get out of the way on error.

## Related Issues

- `docs/catastrophe-gate.md` — the invariant this guard implements for Codex.
- `docs/codex-workers.md` — "Codex guard health" and "Guarded mode" sections.
