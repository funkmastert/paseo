---
title: A linked worktree opened at its own root became its own sidebar project, because "" collapsed to null and the registry matched roots exactly
date: 2026-10-21
category: logic-errors
module: project-registry
problem_type: logic_error
component: tooling
symptoms:
  - "69 of 77 sidebar projects were empty projects, one per linked worktree that had been opened at its own root"
  - "a workspace opened at a worktree root got a project key built from the worktree path, not the main repo's"
  - "the done janitor's empty-project rule could not safely remove them, because a folder named like a worktrees directory also held a main checkout"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components:
  - done-janitor
  - workspace-provisioning
tags:
  [
    project-key,
    worktree,
    empty-string-vs-null,
    relative-path,
    project-registry,
    done-janitor,
    empty-projects,
  ]
---

# A linked worktree opened at its own root became its own sidebar project, because "" collapsed to null and the registry matched roots exactly

## Problem

A workspace opened at a linked git worktree's own root got its own project instead of joining the main repo's project. Two independent bugs caused it, and 69 of 77 projects ended up as empty worktree projects.

## Root cause

**1. `""` collapsed to `null`.** `deriveProjectKey` (`packages/server/src/server/project-key.ts:6`) asks `getRealpathAwareRelativePath` for the workspace's path relative to the worktree root. For the root itself the helper returns `""` (no subdirectory offset). The old code collapsed that with `|| null`, which made "the worktree root" indistinguishable from "not a worktree subpath at all". The local-path branch then ignored `mainRepoRoot` and keyed the project on the worktree path. The fixed code keeps the two apart (`project-key.ts:14-18`) and uses `mainRepoRoot` whenever the offset is not `null` (`project-key.ts:26-29`).

**2. The registry matched by exact root.** `getOrCreateActiveByRoot` (`packages/server/src/server/workspace-registry.ts:450`) looked up an active project whose root equalled the workspace root. A worktree root never equals the main repo root, so it always minted a new project. It now falls back to the project at `mainRepoRoot`, then to one sharing the `projectKey` (`workspace-registry.ts:473-483`). `mainRepoRoot` is set only for a confirmed linked worktree, never for an independent full clone.

Fixed in funkmastert/paseo#68.

## What Didn't Work

Removing idle projects by folder name. A path segment like `*-worktrees/` is not evidence of a worktree: a main checkout lived at `mobile-worktrees/main`, and one person's main project was itself a linked worktree. A name rule would have deleted real projects and kept impostors.

## Solution

Gate the cleanup on git facts plus who created the workspaces. The janitor removes an idle project only when its root is gone, or when the root is a linked or Paseo-owned worktree (its `.git` is a pointer file, not a directory) and every workspace the project ever had, archived ones included, was agent-created. One person-created workspace keeps the project. The rules and their limits live in [docs/done-janitor.md](../../done-janitor.md#empty-projects).

## Prevention

- A relative-path helper that returns `""` for "same directory" and `null` for "not under it" carries two meanings. Never combine them with `||`, `??` on a falsy check, or `if (!x)`. Test the root case explicitly: path equal to the root, with and without `mainRepoRoot`.
- Identity by exact path breaks for any entity with two valid paths (a worktree and its main repo). When a lookup keys on a path, say what happens for a linked worktree, and test it.
- Decide "is this a worktree" from git state (`.git` is a file) and creation provenance, never from directory names.
