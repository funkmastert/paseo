---
title: A live gate re-check on a failed command is only safe when the sandbox actually contained it
date: 2026-10-12
category: logic-errors
module: codex-guard-health
problem_type: logic_error
component: tooling
symptoms:
  - "a command that failed inside the Codex sandbox (no network, write outside permitted roots) is judged by the live re-check and turns health red even though no gate was ever bypassed"
  - "a real child's in-sandbox adb install attempt, blocked because the device cap was full, incorrectly red-lines Codex guard health"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [codex, live-recheck, sandbox-policy, false-positive, guard-health]
---

# A live gate re-check on a failed command is only safe when the sandbox actually contained it

## Problem

The live-detection re-check judges every completed guarded command against the real gates after the fact, to catch one that ran without ever asking for approval. It originally judged a command's outcome without looking at whether the command actually succeeded — so a command that failed for an unrelated, sandbox-internal reason (no network access, a write outside the sandbox's writable roots) got judged by a gate as if it had succeeded unguarded, and turned health red for a violation that never actually happened.

## Symptoms

- A gated command's non-zero exit still produces a red guard-health verdict.
- A real Codex child's `adb install` attempted in-sandbox first (correctly failing, since the device cap was full) can red-line Codex routing for up to 24h.

## What Didn't Work

Skipping every non-zero exit unconditionally looked like the fix, but it isn't sound in general: a non-zero exit only proves the sandbox stopped the command when the sandbox was actually containing. If the host's own Codex config grants network access or extra writable roots, a gated write or push could still have reached outside the sandbox and simply failed for some other reason — skipping it there would hide a real violation.

## Solution

Two changes, not one (`packages/server/src/server/agent/providers/codex-app-server-agent.ts`):

1. Every guarded turn pins `networkAccess: false` in the sandbox policy it sends to Codex, regardless of what the host's own Codex config says. Log a one-line warning if the host config had network on.
2. The re-check skips a non-zero exit only when the session's **effective** sandbox policy — read back from Codex's own `thread/start`/`turn/start` response, not what Paseo requested — is `workspaceWrite` with network off and no extra writable roots. Any other effective policy means the sandbox might not have contained the failure, so every completed command is judged exactly as if it had no exit code at all.

## Why This Works

A gated action (a push, an `adb` call over localhost) needs the network to succeed. Pinning `networkAccess: false` makes the sandbox's own containment the reason a gated write can't succeed in-sandbox — which is the only condition under which "it failed" is proof the sandbox stopped it rather than a gate. Reading back the _effective_ policy, not the requested one, matters because Codex can apply a different policy than what was asked for.

## Prevention

- Never treat a failed command as "the gate didn't need to run" without checking that the sandbox was actually containing at the time. Test both: a non-zero exit under a containing sandbox skips the gate call entirely; a non-zero exit under any other effective policy is judged exactly like exit 0.
- When adding a new live re-check or similar after-the-fact validation, read back the actually-applied configuration from the tool's response, not the configuration you sent it.

## Related Issues

- `docs/codex-workers.md` — "Codex guard health" describes the full live-detection rule.
