---
title: Codex's default-writable sandbox roots silently bypass approval gates
date: 2026-10-12
category: security-issues
module: codex-guard-health
problem_type: security_issue
component: tooling
symptoms:
  - 'Codex guard self-test turns health red with reason "Paseo guard self-test canary"'
  - "approval-time gates never receive an escalation request, even though the self-test writes a canary file that should have been denied"
root_cause: missing_validation
resolution_type: code_fix
severity: high
tags: [codex, sandbox, workspace-write, approval-gate, self-test]
---

# Codex's default-writable sandbox roots silently bypass approval gates

## Problem

A Codex `workspace-write` sandbox makes the session cwd, `$TMPDIR`, and `/tmp` writable by default, so any self-test (or guarded command) with targets inside those roots runs to completion without Codex ever asking Paseo for an escalation — the approval-time gates that decide accept/decline never execute, even on a write the test design assumed would be gated.

## Symptoms

- Guard self-test health goes red with the canary's own deny message (`"Paseo guard self-test canary"`) rather than a verdict from the evaluator — the canary ran and nothing stopped it.
- A `touch` inside `$TMPDIR/<scratch>/...` or the session cwd completes with exit 0 and zero approval-request events.

## What Didn't Work

- Writing files under `os.tmpdir()`/`$TMPDIR` scoped to the session's own scratch directory looked isolated, but `workspace-write`'s default writable roots cover the whole of `$TMPDIR` and `/tmp`, not just paths the daemon created outside them.
- Unit tests using a fake client that always asks for escalation never caught this — the gap only shows up against the real Codex binary's actual sandbox policy.

## Solution

Put every self-test target (ok file, canary file, bare remote) in a daemon-owned scratch directory outside every default-writable root — `$PASEO_HOME/codex-guard-self-test/<nonce>/`, threaded in from `bootstrap.ts` — and realpath-resolve that root at run start. If the resolved root lands inside `os.tmpdir()` or `/tmp` anyway, refuse to run and turn health red with a reason naming the path, rather than running a self-test that can't prove anything (`packages/server/src/server/agent/codex-guard-health.ts`).

The realpath check matters on macOS specifically: `/tmp` and `os.tmpdir()`'s parents are symlinks into `/private/...`, so comparing a realpath'd candidate root against an unresolved `/var/...` path silently passes a root that is actually inside the sandbox.

## Why This Works

The self-test's whole point is to exercise the approval-time gates (catastrophe gate, device gate). A target inside a default-writable root never reaches those gates — Codex has no reason to escalate a write it's already allowed to make. Moving the targets outside every writable root forces an escalation request, which is the only way the gates get a verdict to render at all.

## Prevention

- Any new guarded-command self-test must place its target paths outside `cwd`, `os.tmpdir()`/`$TMPDIR`, and `/tmp`, and realpath-check the chosen root before trusting it.
- Don't rely on a sandbox fake/stub client that always asks for escalation to catch this class of bug — it can't reproduce what the real binary's default writable roots actually are. Verify against the real binary.

## Related Issues

- `docs/codex-workers.md` — "Codex guard health" has the self-test's full mechanics and the live-detection re-check it works alongside.
